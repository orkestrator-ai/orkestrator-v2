/**
 * Records the raw inbound app-server stream to a JSONL file for later replay.
 *
 * Purpose: the reducer/accumulator/render tests are all driven by *hand-authored*
 * notifications, so they encode what we believe app-server emits rather than what
 * it actually emits. Recording a real session and replaying it through the same
 * pipeline turns a live run into a permanent regression fixture — which is exactly
 * what catches a renamed field or a new item variant on the next Codex bump.
 *
 * Two hard constraints:
 *
 *  1. **Never slow the read loop.** `record()` is called from `dispatchLine`,
 *     which must stay O(1) and synchronous — app-server's outbound queue is
 *     bounded, so blocking here stalls every thread in the environment. So
 *     `record()` only appends to an in-memory buffer and schedules a flush; all
 *     disk I/O happens on a detached, serialized chain.
 *  2. **Never grow without bound.** A long session can emit hundreds of MB of
 *     deltas. Recording stops at `maxBytes` and says so in the file, rather than
 *     filling the user's disk.
 *
 * Opt-in only, and deliberately awkward to switch on: `.env` files are loaded
 * automatically by Bun, so a single stray line in a checked-out `.env` would
 * otherwise start writing every prompt and every file the agent reads to disk,
 * announced by one line of startup logging nobody re-reads. Recording therefore
 * requires **both** `CODEX_BRIDGE_RECORD_NOTIFICATIONS=<dir>` and
 * `CODEX_BRIDGE_RECORD_CONFIRM=1`, and the live recorder keeps saying so at
 * intervals for as long as it is running.
 *
 * Recordings are developer artifacts — run `bun scripts/scrub-codex-recording.ts`
 * before committing one as a fixture.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** A recording past this size is already far more than any fixture needs. */
export const DEFAULT_MAX_RECORDING_BYTES = 64 * 1024 * 1024;
/** Batches disk writes so a delta storm costs one append, not thousands. */
export const DEFAULT_FLUSH_INTERVAL_MS = 250;
/** How often a live recording re-announces itself. */
export const DEFAULT_WARN_INTERVAL_MS = 60_000;
/** Second, explicit acknowledgement that recording captures private data. */
export const RECORD_CONFIRM_ENV = "CODEX_BRIDGE_RECORD_CONFIRM";

export interface NotificationRecorderOptions {
  /** Directory to write into; created on first flush. */
  directory: string;
  /** Distinguishes generations within one bridge run. */
  fileName: string;
  maxBytes?: number;
  flushIntervalMs?: number;
  /** How often the "this is recording your data" warning repeats. */
  warnIntervalMs?: number;
  /** Injected in tests. */
  appendFileImpl?: (path: string, contents: string) => Promise<void>;
  ensureDirImpl?: (path: string) => Promise<void>;
  warnImpl?: (message: string) => void;
  now?: () => number;
}

export interface RecorderStats {
  fileName: string;
  linesRecorded: number;
  bytesRecorded: number;
  linesDropped: number;
  capped: boolean;
  writeErrors: number;
}

export class NotificationRecorder {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly flushIntervalMs: number;
  private readonly warnIntervalMs: number;
  private readonly appendFileImpl: (path: string, contents: string) => Promise<void>;
  private readonly ensureDirImpl: (path: string) => Promise<void>;
  private readonly warnImpl: (message: string) => void;
  private readonly now: () => number;

  private buffer: string[] = [];
  private bufferedBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private directoryReady = false;
  private closed = false;
  private lastWarnedAt: number | null = null;

  private stats: RecorderStats;

  constructor(private readonly options: NotificationRecorderOptions) {
    this.path = join(options.directory, options.fileName);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_RECORDING_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.warnIntervalMs = options.warnIntervalMs ?? DEFAULT_WARN_INTERVAL_MS;
    this.appendFileImpl =
      options.appendFileImpl ?? ((path, contents) => appendFile(path, contents, "utf8"));
    this.ensureDirImpl = options.ensureDirImpl ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
    this.warnImpl = options.warnImpl ?? ((message) => console.error(message));
    this.now = options.now ?? Date.now;
    this.stats = {
      fileName: options.fileName,
      linesRecorded: 0,
      bytesRecorded: 0,
      linesDropped: 0,
      capped: false,
      writeErrors: 0,
    };
  }

  getStats(): RecorderStats {
    return { ...this.stats };
  }

