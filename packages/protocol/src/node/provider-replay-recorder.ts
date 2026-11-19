/**
 * Records a bridge's raw provider traffic as provider-replay fixtures.
 *
 * The Claude, Cursor, Pi and ACP bridges replay recorded traffic through
 * their production ingestion paths (`tests/conformance/provider-replay`). This
 * writes the format that suite reads: per session, one JSONL file whose first
 * line is a header naming the bridge and the provider version, then one
 * `{"frame": …}` line per provider frame and an `{"action":"prompt"}` line
 * where a turn began. A developer then names the scenario, adds the actions
 * the user took (answer, interrupt, observe), scrubs it and commits it.
 *
 * Two hard constraints, the same as the Codex notification recorder's:
 *
 *  1. **Never slow the provider's callback.** `frame()` runs on the SDK's own
 *     listener or the agent's stdout loop. It serialises the frame and queues
 *     it; disk I/O happens on a detached, serialized chain.
 *  2. **Never grow without bound.** Recording stops at `maxBytes` overall and
 *     at `maxSessions` files, and says so in the file.
 *
 * Opt-in only, and deliberately awkward to switch on. A recording holds every
 * prompt, file content and absolute path verbatim, and Bun loads `.env` files
 * on its own, so it needs both `ORKESTRATOR_PROVIDER_RECORD_DIR=<dir>` and
 * `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1`, and a live recorder keeps saying so.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createLogger, formatLogError } from "../logger.js";

const log = createLogger("bridge.lifecycle");

export const PROVIDER_RECORD_DIR_ENV = "ORKESTRATOR_PROVIDER_RECORD_DIR";
export const PROVIDER_RECORD_CONFIRM_ENV = "ORKESTRATOR_PROVIDER_RECORD_CONFIRM";
export const PROVIDER_RECORD_MAX_BYTES_ENV = "ORKESTRATOR_PROVIDER_RECORD_MAX_BYTES";

/** Far more than any fixture needs. */
export const DEFAULT_PROVIDER_RECORDING_MAX_BYTES = 64 * 1024 * 1024;
/** One file per session; a bridge that serves more than this stops adding files. */
export const DEFAULT_PROVIDER_RECORDING_MAX_SESSIONS = 64;
export const PROVIDER_RECORDING_FLUSH_INTERVAL_MS = 250;
export const PROVIDER_RECORDING_WARN_INTERVAL_MS = 60_000;

export interface ProviderReplayRecorderOptions {
  bridge: "claude" | "cursor" | "pi" | "acp";
  /** Package or CLI whose traffic this is, e.g. `@cursor/sdk`. */
  provider: string;
  /**
   * The provider version the traffic comes from. A function is read once, when
   * the first header is written, off the provider's callback: the version an
   * agent reports may only be known after it has started.
   */
  providerVersion: string | (() => string | undefined | Promise<string | undefined>);
  directory: string;
  maxBytes?: number;
  maxSessions?: number;
  flushIntervalMs?: number;
  warnIntervalMs?: number;
  /** Injected in tests. */
  appendFileImpl?: (path: string, contents: string) => Promise<void>;
  ensureDirImpl?: (path: string) => Promise<void>;
  warnImpl?: (message: string) => void;
  now?: () => number;
  /**
   * Write what is still buffered, synchronously, when the process exits, so a
   * bridge stopped by a signal keeps the end of its recording. On for the
   * recorder the environment creates; `close()` removes it.
   */
  flushOnExit?: boolean;
}

export interface ProviderReplayRecorderStats {
  sessions: number;
  linesRecorded: number;
  bytesRecorded: number;
  linesDropped: number;
  capped: boolean;
  writeErrors: number;
}

function notice(message: string): void {
  // Fixed text plus the directory the developer named; never recorded content.
  log.warn("replay-recorder.notice", { detail: message });
}

export class ProviderReplayRecorder {
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly flushIntervalMs: number;
  private readonly warnIntervalMs: number;
  private readonly appendFileImpl: (path: string, contents: string) => Promise<void>;
  private readonly ensureDirImpl: (path: string) => Promise<void>;
  private readonly warnImpl: (message: string) => void;
  private readonly now: () => number;
  private readonly stamp: string;

  /** Session key → file name, in first-seen order. */
  private readonly files = new Map<string, string>();
  /** `line` undefined marks a file's header, written at flush time. */
  private buffer: Array<{ file: string; line?: string }> = [];
  private resolvedVersion: string | undefined;
  private bufferedBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private directoryReady = false;
  private closed = false;
  private lastWarnedAt: number | null = null;
  private readonly stats: ProviderReplayRecorderStats = {
    sessions: 0,
    linesRecorded: 0,
    bytesRecorded: 0,
    linesDropped: 0,
    capped: false,
    writeErrors: 0,
  };

