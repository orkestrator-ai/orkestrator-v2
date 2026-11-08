import { Effect } from "effect";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("backend");

/** A failed step: what it threw, rejected with, or the `TimeoutError` of its cap. */
export type ShutdownStepFailure = { readonly step: string; readonly error: unknown };

export interface ShutdownStepOptions {
  /** Stop waiting after this long, log the step as failed and go on. */
  readonly timeoutMs?: number;
  /** Leave the error's message out of the log line, for errors that may carry content. */
  readonly omitMessage?: boolean;
}

function logStepFailure(step: string, error: unknown, options: ShutdownStepOptions = {}): void {
  log.warn("shutdown.step-failed", {
    step,
    error: formatLogError(error, options.omitMessage ? { message: false } : undefined),
  });
}

/**
 * One awaited shutdown step as an Effect that cannot fail. A throw, a rejection
 * or a timeout is logged as `shutdown.step-failed` and returned as the value, so
 * a program of such steps runs every one of them; `null` means the step
 * succeeded. `Effect.timeout` interrupts the wait and clears its timer when the
 * step settles first, which the `Promise.race` it replaces never did. The step
 * itself is not cancelled by a timeout: it keeps running unobserved.
 */
export function shutdownStep(
  step: string,
  run: () => unknown,
  options: ShutdownStepOptions = {},
): Effect.Effect<ShutdownStepFailure | null> {
  const attempt = Effect.tryPromise({
    try: async () => {
      await run();
    },
    catch: (error) => error,
  });
  const bounded =
    options.timeoutMs === undefined ? attempt : attempt.pipe(Effect.timeout(options.timeoutMs));
  return bounded.pipe(
    Effect.as(null),
    Effect.catch((error: unknown) =>
      Effect.sync(() => {
        logStepFailure(step, error, options);
        return { step, error };
      }),
    ),
  );
}

/**
 * A synchronous stop that must not abort shutdown: a throw is logged as
 * `shutdown.step-failed` and shutdown goes on. Plain `try`/`catch` rather than
 * an Effect: nothing here is awaited or capped, so a runtime adds nothing.
 */
export function stopStepNow(step: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    logStepFailure(step, error);
  }
}

/**
 * Starts an asynchronous stop now, without awaiting it. A synchronous throw
 * becomes the returned promise's rejection instead of aborting shutdown, so the
 * caller's existing rejection handling covers both.
 */
export function beginShutdownStep<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(run()));
}
