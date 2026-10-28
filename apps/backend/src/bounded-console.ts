import { formatWithOptions } from "node:util";

/**
 * Console output that never blocks the event loop.
 *
 * Under Electron this process's stdout and stderr are sockets that the desktop
 * main process reads line by line into its log. Bun's `console.log` writes to
 * them synchronously: once the reader stops draining and the socket buffer is
 * full, the next log line parks the whole backend — every HTTP route, the
 * agent MCP endpoint, mail, bridges — until the reader resumes. On 2026-10-28 a
 * desktop main thread held in a modal for 6 h 45 min froze the backend that
 * long; the first log line after the freeze carried an event time from before
 * it.
 *
 * `process.stdout.write` does not block: it queues inside the stream and calls
 * back once the bytes reach the socket. Console methods here format exactly as
 * before, write through the stream, and count the bytes not yet flushed. Past
 * `maxPendingBytes` lines are dropped and counted instead of queued, so a
 * stalled reader costs a bounded amount of memory. Dropping continues until
 * the backlog falls to half the bound, so a slow reader does not alternate
 * between one written line and one dropped line; then one marker line reports
 * the gap and writing resumes. The marker does not wait for an empty backlog,
 * which a process that logs steadily may never reach. A line arriving with
 * nothing pending is always written, however long it is.
 */

/** Unflushed bytes one stream may hold before lines are dropped. */
export const BOUNDED_CONSOLE_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface BoundedStreamStats {
  /** Bytes handed to the stream and not yet flushed. */
  pendingBytes: number;
  /** Lines successfully flushed since install (including gap markers). */
  writtenLines: number;
  /** Writes lost to callback errors or synchronous throws, including gap markers. */
  failedLines: number;
  failedBytes: number;
  /** Lines dropped since install because the reader was not draining. */
  droppedLines: number;
  droppedBytes: number;
  /** Drops since the last marker; non-zero while the reader is still stalled. */
  unreportedDroppedLines: number;
  /** Wall-clock time of the first unreported drop, or null. */
  stalledSince: string | null;
}

export interface BoundedConsoleStats {
  stdout: BoundedStreamStats;
  stderr: BoundedStreamStats;
}

/** The slice of a writable stream used here; `process.stdout` satisfies it. */
export interface BoundedConsoleStream {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export interface BoundedConsoleOptions {
  stdout?: BoundedConsoleStream;
  stderr?: BoundedConsoleStream;
  maxPendingBytes?: number;
  /** Prefix of the marker line written after a gap. */
  label?: string;
  console?: Console;
  now?: () => number;
}

export interface InstalledBoundedConsole {
  stats(): BoundedConsoleStats;
  /**
   * Resolves once everything written so far has flushed, or after
   * `timeoutMs`. `process.exit` discards unflushed stream writes, so the exit
   * path awaits this; the bound keeps a stalled reader from holding exit.
   */
  flush(timeoutMs: number): Promise<void>;
  /** Restores the console methods this replaced. */
  uninstall(): void;
}

const STDOUT_METHODS = ["log", "info", "debug"] as const;
const STDERR_METHODS = ["warn", "error"] as const;
type ConsoleMethod = (typeof STDOUT_METHODS)[number] | (typeof STDERR_METHODS)[number];

let installed: InstalledBoundedConsole | null = null;

/** Counters of the installed console, for diagnostics; null when not installed. */
export function boundedConsoleStats(): BoundedConsoleStats | null {
  return installed?.stats() ?? null;
}

class BoundedStream {
  private pendingBytes = 0;
  private writtenLines = 0;
  private failedLines = 0;
  private failedBytes = 0;
  private droppedLines = 0;
  private droppedBytes = 0;
  private unreportedLines = 0;
  private unreportedBytes = 0;
  private stalledSince: number | null = null;
  private readonly drained: Array<() => void> = [];

  constructor(
    private readonly stream: BoundedConsoleStream,
    private readonly maxPendingBytes: number,
    private readonly label: string,
    private readonly now: () => number,
  ) {}

