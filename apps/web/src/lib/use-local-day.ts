import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let day = localDay();
let timer: ReturnType<typeof setTimeout> | undefined;

function localDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
}

function refresh() {
  const next = localDay();
  if (day !== next) {
    day = next;
    for (const listener of Array.from(listeners)) listener();
  }
  if (timer !== undefined) clearTimeout(timer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = setTimeout(refresh, Math.max(1, midnight.valueOf() - now.valueOf()));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

// One clock for all mounted rows. Subscription refresh also covers an inactive
// transcript mounting after midnight; focus/visibility cover suspended timers.
export function useLocalDay(): Date {
  return new Date(useSyncExternalStore(subscribe, localDaySnapshot, localDaySnapshot));
}

function localDaySnapshot() {
  // With no subscribers there is no timer keeping the cached day current.
  return listeners.size === 0 ? localDay() : day;
}
