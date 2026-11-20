import type { Database } from "bun:sqlite";

import { createLogger } from "@orkestrator/protocol/logger";

/**
 * Runs the WAL checkpoints of a backend SQLite file on a worker thread.
 *
 * `bun:sqlite` is synchronous, so a checkpoint SQLite runs on the backend's own
 * connection holds the event loop. SQLite starts one itself (the automatic
 * checkpoint) inside whichever commit pushes the WAL past
 * `wal_autocheckpoint` frames: it copies the WAL into the database file and
 * syncs it with a write barrier (`checkpoint_fullfsync`). On a quiet disk that
 * costs a millisecond or two; when other processes are syncing the same disk
 * it took up to seconds, and the commit that happened to cross the threshold
 * was reported as slow (`storage` `operation.slow`). The tell was commits on
 * connections at `synchronous = NORMAL` (leases, the change ledger), which
 * sync nothing on commit, taking 0.3–2.2 s.
 *
 * The worker opens its own connection to the same file and runs a PASSIVE
 * checkpoint every {@link BACKGROUND_CHECKPOINT_INTERVAL_MS}. PASSIVE never
 * waits for a lock and never blocks the backend's readers or writers, so the
 * backend connection only appends to the WAL and the next writer restarts it
 * once the worker has copied it. The backend connection keeps a high
 * `wal_autocheckpoint` ({@link BACKGROUND_CHECKPOINT_FALLBACK_PAGES}) as a
 * bound should the worker fall behind, and goes back to SQLite's default when
 * the worker fails. Checkpointing never changes durability: commits are as
 * synced as before, and a checkpoint is crash-safe wherever it stops.
 *
 * The worker's connection must be closed, never terminated: SQLite keeps the
 * locks of every connection to a file in one per-process table, so a thread
 * killed mid-checkpoint would leave its lock held for the rest of the process.
 */

const log = createLogger("storage");

/** How often the worker checkpoints. A pass with nothing to copy costs it microseconds. */
export const BACKGROUND_CHECKPOINT_INTERVAL_MS = 1_000;

/**
 * The backend connection's `wal_autocheckpoint` while the worker runs: about
 * 40 MB of WAL at 4 KiB pages, reached only if the worker stops keeping up.
 */
export const BACKGROUND_CHECKPOINT_FALLBACK_PAGES = 10_000;

/** `journal_size_limit` of every backend connection: the WAL is cut back to this when reset. */
export const JOURNAL_SIZE_LIMIT_BYTES = 8_388_608;

/** SQLite's default `wal_autocheckpoint`, restored when the worker fails. */
export const DEFAULT_AUTOCHECKPOINT_PAGES = 1_000;

/**
 * Whether the backend's own openers checkpoint in the background. Off under
 * `bun test` (`NODE_ENV=test`), where thousands of short-lived databases would
 * each start a thread; the checkpointer's own tests turn it on explicitly.
 */
export function backgroundCheckpointsByDefault(): boolean {
  return process.env.NODE_ENV !== "test";
}

/** One finished background checkpoint: SQLite's answer and how long it took. */
export interface BackgroundCheckpointResult {
  /** The checkpoint could not run (another checkpointer held the lock). */
  busy: boolean;
  /** WAL frames, and how many of them are now in the database file. */
  log: number;
  checkpointed: number;
  durationMs: number;
}

export interface BackgroundCheckpointerOptions {
  intervalMs?: number;
  /** `journal_size_limit` for the worker's connection, as the backend's sets. */
  journalSizeLimit: number;
  /**
   * Called once, on the event loop, when the worker cannot checkpoint; the
   * checkpointer has stopped by then. `reason` and `code` are fixed labels.
   */
  onFailure: (failure: { reason: string; code?: string }) => void;
  /** Called after each checkpoint the worker finished. */
  onCheckpoint?: (result: BackgroundCheckpointResult) => void;
}

/**
 * The worker's whole program. Kept inline (a Blob URL) rather than as a
 * module so the bundled backend needs no extra file. Messages carry only
 * the file path, counts, times and SQLite error codes.
 */
const WORKER_SOURCE = String.raw`
const { Database } = require("bun:sqlite");
let db = null;
const codeOf = (error) => (error && typeof error.code === "string" ? error.code : "error");
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "open") {
    try {
      db = new Database(message.file, { readwrite: true, create: false });
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA checkpoint_fullfsync = ON");
      db.exec("PRAGMA journal_size_limit = " + Number(message.journalSizeLimit));
      self.postMessage({ type: "opened" });
    } catch (error) {
      try { db?.close(); } catch {}
      db = null;
      self.postMessage({ type: "failed", reason: "open-failed", code: codeOf(error) });
    }
    return;
  }
  if (message.type === "checkpoint") {
    if (!db) return;
    const started = performance.now();
    try {
      const row = db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
      self.postMessage({
        type: "checkpointed",
        busy: row.busy !== 0,
        log: row.log,
        checkpointed: row.checkpointed,
        durationMs: performance.now() - started,
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        self.postMessage({ type: "checkpointed", busy: true, log: -1, checkpointed: -1, durationMs: performance.now() - started });
      } else {
        self.postMessage({ type: "failed", reason: "checkpoint-failed", code });
      }
    }
    return;
  }
  if (message.type === "close") {
    try { db?.close(); } catch {}
    db = null;
    process.exit(0);
  }
};
`;

