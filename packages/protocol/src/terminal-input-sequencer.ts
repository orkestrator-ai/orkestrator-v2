import {
  parseTerminalInputRequest,
  TERMINAL_HTTP_INPUT_BATCH_DELAY_MS,
  TERMINAL_HTTP_INPUT_MAX_BUFFER_BYTES,
  TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS,
  TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES,
  TERMINAL_HTTP_INPUT_MAX_TERMINALS,
  TERMINAL_HTTP_INPUT_SEND_TIMEOUT_MS,
  TERMINAL_HTTP_INPUT_PARKED_CEILINGS,
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
 * Client-side commands that re-arm one terminal's input after a failure fence,
 * one per input family. The sequencer answers them and never sends them to the
 * backend, because the fence they clear lives in the client queue.
 */
export const TERMINAL_INPUT_RESUME_COMMAND = "terminal_input_resume";
export const LOCAL_TERMINAL_INPUT_RESUME_COMMAND = "local_terminal_input_resume";

export interface TerminalInputResumeResult {
  /** False when nothing was fenced, or the terminal is closed. */
  resumed: boolean;
}

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

const RESUME_COMMANDS: Readonly<Record<string, TerminalInputCommand>> = {
  [TERMINAL_INPUT_RESUME_COMMAND]: "terminal_write",
  [LOCAL_TERMINAL_INPUT_RESUME_COMMAND]: "local_terminal_write",
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

interface InputReservation {
  bytes: number;
  controller: AbortController;
  currentSession: boolean;
}

const queueKey = (command: TerminalInputCommand, sessionId: string): string =>
  `${command}\0${sessionId}`;

/**
 * The one ordering contract for terminal input, shared by every client
 * transport. Per terminal:
 *
 * - Input is reserved at issue time, delivered in order, and batched. The
 *   reservation covers lifecycle waits and socket acknowledgements too.
 * - Resize and close wait for every write issued before them, including writes
 *   still waiting for room and pipelined writes awaiting acknowledgement.
 *   Writes issued after a lifecycle command wait for it.
 * - Close fences input immediately; only a start reopens it. Start discards
 *   input queued against the previous incarnation instead of waiting for it.
 * - A failed send, or a lost resize, close or start outcome, fences input so
 *   nothing typed after an ambiguous loss can join a partially delivered
 *   prefix. Nothing re-arms it automatically: only a successful start, or an
 *   explicit resume once the user has checked the terminal.
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
  private readonly encoder = new TextEncoder();
  private readonly lifecycleControllers = new Set<AbortController>();
  private readonly sendTimeoutMs: number;
  private readonly maxPendingLifecycleOperations: number;
  private readonly closedSessionMemory: number;
  /** Reservations include writes waiting for lifecycle or socket acknowledgement. */
  private readonly inputs = new Map<string, Set<InputReservation>>();
  private readonly overflowFailures = new Map<string, unknown>();
  private disposedReason: unknown = null;
  private disposed = false;

  constructor(private readonly options: TerminalInputSequencerOptions) {
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

  /**
   * Routes terminal input, lifecycle and resume commands through the ordered
   * queue. Returns null for anything else, which the caller sends directly.
   */
  invoke(command: string, args: Record<string, unknown> | undefined): Promise<unknown> | null {
    const input = parseTerminalInputRequest(command, args);
    if (input) return this.write(input);
    const lifecycle = parseTerminalLifecycleCommand(command, args);
    if (lifecycle) return this.lifecycle(lifecycle);
    if (Object.hasOwn(RESUME_COMMANDS, command)) {
      // Answered here even when malformed: the backend has no such command.
      if (typeof args?.sessionId !== "string") {
        return Promise.reject(new TypeError(`${command} requires a string sessionId`));
      }
      return this.resume(RESUME_COMMANDS[command]!, args.sessionId);
    }
    return null;
  }

  /** Rejects everything queued and every later call with `reason`. */
  dispose(reason: unknown = new Error("Terminal input transport disposed")): void {
    this.disposed = true;
    this.disposedReason = reason;
    this.batcher.dispose(reason);
    for (const controller of this.lifecycleControllers) controller.abort(reason);
    for (const entries of this.inputs.values()) {
      for (const entry of entries) entry.controller.abort(reason);
    }
    this.overflowFailures.clear();
  }

  /** Bounds usage, for tests and diagnostics. Carries no input. */
  getStats(): ReturnType<TerminalHttpInputBatcher["getStats"]> & {
    closedSessions: number;
    pendingLifecycleOperations: number;
    reservedInputBytes: number;
  } {
    let pendingLifecycleOperations = 0;
    for (const count of this.lifecycleCounts.values()) pendingLifecycleOperations += count;
    let pendingInputs = 0;
    let reservedInputBytes = 0;
    for (const entries of this.inputs.values()) {
      pendingInputs += entries.size;
      for (const entry of entries) reservedInputBytes += entry.bytes;
    }
    return {
      ...this.batcher.getStats(),
      pendingInputs,
      reservedInputBytes,
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
    const maxBytes = this.options.maxQueuedBytes ?? TERMINAL_HTTP_INPUT_MAX_QUEUED_BYTES;
    const bytes = this.encoder.encode(input.data).byteLength;
    if (bytes > maxBytes)
      throw new RangeError(`Terminal input exceeds the ${maxBytes}-byte terminal queue limit`);
    const releaseTerminal = this.batcher.reserveTerminal(input.command, input.sessionId);
    const entries = this.inputs.get(key) ?? new Set<InputReservation>();
    let retainedBytes = 0;
    for (const entry of entries) retainedBytes += entry.bytes;
    if (
      entries.size >= (this.options.maxPendingInputs ?? TERMINAL_HTTP_INPUT_MAX_PENDING_INPUTS) ||
      retainedBytes + bytes > maxBytes * (1 + TERMINAL_HTTP_INPUT_PARKED_CEILINGS)
    ) {
      const error = new RangeError(
        "Terminal input queue limit exceeded; restart the session before sending more input",
      );
      this.overflowFailures.set(key, error);
      this.batcher.failQueue(input.command, input.sessionId, error);
      for (const entry of entries) entry.controller.abort(error);
      releaseTerminal();
      throw error;
    }
    const entry = {
      bytes,
      controller: new AbortController(),
      currentSession: true,
    };
    entries.add(entry);
    this.inputs.set(key, entries);
    const signal = entry.controller.signal;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    // Register the cancellation race before running work, even for synchronous overflow.
    const run = async () => {
      if (this.options.pipelined?.active())
        return this.writePipelined(input, key, entry, cancelled);
      const lifecycle = this.lifecycleTails.get(key);
      if (lifecycle) await Promise.race([lifecycle, cancelled]);
      this.assertUsable();
      signal.throwIfAborted();
      if (this.overflowFailures.has(key)) throw this.overflowFailures.get(key);
      await this.batcher.enqueue(input);
      return { delivered: true as const };
    };
    try {
      return await Promise.race([run(), cancelled]);
    } finally {
      signal.removeEventListener("abort", cancel);
      entries.delete(entry);
      if (entries.size === 0 && this.inputs.get(key) === entries) this.inputs.delete(key);
      releaseTerminal();
    }
  }

  /**
   * `send()` on a pipelined channel only means the bytes entered a local
   * buffer, so its acknowledgement is what a later lifecycle command must not
   * overtake. It is emphatically not what the next keystroke waits for:
   * chaining writes on acknowledgements costs a round trip per character.
   * Sends are serialized; acknowledgements are merely tracked.
   */
  private writePipelined(
    input: TerminalInputRequest,
    key: string,
    entry: InputReservation,
    cancelled: Promise<never>,
  ): Promise<{ delivered: true }> {
    const signal = entry.controller.signal;
    const lifecycle = this.lifecycleTails.get(key);
    const previousSend = this.pipelinedSendTails.get(key) ?? lifecycle ?? Promise.resolve();

    const fail = (error: unknown): never => {
      // A start supersedes old reservations; overflow and disposal cancel
      // them. Late failures must never fence the replacement session.
      if (entry.currentSession && !signal.aborted && !this.disposed) {
        this.batcher.failQueue(input.command, input.sessionId, error);
        for (const entry of this.inputs.get(key) ?? []) entry.controller.abort(error);
      }
      throw error;
    };

    const send = Promise.race([previousSend, cancelled])
      .catch(() => undefined)
      .then(async () => {
        signal.throwIfAborted();
        this.assertUsable();
        if (lifecycle) await Promise.race([lifecycle, cancelled]);
        this.assertUsable();
        signal.throwIfAborted();
        if (this.overflowFailures.has(key)) throw this.overflowFailures.get(key);
        // A latched HTTP failure vetoes the channel too: a healthy socket says
        // nothing about how much of the lost write reached the shell.
        await Promise.race([this.batcher.flush(input.command, input.sessionId), cancelled]);
        this.assertUsable();
        signal.throwIfAborted();
        const acknowledgement = this.options.pipelined?.send(input) ?? null;
        if (acknowledgement) {
          // Wrapped, not returned bare: an async function adopts a returned
          // promise, which would make the send tail wait for the acknowledgement.
          return { acknowledgement: acknowledgement.catch(fail) };
        }
        await this.batcher.enqueue(input);
        return null;
      })
      .catch(fail);

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

    const acknowledged = Promise.race([send.then((result) => result?.acknowledgement), cancelled]);
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
    let releaseTerminal: () => void;
    try {
      releaseTerminal = this.batcher.reserveTerminal(operation.inputCommand, operation.sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (operation.kind === "start") {
      this.overflowFailures.delete(key);
      // An earlier close still drains its input before this start. Mark old
      // reservations instead of cancelling them, so their late failures cannot
      // fence the replacement session or change that lifecycle ordering.
      for (const entry of this.inputs.get(key) ?? []) entry.currentSession = false;
    }
    // Snapshot at issue time. Later writes wait on this lifecycle and cannot
    // become part of the acknowledgements it drains without forming a cycle.
    const priorPipelined = Array.from(this.pipelinedAcks.get(key) ?? []);

    // Install the barrier before the first await, so writes issued after this
    // call wait behind resize/start and are rejected after close. The close
    // marker stands even if the close never lands; only a start clears it.
    if (operation.kind === "close") this.rememberClosed(key);
    if (operation.kind === "start") this.closed.delete(key);

    return this.chainLifecycle(
      key,
      () => this.runOrdered(operation, key, priorPipelined),
      releaseTerminal,
    );
  }

  /**
   * Clears one terminal's failure fence once every lifecycle command issued
   * before it has settled, so a resume cannot jump ahead of a close or start.
   * It never reopens a closed terminal; only a start does that.
   */
  private resume(
    inputCommand: TerminalInputCommand,
    sessionId: string,
  ): Promise<TerminalInputResumeResult> {
    try {
      this.assertUsable();
    } catch (error) {
      return Promise.reject(error);
    }
    const key = queueKey(inputCommand, sessionId);
    if ((this.lifecycleCounts.get(key) ?? 0) >= this.maxPendingLifecycleOperations) {
      return Promise.reject(new Error("Terminal lifecycle queue limit exceeded"));
    }
    return this.chainLifecycle(key, async () => {
      this.assertUsable();
      if (this.closed.has(key)) return { resumed: false };
      const overflowed = this.overflowFailures.delete(key);
      const failed = this.batcher.clearFailure(inputCommand, sessionId);
      return { resumed: overflowed || failed };
    });
  }

  /** Runs `task` after this terminal's lifecycle tail and becomes the new tail. */
  private chainLifecycle<T>(
    key: string,
    task: () => Promise<T>,
    onSettled?: () => void,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleCounts.set(key, (this.lifecycleCounts.get(key) ?? 0) + 1);
    this.lifecycleTails.set(key, tail);
    void tail.finally(() => {
      onSettled?.();
      const remaining = (this.lifecycleCounts.get(key) ?? 1) - 1;
      if (remaining > 0) this.lifecycleCounts.set(key, remaining);
      else this.lifecycleCounts.delete(key);
      if (this.lifecycleTails.get(key) === tail) this.lifecycleTails.delete(key);
    });
    return run;
  }

  private async runOrdered(
    operation: TerminalLifecycleOperation,
    key: string,
    priorPipelined: Promise<void>[],
  ): Promise<unknown> {
    // The transport may have been replaced while this command waited.
    this.assertUsable();
    const { inputCommand, sessionId } = operation;

    if (operation.kind === "start") {
      // A restart supersedes input queued against the previous incarnation, and
      // must not wait out a hung write to happen.
      this.batcher.reset(inputCommand, sessionId);
      // Overflow may occur after start was issued but before this continuation runs.
      if (this.overflowFailures.has(key)) {
        this.batcher.failQueue(inputCommand, sessionId, this.overflowFailures.get(key));
      }
      try {
        return await this.runWithDeadline(operation);
      } catch (error) {
        if (!this.disposed) this.batcher.failQueue(inputCommand, sessionId, error);
        throw error;
      }
    }

    // A failed write has already reported its own error. Resize and close must
    // still reach the backend, but never ahead of accepted input.
    await this.batcher.flush(inputCommand, sessionId).catch(() => undefined);
    await Promise.all(priorPipelined);
    // Disposal also rejects the flush. Do not turn that into a stale command
    // against the backend being replaced.
    this.assertUsable();
    try {
      // A successful resize says nothing about what a lost write delivered, so
      // it does not re-arm a fenced terminal.
      return await this.runWithDeadline(operation);
    } catch (error) {
      if (operation.kind === "resize" && !this.disposed) {
        // A lost lifecycle response leaves terminal state uncertain too.
        this.batcher.failQueue(inputCommand, sessionId, error);
      }
      throw error;
    } finally {
      // Unconditional: whether or not the close landed, input queued against
      // the old session must not be delivered.
      if (operation.kind === "close") {
        this.overflowFailures.delete(key);
        this.batcher.reset(inputCommand, sessionId);
      }
    }
  }

  /** The deadline includes response decoding, even if the runner ignores abort. */
  private runWithDeadline(operation: TerminalLifecycleOperation): Promise<unknown> {
    const controller = new AbortController();
    this.lifecycleControllers.add(controller);
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
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
    const run = Promise.resolve().then(() => {
      this.assertUsable();
      controller.signal.throwIfAborted();
      return this.options.runLifecycle(operation, controller.signal);
    });
    return Promise.race([run, timeout, aborted]).finally(() => {
      this.lifecycleControllers.delete(controller);
      controller.signal.removeEventListener("abort", rejectAbort);
      if (timer) clearTimeout(timer);
    });
  }
}
