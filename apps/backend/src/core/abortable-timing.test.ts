import { afterEach, describe, expect, test } from "bun:test";
import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  abortableSleep,
  abortableSleepEffect,
  abortableWork,
  retryWithBackoff,
  runWithTimeout,
  withRetry,
  withTimeout,
  WorkTimeoutError,
} from "./abortable-timing.js";

/** Runs `program` with a `TestClock`, so only `TestClock.adjust` moves time. */
function onTestClock<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(Effect.provide(program, TestClock.layer()));
}

/** Lets promise work that a woken fiber started settle before time moves on. */
const turn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

/** Records every timer set for `ms` and whether it was cleared. */
function spyOnTimers(ms: number) {
  const armed = new Set<unknown>();
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(handler, delay, ...args);
    if (delay === ms) armed.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    if (armed.has(handle)) cleared.add(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  return { armed, cleared };
}

describe("abortableSleep", () => {
  test("resolves true only once the full delay has elapsed", async () => {
    const result = await onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(abortableSleepEffect(1_000));
        yield* TestClock.adjust(999);
        const early = fiber.pollUnsafe();
        yield* TestClock.adjust(1);
        return { early, slept: yield* Fiber.join(fiber) };
      }),
    );
    expect(result.early).toBeUndefined();
    expect(result.slept).toBe(true);
  });

  test("resolves false at once when the signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const result = await onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(abortableSleepEffect(60_000, controller.signal));
        yield* TestClock.adjust(500);
        controller.abort();
        return yield* Fiber.join(fiber);
      }),
    );
    expect(result).toBe(false);
  });

  test("an already aborted signal resolves false without arming a timer", async () => {
    const timers = spyOnTimers(60_000);
    const controller = new AbortController();
    controller.abort();
    expect(await abortableSleep(60_000, controller.signal)).toBe(false);
    expect(timers.armed.size).toBe(0);
  });

  test("an abort after the start clears the timer and resolves false", async () => {
    const timers = spyOnTimers(60_000);
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    expect(timers.armed.size).toBe(1);
    controller.abort(new Error("stopped"));
    expect(await sleeping).toBe(false);
    expect(timers.cleared).toEqual(timers.armed);
  });

  test("a completed sleep removes its abort listener", async () => {
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      added.push(listener);
      add(type, listener, options as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListener) => {
      removed.push(listener);
      remove(type, listener);
    }) as typeof signal.removeEventListener;
    expect(await abortableSleep(1, signal)).toBe(true);
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
});

