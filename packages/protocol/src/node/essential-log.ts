import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { projectEssentialRecord } from "../log-essential.js";
import {
  configureLogger,
  createLogger,
  escapeLogLine,
  formatLogError,
  type LogRecord,
  type LogWireValue,
} from "../logger.js";

/**
 * The always-on essential log: a small rotating file of content-free events,
 * written whatever "Save Logs to Disk" says, so the first occurrence of a crash
 * or a silent fallback is already on disk. A file rather than a table, because it
 * has to work when the database is the failing part. One process owns it: the
 * desktop in the app and the backend when standalone. Everything else relays.
 * docs/architecture/logging.md, "The essential event log", is the guide.
 *
 * Writing never blocks or throws into a caller. An entry joins a bounded queue
 * that one async loop drains; only an exit, with no event loop left to drain it,
 * writes synchronously.
 */

/** The directory under `logs/`. The retention sweep and **Clean up logs** skip it. */
export const ESSENTIAL_LOG_DIRECTORY_NAME = "essential";

/** Every bound is injectable because each only misbehaves at its edge. */
export type EssentialLogBounds = {
  /** Per-file ceiling. A write that would pass it rotates first. */
  maxFileBytes: number;
  /** Rotated files kept beside the active one. Their total is the hard cap. */
  rotatedFiles: number;
  /** A larger entry loses its fields. */
  maxEntryBytes: number;
  /** In-memory queue ceiling. Entries past it are counted and reported. */
  maxPendingBytes: number;
  /** Entries one event may write at once before it is limited. */
  eventBurst: number;
  /** A limited event regains one entry per this long. */
  eventRefillMs: number;
};

/** 4 files of 1 MiB: 4 MiB in total. */
export const DEFAULT_ESSENTIAL_LOG_BOUNDS: EssentialLogBounds = {
  maxFileBytes: 1024 * 1024,
  rotatedFiles: 3,
  maxEntryBytes: 4 * 1024,
  maxPendingBytes: 256 * 1024,
  eventBurst: 10,
  eventRefillMs: 10 * 60 * 1000,
};

/** More than any process logs; a bound so a stream of imitations cannot grow the map. */
const MAX_LIMITED_EVENTS = 1024;

export type EssentialLogOwner = "desktop" | "backend";

/** Replaces the async calls in a test, to hold a write open. */
export type EssentialLogIo = {
  appendFile: typeof appendFile;
  rename: typeof rename;
  stat: typeof stat;
  mkdir: typeof mkdir;
};

export type InstalledEssentialLog = {
  directory: string;
  /** Resolves once everything queued so far has been written or counted as lost. */
  flush(): Promise<void>;
  /** Writes `essential.stopped` and detaches from the logger. */
  stop(): Promise<void>;
};

type DropReason = "queue-full" | "write-failed" | "rate-limited";
type DropCount = { entries: number; bytes: number };
type EventAllowance = { tokens: number; updatedAt: number; suppressed: number };

