/**
 * In-memory stand-ins for a `codex app-server --stdio` child.
 *
 * Deliberately raw: tests push exact byte sequences so JSONL framing edge cases
 * (fragmented lines, several messages per chunk, CRLF, oversized lines) are
 * exercised as the real stream would deliver them rather than as tidy objects.
 */
import type { ReadableLike, WritableLike } from "../jsonl-rpc-client.js";

type Listener = (...args: unknown[]) => void;

export class FakeReadable implements ReadableLike {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end" | "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(event, set);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  /** Pushes an exact chunk, which may contain zero, partial, or many lines. */
  push(chunk: string): void {
    this.emit("data", chunk);
  }

  /** Pushes one complete JSON message plus its newline terminator. */
  pushMessage(message: unknown): void {
    this.push(`${JSON.stringify(message)}\n`);
  }

  end(): void {
    this.emit("end");
  }

  destroy(error?: Error): void {
    if (error) this.emit("error", error);
    else this.emit("close");
  }
}

export interface FakeWritableOptions {
  /**
   * Return false to simulate a full kernel buffer, forcing the client to wait
   * for `drain` before it considers the write complete.
   */
  applyBackpressure?: (line: string, index: number) => boolean;
  /** Fail a specific write, e.g. to model a stdin that closed mid-request. */
  failWith?: (line: string, index: number) => Error | null;
}

export class FakeWritable implements WritableLike {
  readonly lines: string[] = [];
  destroyed = false;
  writableEnded = false;

  private readonly listeners = new Map<string, Set<Listener>>();
  private writeCount = 0;
  private pendingDrain = false;

  constructor(private readonly options: FakeWritableOptions = {}) {}

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const index = this.writeCount;
    this.writeCount += 1;

    const failure = this.options.failWith?.(chunk, index) ?? null;
    if (failure) {
      callback?.(failure);
      return true;
    }

    this.lines.push(chunk);

    const backpressured = this.options.applyBackpressure?.(chunk, index) ?? false;
    if (backpressured) {
      // Withhold the callback: the client must wait on `drain`.
      this.pendingDrain = true;
      return false;
    }

    callback?.(null);
    return true;
  }

  once(event: "drain" | "error" | "close", listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    const wrapped: Listener = (...args) => {
      set.delete(wrapped);
      listener(...args);
    };
    set.add(wrapped);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  off(event: string, listener: Listener): void {
    this.removeListener(event, listener);
  }

  /** Releases a withheld write, as the OS would when the buffer empties. */
  drain(): void {
    if (!this.pendingDrain) return;
    this.pendingDrain = false;
    for (const listener of [...(this.listeners.get("drain") ?? [])]) listener();
  }

  isAwaitingDrain(): boolean {
    return this.pendingDrain;
  }

  /** Parsed view of everything written, for assertions. */
  parsed(): Array<Record<string, unknown>> {
    return this.lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  lastRequest(): Record<string, unknown> | undefined {
    return this.parsed().at(-1);
  }
}

/**
 * A scripted app-server: answers requests from a method → handler map and can
 * emit notifications, letting tests drive realistic request/notification
 * interleavings without a real binary.
 */
export class ScriptedAppServer {
  readonly stdout = new FakeReadable();
  readonly stdin: FakeWritable;
  readonly received: Array<{ id?: unknown; method: string; params: unknown }> = [];

  constructor(
    private readonly handlers: Record<
      string,
      (params: unknown, id: unknown) => unknown | Promise<unknown>
    > = {},
    writableOptions: FakeWritableOptions = {},
  ) {
    this.stdin = new FakeWritable({
      ...writableOptions,
      applyBackpressure: writableOptions.applyBackpressure,
    });
  }

  /**
   * Processes everything the client has written since the last call, replying
   * via the scripted handlers. Unknown methods get a JSON-RPC -32601.
   */
  async flush(): Promise<void> {
    // The client's write path is a promise chain, so a request issued on this
    // tick has not reached stdin yet. Yield once so `flush()` observes it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const parsed = this.stdin.parsed();
    const unseen = parsed.slice(this.received.length);
    for (const message of unseen) {
      const method = String(message.method ?? "");
      this.received.push({ id: message.id, method, params: message.params });
      if (message.id === undefined) continue;

      const handler = this.handlers[method];
      if (!handler) {
        this.stdout.pushMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unknown method ${method}` },
        });
        continue;
      }
      try {
        const result = await handler(message.params, message.id);
        this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.stdout.pushMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  notify(method: string, params: unknown, emittedAtMs?: number): void {
    this.stdout.pushMessage({
      jsonrpc: "2.0",
      method,
      params,
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    });
  }

  /** Sends a server-initiated request the client is obliged to answer. */
  requestFromServer(id: string | number, method: string, params: unknown): void {
    this.stdout.pushMessage({ jsonrpc: "2.0", id, method, params });
  }

  /** Replies with the retryable overload code. */
  rejectWithOverload(id: string | number): void {
    this.stdout.pushMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message: "ingress queue full" },
    });
  }

  exit(): void {
    this.stdin.destroyed = true;
    this.stdout.end();
  }
}
