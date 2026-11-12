import { jest } from "bun:test";
import { act } from "@testing-library/react";

/** One animation frame. Happy DOM delivers frames on real immediates, outside Bun's fake clock. */
export const animationFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/**
 * Lets `ms` of time pass on Bun's fake clock (`jest.useFakeTimers()`, installed
 * before rendering) in 10 ms steps, delivering an animation frame before each
 * step and after the last. Frame-driven work therefore interleaves with timers
 * in order, as it would in real time, and every timer due within `ms` has run
 * when this resolves. Unlike a real sleep it takes no wall time.
 */
export async function elapseFakeTime(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    await animationFrame();
    act(() => {
      jest.advanceTimersByTime(Math.min(10, ms - elapsed));
    });
  }
  await animationFrame();
}

interface TrackedTimer {
  kind: "timeout" | "interval";
  delay: number | undefined;
}

export interface PageTimerTracker {
  /** Timers the page armed through the global timer functions that have neither run nor been cleared. */
  pendingCount(): number;
  /** One line per pending timer, for assertion messages. */
  describePending(): string[];
  /** Puts back the timer functions that were installed when tracking began. */
  restore(): void;
}

/**
 * Tracks the timers the code under test arms through the global
 * `setTimeout`/`setInterval`, so a test can prove that none is left to fire.
 *
 * Use this instead of `jest.getTimerCount()` under Happy DOM. Bun's count also
 * includes Happy DOM's own bookkeeping: its `AsyncTaskManager` arms a 1 ms
 * "wait until complete" probe on a timer function it captured at load, every
 * time the last frame or timer it tracks ends, and clears it whenever another
 * one starts. The animation frame that `elapseFakeTime` delivers last can be
 * such an end, and whether the probe is still pending when the count is read
 * depends on how Happy DOM's real-immediate frames interleave with the rest of
 * the turn, which host load changes. Under load the count read 1 with no page
 * timer pending (flake 9932). The probe never touches the page.
 *
 * Install it after `jest.useFakeTimers()` and before rendering, and restore it
 * after unmounting. A wrapper installed later (`installControlledTimeout`)
 * keeps the timers it captures out of this count, which is what it owns.
 */
export function trackPageTimers(): PageTimerTracker {
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const pending = new Map<unknown, TrackedTimer>();

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof callback !== "function") return originals.setTimeout(callback, delay, ...args);
    const handle = originals.setTimeout(
      (...callbackArgs: unknown[]) => {
        pending.delete(handle);
        return (callback as (...values: unknown[]) => unknown)(...callbackArgs);
      },
      delay,
      ...args,
    );
    pending.set(handle, { kind: "timeout", delay });
    return handle;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    pending.delete(handle);
    originals.clearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const handle = originals.setInterval(callback, delay, ...args);
    pending.set(handle, { kind: "interval", delay });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    pending.delete(handle);
    originals.clearInterval(handle);
  }) as typeof globalThis.clearInterval;

  return {
    pendingCount: () => pending.size,
    describePending: () =>
      Array.from(pending.values(), (timer) => `${timer.kind} (${timer.delay ?? 0} ms)`),
    restore() {
      Object.assign(globalThis, originals);
      pending.clear();
    },
  };
}