  writeLine(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.unreportedLines > 0) this.resumeIfDrained();
    if (
      this.unreportedLines > 0 ||
      (this.pendingBytes > 0 && this.pendingBytes + bytes > this.maxPendingBytes)
    ) {
      this.droppedLines += 1;
      this.droppedBytes += bytes;
      this.unreportedLines += 1;
      this.unreportedBytes += bytes;
      this.stalledSince ??= this.now();
      return;
    }
    this.send(line, bytes);
  }

  private send(line: string, bytes: number): void {
    this.pendingBytes += bytes;
    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      if (failed) {
        this.failedLines += 1;
        this.failedBytes += bytes;
      } else {
        this.writtenLines += 1;
      }
      this.flushed(bytes, failed);
    };
    try {
      this.stream.write(line, (error) => settle(error != null));
    } catch {
      settle(true);
    }
  }

  /** Resolves when nothing written so far is still pending. */
  whenDrained(): Promise<void> {
    if (this.pendingBytes === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  private flushed(bytes: number, failed: boolean): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
    // A failed write is not evidence of a draining reader. Keep failures in
    // separate counters rather than recursively sending markers to a broken stream.
    if (!failed && this.unreportedLines > 0) this.resumeIfDrained();
    if (this.pendingBytes === 0) {
      for (const resolve of this.drained.splice(0)) resolve();
    }
  }

  /** Ends a run of drops once the backlog is down to half the bound. */
  private resumeIfDrained(): void {
    if (this.pendingBytes > this.maxPendingBytes / 2) return;
    const since = this.stalledSince ?? this.now();
    const marker =
      `${this.label} Dropped ${this.unreportedLines} log line(s) (${this.unreportedBytes} bytes) ` +
      `from ${new Date(since).toISOString()} to ${new Date(this.now()).toISOString()}: ` +
      `the log reader was not draining output; this process kept serving.\n`;
    this.unreportedLines = 0;
    this.unreportedBytes = 0;
    this.stalledSince = null;
    this.send(marker, Buffer.byteLength(marker));
  }

  stats(): BoundedStreamStats {
    return {
      pendingBytes: this.pendingBytes,
      writtenLines: this.writtenLines,
      failedLines: this.failedLines,
      failedBytes: this.failedBytes,
      droppedLines: this.droppedLines,
      droppedBytes: this.droppedBytes,
      unreportedDroppedLines: this.unreportedLines,
      stalledSince: this.stalledSince === null ? null : new Date(this.stalledSince).toISOString(),
    };
  }
}

/**
 * Replaces `console.log`/`info`/`debug` (stdout) and `warn`/`error` (stderr)
 * with bounded, non-blocking writers. Install once, before anything logs.
 */
export function installBoundedConsole(
  options: BoundedConsoleOptions = {},
): InstalledBoundedConsole {
  const target = options.console ?? console;
  const maxPendingBytes = options.maxPendingBytes ?? BOUNDED_CONSOLE_MAX_PENDING_BYTES;
  const label = options.label ?? "[Backend]";
  const now = options.now ?? Date.now;
  const stdout = new BoundedStream(options.stdout ?? process.stdout, maxPendingBytes, label, now);
  const stderr = new BoundedStream(options.stderr ?? process.stderr, maxPendingBytes, label, now);
  const original = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  const replace = (method: ConsoleMethod, stream: BoundedStream) => {
    original.set(method, target[method]);
    target[method] = (...args: unknown[]) => {
      stream.writeLine(`${formatWithOptions({ colors: false }, ...args)}\n`);
    };
  };
  for (const method of STDOUT_METHODS) replace(method, stdout);
  for (const method of STDERR_METHODS) replace(method, stderr);

  const handle: InstalledBoundedConsole = {
    stats: () => ({ stdout: stdout.stats(), stderr: stderr.stats() }),
    flush: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.all([stdout.whenDrained(), stderr.whenDrained()]), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
    uninstall: () => {
      for (const [method, fn] of original) target[method] = fn as never;
      if (installed === handle) installed = null;
    },
  };
  installed = handle;
  return handle;
}
