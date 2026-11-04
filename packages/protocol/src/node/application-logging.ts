import { appendFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatWithOptions } from "node:util";

import { normalizeDebugLogRetentionDays } from "../debug-logging.js";
import { ESSENTIAL_LOG_DIRECTORY_NAME } from "./essential-log.js";
import { defaultLogDetail, resolveLogDetail, type LogDetail } from "../log-policy.js";
import {
  createLogger,
  escapeLogLine,
  formatLogError,
  getLogFormat,
  LOG_RECORD_PREFIX,
  parseLogRecordLine,
  renderLogLine,
  type LogFormat,
} from "../logger.js";

/** Electron's own log. A standalone backend writes beside it under its own prefix. */
export const DESKTOP_LOG_FILE_PREFIX = "orkestrator-ai-";
export const BACKEND_LOG_FILE_PREFIX = "orkestrator-backend-";
/**
 * Set by Electron on the backend it spawns. Electron already writes that
 * child's output into its own log, so only an unsupervised backend (started
 * directly with `bun dist/main.js`) writes a file of its own.
 */
export const DESKTOP_SUPERVISED_ENV = "ORKESTRATOR_DESKTOP_SUPERVISED";
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOG_SHUTDOWN_FLUSH_MS = 2_000;
const MAX_PENDING_LOG_BYTES = 4 * 1024 * 1024;
// Above what the byte bound admits at a typical line length. It is there for a
// flood of very short lines, each of which costs far more than its bytes.
const MAX_PENDING_LOG_ENTRIES = 64 * 1024;
const MAX_LOG_BATCH_BYTES = 256 * 1024;
const MAX_LOG_ENTRY_BYTES = 64 * 1024;
const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LOG_DIRECTORY_BYTES = 512 * 1024 * 1024;
// A rolled file is capped at `maxFileBytes`, so this bounds one day far above
// any directory budget. It exists so a corrupted directory cannot spin the
// index scan, not as a limit a real installation can reach.
const MAX_LOG_FILE_INDEX = 10_000;
// Count bound for the directory-budget scan, matching the backend's own
// `MAX_LOG_STORAGE_ENTRIES`. The budget is a byte limit, but the list it sorts
// is a buffer and needs a bound of its own.
const MAX_LOG_BUDGET_FILES = 100_000;

/**
 * Byte bounds for the on-disk log. Every one is injectable because each is a
 * boundary that only misbehaves at its edge, and the production values are far
 * too large for a test to reach.
 */
export type ApplicationLogBounds = {
  /** In-memory queue ceiling. Entries past it are dropped and reported. */
  maxPendingBytes: number;
  /** The same queue's ceiling by count. Entries past it are handled the same way. */
  maxPendingEntries: number;
  /** Most bytes one append carries, unless a single entry is larger on its own. */
  maxBatchBytes: number;
  /** Per-entry ceiling. A longer entry is truncated with an explicit marker. */
  maxEntryBytes: number;
  /** Per-file ceiling. Exceeding it rolls to the next numbered file. */
  maxFileBytes: number;
  /** Whole-directory ceiling, enforced oldest-first after the age sweep. */
  maxDirectoryBytes: number;
};

export const DEFAULT_APPLICATION_LOG_BOUNDS: ApplicationLogBounds = {
  maxPendingBytes: MAX_PENDING_LOG_BYTES,
  maxPendingEntries: MAX_PENDING_LOG_ENTRIES,
  maxBatchBytes: MAX_LOG_BATCH_BYTES,
  maxEntryBytes: MAX_LOG_ENTRY_BYTES,
  maxFileBytes: MAX_LOG_FILE_BYTES,
  maxDirectoryBytes: MAX_LOG_DIRECTORY_BYTES,
};

/** The two filesystem calls the writer makes per batch; injectable so a test can count or fail them. */
export type ApplicationLogFileOperations = {
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  appendFile(target: string, data: Buffer, options: { mode: number }): Promise<void>;
};

export type ApplicationLogSettings = {
  enabled: boolean;
  retentionDays: number;
};

/** Entries lost to the queue bound since the last time a marker was written. */
export type ApplicationLogDropStats = {
  droppedEntries: number;
  droppedBytes: number;
};