describe("withTimeout", () => {
  test("fails with WorkTimeoutError at the deadline and aborts the work's signal", async () => {
    let workSignal: AbortSignal | undefined;
    const work = abortableWork(
      (signal) =>
        new Promise<string>(() => {
          workSignal = signal;
        }),
    );
    const exit = await onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(withTimeout(work, { timeoutMs: 1_000, message: "too slow" })),
        );
        yield* TestClock.adjust(999);
        expect(workSignal?.aborted).toBe(false);
        yield* TestClock.adjust(1);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    expect(error && "error" in error ? error.error : undefined).toBeInstanceOf(WorkTimeoutError);
    expect(workSignal?.aborted).toBe(true);
  });

  test("returns the work's value when it settles first", async () => {
    const value = await onTestClock(
      withTimeout(
        abortableWork(async () => "done"),
        { timeoutMs: 1_000 },
      ),
    );
    expect(value).toBe("done");
  });

  test("the promise edge rejects with the timeout and cancels the work", async () => {
    let workSignal: AbortSignal | undefined;
    const outcome = await runWithTimeout(
      (signal) =>
        new Promise<string>((_, reject) => {
          workSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      { timeoutMs: 5, message: "the probe timed out" },
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(WorkTimeoutError);
    expect((outcome as WorkTimeoutError).message).toBe("the probe timed out");
    expect(workSignal?.aborted).toBe(true);
  });

  test("the promise edge passes the work's own rejection through", async () => {
    const failure = new Error("refused");
    const outcome = await runWithTimeout(() => Promise.reject(failure), {
      timeoutMs: 60_000,
    }).catch((error: unknown) => error);
    expect(outcome).toBe(failure);
  });

  test("the caller's signal rejects with its reason and aborts the work", async () => {
    const controller = new AbortController();
    let workSignal: AbortSignal | undefined;
    const running = runWithTimeout(
      (signal) =>
        new Promise<string>(() => {
          workSignal = signal;
        }),
      { timeoutMs: 60_000, signal: controller.signal },
    ).catch((error: unknown) => error);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    const reason = new Error("caller stopped");
    controller.abort(reason);
    expect(await running).toBe(reason);
    expect(workSignal?.aborted).toBe(true);
  });
});

describe("withRetry", () => {
  /** An attempt that records the clock and fails with `error`. */
  function failingAttempt(times: number[], error: unknown = new Error("unreachable")) {
    return Effect.gen(function* () {
      times.push(yield* Clock.currentTimeMillis);
      return yield* Effect.fail(error);
    });
  }

  test("backs off exponentially, caps the delay and stops after maxAttempts", async () => {
    const times: number[] = [];
    const exit = await onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            withRetry(failingAttempt(times), {
              maxAttempts: 5,
              baseDelayMs: 100,
              maxDelayMs: 250,
              jitter: false,
            }),
          ),
        );
        for (let step = 0; step < 20; step += 1) {
          yield* turn;
          yield* TestClock.adjust(50);
        }
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // 100, 200, then 400 and 800 capped at 250.
    expect(times).toEqual([0, 100, 300, 550, 800]);
  });

  test("jitter never pushes a delay past the cap", async () => {
    const times: number[] = [];
    await onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            withRetry(failingAttempt(times), {
              maxAttempts: 8,
              baseDelayMs: 1_000,
              maxDelayMs: 1_500,
            }),
          ),
        );
        for (let step = 0; step < 200; step += 1) {
          yield* turn;
          yield* TestClock.adjust(100);
        }
        return yield* Fiber.join(fiber);
      }),
    );
    expect(times).toHaveLength(8);
    const delays = times.slice(1).map((time, index) => time - times[index]!);
    // The first delay is 1 s jittered by [0.8, 1.2); later ones would exceed the cap.
    // Jittered delays are fractional, so allow for float error in the subtraction.
    expect(delays[0]).toBeGreaterThanOrEqual(800 - 1e-6);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(1_500 + 1e-6);
    expect(delays.slice(2).every((delay) => Math.abs(delay - 1_500) < 1e-6)).toBe(true);
  });

  test("a failure the predicate rejects fails at once with attempts to spare", async () => {
    const times: number[] = [];
    const denied = new Error("Authentication failed");
    const exit = await onTestClock(
      Effect.exit(
        withRetry(failingAttempt(times, denied), {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          retryable: (error) => error !== denied,
        }),
      ),
    );
    expect(times).toEqual([0]);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("succeeds as soon as an attempt does", async () => {
    let attempts = 0;
    const value = await retryWithBackoff(
      async (_signal, attempt) => {
        attempts = attempt;
        if (attempt < 3) throw new Error("transient");
        return "listed";
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(value).toBe("listed");
    expect(attempts).toBe(3);
  });

  test("the promise edge rejects with the last failure once attempts run out", async () => {
    let attempts = 0;
    const outcome = await retryWithBackoff(
      async (_signal, attempt) => {
        attempts = attempt;
        throw new Error(`failure ${attempt}`);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    ).catch((error: unknown) => error);
    expect(attempts).toBe(3);
    expect((outcome as Error).message).toBe("failure 3");
  });

  test("an abort during a backoff delay rejects with its reason and clears the timer", async () => {
    const timers = spyOnTimers(60_000);
    const controller = new AbortController();
    let attempts = 0;
    const running = retryWithBackoff(
      async () => {
        attempts += 1;
        throw new Error("transient");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitter: false,
        signal: controller.signal,
      },
    ).catch((error: unknown) => error);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    expect(timers.armed.size).toBe(1);
    const reason = new Error("owner stopped");
    controller.abort(reason);
    expect(await running).toBe(reason);
    expect(attempts).toBe(1);
    expect(timers.cleared).toEqual(timers.armed);
  });
});
