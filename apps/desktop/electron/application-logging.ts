import { appendFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatWithOptions } from "node:util";

import { normalizeDebugLogRetentionDays } from "@orkestrator/protocol/debug-logging";

const LOG_FILE_PREFIX = "orkestrator-ai-";
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOG_SHUTDOWN_FLUSH_MS = 2_000;
const MAX_PENDING_LOG_BYTES = 4 * 1024 * 1024;
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
  /** Per-entry ceiling. A longer entry is truncated with an explicit marker. */
  maxEntryBytes: number;
  /** Per-file ceiling. Exceeding it rolls to the next numbered file. */
  maxFileBytes: number;
  /** Whole-directory ceiling, enforced oldest-first after the age sweep. */
  maxDirectoryBytes: number;
};

export const DEFAULT_APPLICATION_LOG_BOUNDS: ApplicationLogBounds = {
  maxPendingBytes: MAX_PENDING_LOG_BYTES,
  maxEntryBytes: MAX_LOG_ENTRY_BYTES,
  maxFileBytes: MAX_LOG_FILE_BYTES,
  maxDirectoryBytes: MAX_LOG_DIRECTORY_BYTES,
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
  retentionDays: number;
  flush(): Promise<void>;
  stop(): Promise<void>;
  /** Unreported drops. Non-zero means the log has an unmarked gap in flight. */
  dropStats(): ApplicationLogDropStats;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readApplicationLogSettings(dataDir: string): ApplicationLogSettings {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as unknown;
    const global = isRecord(parsed) && isRecord(parsed.global) ? parsed.global : {};
    return {
      enabled: global.debugLogging === true,
      retentionDays: normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
    };
  } catch {
    return {
      enabled: false,
      retentionDays: normalizeDebugLogRetentionDays(undefined),
    };
  }
}

/**
 * Directory removal codes that mean "nothing left to do here". `ERR_FS_EISDIR`
 * is Node's answer to `rm` without `recursive`, and `ENOTEMPTY`/`EEXIST` mean a
 * concurrent writer refilled the directory between the read and the removal.
 */
const BENIGN_RMDIR_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "ERR_FS_EISDIR"]);

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
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await collectLogFiles(entryPath, collected, failures);
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
  await collectLogFiles(logDirectory, files, failures);
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
 * `maxDirectoryBytes`. Individual failures are collected rather than thrown
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

function dailyLogBase(logDirectory: string, now: Date): string {
  return path.join(logDirectory, `${LOG_FILE_PREFIX}${now.toISOString().slice(0, 10)}`);
}

function logPathFor(base: string, index: number): string {
  return index === 0 ? `${base}.log` : `${base}.${index}.log`;
}

async function fileSize(target: string): Promise<number | null> {
  const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata ? metadata.size : null;
}

function boundedEntry(value: string, maxEntryBytes: number): Buffer {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxEntryBytes) return encoded;
  const suffix = Buffer.from("\n[log entry truncated]\n");
  const keep = Math.max(0, maxEntryBytes - suffix.byteLength);
  return Buffer.concat([encoded.subarray(0, keep), suffix]);
}