export type InstalledApplicationLogging = {
  logDirectory: string;
  /** The settings in force now; `updateSettings` replaces them. */
  settings(): ApplicationLogSettings;
  /**
   * Applies "Save logs to disk" and retention at once. Off stops new entries and
   * announces any drop not yet reported; on starts writing; a change while on
   * sweeps straight away, so a shorter retention does not wait for the next tick.
   */
  updateSettings(next: ApplicationLogSettings): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  /** Unreported drops. Non-zero means the log has an unmarked gap in flight. */
  dropStats(): ApplicationLogDropStats;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Both logging settings, as `config.json` holds them now. */
export type ApplicationLogPolicy = {
  saving: ApplicationLogSettings;
  detail: LogDetail;
};

/**
 * Reads the file rather than asking the backend: the desktop needs these before
 * its backend exists, and they may predate the backend's one-time upgrade, which
 * `resolveLogDetail` applies the same way here.
 */
export function readApplicationLogPolicy(dataDir: string): ApplicationLogPolicy {
  return (
    readStoredApplicationLogPolicy(dataDir) ?? {
      saving: {
        enabled: false,
        retentionDays: normalizeDebugLogRetentionDays(undefined),
      },
      detail: defaultLogDetail(),
    }
  );
}

/**
 * The same read, null when the file cannot be read or parsed. A process already
 * running keeps what it has on null: an unreadable file is no reason to turn off
 * saving, or the detail, that someone turned on to catch a problem.
 */
export function readStoredApplicationLogPolicy(dataDir: string): ApplicationLogPolicy | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as unknown;
    const global = isRecord(parsed) && isRecord(parsed.global) ? parsed.global : {};
    return {
      saving: {
        enabled: global.debugLogging === true,
        retentionDays: normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
      },
      detail: resolveLogDetail(global),
    };
  } catch {
    return null;
  }
}

export function readApplicationLogSettings(dataDir: string): ApplicationLogSettings {
  return readApplicationLogPolicy(dataDir).saving;
}

/**
 * Directory removal codes that mean "nothing left to do here". `ERR_FS_EISDIR`
 * is Node's answer to `rm` without `recursive`, and `ENOTEMPTY`/`EEXIST` mean a
 * concurrent writer refilled the directory between the read and the removal.
 */
const BENIGN_RMDIR_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "ERR_FS_EISDIR"]);

/** The essential log has its own byte cap and is outside retention and the budget. */
function isEssentialLogDirectory(entry: { name: string; isDirectory(): boolean }): boolean {
  return entry.name === ESSENTIAL_LOG_DIRECTORY_NAME && entry.isDirectory();
}

async function removeIfEmpty(directory: string): Promise<void> {
  const children = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (children.length > 0) return;
  // `rmdir`, not `rm`: `rm` without `recursive` rejects a directory outright
  // with ERR_FS_EISDIR, which used to abort the whole sweep.
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (!BENIGN_RMDIR_CODES.has(error.code ?? "")) throw error;
  });
}

async function removeExpiredEntries(
  directory: string,
  cutoff: number,
  root: string,
  failures: unknown[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      failures.push(error);
      return [];
    },
  );
  for (const entry of entries) {
    if (directory === root && isEssentialLogDirectory(entry)) continue;
    const entryPath = path.join(directory, entry.name);
    // Each entry is isolated: one unreadable file or locked directory must not
    // stop the sweep, or a single bad entry silently disables retention for
    // everything after it.
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await removeExpiredEntries(entryPath, cutoff, root, failures);
        if (entryPath !== root) await removeIfEmpty(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata && metadata.mtimeMs < cutoff) await rm(entryPath, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
}

type LogFileRecord = { path: string; size: number; mtimeMs: number };

async function collectLogFiles(
  directory: string,
  root: string,
  collected: LogFileRecord[],
  failures: unknown[],
): Promise<void> {
  // The list is a buffer in the main process, so it is bounded by count as
  // well as by the byte budget it feeds. Stopping short still evicts real
  // files, and the shortfall is reported rather than passed off as a clean
  // sweep.
  if (collected.length >= MAX_LOG_BUDGET_FILES) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      failures.push(error);
      return [];
    },
  );
  for (const entry of entries) {
    if (collected.length >= MAX_LOG_BUDGET_FILES) {
      failures.push(
        new Error(
          `Log directory holds more than ${MAX_LOG_BUDGET_FILES} files; trimmed only the oldest of those inspected`,
        ),
      );
      return;
    }
    if (directory === root && isEssentialLogDirectory(entry)) continue;
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await collectLogFiles(entryPath, root, collected, failures);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata)
        collected.push({ path: entryPath, size: metadata.size, mtimeMs: metadata.mtimeMs });
    } catch (error) {
      failures.push(error);
    }
  }
}

