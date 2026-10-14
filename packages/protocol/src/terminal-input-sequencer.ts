import {
  parseTerminalInputRequest,
  TERMINAL_HTTP_INPUT_BATCH_DELAY_MS,
  TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
  TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS,
  TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES,
  TERMINAL_HTTP_INPUT_MAX_TERMINALS,
  TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS,
  TerminalHttpInputBatcher,
  type TerminalInputCommand,
  type TerminalInputRequest,
} from "./terminal-input-batcher.js";

/** Lifecycle commands queued behind one terminal's input before refusing more. */
export const TERMINAL_MAX_PENDING_LIFECYCLE_OPERATIONS = 256;
/**
 * How many recently closed terminals keep rejecting input. Session ids are not
 * reused after a close, so the oldest can be forgotten: the worst case for an
 * evicted id is a write to a dead session, which the backend refuses.
 */
export const TERMINAL_CLOSED_SESSION_MEMORY = 256;
export const TERMINAL_INPUT_CLOSED_MESSAGE = "Terminal input is closed until the session restarts";
export const TERMINAL_INPUT_NOT_DELIVERED_MESSAGE = "Terminal session is not running";

/**
 * What re-enables input after a send failed or a lifecycle outcome was lost.
 *
 * - `rearm-on-lifecycle`: a successful resize (or a socket-accepted write)
 *   proves the transport recovered and re-arms the queue; a failed start or
 *   close leaves the terminal writable. The terminal's echo shows what the
 *   shell actually holds.
 * - `fence-until-start`: only a successful start re-arms. A failed resize,
 *   close or start fences input too, so nothing typed after an ambiguous loss
 *   can join a partially delivered prefix.
 *
 * The browser gateway uses the first and the desktop client the second. That
 * divergence is deliberate and undecided; keep it to this one switch.
 */
export type TerminalInputRecovery = "rearm-on-lifecycle" | "fence-until-start";

export type TerminalLifecycleKind = "resize" | "close" | "start";

export interface TerminalLifecycleOperation {
  /** The original command, e.g. `detach_terminal`. */
  command: string;
  args: Record<string, unknown>;
  sessionId: string;
  /** The input command this operation orders against. */
  inputCommand: TerminalInputCommand;
  kind: TerminalLifecycleKind;
}

/**
 * A channel that accepts input without waiting for the previous write's
 * acknowledgement (the browser's terminal WebSocket). `send` returns the
 * acknowledgement, or null when this write must use HTTP instead.
 */
export interface PipelinedTerminalInput {
  active(): boolean;
  send(request: TerminalInputRequest): Promise<void> | null;
}

export interface TerminalInputSequencerOptions {
  /** Sends one batched write over HTTP and resolves with the backend result. */
  sendInput(request: TerminalInputRequest, signal: AbortSignal): Promise<unknown>;
  /** Runs one lifecycle command once every earlier input has settled. */
  runLifecycle(operation: TerminalLifecycleOperation, signal: AbortSignal): Promise<unknown>;
  recovery: TerminalInputRecovery;
  pipelined?: PipelinedTerminalInput;
  batchDelayMs?: number;
  maxBatchBytes?: number;
  maxQueuedBytes?: number;
  maxPendingInputs?: number;
  maxTerminals?: number;
  /** Deadline for one write batch or lifecycle command, including the response. */
  sendTimeoutMs?: number;
  maxPendingLifecycleOperations?: number;
  closedSessionMemory?: number;
}

const LIFECYCLE_COMMANDS: Readonly<
  Record<string, { inputCommand: TerminalInputCommand; kind: TerminalLifecycleKind }>
> = {
  terminal_resize: { inputCommand: "terminal_write", kind: "resize" },
  detach_terminal: { inputCommand: "terminal_write", kind: "close" },
  start_terminal_session: { inputCommand: "terminal_write", kind: "start" },
  local_terminal_resize: { inputCommand: "local_terminal_write", kind: "resize" },
  close_local_terminal_session: { inputCommand: "local_terminal_write", kind: "close" },
  start_local_terminal_session: { inputCommand: "local_terminal_write", kind: "start" },
};

/**
 * A lifecycle command that must be ordered against one terminal's input, or
 * null. Without a string session id there is no queue to order against, so
 * the caller sends it straight through.
 */
