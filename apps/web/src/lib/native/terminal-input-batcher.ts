export const TERMINAL_HTTP_INPUT_BATCH_DELAY_MS = 8;
export const TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES = 64 * 1024;
export const TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES = 1024 * 1024;
export const TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS = 30_000;

export type TerminalInputCommand = "terminal_write" | "local_terminal_write";

export type TerminalInputRequest = {
  command: TerminalInputCommand;
  sessionId: string;
  data: string;
};

type InputWaiter = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  remainingBatches: number;
  settled: boolean;
};

type PendingBatch = {
  data: string;
  bytes: number;
  ready: boolean;
  waiters: Set<InputWaiter>;
};

type InFlightBatch = {
  batch: PendingBatch;
  controller: AbortController;
};

type PendingInput = {
  command: TerminalInputCommand;
  sessionId: string;
  batches: PendingBatch[];
  waiters: Set<InputWaiter>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: InFlightBatch | null;
  outstandingBytes: number;
  failed: boolean;
  failure: unknown | null;
  retired: boolean;
};

type TerminalInputSender = (
  request: TerminalInputRequest,
  signal: AbortSignal,
) => void | Promise<void>;

export function parseTerminalInputRequest(
  command: string,
  args: Record<string, unknown> | undefined,
): TerminalInputRequest | null {
  if (command !== "terminal_write" && command !== "local_terminal_write") return null;
  if (typeof args?.sessionId !== "string" || typeof args.data !== "string") return null;
  return { command, sessionId: args.sessionId, data: args.data };
}

/**
 * Enter, C0/DEL controls, escape sequences, and multi-code-unit chunks (the
 * boundary xterm exposes for an ordinary paste) should not wait for the typing
 * timer. The pending printable prefix is folded into the same ordered request.
 */
export function terminalInputRequiresImmediateFlush(data: string): boolean {
  return data.length !== 1 || /[\u0000-\u001f\u007f]/.test(data);
}

function createWaiter(): InputWaiter {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject, remainingBatches: 0, settled: false };
}

