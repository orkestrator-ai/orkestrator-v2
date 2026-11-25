/**
 * What the queues of owed Linear writes share (`linear-merged-label.ts`,
 * `linear-completion-comments.ts`): one drain at a time, re-run when asked
 * during one, re-armed for the next due record, and attempts with an overall
 * deadline. Nothing here reads Linear or storage.
 */

/** Overall deadline of one Linear write, including every response body and page. */
export const LINEAR_WRITE_TIMEOUT_MS = 30_000;
/** First retry after a failure; doubles per attempt. */
export const LINEAR_WRITE_RETRY_MS = 60_000;
/** The longest wait between attempts. */
export const LINEAR_WRITE_MAX_RETRY_MS = 60 * 60_000;
/** Why a write waits on a machine that holds no Linear key. */
export const LINEAR_NOT_CONNECTED_HERE = "Linear is not connected on this machine";

export function linearWriteRetryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 16);
  return Math.min(LINEAR_WRITE_RETRY_MS * 2 ** exponent, LINEAR_WRITE_MAX_RETRY_MS);
}

export type LinearDrainClock = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export class LinearDrainLoop {
  readonly now: () => number;
  private readonly schedule: NonNullable<LinearDrainClock["schedule"]>;
  private readonly cancel: NonNullable<LinearDrainClock["cancel"]>;
  private timer: unknown = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private attempt: AbortController | null = null;
  private stopped = false;

  /** `drain` does one pass and answers when the next is due (Infinity: not until asked). */
  constructor(
    private readonly drain: () => Promise<number>,
    private readonly onError: (error: unknown) => void,
    clock: LinearDrainClock = {},
  ) {
    this.now = clock.now ?? Date.now;
    this.schedule =
      clock.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        (timer as { unref?: () => void }).unref?.();
        return timer;
      });
    this.cancel =
      clock.cancel ?? ((timer) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
  }

  get closed(): boolean {
    return this.stopped;
  }

  /** The drain in flight, if any. */
  get running(): Promise<void> | null {
    return this.draining;
  }

  /** Starts a drain now, or once the running one finishes. */
  request(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.clearTimer();
    this.draining = this.drain()
      .then((nextDue) => {
        if (Number.isFinite(nextDue)) this.armTimer(nextDue);
      })
      .catch((error: unknown) => {
        this.onError(error);
        this.armTimer(this.now() + LINEAR_WRITE_RETRY_MS);
      })
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.request();
        }
      });
  }

  /** Runs one Linear write under the overall deadline; `stop()` aborts it. */
  async bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutReason = "Linear write attempt timed out",
  ): Promise<T> {
    const controller = new AbortController();
    this.attempt = controller;
    const timer = this.schedule(
      () => controller.abort(new Error(timeoutReason)),
      LINEAR_WRITE_TIMEOUT_MS,
    );
    try {
      return await raceAbort(run, controller.signal);
    } finally {
      this.cancel(timer);
      this.attempt = null;
    }
  }

  /** Stops the timer and the attempt in flight; later calls do nothing. */
  stop(reason: string): void {
    this.stopped = true;
    this.attempt?.abort(new Error(reason));
    this.clearTimer();
  }

  private armTimer(dueAt: number): void {
    if (this.stopped) return;
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    this.clearTimer();
    this.timerDueAt = dueAt;
    this.timer = this.schedule(
      () => {
        this.timer = null;
        this.timerDueAt = Number.POSITIVE_INFINITY;
        this.request();
      },
      Math.max(0, dueAt - this.now()),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
  }
}

/** `run`, rejected when `signal` aborts even if its transport ignores the signal. */
export async function raceAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
