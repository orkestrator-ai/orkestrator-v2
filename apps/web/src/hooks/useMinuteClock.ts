import { useSyncExternalStore } from "react";

/**
 * The wall clock to the minute, for relative times ("3h ago") that should
 * move while they are on screen. Every subscriber shares one interval, which
 * stops when the last one unmounts, so a board of cards costs one timer.
 */

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

function subscribe(onTick: () => void): () => void {
  listeners.add(onTick);
  interval ??= setInterval(() => {
    for (const listener of Array.from(listeners)) listener();
  }, MINUTE_MS);
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

/** Whole minutes, so the snapshot is stable between ticks. */
function readMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** The current time, re-rendered once a minute. */
export function useMinuteClock(): Date {
  const minute = useSyncExternalStore(subscribe, readMinute, readMinute);
  return new Date(minute);
}
