import { appendFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createEssentialLogLock } from "./essential-log-lock.js";
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
 * A caller only enqueues. One deferred loop drains the bounded queue, waiting
 * asynchronously for the cross-process lock. Each small filesystem transaction
 * is synchronous so process exit cannot interrupt our own rotation and race its
 * exit drain. The exit drain uses the same lock and per-write size limits.
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

/** Replaces physical operations in tests, including Windows rename semantics. */
export type EssentialLogIo = {
  appendFileSync: typeof appendFileSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
};

export type InstalledEssentialLog = {
  directory: string;
  /** Resolves once everything queued so far has been written or counted as lost. */
  flush(): Promise<void>;
  /** Bounded synchronous drain for immediate app.exit(), which skips will-quit. */
  flushSync(): void;
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
  /** Test barrier before acquiring the file lock; no filesystem write has started. */
  beforeWrite?: () => Promise<void>;
}): InstalledEssentialLog {
  const directory = path.join(options.dataDir, "logs", ESSENTIAL_LOG_DIRECTORY_NAME);
  const bounds: EssentialLogBounds = { ...DEFAULT_ESSENTIAL_LOG_BOUNDS, ...options.bounds };
  const now = options.now ?? (() => new Date());
  const io: EssentialLogIo = { appendFileSync, renameSync, statSync, unlinkSync, ...options.io };
  const tryLock = createEssentialLogLock(directory);
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

  // Called only while holding the cross-process lock; never awaits midway.
  const writeLocked = (payload: Buffer) => {
    if (payload.byteLength > bounds.maxFileBytes)
      throw new Error("Essential log entry exceeds file bound");
    let size = 0;
    try {
      size = io.statSync(fileAt(0)).size;
    } catch (error) {
      missingIsFine(error);
    }
    if (size > 0 && size + payload.byteLength > bounds.maxFileBytes) {
      // Remove the oldest destination first. Every remaining rename now targets
      // an absent path on Windows as well as POSIX.
      try {
        io.unlinkSync(fileAt(bounds.rotatedFiles));
      } catch (error) {
        missingIsFine(error);
      }
      for (let index = bounds.rotatedFiles; index >= 1; index -= 1) {
        try {
          io.renameSync(fileAt(index - 1), fileAt(index));
        } catch (error) {
          missingIsFine(error);
        }
      }
    }
    io.appendFileSync(fileAt(0), payload, { mode: 0o600 });
  };

  const writeAsync = async (payload: Buffer, stillPending = () => true, committed = () => {}) => {
    await options.beforeWrite?.();
    const deadline = Date.now() + 2_000;
    for (;;) {
      if (!stillPending()) return;
      const release = tryLock();
      if (release) {
        try {
          writeLocked(payload);
          committed();
        } finally {
          release();
        }
        return;
      }
      if (Date.now() >= deadline) throw new Error("Essential log writer lock busy");
      await delay(5);
    }
  };

  const writeSync = (payload: Buffer) => {
    const deadline = Date.now() + 100;
    for (;;) {
      const release = tryLock();
      if (release) {
        try {
          writeLocked(payload);
        } finally {
          release();
        }
        return;
      }
      if (Date.now() >= deadline) throw new Error("Essential log writer lock busy at exit");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
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
    // Defer physical work, including synchronous lock acquisition, past the caller.
    await delay(0);
    while (queue.length > 0) {
      const entry = queue[0]!;
      const markers = takeDropMarkers();
      try {
        for (const marker of markers.payload) await writeAsync(marker);
        // An immediate exit flush may have consumed the queue while we waited.
        if (queue[0] !== entry) continue;
        await writeAsync(
          entry,
          () => queue[0] === entry,
          () => {
            queue.shift();
            pendingBytes -= entry.byteLength;
          },
        );
        logs.recovered("essential.write-failed");
      } catch (error) {
        markers.restore();
        countDrop("write-failed", 1, entry.byteLength);
        reportWriteFailure(error);
      }
      if (queue[0] === entry) {
        queue.shift();
        pendingBytes -= entry.byteLength;
      }
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
    const key = `${record.area}\0${record.event}\0${record.level}`;
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
        for (const payload of [...markers.payload, ...entries]) writeSync(payload);
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
    flushSync: drainOnExit,
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
        for (const marker of markers.payload) await writeAsync(marker).catch(() => undefined);
      }
    },
  };
}