  constructor(private readonly options: ProviderReplayRecorderOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_PROVIDER_RECORDING_MAX_BYTES;
    this.maxSessions = options.maxSessions ?? DEFAULT_PROVIDER_RECORDING_MAX_SESSIONS;
    this.flushIntervalMs = options.flushIntervalMs ?? PROVIDER_RECORDING_FLUSH_INTERVAL_MS;
    this.warnIntervalMs = options.warnIntervalMs ?? PROVIDER_RECORDING_WARN_INTERVAL_MS;
    this.appendFileImpl =
      options.appendFileImpl ?? ((path, contents) => appendFile(path, contents, "utf8"));
    this.ensureDirImpl =
      options.ensureDirImpl ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
    this.warnImpl = options.warnImpl ?? notice;
    this.now = options.now ?? Date.now;
    this.stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    if (options.flushOnExit) process.once("exit", this.flushOnExit);
  }

  private readonly flushOnExit = (): void => {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      mkdirSync(this.options.directory, { recursive: true });
      for (const entry of pending) {
        appendFileSync(
          join(this.options.directory, entry.file),
          `${entry.line ?? this.headerLine(this.syncVersion())}\n`,
          "utf8",
        );
      }
    } catch {
      // The process is exiting; a recording it cannot finish is simply shorter.
    }
  };

  /** The version without awaiting: an exit handler cannot. */
  private syncVersion(): string {
    if (this.resolvedVersion !== undefined) return this.resolvedVersion;
    const declared = this.options.providerVersion;
    try {
      const value = typeof declared === "function" ? declared() : declared;
      return typeof value === "string" && value.trim() ? value.trim() : "unknown";
    } catch {
      return "unknown";
    }
  }

  getStats(): ProviderReplayRecorderStats {
    return { ...this.stats };
  }

  /** One provider frame for `sessionKey`, in the bridge's native shape. */
  frame(sessionKey: string, frame: unknown): void {
    this.record(sessionKey, () => JSON.stringify({ frame }));
  }

  /** One raw line from a line-oriented provider, kept byte for byte. */
  rawLine(sessionKey: string, line: string): void {
    this.record(sessionKey, () => {
      // A line that is valid JSON is a frame; anything else is kept verbatim
      // as a string frame, which the ACP replay writes back as that raw line.
      try {
        return JSON.stringify({ frame: JSON.parse(line) as unknown });
      } catch {
        return JSON.stringify({ frame: line });
      }
    });
  }

  /** A turn began. Its prompt text is deliberately not recorded. */
  prompt(sessionKey: string): void {
    this.record(sessionKey, () => JSON.stringify({ action: "prompt" }));
  }

  private record(sessionKey: string, serialize: () => string): void {
    if (this.closed || this.stats.capped) {
      this.stats.linesDropped += 1;
      return;
    }
    let file = this.files.get(sessionKey);
    if (!file) {
      if (this.files.size >= this.maxSessions) {
        this.stats.linesDropped += 1;
        return;
      }
      // The key may be a provider session id; the file name carries only a digest.
      const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
      file = `${this.options.bridge}-${this.stamp}-${digest}.jsonl`;
      this.files.set(sessionKey, file);
      this.stats.sessions = this.files.size;
      this.buffer.push({ file });
    }
    let line: string;
    try {
      line = serialize();
    } catch {
      // A frame JSON cannot represent (a cycle, a BigInt) is dropped, never thrown.
      this.stats.linesDropped += 1;
      return;
    }
    this.enqueue(file, line);
  }

  private enqueue(file: string, line: string): void {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (this.stats.bytesRecorded + this.bufferedBytes + size > this.maxBytes) {
      // Stop cleanly rather than truncating mid-line.
      this.stats.capped = true;
      this.stats.linesDropped += 1;
      for (const name of new Set(this.files.values())) {
        this.buffer.push({
          file: name,
          line: JSON.stringify({ __recorderNotice: "recording stopped: max bytes reached" }),
        });
      }
      this.scheduleFlush();
      return;
    }
    this.buffer.push({ file, line });
    this.bufferedBytes += size;
    this.stats.linesRecorded += 1;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Detached on purpose: the provider callback must not await this.
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** Serialized, so two flushes cannot interleave lines within a file. */
  async flush(): Promise<void> {
    const attempt = this.flushChain.then(() => this.flushOnce());
    this.flushChain = attempt.catch(() => undefined);
    await attempt;
  }

  private warnIfDue(): void {
    const now = this.now();
    if (this.lastWarnedAt !== null && now - this.lastWarnedAt < this.warnIntervalMs) return;
    this.lastWarnedAt = now;
    this.warnImpl(
      `RECORDING ${this.options.bridge} provider traffic to ${this.options.directory} ` +
        `(${this.stats.linesRecorded} lines, ${this.stats.sessions} sessions). Prompts, file ` +
        `contents and absolute paths are written verbatim. Unset ${PROVIDER_RECORD_DIR_ENV} to stop.`,
    );
  }

  private async header(): Promise<string> {
    if (this.resolvedVersion === undefined) {
      const declared = this.options.providerVersion;
      let version: string | undefined;
      try {
        version = typeof declared === "function" ? await declared() : declared;
      } catch {
        version = undefined;
      }
      this.resolvedVersion = version?.trim() || "unknown";
    }
    return this.headerLine(this.resolvedVersion);
  }

  private headerLine(providerVersion: string): string {
    return JSON.stringify({
      replay: 1,
      bridge: this.options.bridge,
      scenario: "unclassified",
      source: "recorded",
      provider: this.options.provider,
      providerVersion,
      description:
        "Recorded traffic. Name the scenario, add the user's actions, scrub it and read the diff before committing.",
    });
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.warnIfDue();
    const pending = this.buffer;
    const pendingBytes = this.bufferedBytes;
    this.buffer = [];
    this.bufferedBytes = 0;
    const byFile = new Map<string, string[]>();
    for (const entry of pending) {
      const lines = byFile.get(entry.file) ?? [];
      lines.push(entry.line ?? (await this.header()));
      byFile.set(entry.file, lines);
    }
    try {
      if (!this.directoryReady) {
        await this.ensureDirImpl(this.options.directory);
        this.directoryReady = true;
      }
      for (const [file, lines] of byFile) {
        await this.appendFileImpl(join(this.options.directory, file), `${lines.join("\n")}\n`);
      }
      this.stats.bytesRecorded += pendingBytes;
    } catch (error) {
      // A recording is a developer convenience; failing to write one must never
      // affect the session it records.
      this.stats.writeErrors += 1;
      this.stats.linesDropped += pending.length;
      log.error("replay-recorder.write-failed", {
        error: formatLogError(error, { stack: false }),
      });
    }
  }

  /** Flushes what is buffered and stops accepting frames. */
  async close(): Promise<void> {
    this.closed = true;
    process.removeListener("exit", this.flushOnExit);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/**
 * The recorder the environment asks for, or null when recording is off.
 *
 * Needs the explicit confirmation as well as the directory: a directory alone
 * is too easy to switch on by accident, and the failure mode is silent,
 * permanent capture of the user's prompts and source files.
 */
export function createProviderReplayRecorderFromEnv(
  options: Omit<ProviderReplayRecorderOptions, "directory" | "maxBytes">,
  env: Record<string, string | undefined> = process.env,
): ProviderReplayRecorder | null {
  const warn = options.warnImpl ?? notice;
  const directory = env[PROVIDER_RECORD_DIR_ENV]?.trim();
  if (!directory) return null;
  if (env[PROVIDER_RECORD_CONFIRM_ENV]?.trim() !== "1") {
    warn(
      `Ignoring ${PROVIDER_RECORD_DIR_ENV}=${directory}: recordings capture every prompt, file ` +
        `content and absolute path verbatim, so they also require ${PROVIDER_RECORD_CONFIRM_ENV}=1. ` +
        "Not recording.",
    );
    return null;
  }
  const maxBytes = Number(env[PROVIDER_RECORD_MAX_BYTES_ENV]);
  return new ProviderReplayRecorder({
    flushOnExit: true,
    ...options,
    directory,
    ...(Number.isSafeInteger(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
  });
}

/**
 * The installed version of `packageName` as resolved from `fromUrl` (a
 * module's `import.meta.url`), for a recording's header. Walks up from the
 * package's entry point to its own manifest, because an `exports` map may
 * refuse `<name>/package.json`. Undefined when it cannot tell.
 */
export function installedPackageVersion(packageName: string, fromUrl: string): string | undefined {
  try {
    let directory = dirname(createRequire(fromUrl).resolve(packageName));
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === packageName) return manifest.version;
      } catch {
        // No manifest here; keep walking up.
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}
