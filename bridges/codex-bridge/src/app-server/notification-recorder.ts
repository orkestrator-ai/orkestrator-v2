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
 * Opt-in only, via `CODEX_BRIDGE_RECORD_NOTIFICATIONS=<dir>`. Recordings contain
 * prompts, file contents and absolute paths, so they are developer artifacts —
 * run `bun scripts/scrub-codex-recording.ts` before committing one as a fixture.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** A recording past this size is already far more than any fixture needs. */
export const DEFAULT_MAX_RECORDING_BYTES = 64 * 1024 * 1024;
/** Batches disk writes so a delta storm costs one append, not thousands. */
export const DEFAULT_FLUSH_INTERVAL_MS = 250;

export interface NotificationRecorderOptions {
  /** Directory to write into; created on first flush. */
  directory: string;
  /** Distinguishes generations within one bridge run. */
  fileName: string;
  maxBytes?: number;
  flushIntervalMs?: number;
  /** Injected in tests. */
  appendFileImpl?: (path: string, contents: string) => Promise<void>;
  ensureDirImpl?: (path: string) => Promise<void>;
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
  private readonly appendFileImpl: (path: string, contents: string) => Promise<void>;
  private readonly ensureDirImpl: (path: string) => Promise<void>;

  private buffer: string[] = [];
  private bufferedBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private directoryReady = false;
  private closed = false;

  private stats: RecorderStats;

  constructor(private readonly options: NotificationRecorderOptions) {
    this.path = join(options.directory, options.fileName);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_RECORDING_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.appendFileImpl =
      options.appendFileImpl ?? ((path, contents) => appendFile(path, contents, "utf8"));
    this.ensureDirImpl = options.ensureDirImpl ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
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

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
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
 */
export function createRecorderFromEnv(options: {
  generation: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): NotificationRecorder | null {
  const env = options.env ?? process.env;
  const directory = env.CODEX_BRIDGE_RECORD_NOTIFICATIONS?.trim();
  if (!directory) return null;

  const stamp = new Date(options.now?.() ?? Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");
  return new NotificationRecorder({
    directory,
    fileName: `codex-app-server-${stamp}-gen${options.generation}.jsonl`,
    ...(env.CODEX_BRIDGE_RECORD_MAX_BYTES
      ? { maxBytes: Number(env.CODEX_BRIDGE_RECORD_MAX_BYTES) || DEFAULT_MAX_RECORDING_BYTES }
      : {}),
  });
}
