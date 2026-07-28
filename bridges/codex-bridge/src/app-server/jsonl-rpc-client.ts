/**
 * JSON-RPC-over-JSONL client for one `codex app-server --stdio` generation.
 *
 * The single most important property: **the read loop never awaits consumer
 * work.** app-server uses bounded outbound queues, so if this loop blocked on a
 * slow SSE client or an expensive message rebuild, that back-pressure would
 * reach app-server and stall every thread in the environment. Concretely the
 * loop only ever:
 *
 *   1. resolves a pending RPC promise, or
 *   2. hands a server request to a router (fire-and-forget), or
 *   3. appends a notification to a per-thread queue.
 *
 * All three are O(1) and synchronous. Notification *processing* happens on
 * separate per-thread drains so one slow thread cannot reorder or delay another.
 */
import { StringDecoder } from "node:string_decoder";
import {
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
} from "./errors.js";
import {
  extractThreadId,
  parseInboundLine,
  type InboundNotification,
  type InboundServerRequest,
  type JsonRpcId,
} from "./envelope-validation.js";
import type { EngineGeneration } from "../engine/types.js";

/** Guards against a runaway peer filling memory with one unterminated line. */
export const DEFAULT_MAX_INBOUND_LINE_BYTES = 64 * 1024 * 1024;
/** Keeps us from writing a request app-server would reject outright. */
export const DEFAULT_MAX_OUTBOUND_LINE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Per-method budgets. Interrupt and history reads must not inherit a long
 * default: an interrupt that appears to hang would otherwise let the bridge
 * accept a new turn while the old one may still be running.
 */
export const METHOD_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  initialize: 30_000,
  "turn/interrupt": 15_000,
  "turn/start": 60_000,
  "thread/start": 60_000,
  "thread/resume": 120_000,
  "thread/read": 120_000,
  "thread/list": 60_000,
  "thread/unsubscribe": 15_000,
  "thread/name/set": 15_000,
  "model/list": 30_000,
};

export interface WritableLike {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: "drain" | "error" | "close", listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
}