  /**
   * Buffers one raw inbound line. Must remain O(1): called from the read loop.
   *
   * The line is stored verbatim — no parsing, no re-serialization — so a replay
   * sees byte-identical input to what app-server produced, including anything our
   * envelope validation would have rejected.
   */
  record(line: string): void {
    if (this.closed || this.stats.capped) {
      this.stats.linesDropped += 1;
      return;
    }

    const size = Buffer.byteLength(line, "utf8") + 1;
    if (this.stats.bytesRecorded + this.bufferedBytes + size > this.maxBytes) {
      // Stop cleanly rather than truncating mid-line: a half-written JSON object
      // would make the whole fixture unparseable.
      this.stats.capped = true;
      this.stats.linesDropped += 1;
      this.buffer.push(
        JSON.stringify({
          __recorderNotice: "recording stopped: max bytes reached",
          maxBytes: this.maxBytes,
        }),
      );
      this.scheduleFlush();
      return;
    }

    this.buffer.push(line);
    this.bufferedBytes += size;
    this.stats.linesRecorded += 1;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Detached on purpose: the read loop must not await this.
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** Serialized so two flushes cannot interleave lines in the file. */
  async flush(): Promise<void> {
    const attempt = this.flushChain.then(() => this.flushOnce());
    this.flushChain = attempt.catch(() => undefined);
    await attempt;
  }

  /**
   * Re-announces a live recording.
   *
   * One warning at spawn is not enough: a recording started by a stray `.env`
   * entry outlives the scrollback that mentioned it, and nothing else in the log
   * hints that every prompt is being written to disk. Emitted from the flush
   * path rather than `record()` so the read loop stays O(1).
   */
  private warnIfDue(): void {
    const now = this.now();
    if (this.lastWarnedAt !== null && now - this.lastWarnedAt < this.warnIntervalMs) return;
    this.lastWarnedAt = now;
    this.warnImpl(
      `[codex-bridge] RECORDING app-server notifications to ${this.path} `
      + `(${this.stats.linesRecorded} lines). Prompts, file contents and absolute paths `
      + "are written verbatim. Unset CODEX_BRIDGE_RECORD_NOTIFICATIONS to stop.",
    );
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.warnIfDue();
    const pending = this.buffer;
    const pendingBytes = this.bufferedBytes;
    this.buffer = [];
    this.bufferedBytes = 0;

    try {
      if (!this.directoryReady) {
        await this.ensureDirImpl(this.options.directory);
        this.directoryReady = true;
      }
      await this.appendFileImpl(this.path, `${pending.join("\n")}\n`);
      this.stats.bytesRecorded += pendingBytes;
    } catch (error) {
      // A recording is a developer convenience; failing to write one must never
      // affect the session it is recording.
      this.stats.writeErrors += 1;
      this.stats.linesDropped += pending.length;
      console.error(`[codex-bridge] Failed to write notification recording: ${String(error)}`);
    }
  }

  /** Flushes whatever is buffered and stops accepting lines. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/**
 * Builds a recorder from the environment, or null when recording is off.
 *
 * Kept here rather than in the RPC client so the client has no environment
 * dependency and stays trivially testable.
 *
 * Requires a second, explicit acknowledgement. Bun auto-loads `.env`, so a
 * directory alone is far too easy to switch on by accident — and the failure
 * mode is silent, permanent capture of the user's prompts and source files.
 */
export function createRecorderFromEnv(options: {
  generation: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  warn?: (message: string) => void;
}): NotificationRecorder | null {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const directory = env.CODEX_BRIDGE_RECORD_NOTIFICATIONS?.trim();
  if (!directory) return null;

  if (env[RECORD_CONFIRM_ENV]?.trim() !== "1") {
    // Loud, because the user asked for something and is not getting it.
    warn(
      `[codex-bridge] Ignoring CODEX_BRIDGE_RECORD_NOTIFICATIONS=${directory}: recordings `
      + "capture every prompt, file content and absolute path verbatim, so they also "
      + `require ${RECORD_CONFIRM_ENV}=1. Not recording.`,
    );
    return null;
  }

  const stamp = new Date(options.now?.() ?? Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");
  return new NotificationRecorder({
    directory,
    fileName: `codex-app-server-${stamp}-gen${options.generation}.jsonl`,
    ...(options.warn ? { warnImpl: options.warn } : {}),
    ...(env.CODEX_BRIDGE_RECORD_MAX_BYTES
      ? { maxBytes: Number(env.CODEX_BRIDGE_RECORD_MAX_BYTES) || DEFAULT_MAX_RECORDING_BYTES }
      : {}),
  });
}
