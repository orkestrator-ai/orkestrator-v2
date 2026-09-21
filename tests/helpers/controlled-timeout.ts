type ScheduledCallback = { callback: (...args: unknown[]) => void; args: unknown[] };

/**
 * Controls one application delay while leaving Testing Library, promises and
 * unrelated UI timers on the real clock.
 */
export function installControlledTimeout(delayMs: number) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map<object, ScheduledCallback>();

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof callback === "function" && delay === delayMs) {
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
      const due = Array.from(scheduled.entries());
      scheduled.clear();
      for (const [, { callback, args }] of due) callback(...args);
    },
    pendingCount() {
      return scheduled.size;
    },
    restore() {
      scheduled.clear();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}
