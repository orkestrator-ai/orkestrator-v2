import { createContext, useContext, useSyncExternalStore } from "react";
import { runtimePartsAt, type RuntimeParts } from "./runtime-summary";

/**
 * A one-second wall clock that a view owns and its leaves read.
 *
 * Holding the tick in a tab's own state re-renders the whole tab every second
 * something runs. With this clock the owner only starts and stops it; the
 * components that print a time subscribe to it, so they are the only thing
 * that re-renders on a tick (the same idea as `LiveElapsed`).
 */
export interface RuntimeClock {
  subscribe: (onTick: () => void) => () => void;
  /** The time of the last tick; stable between ticks. */
  getNow: () => number;
  /**
   * Starts ticking and reads the time at once, so a resumed clock never shows
   * the time it paused at for a second. Returns the matching stop; the clock
   * runs while any start is outstanding.
   */
  start: () => () => void;
}

export function createRuntimeClock(intervalMs = 1_000): RuntimeClock {
  let now = Date.now();
  let starts = 0;
  let interval: number | undefined;
  const listeners = new Set<() => void>();
  const tick = () => {
    now = Date.now();
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    subscribe: (onTick) => {
      listeners.add(onTick);
      return () => listeners.delete(onTick);
    },
    getNow: () => now,
    start: () => {
      starts += 1;
      if (starts === 1) {
        tick();
        interval = window.setInterval(tick, intervalMs);
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        starts -= 1;
        if (starts === 0 && interval !== undefined) {
          window.clearInterval(interval);
          interval = undefined;
        }
      };
    },
  };
}

/** The clock of the view this component renders in, or null outside one. */
export const RuntimeClockContext = createContext<RuntimeClock | null>(null);

const NO_SUBSCRIPTION = () => () => {};
const NO_TIME = () => 0;

/**
 * The clock's time, re-read on each of its ticks. With `subscribed` false (or
 * no clock) the caller is not re-rendered by ticks and gets `fallback`.
 */
export function useRuntimeClockNow(
  clock: RuntimeClock | null,
  subscribed = true,
  fallback = 0,
): number {
  const active = clock !== null && subscribed;
  const now = useSyncExternalStore(
    active ? clock.subscribe : NO_SUBSCRIPTION,
    active ? clock.getNow : NO_TIME,
    active ? clock.getNow : NO_TIME,
  );
  return active ? now : fallback;
}

/**
 * Runtime parts with a live `elapsed` kept current by the surrounding
 * `RuntimeClockContext`. Settled parts, and parts outside a clock, are
 * returned as given and never subscribe.
 */
export function useLiveRuntimeParts<T extends RuntimeParts | null>(parts: T): T {
  const clock = useContext(RuntimeClockContext);
  const live = parts !== null && parts.live && parts.liveStartedAt !== undefined;
  const now = useRuntimeClockNow(clock, live);
  if (!live || clock === null || parts === null) return parts;
  return runtimePartsAt(parts, now) as T;
}
