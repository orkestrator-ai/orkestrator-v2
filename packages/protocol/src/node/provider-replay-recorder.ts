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
 *     at `maxSessions` streams.
 *
 * Opt-in only, and deliberately awkward to switch on. A recording holds every
 * prompt, file content and absolute path verbatim, and Bun loads `.env` files
 * on its own, so it needs both `ORKESTRATOR_PROVIDER_RECORD_DIR=<dir>` and
 * `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1`, and a live recorder keeps saying so.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
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
  appendFileImpl?: (path: string, contents: string, first: boolean) => Promise<void>;
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

const MAX_VERSION_JSON_BYTES = 96;
const MAX_QUEUED_LINES = 65_536;
const CAP_NOTICE = JSON.stringify({ __recorderNotice: "recording stopped: max bytes reached" });

function assertPrivate(stat: { uid: number; mode: number }, expectedKind: boolean): void {
  if (!expectedKind || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
    throw new Error("Recording destination must be owned by the current user and private");
  }
}

function recordingFlags(first: boolean): number {
  return (
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    (first ? constants.O_CREAT | constants.O_EXCL : 0)
  );
}

async function appendPrivate(path: string, contents: string, first: boolean): Promise<void> {
  const file = await open(path, recordingFlags(first), 0o600);
  try {
    const stat = await file.stat();
    assertPrivate(stat, stat.isFile() && stat.nlink === 1);
    await file.writeFile(contents, "utf8");
  } finally {
    await file.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  assertPrivate(stat, stat.isDirectory());
}

interface RecordingFile {
  name: string;
  started: boolean;
  failed: boolean;
}

export class ProviderReplayRecorder {
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly flushIntervalMs: number;
  private readonly warnIntervalMs: number;
  private readonly appendFileImpl: NonNullable<ProviderReplayRecorderOptions["appendFileImpl"]>;
  private readonly ensureDirImpl: (path: string) => Promise<void>;
  private readonly warnImpl: (message: string) => void;
  private readonly now: () => number;
  private readonly stamp: string;
  private readonly headerAllowance: number;

  private readonly files = new Map<string, RecordingFile>();
  private buffer = new Map<RecordingFile, string[]>();
  private resolvedVersion: string | undefined;
  // Includes disk bytes, bytes queued/in flight and uncertain writes. An I/O
  // error may have written a prefix, so that reservation is never refunded.
  private reservedBytes = 0;
  private queuedLines = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
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
    this.appendFileImpl = options.appendFileImpl ?? appendPrivate;
    this.ensureDirImpl = options.ensureDirImpl ?? ensurePrivateDirectory;
    this.warnImpl = options.warnImpl ?? notice;
    this.now = options.now ?? Date.now;
    this.stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    this.headerAllowance = Buffer.byteLength(this.headerLine("")) + MAX_VERSION_JSON_BYTES - 1;
    if (options.flushOnExit) process.once("exit", this.flushOnExit);
  }

  private readonly flushOnExit = (): void => {
    // A hard exit cannot await the active write. Never append the newer buffer
    // ahead of it. Normal signal shutdown awaits close() in each bridge.
    if (this.activeFlush || this.buffer.size === 0) return;
    const directory = this.options.directory;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      assertPrivate(stat, stat.isDirectory());
    } catch {
      return;
    }
    for (const [file, lines] of this.takeBuffer()) {
      if (file.failed) continue;
      try {
        const contents = this.contents(file, lines);
        const fd = openSync(join(directory, file.name), recordingFlags(!file.started), 0o600);
        try {
          const stat = fstatSync(fd);
          assertPrivate(stat, stat.isFile() && stat.nlink === 1);
          writeFileSync(fd, contents, "utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        // Last resort only. Other files can still be written independently.
      }
    }
  };

  getStats(): ProviderReplayRecorderStats {
    return { ...this.stats };
  }

  frame(sessionKey: string, frame: unknown): void {
    this.record(sessionKey, () => JSON.stringify({ frame }));
  }

  /** Keep the wire representation distinct from a structured JSON string. */
  rawLine(sessionKey: string, line: string): void {
    this.record(sessionKey, () => JSON.stringify({ rawLine: line }));
  }

  /** A turn began. Its prompt text is deliberately not recorded. */
  prompt(sessionKey: string, rpcId?: number): void {
    this.action(sessionKey, "prompt", { rpcId });
  }

  action(sessionKey: string, action: string, args: Record<string, unknown>): void {
    this.record(sessionKey, () => JSON.stringify({ ...args, action }));
  }

  private record(sessionKey: string, serialize: () => string): void {
    let file = this.files.get(sessionKey);
    if (
      this.closed ||
      this.stats.capped ||
      file?.failed ||
      this.queuedLines >= MAX_QUEUED_LINES ||
      (!file && this.files.size >= this.maxSessions)
    ) {
      this.stats.linesDropped += 1;
      return;
    }
    let line: string;
    try {
      line = serialize();
    } catch {
      this.stats.linesDropped += 1;
      return;
    }
    const size = Buffer.byteLength(line) + 1 + (file ? 0 : this.headerAllowance);
    if (this.reservedBytes + size > this.maxBytes) {
      this.stats.capped = true;
      this.stats.linesDropped += 1;
      if (file && this.reservedBytes + Buffer.byteLength(CAP_NOTICE) + 1 <= this.maxBytes) {
        this.reservedBytes += Buffer.byteLength(CAP_NOTICE) + 1;
        this.queue(file, CAP_NOTICE);
      }
      return;
    }
    if (!file) {
      const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
      file = {
        name: `${this.options.bridge}-${this.stamp}-${digest}-${randomUUID()}.jsonl`,
        started: false,
        failed: false,
      };
      this.files.set(sessionKey, file);
      this.stats.sessions = this.files.size;
    }
    this.reservedBytes += size;
    this.queue(file, line);
  }

  private queue(file: RecordingFile, line: string): void {
    const lines = this.buffer.get(file) ?? [];
    lines.push(line);
    this.buffer.set(file, lines);
    this.queuedLines += 1;
    if (this.flushTimer || this.activeFlush) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private takeBuffer(): Map<RecordingFile, string[]> {
    const pending = this.buffer;
    this.buffer = new Map();
    return pending;
  }

  /** Coalesce overlapping calls into a single drain, in arrival order. */
  flush(): Promise<void> {
    this.activeFlush ??= Promise.resolve().then(async () => {
      try {
        while (this.buffer.size > 0) await this.flushOnce();
      } finally {
        this.activeFlush = null;
      }
    });
    return this.activeFlush;
  }

  private warnIfDue(): void {
    const now = this.now();
    if (this.lastWarnedAt !== null && now - this.lastWarnedAt < this.warnIntervalMs) return;
    this.lastWarnedAt = now;
    this.warnImpl(
      `RECORDING ${this.options.bridge} provider traffic to ${this.options.directory} ` +
        `(${this.stats.linesRecorded} lines, ${this.stats.sessions} sessions). Provider frames may hold prompts, ` +
        `file contents and absolute paths. Unset ${PROVIDER_RECORD_DIR_ENV} to stop.`,
    );
  }

  private async resolveVersion(): Promise<void> {
    if (this.resolvedVersion !== undefined) return;
    const declared = this.options.providerVersion;
    let version: string | undefined;
    try {
      version = typeof declared === "function" ? await declared() : declared;
    } catch {
      version = undefined;
    }
    this.resolvedVersion = this.boundedVersion(version);
  }

  private boundedVersion(value: string | undefined): string {
    const version = value?.trim() || "unknown";
    return Buffer.byteLength(JSON.stringify(version)) <= MAX_VERSION_JSON_BYTES
      ? version
      : "unknown";
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
        "Name the scenario, add actions, scrub the capture and review it before committing.",
    });
  }

  private contents(file: RecordingFile, lines: string[]): string {
    const version =
      this.resolvedVersion ??
      this.boundedVersion(
        typeof this.options.providerVersion === "string" ? this.options.providerVersion : undefined,
      );
    const prefix = file.started ? "" : `${this.headerLine(version)}\n`;
    return `${prefix}${lines.join("\n")}\n`;
  }

  private writeFailed(error: unknown, lines: number): void {
    this.stats.writeErrors += 1;
    this.stats.linesDropped += lines;
    log.error("replay-recorder.write-failed", {
      error: formatLogError(error, { stack: false, message: false }),
    });
  }

  private async flushOnce(): Promise<void> {
    const pending = this.takeBuffer();
    try {
      this.warnIfDue();
      await this.resolveVersion();
      await this.ensureDirImpl(this.options.directory);
    } catch (error) {
      const lines = [...pending.values()].reduce((total, batch) => total + batch.length, 0);
      this.queuedLines -= lines;
      this.writeFailed(error, lines);
      return;
    }
    for (const [file, lines] of pending) {
      try {
        if (file.failed) {
          this.stats.linesDropped += lines.length;
          continue;
        }
        const contents = this.contents(file, lines);
        await this.appendFileImpl(join(this.options.directory, file.name), contents, !file.started);
        if (!file.started) {
          this.reservedBytes -=
            this.headerAllowance - Buffer.byteLength(this.headerLine(this.resolvedVersion!)) - 1;
          file.started = true;
        }
        this.stats.bytesRecorded += Buffer.byteLength(contents);
        this.stats.linesRecorded += lines.length;
      } catch (error) {
        // An append can fail after writing a prefix. Retire the file instead of
        // appending more frames to potentially incomplete JSONL.
        file.failed = true;
        this.writeFailed(error, lines.length);
      } finally {
        this.queuedLines -= lines.length;
      }
    }
  }

  /** Stop admission immediately, then drain queued and in-flight writes. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.closePromise = this.flush().finally(() =>
      process.removeListener("exit", this.flushOnExit),
    );
    return this.closePromise;
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