export function parseTerminalLifecycleCommand(
  command: string,
  args: Record<string, unknown> | undefined,
): TerminalLifecycleOperation | null {
  const lifecycle = Object.hasOwn(LIFECYCLE_COMMANDS, command)
    ? LIFECYCLE_COMMANDS[command]
    : undefined;
  if (!lifecycle || typeof args?.sessionId !== "string") return null;
  return { command, args: { ...args }, sessionId: args.sessionId, ...lifecycle };
}

const queueKey = (command: TerminalInputCommand, sessionId: string): string =>
  `${command}\0${sessionId}`;

/**
 * The one ordering contract for terminal input, shared by every client
 * transport. Per terminal:
 *
 * - Input is delivered in issue order, batched and bounded by the batcher.
 * - Resize and close wait for every write issued before them, including writes
 *   still waiting for room and pipelined writes awaiting acknowledgement.
 *   Writes issued after a lifecycle command wait for it.
 * - Close fences input immediately; only a start reopens it. Start discards
 *   input queued against the previous incarnation instead of waiting for it.
 * - A failed send fails the queue closed; `recovery` decides what re-arms it.
 */
export class TerminalInputSequencer {
  private readonly batcher: TerminalHttpInputBatcher;
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly lifecycleCounts = new Map<string, number>();
  /** Serializes pipelined sends per terminal; releases before acknowledgement. */
  private readonly pipelinedSendTails = new Map<string, Promise<void>>();
  /** Outstanding pipelined acknowledgements a lifecycle command waits behind. */
  private readonly pipelinedAcks = new Map<string, Set<Promise<void>>>();
  private readonly closed = new Set<string>();
  private readonly sendTimeoutMs: number;
  private readonly maxPendingLifecycleOperations: number;
  private readonly closedSessionMemory: number;
  private disposedReason: unknown = null;
  private disposed = false;

  constructor(private readonly options: TerminalInputSequencerOptions) {
    if (options.recovery !== "rearm-on-lifecycle" && options.recovery !== "fence-until-start") {
      throw new TypeError("recovery must be rearm-on-lifecycle or fence-until-start");
    }
    this.sendTimeoutMs = options.sendTimeoutMs ?? TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS;
    this.maxPendingLifecycleOperations =
      options.maxPendingLifecycleOperations ?? TERMINAL_MAX_PENDING_LIFECYCLE_OPERATIONS;
    this.closedSessionMemory = options.closedSessionMemory ?? TERMINAL_CLOSED_SESSION_MEMORY;
    if (
      !Number.isSafeInteger(this.maxPendingLifecycleOperations) ||
      this.maxPendingLifecycleOperations < 1
    ) {
      throw new RangeError("maxPendingLifecycleOperations must be a positive integer");
    }
    if (!Number.isSafeInteger(this.closedSessionMemory) || this.closedSessionMemory < 1) {
      throw new RangeError("closedSessionMemory must be a positive integer");
    }
    this.batcher = new TerminalHttpInputBatcher(
      async (request, signal) => {
        const result = await options.sendInput(request, signal);
        // One batch fans out to every original input waiter. Rejecting it is how
        // an in-band refusal reaches all of them without weakening ordering.
        if (
          result &&
          typeof result === "object" &&
          (result as { delivered?: unknown }).delivered === false
        ) {
          throw new Error(TERMINAL_INPUT_NOT_DELIVERED_MESSAGE);
        }
      },
      options.batchDelayMs ?? TERMINAL_HTTP_INPUT_BATCH_DELAY_MS,
      options.maxBatchBytes ?? TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
      options.maxQueuedBytes ?? TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES,
      this.sendTimeoutMs,
      options.maxPendingInputs ?? TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS,
      options.maxTerminals ?? TERMINAL_HTTP_INPUT_MAX_TERMINALS,
    );
  }

  private get rearms(): boolean {
    return this.options.recovery === "rearm-on-lifecycle";
  }

  /**
   * Routes terminal input and lifecycle commands through the ordered queue.
   * Returns null for anything else, which the caller sends directly.
   */
  invoke(command: string, args: Record<string, unknown> | undefined): Promise<unknown> | null {
    const input = parseTerminalInputRequest(command, args);
    if (input) return this.write(input);
    const lifecycle = parseTerminalLifecycleCommand(command, args);
    if (lifecycle) return this.lifecycle(lifecycle);
    return null;
  }