export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end" | "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface JsonlRpcClientOptions {
  generation: EngineGeneration;
  stdin: WritableLike;
  stdout: ReadableLike;
  /**
   * Enqueue-only. Called synchronously from the read loop; must not do work.
   * `threadId` is null for connection-scoped notifications.
   */
  onNotification: (notification: InboundNotification, threadId: string | null) => void;
  /** Fire-and-forget. The router owns responding within its own timeout. */
  onServerRequest: (request: InboundServerRequest) => void;
  onProtocolViolation?: (detail: string, preview: string) => void;
  /**
   * Optional verbatim capture of every inbound line, for replay fixtures.
   *
   * Called from the read loop, so an implementation **must** be O(1) and must not
   * await — see `NotificationRecorder`, which buffers and flushes off-loop.
   */
  recordInboundLine?: (line: string) => void;
  maxInboundLineBytes?: number;
  maxOutboundLineBytes?: number;
  defaultTimeoutMs?: number;
  methodTimeoutsMs?: Readonly<Record<string, number>>;
  now?: () => number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

export interface RpcMetricsSnapshot {
  requestsSent: number;
  responsesReceived: number;
  errorResponses: number;
  overloadResponses: number;
  notificationsReceived: number;
  serverRequestsReceived: number;
  protocolViolations: number;
  timeouts: number;
  pendingRequests: number;
  oversizedInboundLines: number;
  writeBackpressureEvents: number;
}

export class JsonlRpcClient {
  readonly generation: EngineGeneration;

  private readonly options: JsonlRpcClientOptions;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly maxInboundLineBytes: number;
  private readonly maxOutboundLineBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly methodTimeoutsMs: Readonly<Record<string, number>>;
  private readonly now: () => number;

  /**
   * Stateful UTF-8 decoder for the raw stdout pipe.
   *
   * Chunks are split on byte boundaries, not character boundaries, so a
   * multi-byte sequence routinely straddles two chunks. Decoding each chunk
   * independently with `Buffer#toString` turns that sequence into U+FFFD, and
   * because U+FFFD is a legal JSON string character `JSON.parse` still succeeds —
   * the corruption lands silently in the user's transcript, tool arguments and
   * diffs. `StringDecoder` holds an incomplete trailing sequence back until the
   * bytes that complete it arrive.
   */
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  /**
   * Encoded size of `buffer`, tracked incrementally.
   *
   * The overflow budget is a *byte* budget, and `String#length` counts UTF-16
   * code units, so a buffer of multi-byte text is up to three times larger than
   * its length suggests. Recomputing `Buffer.byteLength` over the whole buffer on
   * every chunk would reintroduce the O(n²) scan `bufferScannedTo` exists to
   * avoid, so it is only recomputed on the (rare, bounded) slice.
   */
  private bufferBytes = 0;
  /**
   * Where the next newline scan starts. The buffered tail has already been
   * scanned and contains no newline, so only bytes appended after this offset
   * can complete a line. Without it, a multi-MB single line (a `thread/read`
   * response) re-scans the whole accumulated buffer on every chunk — O(n²).
   */
  private bufferScannedTo = 0;
  /**
   * True while the scan loop below is running.
   *
   * A dispatch handler can synchronously feed more input back in (the scripted
   * transports the bridge suite drives the engine with do exactly that). A
   * re-entrant scan would restart `lineStart` at 0 over a buffer that still holds
   * already-dispatched lines, emit a "line" spanning two records, and then let the
   * outer `finally` slice with a stale offset — losing frames outright.
   */
  private draining = false;
  private nextId = 0;
  private closed = false;
  private closeError: Error | null = null;
  /** Serializes writes so two concurrent requests cannot interleave a line. */
  private writeChain: Promise<void> = Promise.resolve();

  private metrics: RpcMetricsSnapshot = {
    requestsSent: 0,
    responsesReceived: 0,
    errorResponses: 0,
    overloadResponses: 0,
    notificationsReceived: 0,
    serverRequestsReceived: 0,
    protocolViolations: 0,
    timeouts: 0,
    pendingRequests: 0,
    oversizedInboundLines: 0,
    writeBackpressureEvents: 0,
  };

  constructor(options: JsonlRpcClientOptions) {
    this.options = options;
    this.generation = options.generation;
    this.maxInboundLineBytes = options.maxInboundLineBytes ?? DEFAULT_MAX_INBOUND_LINE_BYTES;
    this.maxOutboundLineBytes = options.maxOutboundLineBytes ?? DEFAULT_MAX_OUTBOUND_LINE_BYTES;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.methodTimeoutsMs = options.methodTimeoutsMs ?? METHOD_TIMEOUTS_MS;
    this.now = options.now ?? Date.now;

    options.stdout.on("data", (chunk) => this.handleChunk(chunk));
    options.stdout.on("end", () => this.handleStreamClosed("app-server stdout ended"));
    options.stdout.on("close", () => this.handleStreamClosed("app-server stdout closed"));
    options.stdout.on("error", (error) =>
      this.handleStreamClosed(`app-server stdout errored: ${error.message}`),
    );
  }

  getMetrics(): RpcMetricsSnapshot {
    return { ...this.metrics, pendingRequests: this.pending.size };
  }

  isClosed(): boolean {
    return this.closed;
  }

  timeoutFor(method: string): number {
    return this.methodTimeoutsMs[method] ?? this.defaultTimeoutMs;
  }

  /**
   * Splits the stream into lines. Chunks arrive fragmented and coalesced
   * arbitrarily, so a single line may span many chunks and a single chunk may
   * carry many lines plus a partial tail.
   */
  private handleChunk(chunk: Buffer | string): void {
    if (this.closed) return;
    const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.buffer += decoded;
    this.bufferBytes += Buffer.byteLength(decoded, "utf8");

    // A scan already in flight will pick the bytes just appended up on its next
    // iteration, because the loop re-reads `this.buffer` each time. Returning
    // here is therefore not a deferral — the data is consumed by the outer call.
    if (this.draining) return;
    this.draining = true;

    // Consume every complete line before slicing the buffer once, rather than
    // re-copying the remainder per line.
    let lineStart = 0;
    let scanExhausted = false;
    try {
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf("\n", this.bufferScannedTo)) >= 0) {
        // Slice off `\r` too so CRLF framing does not corrupt the JSON tail.
        const raw = this.buffer
          .slice(lineStart, newlineIndex)
          .replace(/\r$/, "");
        lineStart = newlineIndex + 1;
        this.bufferScannedTo = lineStart;
        this.dispatchLine(raw);
      }
      scanExhausted = true;
    } finally {
      // Runs even if a dispatch handler throws, so consumed lines are never
      // re-dispatched on the next chunk. Only a completed scan proved the
      // remainder holds no newline; after a mid-loop throw the remainder must
      // be rescanned from the start or a line boundary would be lost for good.
      if (lineStart > 0) {
        this.buffer = this.buffer.slice(lineStart);
        this.bufferBytes = Buffer.byteLength(this.buffer, "utf8");
      }
      this.bufferScannedTo = scanExhausted ? this.buffer.length : 0;
      // Released in `finally` so a throwing handler cannot wedge the reader shut.
      this.draining = false;
    }

    if (this.bufferBytes > this.maxInboundLineBytes) {
      // Dropping the partial line keeps the reader alive; resyncing at the next
      // newline is better than growing without bound or killing every thread.
      this.metrics.oversizedInboundLines += 1;
      this.reportViolation(
        `inbound line exceeded ${this.maxInboundLineBytes} bytes; discarding partial line`,
        "",
      );
      this.buffer = "";
      this.bufferBytes = 0;
      this.bufferScannedTo = 0;
    }
  }

  private dispatchLine(line: string): void {
    // Recorded before parsing, and verbatim, so a replay fixture also captures
    // lines our own envelope validation would reject — those are precisely the
    // ones worth seeing after a protocol change.
    if (this.options.recordInboundLine && line.trim().length > 0) {
      try {
        this.options.recordInboundLine(line);
      } catch (error) {
        console.error("[codex-bridge] notification recorder threw:", error);
      }
    }

    const message = parseInboundLine(line);
    if (!message) return;

    switch (message.kind) {
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) {
          // Late response to something we already timed out, or a duplicate id.
          this.reportViolation(`response for unknown request id ${String(message.id)}`, "");
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        this.metrics.responsesReceived += 1;
        if (message.error) {
          this.metrics.errorResponses += 1;
          const rpcError = new AppServerRpcError(pending.method, message.error);
          if (rpcError.isOverload()) this.metrics.overloadResponses += 1;
          pending.reject(rpcError);
          return;
        }
        pending.resolve(message.result);
        return;
      }
      case "server-request": {
        this.metrics.serverRequestsReceived += 1;
        // Handed off without awaiting: an unanswered server request would hang a
        // turn, but answering it must never block this loop.
        try {
          this.options.onServerRequest(message);
        } catch (error) {
          console.error("[codex-bridge] server-request handoff threw:", error);
        }
        return;
      }
      case "notification": {
        this.metrics.notificationsReceived += 1;
        try {
          this.options.onNotification(message, extractThreadId(message.params));
        } catch (error) {
          console.error("[codex-bridge] notification enqueue threw:", error);
        }
        return;
      }
      case "invalid": {
        this.metrics.protocolViolations += 1;
        this.reportViolation(message.detail, message.preview);
        return;
      }
    }
  }

  private reportViolation(detail: string, preview: string): void {
    this.options.onProtocolViolation?.(detail, preview);
  }

  /**
   * Fails every in-flight request with an ambiguous process-exit error. Callers
   * must reconcile rather than blindly retry: the write may have landed.
   */
  private handleStreamClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error =
      this.closeError
      ?? new AppServerProcessExitError(reason, { generation: this.generation });
    this.rejectAllPending(error);
  }

  private rejectAllPending(error: Error): void {
    const pendingEntries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, pending] of pendingEntries) {
      clearTimeout(pending.timer);
      pending.reject(
        error instanceof AppServerProcessExitError
          ? new AppServerProcessExitError(error.message, {
              generation: this.generation,
              exitCode: error.exitCode,
              signal: error.signal,
              method: pending.method,
            })
          : error,
      );
    }
  }

  /** Called by the supervisor when the child exits, so we can attach exit detail. */
  close(error?: Error): void {
    this.closeError = error ?? null;
    this.handleStreamClosed(error?.message ?? "app-server client closed");
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.writeLine({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Responds to a server-initiated request. */
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.writeLine({ jsonrpc: "2.0", id, result });
  }

  async respondWithError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.writeLine({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      throw new AppServerProcessExitError("app-server connection is closed", {
        generation: this.generation,
        method,
      });
    }

    this.nextId += 1;
    const id = this.nextId;
    const timeoutMs = options.timeoutMs ?? this.timeoutFor(method);

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.metrics.timeouts += 1;
          reject(new AppServerTimeoutError(method, timeoutMs));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        startedAt: this.now(),
      });
    });

    this.metrics.requestsSent += 1;
    try {
      await this.writeLine({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
      }
      throw error;
    }

    return promise;
  }

  /**
   * Serialized, back-pressure-aware write. Chaining matters: two concurrent
   * `request` calls must not interleave partial lines on stdin.
   */
  private writeLine(payload: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(payload)}\n`;
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength > this.maxOutboundLineBytes) {
      return Promise.reject(
        new AppServerProtocolError(
          `outbound message of ${byteLength} bytes exceeds the ${this.maxOutboundLineBytes} byte limit`,
        ),
      );
    }

    const attempt = this.writeChain.then(() => this.writeOnce(line));
    // Keep the chain alive after a failure so later writes are still ordered.
    this.writeChain = attempt.catch(() => undefined);
    return attempt;
  }

  private writeOnce(line: string): Promise<void> {
    const stdin = this.options.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(
        new AppServerProcessExitError("app-server stdin is no longer writable", {
          generation: this.generation,
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      const flushed = stdin.write(line, (error) => finish(error ?? null));
      if (!flushed) {
        // The kernel buffer is full. Waiting for `drain` is what keeps a large
        // prompt from being silently truncated.
        this.metrics.writeBackpressureEvents += 1;
        stdin.once("drain", () => finish(null));
        stdin.once("error", (error) => finish(error as Error));
      }
    });
  }
}

/**
 * Serial, per-key queue for notification processing.
 *
 * Ordering is guaranteed within a thread and independent across threads, so an
 * expensive rebuild on one thread cannot delay or reorder another's events.
 */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private depth = 0;
  private maxObservedDepth = 0;

  get pendingDepth(): number {
    return this.depth;
  }

  get highWaterMark(): number {
    return this.maxObservedDepth;
  }

  run(key: string, task: () => Promise<void> | void): void {
    this.depth += 1;
    this.maxObservedDepth = Math.max(this.maxObservedDepth, this.depth);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => task())
      .catch((error: unknown) => {
        console.error(`[codex-bridge] queued task for ${key} failed:`, error);
      })
      .finally(() => {
        this.depth -= 1;
        // Only clear when this task was the tail, or we would drop a queued
        // successor that is still waiting behind us.
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Resolves once everything currently queued for `key` has drained. */
  async drain(key: string): Promise<void> {
    await (this.chains.get(key) ?? Promise.resolve());
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  clear(): void {
    this.chains.clear();
    this.depth = 0;
  }
}
