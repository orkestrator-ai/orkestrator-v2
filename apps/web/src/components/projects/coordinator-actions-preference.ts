import { useSyncExternalStore } from "react";

/**
 * Whether the docked Actions panel is open on panes with room to dock it.
 *
 * A local UI preference shared by every coordinator conversation and every
 * window of this renderer's origin, so it is deliberately not under a
 * per-window or per-node key. Another window's change arrives through the
 * `storage` event. Narrow panes never read or write it: their overlay's open
 * state is transient.
 */
export const COORDINATOR_ACTIONS_DOCKED_KEY = "orkestrator.coordinator-actions.docked";

const listeners = new Set<() => void>();
/** Set when storage refuses a read or write; the choice then lives here only. */
let unstored: boolean | undefined;

function snapshot(): boolean {
  if (unstored !== undefined) return unstored;
  try {
    return localStorage.getItem(COORDINATOR_ACTIONS_DOCKED_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of Array.from(listeners)) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === COORDINATOR_ACTIONS_DOCKED_KEY) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setCoordinatorActionsDockedOpen(open: boolean) {
  try {
    if (open) localStorage.removeItem(COORDINATOR_ACTIONS_DOCKED_KEY);
    else localStorage.setItem(COORDINATOR_ACTIONS_DOCKED_KEY, "collapsed");
    unstored = undefined;
  } catch {
    // The choice still applies to this window until it reloads.
    unstored = open;
  }
  notify();
}

/** The docked panel's open state; open by default. */
export function useCoordinatorActionsDockedOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
