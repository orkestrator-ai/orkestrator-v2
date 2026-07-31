export const TERMINAL_HTTP_INPUT_BATCH_DELAY_MS = 8;
export const TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES = 64 * 1024;

type TerminalInputCommand = "terminal_write" | "local_terminal_write";

type TerminalInputRequest = {
  command: TerminalInputCommand;
  sessionId: string;
  data: string;
};

type PendingInput = {
  data: string;
  bytes: number;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  readyToFlush: boolean;
};

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

/**
 * Batches only remote HTTP terminal writes. Each terminal has an independent
 * queue, while requests for that terminal are serialized so a slow fetch can
 * never let later input overtake earlier input.
 */
export class TerminalHttpInputBatcher {
  private readonly pending = new Map<string, PendingInput>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly send: (request: TerminalInputRequest) => Promise<void>,
    private readonly delayMs = TERMINAL_HTTP_INPUT_BATCH_DELAY_MS,
    private readonly maxBufferBytes = TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
  ) {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be non-negative");
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) {
      throw new RangeError("maxBufferBytes must be a positive integer");
    }
  }

  enqueue(request: TerminalInputRequest): Promise<void> {
    if (request.data.length === 0) return Promise.resolve();
    const key = `${request.command}\0${request.sessionId}`;
    const incomingBytes = this.encoder.encode(request.data).byteLength;
    if (incomingBytes > this.maxBufferBytes) {
      return Promise.reject(new RangeError("Terminal input exceeds the HTTP buffer limit"));
    }
    let state = this.pending.get(key);
    if (!state) {
      state = {
        data: "",
        bytes: 0,
        waiters: [],
        timer: null,
        inFlight: false,
        readyToFlush: false,
      };
      this.pending.set(key, state);
    }

    if (state.bytes > 0 && state.bytes + incomingBytes > this.maxBufferBytes) {
      if (state.inFlight) {
        return Promise.reject(new RangeError("Terminal HTTP input buffer is full"));
      }
      state.readyToFlush = true;
      this.flush(key, request.command, request.sessionId, state);
    }

    state.data += request.data;
    state.bytes += incomingBytes;
    const completion = new Promise<void>((resolve, reject) => {
      state!.waiters.push({ resolve, reject });
    });

    if (terminalInputRequiresImmediateFlush(request.data) || state.bytes === this.maxBufferBytes) {
      state.readyToFlush = true;
      this.flush(key, request.command, request.sessionId, state);
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state!.timer = null;
        state!.readyToFlush = true;
        this.flush(key, request.command, request.sessionId, state!);
      }, this.delayMs);
    }
    return completion;
  }

  private flush(
    key: string,
    command: TerminalInputCommand,
    sessionId: string,
    state: PendingInput,
  ): void {
    if (!state.readyToFlush || state.inFlight || state.bytes === 0) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const data = state.data;
    const waiters = state.waiters;
    state.data = "";
    state.bytes = 0;
    state.waiters = [];
    state.readyToFlush = false;
    state.inFlight = true;
    const operation = this.send({ command, sessionId, data });
    operation.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    ).finally(() => {
      state.inFlight = false;
      if (state.readyToFlush) {
        this.flush(key, command, sessionId, state);
      } else if (state.bytes === 0 && state.waiters.length === 0 && !state.timer) {
        this.pending.delete(key);
      }
    });
  }
}