export function installProductionApplicationLogging(options: {
  dataDir: string;
  now?: () => Date;
  cleanupIntervalMs?: number;
  bounds?: Partial<ApplicationLogBounds>;
}): InstalledApplicationLogging | null {
  const settings = readApplicationLogSettings(options.dataDir);
  if (!settings.enabled) return null;

  const logDirectory = path.join(options.dataDir, "logs");
  const now = options.now ?? (() => new Date());
  const bounds: ApplicationLogBounds = { ...DEFAULT_APPLICATION_LOG_BOUNDS, ...options.bounds };
  const originalMethods = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  let pending = Promise.resolve();
  let pendingBytes = 0;
  let stopped = false;
  let droppedEntries = 0;
  let droppedBytes = 0;
  let active: { base: string; index: number; bytes: number } | null = null;

  const reportWriteFailure = (error: unknown) => {
    originalMethods.error.call(console, "[ApplicationLogging] Failed to write log:", error);
  };

  /**
   * Resolves the file this entry belongs in, rolling to the next index when the
   * active one would pass `maxFileBytes`. Runs inside the serialized write
   * chain, so `active` is never read concurrently.
   */
  const resolveTarget = async (entryBytes: number): Promise<string> => {
    const base = dailyLogBase(logDirectory, now());
    if (!active || active.base !== base) {
      let index = 0;
      let bytes = (await fileSize(logPathFor(base, 0))) ?? 0;
      while (index < MAX_LOG_FILE_INDEX) {
        const next = await fileSize(logPathFor(base, index + 1));
        if (next === null) break;
        index += 1;
        bytes = next;
      }
      active = { base, index, bytes };
    }
    // `bytes > 0` keeps a single oversized entry writable instead of rolling
    // forever through empty files.
    if (active.bytes > 0 && active.bytes + entryBytes > bounds.maxFileBytes) {
      active = {
        base: active.base,
        index: Math.min(active.index + 1, MAX_LOG_FILE_INDEX),
        bytes: 0,
      };
    }
    active.bytes += entryBytes;
    return logPathFor(active.base, active.index);
  };

  const dropMarker = (timestamp: string): Buffer | null => {
    if (droppedEntries === 0) return null;
    const plural = droppedEntries === 1 ? "entry" : "entries";
    return Buffer.from(
      `${timestamp} WARN [ApplicationLogging] ${droppedEntries} ${plural} (${droppedBytes} bytes) dropped: log queue full\n`,
    );
  };

  const write = (payload: Buffer) => {
    pendingBytes += payload.byteLength;
    pending = pending
      .then(async () => {
        await mkdir(logDirectory, { recursive: true, mode: 0o700 });
        await appendFile(await resolveTarget(payload.byteLength), payload, { mode: 0o600 });
      })
      .catch(reportWriteFailure)
      .finally(() => {
        pendingBytes -= payload.byteLength;
      });
  };

  const enqueue = (level: string, args: unknown[]) => {
    if (stopped) return;
    const timestamp = now().toISOString();
    const formatted = formatWithOptions(
      { colors: false, depth: 5, maxArrayLength: 100, maxStringLength: 10_000 },
      ...args,
    );
    const entry = boundedEntry(
      `${timestamp} ${level.toUpperCase()} ${formatted}\n`,
      bounds.maxEntryBytes,
    );
    const marker = dropMarker(timestamp);
    const payload = marker ? Buffer.concat([marker, entry]) : entry;
    if (pendingBytes + payload.byteLength > bounds.maxPendingBytes) {
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
    write(payload);
  };

  for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
    console[level] = (...args: unknown[]) => {
      originalMethods[level].apply(console, args);
      enqueue(level, args);
    };
  }

  const prune = () =>
    pruneExpiredApplicationLogs(logDirectory, settings.retentionDays, Date.now(), bounds).catch(
      (error) => {
        originalMethods.error.call(console, "[ApplicationLogging] Failed to prune logs:", error);
      },
    );
  void prune();
  const cleanupTimer = setInterval(prune, options.cleanupIntervalMs ?? LOG_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  console.info(
    `[ApplicationLogging] Saving logs to ${logDirectory}; retaining ${settings.retentionDays} day(s).`,
  );

  return {
    logDirectory,
    retentionDays: settings.retentionDays,
    flush: () => pending,
    dropStats: () => ({ droppedEntries, droppedBytes }),
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(cleanupTimer);
        for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
          console[level] = originalMethods[level];
        }
        // A drop in the final window would otherwise never be announced.
        const marker = dropMarker(now().toISOString());
        if (marker) {
          droppedEntries = 0;
          droppedBytes = 0;
          write(marker);
        }
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
 */
export function registerApplicationLoggingShutdown(
  app: ApplicationLoggingQuitHost,
  logging: InstalledApplicationLogging | null,
  timeoutMs = LOG_SHUTDOWN_FLUSH_MS,
): void {
  if (!logging) return;
  let shuttingDown = false;
  app.on("will-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    void Promise.race([logging.stop().catch(() => {}), deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      app.quit();
    });
  });
}
