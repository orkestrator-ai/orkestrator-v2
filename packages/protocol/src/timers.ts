/**
 * The timer seams a module takes so its tests can drive time.
 *
 * A module that arms a debounce, deadline, retry or poll accepts one of these
 * as an optional dependency and uses the runtime's timers when none is given.
 * Tests pass a `ManualClock` (`@orkestrator/protocol/testing/manual-clock`),
 * which implements all of them, and advance it instead of sleeping past the
 * delay. Browser-safe: no Node or Bun imports.
 *
 * Handles are opaque (`unknown`) so the same seam serves Bun, Node and the
 * browser, whose `setTimeout` return types differ.
 */

/** One-shot timers: debounces, deadlines, retries. */
export interface TimeoutTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Repeating timers: polls, sweeps, watchdogs. */
export interface IntervalTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Both kinds of timer plus the time they are measured against. */
export interface Timers extends TimeoutTimers, IntervalTimers {
  /** Milliseconds, comparable with `Date.now()`. */
  now(): number;
}

/** The runtime's own one-shot timers, unchanged (they keep a process alive as usual). */
export const runtimeTimeoutTimers: TimeoutTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Unrefs a runtime timer handle where the runtime has one (Bun, Node); a browser's number has none. */
function unref<T>(handle: T): T {
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

/**
 * The runtime's timers, unref'd: a watchdog, sweep, grace period or backstop
 * armed through them never keeps a process alive on its own.
 */
export const unrefTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => unref(setTimeout(callback, ms)),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => unref(setInterval(callback, ms)),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
