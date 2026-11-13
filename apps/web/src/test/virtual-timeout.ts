type TimerCallback = (...args: unknown[]) => void;

interface VirtualTimer {
  callback: TimerCallback;
  args: unknown[];
  dueAt: number;
}

const MICROTASK_TURNS = 20;

export interface VirtualTimeout {
  /**
   * Lets `ms` of virtual time pass: runs every captured timer that falls due
   * within it, earliest first. Between timers only the microtask queue is
   * flushed, so work a timer starts (including timers it arms in turn) is
   * visible before the next one is considered; `drain` runs once at the end for
   * anything that needs real macrotask turns.
   */
  elapse(ms: number, drain: () => Promise<void>): Promise<void>;
  pendingCount(): number;
  /** Restores the real clock and returns how many captured timers were dropped. */
  restore(): number;
}

/**
 * Puts one application delay on a virtual clock, leaving every other delay on
 * the real one. A test that must see work scheduled behind that delay finish
 * calls `elapse` instead of sleeping past it, so the wait is the work and not
 * the delay.
 *
 * Unlike `installControlledTimeout`, which runs every captured timer when
 * advanced, this tracks when each timer is due. A test that lets 30 ms pass,
 * arms a second timer and lets 30 ms pass again sees only the first one fire,
 * as it would in real time. Capture is by exact delay, so the delay must have
 * one owner in the code under test; a timer left pending is reported by
 * `restore`.
 */
export function installVirtualTimeout(
  delayMs: number,
  options: { label?: string } = {},
): VirtualTimeout {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const label = options.label ? `${options.label} (${delayMs} ms)` : `the ${delayMs} ms delay`;
  const scheduled = new Map<object, VirtualTimer>();
  let now = 0;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof callback === "function" && delay === delayMs) {
      const handle = { unref: () => handle };
      scheduled.set(handle, { callback: callback as TimerCallback, args, dueAt: now + delayMs });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && scheduled.delete(handle as unknown as object)) return;
    originalClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;

  const nextDue = (limit: number): [object, VirtualTimer] | undefined => {
    let earliest: [object, VirtualTimer] | undefined;
    for (const entry of scheduled) {
      if (entry[1].dueAt > limit) continue;
      if (!earliest || entry[1].dueAt < earliest[1].dueAt) earliest = entry;
    }
    return earliest;
  };

  return {
    async elapse(ms, drain) {
      const target = now + ms;
      for (let due = nextDue(target); due; due = nextDue(target)) {
        const [handle, timer] = due;
        scheduled.delete(handle);
        now = Math.max(now, timer.dueAt);
        timer.callback(...timer.args);
        for (let microtask = 0; microtask < MICROTASK_TURNS; microtask++) await Promise.resolve();
      }
      now = target;
      await drain();
    },
    pendingCount: () => scheduled.size,
    restore() {
      const dropped = scheduled.size;
      scheduled.clear();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      if (dropped > 0) {
        console.warn(`installVirtualTimeout: dropped ${dropped} pending timer(s) at ${label}.`);
      }
      return dropped;
    },
  };
}
