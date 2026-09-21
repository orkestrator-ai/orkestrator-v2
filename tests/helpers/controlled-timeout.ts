type ScheduledCallback = { callback: (...args: unknown[]) => void; args: unknown[] };

export interface ControlledTimeoutOptions {
  /**
   * How many timers at the controlled delay may be live at the same time.
   * Defaults to 1, which is right for a debounce: the production effect clears
   * the previous timer before re-arming, so a second concurrent timer means
   * some other module shares the delay and is being captured by accident.
   */
  maxPending?: number;
  /** Named in diagnostics so a collision points at the right call site. */
  label?: string;
}

export interface ControlledTimeout {
  /** Runs every captured timer that is currently due. Returns how many ran. */
  advance(): number;
  pendingCount(): number;
  /** Throws when a captured timer was never advanced. */
  assertDrained(): void;
  /**
   * Restores the real clock. Returns the number of captured timers dropped;
   * dropping any is reported, because a silently discarded timer can make a
   * test pass for the wrong reason.
   */
  restore(): number;
}

/**
 * Controls one application delay while leaving Testing Library, promises and
 * unrelated UI timers on the real clock.
 *
 * Interception is by exact delay, which is all `setTimeout` exposes about a
 * caller. That is only sound while the controlled delay has a single owner in
 * the rendered tree, so both ends of that assumption are enforced rather than
 * assumed: scheduling more than `maxPending` timers at the delay throws, and
 * discarding a pending timer at `restore()` is reported.
 */
export function installControlledTimeout(
  delayMs: number,
  options: ControlledTimeoutOptions = {},
): ControlledTimeout {
  const { maxPending = 1, label } = options;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map<object, ScheduledCallback>();
  const describe = () => `${label ? `${label} (${delayMs} ms)` : `the ${delayMs} ms delay`}`;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof callback === "function" && delay === delayMs) {
      if (scheduled.size >= maxPending) {
        throw new Error(
          `installControlledTimeout: ${describe()} already has ${scheduled.size} timer(s) ` +
            `pending and another was scheduled. Interception is by exact delay, so an ` +
            `unrelated module using the same delay would be captured and silently dropped. ` +
            `Raise maxPending if the extra timer is expected, or control a delay this test owns.`,
        );
      }
      const handle = { unref: () => handle };
      scheduled.set(handle, {
        callback: callback as (...callbackArgs: unknown[]) => void,
        args,
      });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle && scheduled.delete(handle as unknown as object)) return;
    originalClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;

  return {
    advance() {
      const due = Array.from(scheduled.values());
      scheduled.clear();
      for (const { callback, args } of due) callback(...args);
      return due.length;
    },
    pendingCount() {
      return scheduled.size;
    },
    assertDrained() {
      if (scheduled.size > 0) {
        throw new Error(
          `installControlledTimeout: ${scheduled.size} timer(s) at ${describe()} were never advanced.`,
        );
      }
    },
    restore() {
      const dropped = scheduled.size;
      scheduled.clear();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      if (dropped > 0) {
        // Not thrown: restore() runs in afterEach, where throwing would mask
        // the failure that left the timer pending in the first place.
        console.warn(
          `installControlledTimeout: dropped ${dropped} pending timer(s) at ${describe()} on restore.`,
        );
      }
      return dropped;
    },
  };
}