type WorkerMessage =
  | { type: "opened" }
  | ({ type: "checkpointed" } & BackgroundCheckpointResult)
  | { type: "failed"; reason: string; code?: string };

let workerUrl: string | null = null;

function checkpointWorkerUrl(): string {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  return workerUrl;
}

/** A worker thread checkpointing one SQLite file until {@link stop}. */
export class BackgroundCheckpointer {
  private worker: Worker | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opened = false;
  private inFlight = false;
  private stopped = false;
  /** Settles once the worker thread has ended, its connection closed. */
  readonly exited: Promise<void>;

  /** Starts the worker; `null` when this runtime cannot start one. */
  static start(
    file: string,
    options: BackgroundCheckpointerOptions,
  ): BackgroundCheckpointer | null {
    let worker: Worker;
    try {
      worker = new Worker(checkpointWorkerUrl());
    } catch {
      return null;
    }
    return new BackgroundCheckpointer(worker, file, options);
  }

  private constructor(
    worker: Worker,
    file: string,
    private readonly options: BackgroundCheckpointerOptions,
  ) {
    this.worker = worker;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.exited = promise;
    worker.addEventListener("close", () => resolve());
    // Never what keeps the backend process alive. Bun's Worker has `unref`;
    // the DOM type this package compiles against does not.
    (worker as Worker & { unref?: () => void }).unref?.();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail({ reason: "worker-error" });
    };
    worker.postMessage({ type: "open", file, journalSizeLimit: options.journalSizeLimit });
    this.timer = setInterval(
      () => this.tick(),
      options.intervalMs ?? BACKGROUND_CHECKPOINT_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  /** Whether the worker is still checkpointing. */
  isRunning(): boolean {
    return !this.stopped;
  }

  /**
   * Stops checkpointing: the worker closes its connection and exits. Safe to
   * call more than once. Does not wait; a checkpoint still running finishes
   * first, which SQLite keeps consistent with the backend's own connection.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    try {
      worker.postMessage({ type: "close" });
    } catch {
      // The worker already exited.
    }
  }

  private tick(): void {
    if (this.stopped || !this.opened || this.inFlight) return;
    this.inFlight = true;
    this.worker?.postMessage({ type: "checkpoint" });
  }

  private receive(message: WorkerMessage): void {
    if (this.stopped) return;
    if (message.type === "opened") {
      this.opened = true;
      return;
    }
    if (message.type === "checkpointed") {
      this.inFlight = false;
      const { busy, log: frames, checkpointed, durationMs } = message;
      this.options.onCheckpoint?.({ busy, log: frames, checkpointed, durationMs });
      return;
    }
    this.fail({ reason: message.reason, code: message.code });
  }

  private fail(failure: { reason: string; code?: string }): void {
    if (this.stopped) return;
    this.stop();
    this.options.onFailure(failure);
  }
}

/**
 * Moves `db`'s WAL checkpoints to a {@link BackgroundCheckpointer}: raises the
 * connection's `wal_autocheckpoint` to the fallback while the worker runs and
 * restores SQLite's default if it fails (unless `isClosed`). `null` when no
 * worker could start, leaving the connection as it was. `database` names the
 * file in logs (`main`, `ledger`).
 */
export function startBackgroundCheckpoints(
  db: Database,
  file: string,
  database: string,
  isClosed: () => boolean,
  options: Pick<BackgroundCheckpointerOptions, "intervalMs" | "onCheckpoint"> = {},
): BackgroundCheckpointer | null {
  const checkpointer = BackgroundCheckpointer.start(file, {
    ...options,
    journalSizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
    onFailure: ({ reason, code }) => {
      log.warn("checkpoint.background-failed", { database, reason, code });
      if (isClosed()) return;
      try {
        db.exec(`PRAGMA wal_autocheckpoint = ${DEFAULT_AUTOCHECKPOINT_PAGES}`);
      } catch {
        // Closing concurrently; nothing left to checkpoint for.
      }
    },
  });
  if (!checkpointer) {
    log.warn("checkpoint.background-failed", { database, reason: "worker-unavailable" });
    return null;
  }
  db.exec(`PRAGMA wal_autocheckpoint = ${BACKGROUND_CHECKPOINT_FALLBACK_PAGES}`);
  return checkpointer;
}