  /** Rejects everything queued and every later call with `reason`. */
  dispose(reason: unknown = new Error("Terminal input transport disposed")): void {
    this.disposed = true;
    this.disposedReason = reason;
    this.batcher.dispose(reason);
  }

  /** Bounds usage, for tests and diagnostics. Carries no input. */
  getStats(): ReturnType<TerminalHttpInputBatcher["getStats"]> & {
    closedSessions: number;
    pendingLifecycleOperations: number;
  } {
    let pendingLifecycleOperations = 0;
    for (const count of this.lifecycleCounts.values()) pendingLifecycleOperations += count;
    return {
      ...this.batcher.getStats(),
      closedSessions: this.closed.size,
      pendingLifecycleOperations,
    };
  }

  private assertUsable(): void {
    if (this.disposed) throw this.disposedReason;
  }

  private rememberClosed(key: string): void {
    this.closed.delete(key);
    this.closed.add(key);
    while (this.closed.size > this.closedSessionMemory) {
      const oldest = this.closed.values().next().value;
      if (oldest === undefined) break;
      this.closed.delete(oldest);
    }
  }

  private async write(input: TerminalInputRequest): Promise<{ delivered: true }> {
    this.assertUsable();
    const key = queueKey(input.command, input.sessionId);
    if (this.closed.has(key)) throw new Error(TERMINAL_INPUT_CLOSED_MESSAGE);
    if (this.options.pipelined?.active()) return this.writePipelined(input, key);
    const lifecycle = this.lifecycleTails.get(key);
    if (lifecycle) await lifecycle;
    // Disposal can happen while this write waits behind a lifecycle barrier,
    // before it has entered the batcher itself.
    this.assertUsable();
    await this.batcher.enqueue(input);
    // A successful batched send is an explicit delivery verdict; an in-band
    // refusal has already rejected above.
    return { delivered: true };
  }

  /**
   * `send()` on a pipelined channel only means the bytes entered a local
   * buffer, so its acknowledgement is what a later lifecycle command must not
   * overtake. It is emphatically not what the next keystroke waits for:
   * chaining writes on acknowledgements costs a round trip per character.
   * Sends are serialized; acknowledgements are merely tracked.
   */
  private writePipelined(input: TerminalInputRequest, key: string): Promise<{ delivered: true }> {
    const previousSend =
      this.pipelinedSendTails.get(key) ?? this.lifecycleTails.get(key) ?? Promise.resolve();

    const send = previousSend
      .catch(() => undefined)
      .then(async () => {
        this.assertUsable();
        const lifecycle = this.lifecycleTails.get(key);
        if (lifecycle) await lifecycle.catch(() => undefined);
        this.assertUsable();
        const flushed = this.batcher.flush(input.command, input.sessionId);
        if (this.rearms) {
          // A latched HTTP failure must not veto a healthy channel; its
          // rejection has already reached whoever issued that write.
          await flushed.catch(() => undefined);
        } else {
          await flushed;
        }
        this.assertUsable();
        const acknowledgement = this.options.pipelined?.send(input) ?? null;
        if (acknowledgement) {
          // The channel accepted this write, so the transport has recovered.
          if (this.rearms) this.batcher.clearFailure(input.command, input.sessionId);
          // Wrapped, not returned bare: an async function adopts a returned
          // promise, which would make the send tail wait for the acknowledgement.
          return { acknowledgement };
        }
        await this.batcher.enqueue(input);
        return null;
      });

    // The send tail releases once the frame is handed off, so the next
    // keystroke follows immediately and still in order.
    const sendTail = send.then(
      () => undefined,
      () => undefined,
    );
    this.pipelinedSendTails.set(key, sendTail);
    void sendTail.finally(() => {
      if (this.pipelinedSendTails.get(key) === sendTail) this.pipelinedSendTails.delete(key);
    });

    const acknowledged = send.then((result) => result?.acknowledgement);
    const settled = acknowledged.then(
      () => undefined,
      () => undefined,
    );
    const outstanding = this.pipelinedAcks.get(key) ?? new Set<Promise<void>>();
    this.pipelinedAcks.set(key, outstanding);
    outstanding.add(settled);
    void settled.finally(() => {
      outstanding.delete(settled);
      if (outstanding.size === 0 && this.pipelinedAcks.get(key) === outstanding) {
        this.pipelinedAcks.delete(key);
      }
    });
    return acknowledged.then(() => ({ delivered: true }));
  }

