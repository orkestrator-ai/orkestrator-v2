import type { OpenCodeSilenceClock } from "./stream-silence.js";

/**
 * A manual clock for the watchdog: time moves only when a test advances it,
 * so no assertion depends on how long a sleep took on a loaded host. `reads`
 * counts calls to `now()`, which the watchdog makes once per frame and once
 * per deadline check, so a test can await "the frame was seen".
 */
export function manualSilenceClock() {
  let time = 0;
  let nextId = 0;
  let reads = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: OpenCodeSilenceClock = {
    now: () => {
      reads += 1;
      return time;
    },
    setTimer(callback, delayMs) {
      nextId += 1;
      timers.set(nextId, { at: time + delayMs, callback });
      return nextId;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    get reads() {
      return reads;
    },
    pending: () => timers.size,
    /** Moves time forward and runs every timer that falls due, in order. */
    advance(ms: number) {
      time += ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= time)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

export type ManualSilenceClock = ReturnType<typeof manualSilenceClock>;