function missingIsFine(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export function installEssentialLog(options: {
  dataDir: string;
  owner: EssentialLogOwner;
  now?: () => Date;
  bounds?: Partial<EssentialLogBounds>;
  io?: Partial<EssentialLogIo>;
}): InstalledEssentialLog {
  const directory = path.join(options.dataDir, "logs", ESSENTIAL_LOG_DIRECTORY_NAME);
  const bounds: EssentialLogBounds = { ...DEFAULT_ESSENTIAL_LOG_BOUNDS, ...options.bounds };
  const now = options.now ?? (() => new Date());
  const io: EssentialLogIo = { appendFile, rename, stat, mkdir, ...options.io };
  const fileAt = (index: number) =>
    path.join(directory, index === 0 ? "essential.jsonl" : `essential.${index}.jsonl`);
  const logs = createLogger("logging");

  const queue: Buffer[] = [];
  const drops = new Map<DropReason, DropCount>();
  const allowances = new Map<string, EventAllowance>();
  let pendingBytes = 0;
  let draining: Promise<void> | null = null;
  let stopped = false;

  const countDrop = (reason: DropReason, entries: number, bytes: number) => {
    const count = drops.get(reason) ?? { entries: 0, bytes: 0 };
    count.entries += entries;
    count.bytes += bytes;
    drops.set(reason, count);
  };

  const serialize = (record: LogRecord): Buffer => {
    const line = Buffer.from(`${escapeLogLine(JSON.stringify(record))}\n`);
    if (line.byteLength <= bounds.maxEntryBytes) return line;
    const { fields: _fields, ...bare } = record;
    return Buffer.from(`${escapeLogLine(JSON.stringify(bare))}\n`);
  };

  /** A marker for each kind of loss since the last one that reached the file. */
  const takeDropMarkers = (): { payload: Buffer[]; restore: () => void } => {
    const taken = Array.from(drops);
    drops.clear();
    return {
      payload: taken.map(([reason, { entries, bytes }]) =>
        serialize({
          orklog: 1,
          ts: now().toISOString(),
          level: "warn",
          area: "logging",
          event: "entries.dropped",
          fields: { entries, bytes, reason },
        }),
      ),
      restore: () => {
        for (const [reason, { entries, bytes }] of taken) countDrop(reason, entries, bytes);
      },
    };
  };

  /** Counts for events that went quiet while limited, so no count outlives the process. */
  const collectUnreportedSuppressions = () => {
    let entries = 0;
    for (const allowance of allowances.values()) {
      entries += allowance.suppressed;
      allowance.suppressed = 0;
    }
    if (entries > 0) countDrop("rate-limited", entries, 0);
  };

  const writeAsync = async (payload: Buffer) => {
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await io.stat(fileAt(0)).catch((error: unknown) => missingIsFine(error));
    if (metadata && metadata.size > 0 && metadata.size + payload.byteLength > bounds.maxFileBytes) {
      for (let index = bounds.rotatedFiles; index >= 1; index -= 1) {
        await io.rename(fileAt(index - 1), fileAt(index)).catch(missingIsFine);
      }
    }
    await io.appendFile(fileAt(0), payload, { mode: 0o600 });
  };

  const writeSync = (payload: Buffer) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(fileAt(0)).size;
    } catch (error) {
      missingIsFine(error);
    }
    if (size > 0 && size + payload.byteLength > bounds.maxFileBytes) {
      for (let index = bounds.rotatedFiles; index >= 1; index -= 1) {
        try {
          renameSync(fileAt(index - 1), fileAt(index));
        } catch (error) {
          missingIsFine(error);
        }
      }
    }
    appendFileSync(fileAt(0), payload, { mode: 0o600 });
  };

  // `warn` and in `logging`, which `isEssentialEntry` refuses, so reporting a
  // failed write can never queue another write.
  const reportWriteFailure = (error: unknown) => {
    logs.throttled("warn", "essential.write-failed", {
      error,
      fields: () => ({ error: formatLogError(error, { message: false, stack: false }) }),
    });
  };

  const drain = async () => {
    while (queue.length > 0) {
      const entry = queue[0]!;
      const markers = takeDropMarkers();
      try {
        await writeAsync(Buffer.concat([...markers.payload, entry]));
        logs.recovered("essential.write-failed");
      } catch (error) {
        markers.restore();
        countDrop("write-failed", 1, entry.byteLength);
        reportWriteFailure(error);
      }
      queue.shift();
      pendingBytes -= entry.byteLength;
    }
  };

  const startDrain = () => {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
    });
  };

  const enqueue = (entry: Buffer) => {
    if (pendingBytes + entry.byteLength > bounds.maxPendingBytes) {
      countDrop("queue-full", 1, entry.byteLength);
      return;
    }
    queue.push(entry);
    pendingBytes += entry.byteLength;
    startDrain();
  };

  /** A token bucket per event, so a fault that repeats cannot evict everything else. */
  const admitEvent = (record: LogRecord, at: number): EventAllowance | null => {
    const key = `${record.area}\0${record.event}`;
    let allowance = allowances.get(key);
    if (!allowance) {
      if (allowances.size >= MAX_LIMITED_EVENTS) {
        allowances.delete(allowances.keys().next().value!);
      }
      allowance = { tokens: bounds.eventBurst, updatedAt: at, suppressed: 0 };
      allowances.set(key, allowance);
    }
    const earned = Math.max(0, at - allowance.updatedAt) / bounds.eventRefillMs;
    allowance.tokens = Math.min(bounds.eventBurst, allowance.tokens + earned);
    allowance.updatedAt = at;
    if (allowance.tokens < 1) {
      allowance.suppressed += 1;
      return null;
    }
    allowance.tokens -= 1;
    return allowance;
  };

  const accept = (record: LogRecord) => {
    if (stopped) return;
    const moment = now();
    const projected = projectEssentialRecord(record, moment.toISOString());
    if (!projected) return;
    const allowance = admitEvent(projected, moment.getTime());
    if (!allowance) return;
    let fields: Readonly<Record<string, LogWireValue>> | undefined = projected.fields;
    if (allowance.suppressed > 0) {
      fields = { ...fields, suppressed: allowance.suppressed };
      allowance.suppressed = 0;
    }
    enqueue(serialize({ ...projected, ...(fields ? { fields } : {}) }));
  };

  const writeLifecycle = (event: "essential.started" | "essential.stopped") => {
    accept({
      orklog: 1,
      ts: now().toISOString(),
      level: "info",
      area: "logging",
      event,
      fields: { owner: options.owner },
    });
  };

  /**
   * What an exit would otherwise lose, the crash that caused it above all. The
   * process is going, so this cannot stall anything, and a failure has nowhere
   * left to be reported.
   */
  const drainOnExit = () => {
    collectUnreportedSuppressions();
    const markers = takeDropMarkers();
    const entries = queue.splice(0);
    pendingBytes = 0;
    try {
      if (markers.payload.length > 0 || entries.length > 0) {
        writeSync(Buffer.concat([...markers.payload, ...entries]));
      }
    } catch {
      // Nothing can be done about it now.
    }
  };

  configureLogger({ essentialSink: accept });
  process.on("exit", drainOnExit);
  writeLifecycle("essential.started");

  const flush = async () => {
    while (draining) await draining;
  };

  return {
    directory,
    flush,
    async stop() {
      if (stopped) return flush();
      writeLifecycle("essential.stopped");
      stopped = true;
      configureLogger({ essentialSink: null });
      process.off("exit", drainOnExit);
      await flush();
      collectUnreportedSuppressions();
      const markers = takeDropMarkers();
      if (markers.payload.length > 0) {
        await writeAsync(Buffer.concat(markers.payload)).catch(() => undefined);
      }
    },
  };
}