  /**
   * Waits for every pipelined write already issued for one terminal. One
   * snapshot is enough: a write issued after the caller installed its
   * lifecycle tail blocks on that tail, and one issued before it is already
   * registered here.
   */
  private async drainPipelined(key: string): Promise<void> {
    const outstanding = this.pipelinedAcks.get(key);
    if (!outstanding || outstanding.size === 0) return;
    await Promise.all(outstanding);
  }

  private lifecycle(operation: TerminalLifecycleOperation): Promise<unknown> {
    try {
      this.assertUsable();
    } catch (error) {
      return Promise.reject(error);
    }
    const key = queueKey(operation.inputCommand, operation.sessionId);
    const pendingCount = this.lifecycleCounts.get(key) ?? 0;
    if (pendingCount >= this.maxPendingLifecycleOperations) {
      return Promise.reject(new Error("Terminal lifecycle queue limit exceeded"));
    }
    const previous = this.lifecycleTails.get(key) ?? Promise.resolve();

    // Install the barrier before the first await, so writes issued after this
    // call wait behind resize/start and are rejected after close. The close
    // marker is provisional under `rearm-on-lifecycle`: a close that never
    // reached the backend leaves a live terminal that must stay writable.
    if (operation.kind === "close") this.rememberClosed(key);
    if (operation.kind === "start") this.closed.delete(key);

    const run = previous.catch(() => undefined).then(() => this.runOrdered(operation, key));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleCounts.set(key, pendingCount + 1);
    this.lifecycleTails.set(key, tail);
    void tail.finally(() => {
      const remaining = (this.lifecycleCounts.get(key) ?? 1) - 1;
      if (remaining > 0) this.lifecycleCounts.set(key, remaining);
      else this.lifecycleCounts.delete(key);
      if (this.lifecycleTails.get(key) === tail) this.lifecycleTails.delete(key);
    });
    return run;
  }

  private async runOrdered(operation: TerminalLifecycleOperation, key: string): Promise<unknown> {
    // The transport may have been replaced while this command waited.
    this.assertUsable();
    const { inputCommand, sessionId } = operation;

    if (operation.kind === "start") {
      // A restart supersedes input queued against the previous incarnation, and
      // must not wait out a hung write to happen.
      this.batcher.reset(inputCommand, sessionId);
      try {
        return await this.runWithDeadline(operation);
      } catch (error) {
        if (!this.rearms) this.batcher.failQueue(inputCommand, sessionId, error);
        throw error;
      }
    }

    // A failed write has already reported its own error. Resize and close must
    // still reach the backend, but never ahead of accepted input.
    await this.batcher.flush(inputCommand, sessionId).catch(() => undefined);
    await this.drainPipelined(key);
    // Disposal also rejects the flush. Do not turn that into a stale command
    // against the backend being replaced.
    this.assertUsable();
    try {
      const result = await this.runWithDeadline(operation);
      // Resize proves the transport recovered. Without this, one transient
      // write failure would leave a terminal that streams output but refuses
      // every keystroke.
      if (operation.kind === "resize" && this.rearms) {
        this.batcher.clearFailure(inputCommand, sessionId);
      }
      return result;
    } catch (error) {
      if (this.rearms) {
        // The terminal is still alive, so undo the provisional close rather
        // than rejecting its input for the lifetime of the client.
        if (operation.kind === "close") this.closed.delete(key);
      } else if (operation.kind === "resize") {
        // A lost lifecycle response leaves terminal state uncertain too.
        this.batcher.failQueue(inputCommand, sessionId, error);
      }
      throw error;
    } finally {
      // Unconditional: whether or not the close landed, input queued against
      // the old session must not be delivered.
      if (operation.kind === "close") this.batcher.reset(inputCommand, sessionId);
    }
  }

  /** The deadline includes response decoding, even if the runner ignores abort. */
  private runWithDeadline(operation: TerminalLifecycleOperation): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Terminal ${operation.kind} command timed out after ${this.sendTimeoutMs}ms`,
        );
        controller.abort(error);
        reject(error);
      }, this.sendTimeoutMs);
    });
    const run = Promise.resolve().then(() =>
      this.options.runLifecycle(operation, controller.signal),
    );
    return Promise.race([run, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