function splitAtUtf8Boundaries(
  data: string,
  maxBytes: number,
): Array<{ data: string; bytes: number }> {
  const chunks: Array<{ data: string; bytes: number }> = [];
  let chunkStart = 0;
  let chunkEnd = 0;
  let chunkBytes = 0;

  for (const character of data) {
    const codePoint = character.codePointAt(0)!;
    // for...of keeps valid surrogate pairs together. Lone surrogates reach
    // TextEncoder as U+FFFD, which is also three UTF-8 bytes.
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (characterBytes > maxBytes) {
      throw new RangeError("maxBufferBytes cannot contain one UTF-8 code point");
    }
    if (chunkBytes > 0 && chunkBytes + characterBytes > maxBytes) {
      chunks.push({ data: data.slice(chunkStart, chunkEnd), bytes: chunkBytes });
      chunkStart = chunkEnd;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    chunkEnd += character.length;
  }

  if (chunkBytes > 0) {
    chunks.push({ data: data.slice(chunkStart, chunkEnd), bytes: chunkBytes });
  }
  return chunks;
}

/**
 * Batches only remote HTTP terminal writes. Each terminal has an independent,
 * byte-bounded queue. Requests for one terminal are serialized and a failed or
 * timed-out send stops that queue until reset, so a suffix is never delivered
 * after an ambiguously lost prefix.
 */
export class TerminalHttpInputBatcher {
  private readonly pending = new Map<string, PendingInput>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly send: TerminalInputSender,
    private readonly delayMs = TERMINAL_HTTP_INPUT_BATCH_DELAY_MS,
    private readonly maxBufferBytes = TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
    private readonly maxQueuedBytes = TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES,
    private readonly sendTimeoutMs = TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS,
  ) {
    if (typeof send !== "function") throw new TypeError("send must be a function");
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be non-negative");
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) {
      throw new RangeError("maxBufferBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < maxBufferBytes) {
      throw new RangeError("maxQueuedBytes must be an integer at least as large as maxBufferBytes");
    }
    if (!Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0) {
      throw new RangeError("sendTimeoutMs must be positive");
    }
  }

  enqueue(request: TerminalInputRequest): Promise<void> {
    if (
      (request?.command !== "terminal_write" && request?.command !== "local_terminal_write")
      || typeof request.sessionId !== "string"
      || typeof request.data !== "string"
    ) {
      return Promise.reject(new TypeError("Invalid terminal input request"));
    }
    if (request.data.length === 0) return Promise.resolve();

    const key = this.keyFor(request.command, request.sessionId);
    let state = this.pending.get(key);
    if (state?.failed) {
      return Promise.reject(state.failure);
    }

    const incomingBytes = this.encoder.encode(request.data).byteLength;
    if (incomingBytes > this.maxQueuedBytes || (state?.outstandingBytes ?? 0) + incomingBytes > this.maxQueuedBytes) {
      return Promise.reject(new RangeError("Terminal HTTP input queue is full"));
    }

    let chunks: Array<{ data: string; bytes: number }>;
    try {
      chunks = splitAtUtf8Boundaries(request.data, this.maxBufferBytes);
    } catch (error) {
      return Promise.reject(error);
    }

    if (!state) {
      state = {
        command: request.command,
        sessionId: request.sessionId,
        batches: [],
        waiters: new Set(),
        timer: null,
        inFlight: null,
        outstandingBytes: 0,
        failed: false,
        failure: null,
        retired: false,
      };
      this.pending.set(key, state);
    }

    const waiter = createWaiter();
    state.waiters.add(waiter);
    state.outstandingBytes += incomingBytes;
    for (const chunk of chunks) this.appendChunk(state, chunk, waiter);

    const immediate = terminalInputRequiresImmediateFlush(request.data);
    if (immediate) {
      this.markReady(state);
    } else {
      const tail = state.batches.at(-1);
      if (tail?.bytes === this.maxBufferBytes) {
        this.markReady(state);
      } else {
        this.pump(key, state);
        if (state.batches.some((batch) => !batch.ready)) this.scheduleFlush(key, state);
      }
    }
    return waiter.promise;
  }

  /** Flushes all input currently accepted for one terminal. */
  flush(command: TerminalInputCommand, sessionId: string): Promise<void> {
    const state = this.pending.get(this.keyFor(command, sessionId));
    if (!state) return Promise.resolve();
    if (state.failed) return Promise.reject(state.failure);
    const completions = [...state.waiters].map((waiter) => waiter.promise);
    this.markReady(state);
    return Promise.all(completions).then(() => undefined);
  }

  /** Flushes all input currently accepted across every terminal. */
  flushAll(): Promise<void> {
    const completions = [...this.pending.values()].map((state) => {
      if (state.failed) return Promise.reject(state.failure);
      const current = [...state.waiters].map((waiter) => waiter.promise);
      this.markReady(state);
      return Promise.all(current);
    });
    return Promise.all(completions).then(() => undefined);
  }

  /**
   * Aborts and forgets one queue. Callers must reset after a send failure before
   * accepting more input for that terminal.
   */
  reset(
    command: TerminalInputCommand,
    sessionId: string,
    reason: unknown = new Error("Terminal HTTP input queue reset"),
  ): void {
    const key = this.keyFor(command, sessionId);
    const state = this.pending.get(key);
    if (!state) return;
    this.retire(key, state, reason);
  }

  /** Aborts and forgets every queue, for gateway teardown or reconnection. */
  resetAll(reason: unknown = new Error("Terminal HTTP input queues reset")): void {
    for (const [key, state] of [...this.pending]) this.retire(key, state, reason);
  }

  dispose(reason?: unknown): void {
    this.resetAll(reason);
  }

  private keyFor(command: TerminalInputCommand, sessionId: string): string {
    return `${command}\0${sessionId}`;
  }

  private appendChunk(
    state: PendingInput,
    chunk: { data: string; bytes: number },
    waiter: InputWaiter,
  ): void {
    let batch = state.batches.at(-1);
    if (!batch || batch.ready || batch.bytes + chunk.bytes > this.maxBufferBytes) {
      batch = { data: "", bytes: 0, ready: false, waiters: new Set() };
      state.batches.push(batch);
    }
    batch.data += chunk.data;
    batch.bytes += chunk.bytes;
    if (!batch.waiters.has(waiter)) {
      batch.waiters.add(waiter);
      waiter.remainingBatches += 1;
    }
  }

  private scheduleFlush(key: string, state: PendingInput): void {
    if (state.timer || state.retired || state.failed) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.retired || this.pending.get(key) !== state) return;
      this.markReady(state);
    }, this.delayMs);
  }

  private markReady(state: PendingInput): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    for (const batch of state.batches) batch.ready = true;
    this.pump(this.keyFor(state.command, state.sessionId), state);
  }

  private pump(key: string, state: PendingInput): void {
    if (state.retired || state.failed || state.inFlight) return;
    const batch = state.batches[0];
    if (!batch?.ready) return;
    state.batches.shift();

    const controller = new AbortController();
    const inFlight = { batch, controller };
    state.inFlight = inFlight;
    this.sendWithTimeout(
      { command: state.command, sessionId: state.sessionId, data: batch.data },
      controller,
    ).then(
      () => this.completeBatch(key, state, inFlight),
      (error) => this.fail(key, state, error),
    );
  }

  private sendWithTimeout(request: TerminalInputRequest, controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Terminal HTTP input send timed out after ${this.sendTimeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.sendTimeoutMs);
    });
    const operation = Promise.resolve().then(() => this.send(request, controller.signal));
    return Promise.race([operation, timeout]).then(() => undefined).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private completeBatch(
    key: string,
    state: PendingInput,
    inFlight: InFlightBatch,
  ): void {
    if (state.retired || state.inFlight !== inFlight || this.pending.get(key) !== state) return;
    state.inFlight = null;
    state.outstandingBytes -= inFlight.batch.bytes;
    for (const waiter of inFlight.batch.waiters) {
      waiter.remainingBatches -= 1;
      if (waiter.remainingBatches === 0 && !waiter.settled) {
        waiter.settled = true;
        state.waiters.delete(waiter);
        waiter.resolve();
      }
    }
    this.pump(key, state);
    if (!state.inFlight && state.batches.length === 0 && state.waiters.size === 0 && !state.timer) {
      this.pending.delete(key);
    }
  }

  private fail(key: string, state: PendingInput, error: unknown): void {
    if (state.retired || this.pending.get(key) !== state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.inFlight?.controller.abort(error);
    state.inFlight = null;
    state.batches = [];
    state.outstandingBytes = 0;
    state.failed = true;
    state.failure = error;
    for (const waiter of state.waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(error);
    }
    state.waiters.clear();
  }

  private retire(key: string, state: PendingInput, reason: unknown): void {
    state.retired = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.inFlight?.controller.abort(reason);
    state.inFlight = null;
    state.batches = [];
    state.outstandingBytes = 0;
    for (const waiter of state.waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(reason);
    }
    state.waiters.clear();
    if (this.pending.get(key) === state) this.pending.delete(key);
  }
}
