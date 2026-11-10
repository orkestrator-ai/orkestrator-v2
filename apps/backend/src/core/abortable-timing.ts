/**
 * The backend's shared abort-aware sleep, timeout and retry (to-do 7543 item 3).
 *
 * Each helper is an Effect, so tests drive it with `TestClock`, plus a promise
 * edge for the promise-based callers. A timer is always cleared when the wait
 * ends early, and a stop reaches the work through its `AbortSignal` wherever
 * the work takes one.
 *
 * **Abort convention.** {@link abortableSleep} *resolves* `false` when its
 * signal aborts (and `true` when the full delay elapsed); it never rejects.
 * Abort is how an owner stops a poll or a retry wait, which is the expected
 * path rather than a failure, and a sleep that rejected would turn every
 * shared signal's abort into a rejection each waiter must handle (an unhandled
 * one is fatal in the backend; AGENTS.md "Unhandled Rejections Are Fatal").
 * A caller whose contract is to reject on abort adapts at its call site:
 * `if (!(await abortableSleep(ms, signal))) throw signal.reason`.
 *
 * {@link runWithTimeout} and {@link retryWithBackoff} produce a value, so they
 * have nothing to resolve with on abort: they reject with the signal's
 * `reason`, as `fetch` does.
 */
import { Cause, Data, Duration, Effect, Exit, Schedule } from "effect";

/** Work that did not settle within its limit. Its `AbortSignal` was aborted. */
export class WorkTimeoutError extends Data.TaggedError("WorkTimeoutError")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

/** A non-negative delay; `NaN` waits no time, as `setTimeout` does. */
function delayMillis(ms: number): Duration.Duration {
  return Duration.millis(Number.isNaN(ms) ? 0 : Math.max(0, ms));
}

/** Completes once `signal` aborts, removing its listener when interrupted first. */
function whenAborted(signal: AbortSignal): Effect.Effect<false> {
  return Effect.callback<false>((resume) => {
    const onAbort = () => resume(Effect.succeed(false));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Sleeps `ms` on the Effect clock: `true` once the delay elapsed, `false` as
 * soon as `signal` aborts (at once when it already has). Either way the loser
 * is interrupted, so the timer is cleared and the abort listener removed.
 */
export function abortableSleepEffect(ms: number, signal?: AbortSignal): Effect.Effect<boolean> {
  const slept = Effect.sleep(delayMillis(ms)).pipe(Effect.as(true));
  if (!signal) return slept;
  return Effect.suspend(() =>
    signal.aborted ? Effect.succeed(false) : Effect.race(slept, whenAborted(signal)),
  );
}

/**
 * Sleeps `ms`; resolves `true` once the delay elapsed or `false` when `signal`
 * aborted first. Never rejects (see the module's abort convention).
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return Effect.runPromise(abortableSleepEffect(ms, signal));
}

/**
 * Promise work as an Effect. The work's `AbortSignal` aborts when the Effect
 * is interrupted (a timeout, a caller's abort), and its rejection becomes the
 * typed failure unchanged.
 */
export function abortableWork<A>(
  work: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, unknown> {
  // `tryPromise` passes a signal only to a thunk that declares a parameter.
  return Effect.tryPromise({ try: (signal) => work(signal), catch: (error) => error });
}

export interface TimeoutOptions {
  readonly timeoutMs: number;
  /** The {@link WorkTimeoutError}'s message; defaults to a generic one. */
  readonly message?: string;
}

/**
 * Fails with a {@link WorkTimeoutError} when `effect` has not completed within
 * `timeoutMs`. The effect is interrupted, which aborts the signal an
 * {@link abortableWork} passed to its work, and the timer is cleared when the
 * effect settles first.
 */
export function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: TimeoutOptions,
): Effect.Effect<A, E | WorkTimeoutError, R> {
  const { timeoutMs } = options;
  return Effect.timeoutOrElse(effect, {
    duration: delayMillis(timeoutMs),
    orElse: () =>
      Effect.fail(
        new WorkTimeoutError({
          message: options.message ?? `The operation did not finish within ${timeoutMs}ms.`,
          timeoutMs,
        }),
      ),
  });
}

export interface RetryPolicy {
  /** Attempts in total, the first included. At least one is always made. */
  readonly maxAttempts: number;
  /** The delay before the first retry; each later one doubles it. */
  readonly baseDelayMs: number;
  /** No delay is longer than this, jitter included. */
  readonly maxDelayMs: number;
  /**
   * Whether a failure may be retried. One that may not (an authentication
   * failure, say) fails at once with attempts to spare. Defaults to every one.
   */
  readonly retryable?: (error: unknown) => boolean;
  /** Spread each delay by a random factor in [0.8, 1.2) before the cap. Default true. */
  readonly jitter?: boolean;
}

/**
 * A capped, optionally jittered exponential `Schedule` that stops after
 * `maxAttempts` attempts or at the first failure `retryable` rejects.
 */
export function retrySchedule<E = unknown>(
  policy: RetryPolicy,
): Schedule.Schedule<Duration.Duration, E> {
  const exponential = Schedule.exponential(delayMillis(policy.baseDelayMs));
  const spread = policy.jitter === false ? exponential : Schedule.jittered(exponential);
  const cap = delayMillis(policy.maxDelayMs);
  const retryable = policy.retryable;
  return spread.pipe(
    // The cap applies after jitter, so it is a true ceiling.
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, cap))),
    Schedule.upTo({ times: Math.max(0, Math.floor(policy.maxAttempts) - 1) }),
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => (retryable ? retryable(input) : true)),
  );
}

/** `effect` retried on `policy`; the last failure is propagated once it stops. */
export function withRetry<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  policy: RetryPolicy,
): Effect.Effect<A, E, R> {
  return Effect.retry(effect, retrySchedule<E>(policy));
}

/**
 * The promise edge: runs `effect`, resolving its value or rejecting with its
 * failure as thrown. When `signal` aborts first the effect is interrupted
 * (timers cleared, an {@link abortableWork}'s signal aborted) and the promise
 * rejects with the signal's `reason`.
 */
export async function runAbortable<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  if (signal?.aborted) throw signal.reason;
  const exit = await Effect.runPromiseExit(effect, signal ? { signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  if (!Cause.hasFails(exit.cause) && signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}

/**
 * Runs `work` with a deadline. When it fires, the work's signal aborts (so a
 * callee that takes one stops) and this rejects with a {@link WorkTimeoutError}.
 * `options.signal` aborts it early, rejecting with that signal's reason.
 */
export function runWithTimeout<A>(
  work: (signal: AbortSignal) => PromiseLike<A>,
  options: TimeoutOptions & { readonly signal?: AbortSignal },
): Promise<A> {
  return runAbortable(withTimeout(abortableWork(work), options), options.signal);
}

/**
 * Runs `work` until it succeeds or `policy` stops retrying, rejecting with the
 * last failure. `attempt` counts from 1. `policy.signal` aborts the running
 * attempt's signal and any pending delay, rejecting with that signal's reason.
 */
export function retryWithBackoff<A>(
  work: (signal: AbortSignal, attempt: number) => PromiseLike<A>,
  policy: RetryPolicy & { readonly signal?: AbortSignal },
): Promise<A> {
  let attempt = 0;
  const once = Effect.suspend(() => {
    attempt += 1;
    const current = attempt;
    return abortableWork((signal) => work(signal, current));
  });
  return runAbortable(withRetry(once, policy), policy.signal);
}