/**
 * Drops oldest-first until the directory fits `maxDirectoryBytes`. The age
 * sweep alone cannot bound disk use: the shortest retention the UI offers is a
 * full day, and a day's output has no natural ceiling.
 */
async function enforceDirectoryBudget(
  logDirectory: string,
  maxDirectoryBytes: number,
  failures: unknown[],
): Promise<void> {
  if (!Number.isFinite(maxDirectoryBytes) || maxDirectoryBytes <= 0) return;
  const files: LogFileRecord[] = [];
  await collectLogFiles(logDirectory, logDirectory, files, failures);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxDirectoryBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const file of files) {
    if (total <= maxDirectoryBytes) break;
    try {
      await rm(file.path, { force: true });
      total -= file.size;
    } catch (error) {
      failures.push(error);
    }
  }
}

/**
 * Removes logs older than `retentionDays`, then trims the directory to
 * `maxDirectoryBytes`, leaving `essential/` alone. Individual failures are collected rather than thrown
 * mid-traversal, so one bad entry cannot skip the rest; the aggregate is thrown
 * at the end so a genuine problem still surfaces.
 */
export async function pruneExpiredApplicationLogs(
  logDirectory: string,
  retentionDays: number,
  now = Date.now(),
  bounds: Partial<ApplicationLogBounds> = {},
): Promise<void> {
  const normalizedDays = normalizeDebugLogRetentionDays(retentionDays);
  const maxDirectoryBytes =
    bounds.maxDirectoryBytes ?? DEFAULT_APPLICATION_LOG_BOUNDS.maxDirectoryBytes;
  const failures: unknown[] = [];
  await removeExpiredEntries(
    logDirectory,
    now - normalizedDays * 24 * 60 * 60 * 1000,
    logDirectory,
    failures,
  );
  await enforceDirectoryBudget(logDirectory, maxDirectoryBytes, failures);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to prune ${failures.length} log entr${failures.length === 1 ? "y" : "ies"}`,
    );
  }
}

function dailyLogBase(logDirectory: string, filePrefix: string, now: Date): string {
  return path.join(logDirectory, `${filePrefix}${now.toISOString().slice(0, 10)}`);
}

function logPathFor(base: string, index: number, format: LogFormat): string {
  const extension = format === "json" ? "jsonl" : "log";
  return index === 0 ? `${base}.${extension}` : `${base}.${index}.${extension}`;
}

async function fileSize(target: string): Promise<number | null> {
  const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata ? metadata.size : null;
}

/**
 * One JSON line for the file. A logger's record is already one; any other
 * console call (a vendor's own printing, relayed process output) is wrapped without
 * an area or event, so every line of the file still parses.
 */
function jsonEntry(
  timestamp: string,
  level: string,
  args: unknown[],
  formatted: string,
  maxEntryBytes: number,
): Buffer {
  const only = args.length === 1 && typeof args[0] === "string" ? args[0] : null;
  const wrap = (message: string, truncated: boolean) =>
    Buffer.from(
      `${LOG_RECORD_PREFIX}${escapeLogLine(JSON.stringify({ ts: timestamp, level, message, ...(truncated ? { truncated } : {}) })).slice(1)}\n`,
    );
  const whole =
    only !== null && parseLogRecordLine(only)
      ? Buffer.from(`${escapeLogLine(only)}\n`)
      : wrap(formatted, false);
  if (whole.byteLength <= maxEntryBytes) return whole;
  // Cutting the bytes would leave a line that does not parse. The eighth allows
  // for JSON escapes; the marker says the entry is incomplete.
  return wrap(formatted.slice(0, Math.floor(maxEntryBytes / 8)), true);
}

function boundedEntry(value: string, maxEntryBytes: number): Buffer {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxEntryBytes) return encoded;
  const suffix = Buffer.from("\n[log entry truncated]\n");
  const keep = Math.max(0, maxEntryBytes - suffix.byteLength);
  return Buffer.concat([encoded.subarray(0, keep), suffix]);
}

type QueuedLogEntry = { payload: Buffer; format: LogFormat };

function queuedBytes(entries: QueuedLogEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.payload.byteLength, 0);
}

/** Removes and returns the next entries that fit `maxBytes`, always at least one. */
function takeBatch(entries: QueuedLogEntry[], maxBytes: number): QueuedLogEntry[] {
  let count = 1;
  let bytes = entries[0]!.payload.byteLength;
  while (count < entries.length) {
    bytes += entries[count]!.payload.byteLength;
    if (bytes > maxBytes) break;
    count += 1;
  }
  return entries.splice(0, count);
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function installProductionApplicationLogging(options: {
  dataDir: string;
  /** Daily file name prefix; defaults to the desktop app's own log. */
  filePrefix?: string;
  now?: () => Date;
  cleanupIntervalMs?: number;
  bounds?: Partial<ApplicationLogBounds>;
  files?: ApplicationLogFileOperations;
}): InstalledApplicationLogging {
  let settings = readApplicationLogSettings(options.dataDir);

  const logDirectory = path.join(options.dataDir, "logs");
  const filePrefix = options.filePrefix ?? DESKTOP_LOG_FILE_PREFIX;
  const now = options.now ?? (() => new Date());
  const bounds: ApplicationLogBounds = { ...DEFAULT_APPLICATION_LOG_BOUNDS, ...options.bounds };
  const files: ApplicationLogFileOperations = options.files ?? { mkdir, appendFile };
  const originalMethods = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  let pending = Promise.resolve();
  const queue: QueuedLogEntry[] = [];
  let batchScheduled = false;
  let directoryReady = false;
  let pendingBytes = 0;
  let pendingEntries = 0;
  let stopped = false;
  let droppedEntries = 0;
  let droppedBytes = 0;
  // At most one daily target per format; keep reservations across format switches.
  const activeTargets = new Map<
    LogFormat,
    { base: string; format: LogFormat; index: number; bytes: number }
  >();

  const reportWriteFailure = (error: unknown, lost: QueuedLogEntry[]) => {
    // Runs inside the write chain, which nothing else can restart if it rejects.
    try {
      originalMethods.error.call(
        console,
        renderLogLine("error", "logging", "write.failed", {
          error: formatLogError(error),
          entries: lost.length,
          bytes: queuedBytes(lost),
        }),
      );
    } catch {
      // Nowhere left to report it.
    }
  };

  /**
   * Resolves the file this entry belongs in, rolling to the next index when the
   * active one would pass `maxFileBytes`. Runs inside the serialized write
   * chain, so target reservations are never read concurrently.
   */
  const resolveTarget = async (entryBytes: number, format: LogFormat): Promise<string> => {
    const base = dailyLogBase(logDirectory, filePrefix, now());
    let active = activeTargets.get(format);
    if (!active || active.base !== base) {
      let index = 0;
      let bytes = (await fileSize(logPathFor(base, 0, format))) ?? 0;
      while (index < MAX_LOG_FILE_INDEX) {
        const next = await fileSize(logPathFor(base, index + 1, format));
        if (next === null) break;
        index += 1;
        bytes = next;
      }
      active = { base, format, index, bytes };
    }
    // `bytes > 0` keeps a single oversized entry writable instead of rolling
    // forever through empty files.
    if (active.bytes > 0 && active.bytes + entryBytes > bounds.maxFileBytes) {
      active = {
        base: active.base,
        format: active.format,
        index: Math.min(active.index + 1, MAX_LOG_FILE_INDEX),
        bytes: 0,
      };
    }
    active.bytes += entryBytes;
    activeTargets.set(format, active);
    return logPathFor(active.base, active.index, active.format);
  };

  const dropMarker = (timestamp: string): Buffer | null => {
    if (droppedEntries === 0) return null;
    const line = renderLogLine("warn", "logging", "entries.dropped", {
      entries: droppedEntries,
      bytes: droppedBytes,
      reason: "queue-full",
    });
    return Buffer.from(getLogFormat() === "json" ? `${line}\n` : `${timestamp} WARN ${line}\n`);
  };

  const ensureLogDirectory = async () => {
    if (directoryReady) return;
    await files.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    directoryReady = true;
  };

  /** One run per target file, so a batch splits only where `resolveTarget` rolls. */
  const groupByTarget = async (entries: QueuedLogEntry[]) => {
    const runs: Array<{ target: string; payloads: Buffer[] }> = [];
    for (const { payload, format } of entries) {
      const target = await resolveTarget(payload.byteLength, format);
      const last = runs.at(-1);
      if (last?.target === target) last.payloads.push(payload);
      else runs.push({ target, payloads: [payload] });
    }
    return runs;
  };

  /**
   * Appends a batch and never rejects. `ENOENT` means the log folder went away
   * while running, so the unwritten entries get one retry through a fresh
   * `mkdir`. Anything else loses them: holding on would only trade them for
   * newer lines at the queue bound. The next batch then starts from `mkdir`.
   */
  const writeBatch = async (entries: QueuedLogEntry[]) => {
    let written = 0;
    let recovered = false;
    try {
      await ensureLogDirectory();
      while (written < entries.length) {
        try {
          for (const run of await groupByTarget(entries.slice(written))) {
            await files.appendFile(run.target, Buffer.concat(run.payloads), { mode: 0o600 });
            written += run.payloads.length;
          }
        } catch (error) {
          // The failed write may have taken the sizes the targets counted with it.
          activeTargets.clear();
          directoryReady = false;
          if (recovered || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          recovered = true;
          await ensureLogDirectory();
        }
      }
    } catch (error) {
      reportWriteFailure(error, entries.slice(written));
    }
  };

  /**
   * Each link of the chain writes everything queued when it starts, in pieces no
   * larger than `maxBatchBytes`, so entries logged while an append is in flight
   * share the next link. `pending` is therefore always the link that will take
   * the newest entry, which is what `flush` and `stop` rely on.
   */
  const writeQueued = async () => {
    batchScheduled = false;
    const entries = queue.splice(0);
    while (entries.length > 0) {
      const batch = takeBatch(entries, bounds.maxBatchBytes);
      await writeBatch(batch);
      pendingBytes -= queuedBytes(batch);
      pendingEntries -= batch.length;
    }
  };

  // The next event-loop turn, not a timer, so a lone line waits for nothing but
  // an append already in flight. A blocked main thread delays it regardless
  // (to-do 0880), and a longer delay would only widen that window.
  const scheduleBatch = () => {
    if (batchScheduled) return;
    batchScheduled = true;
    pending = pending.then(nextEventLoopTurn).then(writeQueued);
  };

  const write = (payload: Buffer, format: LogFormat) => {
    pendingBytes += payload.byteLength;
    pendingEntries += 1;
    queue.push({ payload, format });
    scheduleBatch();
  };

  const enqueue = (level: string, args: unknown[]) => {
    // Off costs one comparison per console call: no formatting, no queue.
    if (stopped || !settings.enabled) return;
    const format = getLogFormat();
    const timestamp = now().toISOString();
    const formatted = formatWithOptions(
      { colors: false, depth: 5, maxArrayLength: 100, maxStringLength: 10_000 },
      ...args,
    );
    const entry =
      format === "json"
        ? jsonEntry(timestamp, level, args, formatted, bounds.maxEntryBytes)
        : boundedEntry(`${timestamp} ${level.toUpperCase()} ${formatted}\n`, bounds.maxEntryBytes);
    const marker = dropMarker(timestamp);
    const payload = marker ? Buffer.concat([marker, entry]) : entry;
    if (
      pendingBytes + payload.byteLength > bounds.maxPendingBytes ||
      pendingEntries >= bounds.maxPendingEntries
    ) {
      // A dropped entry leaves a hole, so record it; the next entry that fits
      // announces the gap rather than letting the log read as continuous.
      droppedEntries += 1;
      droppedBytes += entry.byteLength;
      return;
    }
    if (marker) {
      droppedEntries = 0;
      droppedBytes = 0;
    }
    write(payload, format);
  };

  for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
    console[level] = (...args: unknown[]) => {
      originalMethods[level].apply(console, args);
      enqueue(level, args);
    };
  }

  // A sweep follows saving: files already on disk stay while it is off, as they
  // always have, and the Debug settings' clean-up button stays the way to remove them.
  const prune = async () => {
    if (!settings.enabled) return;
    await pruneExpiredApplicationLogs(
      logDirectory,
      settings.retentionDays,
      Date.now(),
      bounds,
    ).catch((error) => {
      originalMethods.error.call(
        console,
        renderLogLine("error", "logging", "prune.failed", { error: formatLogError(error) }),
      );
    });
  };
  const logs = createLogger("logging");
  const announceStart = () => {
    logs.info("capture.started", {
      directory: logDirectory,
      retentionDays: settings.retentionDays,
    });
  };
  // A drop in the final window would otherwise never be announced.
  const flushDropMarker = () => {
    const marker = dropMarker(now().toISOString());
    if (!marker) return;
    droppedEntries = 0;
    droppedBytes = 0;
    write(marker, getLogFormat());
  };
  void prune();
  const cleanupTimer = setInterval(prune, options.cleanupIntervalMs ?? LOG_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  if (settings.enabled) announceStart();

  return {
    logDirectory,
    settings: () => ({ ...settings }),
    updateSettings(next) {
      if (stopped) return;
      const previous = settings;
      const normalized: ApplicationLogSettings = {
        enabled: next.enabled === true,
        retentionDays: normalizeDebugLogRetentionDays(next.retentionDays),
      };
      if (previous.enabled && !normalized.enabled) {
        logs.info("capture.stopped", { directory: logDirectory });
        flushDropMarker();
      }
      settings = normalized;
      if (!previous.enabled && normalized.enabled) announceStart();
      if (
        normalized.enabled &&
        (!previous.enabled || previous.retentionDays !== normalized.retentionDays)
      ) {
        void prune();
      }
    },
    flush: () => pending,
    dropStats: () => ({ droppedEntries, droppedBytes }),
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(cleanupTimer);
        for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
          console[level] = originalMethods[level];
        }
        flushDropMarker();
      }
      await pending;
    },
  };
}

/** The subset of Electron's `App` this module needs, so it can be faked. */
export type ApplicationLoggingQuitHost = {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
};

/**
 * Holds the quit open until buffered entries reach disk. `will-quit` proceeds
 * as soon as a synchronous listener returns, so without `preventDefault` the
 * flush races the process exit and loses exactly the entries a user enabled
 * logging to capture. The wait is bounded so a stalled filesystem cannot make
 * the app unquittable.
 *
 * The follow-up quit must run on a later macrotask. Electron drains microtasks
 * before `will-quit` dispatch returns, while it still considers itself
 * quitting, and only afterwards applies the `preventDefault` by clearing that
 * flag. When the log queue is already idle, `stop()` settles inside that drain;
 * a quit issued there is ignored as a duplicate, and the process then lingers
 * windowless with its backend stopped. macOS "Quit & Reopen" after a privacy
 * grant waits on that exit and never reopens the app.
 */
export function registerApplicationLoggingShutdown(
  app: ApplicationLoggingQuitHost,
  logging: InstalledApplicationLogging | null,
  timeoutMs = LOG_SHUTDOWN_FLUSH_MS,
  /**
   * Output that must reach the log first, bounded by its own timeout: the
   * desktop's backend logs its drain through this process, and holds run in
   * parallel, so closing the log at once dropped exactly how the quit ended.
   */
  pending?: { settled: () => Promise<unknown>; timeoutMs: number },
): void {
  if (!logging) return;
  registerWillQuitHold(
    app,
    async () => {
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          pending.settled().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, pending.timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      await logging.stop();
    },
    timeoutMs + (pending?.timeoutMs ?? 0),
  );
}

/**
 * Holds `will-quit` open until `settle` finishes or `timeoutMs` passes, then
 * re-issues the quit on a later macrotask (see above for why it must be later).
 *
 * Several holds may be registered. One that releases first re-issues the quit
 * while another is still settling, so a hold keeps preventing every `will-quit`
 * until it has released itself; only then does it fall through.
 */
export function registerWillQuitHold(
  app: ApplicationLoggingQuitHost,
  settle: () => Promise<unknown>,
  timeoutMs: number,
): void {
  let state: "idle" | "holding" | "released" = "idle";
  app.on("will-quit", (event) => {
    if (state === "released") return;
    event.preventDefault();
    if (state === "holding") return;
    state = "holding";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    void Promise.race([settle().catch(() => {}), deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      state = "released";
      setTimeout(() => app.quit(), 0);
    });
  });
}
