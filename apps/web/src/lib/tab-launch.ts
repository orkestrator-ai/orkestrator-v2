import {
  cancelPaneTabActivation,
  flushPaneTabActivation,
  requestPaneTabActivation,
} from "@/lib/pane-layout-authoritative";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useTabLaunchStore, type TabLaunchSurface } from "@/stores/tabLaunchStore";

/**
 * A tab launched by the user takes focus at once, whatever the backend still
 * has to do. Until the layout carries the real tab, the pane shows a focused
 * placeholder; until the launch request answers, it shows shimmer outlines.
 *
 * Launches live here rather than in a component, so one survives its button
 * being unmounted or the user switching environment while it runs.
 */

/** How long an answered launch waits for its tab before the placeholder goes. */
const ARRIVAL_GRACE_MS = 15_000;

export interface TabLaunchHandle {
  /** The request answered, naming the tab it landed in. */
  settled: (landedTabId?: string) => void;
  /** The request failed. The caller reports why. */
  failed: () => void;
}

const arrivalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (environmentId: string, tabId: string) => `${environmentId}\0${tabId}`;
let stopWatchingLayouts: (() => void) | null = null;

function forget(environmentId: string, tabId: string): void {
  const key = timerKey(environmentId, tabId);
  const timer = arrivalTimers.get(key);
  if (timer) clearTimeout(timer);
  arrivalTimers.delete(key);
  useTabLaunchStore.getState().remove(environmentId, tabId);
  if (useTabLaunchStore.getState().launches.size === 0) {
    stopWatchingLayouts?.();
    stopWatchingLayouts = null;
  }
}

function reconcileArrivals(): void {
  const { launches, update } = useTabLaunchStore.getState();
  const layouts = usePaneLayoutStore.getState();
  for (const [environmentId, entries] of Array.from(launches)) {
    for (const entry of entries) {
      if (entry.arrived || !layouts.findPaneWithTab(entry.tabId, environmentId)) continue;
      if (entry.settled) forget(environmentId, entry.tabId);
      else update(environmentId, entry.tabId, { arrived: true });
      if (entry.focused) flushPaneTabActivation(environmentId);
    }
  }
}

/** Show the launched tab now. Call before awaiting the request that creates it. */
export function beginTabLaunch(
  environmentId: string,
  launch: { tabId: string; title: string; surface: TabLaunchSurface },
): TabLaunchHandle {
  useTabLaunchStore.getState().add(environmentId, launch);
  // The tab that had focus no longer does, so it stops taking the user's keys.
  (document.activeElement as HTMLElement | null)?.blur?.();
  requestPaneTabActivation(environmentId, launch.tabId);
  stopWatchingLayouts ??= usePaneLayoutStore.subscribe(reconcileArrivals);
  reconcileArrivals();
  const { tabId } = launch;
  const current = () =>
    useTabLaunchStore
      .getState()
      .launches.get(environmentId)
      ?.find((candidate) => candidate.tabId === tabId);
  let answered = false;
  return {
    settled: (landedTabId) => {
      answered = true;
      const entry = current();
      if (!entry) return;
      if (landedTabId && landedTabId !== tabId) {
        // The backend reused another tab, so the placeholder has nothing to become.
        cancelPaneTabActivation(environmentId, tabId);
        forget(environmentId, tabId);
        if (entry.focused) requestPaneTabActivation(environmentId, landedTabId);
        return;
      }
      if (entry.arrived) {
        forget(environmentId, tabId);
        return;
      }
      useTabLaunchStore.getState().update(environmentId, tabId, { settled: true });
      arrivalTimers.set(
        timerKey(environmentId, tabId),
        setTimeout(() => {
          cancelPaneTabActivation(environmentId, tabId);
          forget(environmentId, tabId);
        }, ARRIVAL_GRACE_MS),
      );
    },
    failed: () => {
      // A launch that answered and was then refused still owns its tab.
      if (answered) return;
      answered = true;
      if (current()?.focused) cancelPaneTabActivation(environmentId);
      forget(environmentId, tabId);
    },
  };
}

/** The user picked a tab or opened another, so no launch may take focus from it. */
export function cancelTabLaunchFocus(environmentId: string): void {
  const launches = useTabLaunchStore.getState().launches.get(environmentId);
  if (!launches?.some((entry) => entry.focused)) return;
  useTabLaunchStore.getState().blur(environmentId);
  cancelPaneTabActivation(environmentId);
}

/** The user picked a launch's placeholder in the tab strip. */
export function focusTabLaunch(environmentId: string, tabId: string): void {
  useTabLaunchStore.getState().focus(environmentId, tabId);
  requestPaneTabActivation(environmentId, tabId);
}

const claims = new Set<string>();

/**
 * Longer than a double press. A fast request answers before the second press of
 * one lands, so releasing on the answer alone would let it through.
 */
export const TAB_LAUNCH_CLAIM_MIN_MS = 600;

/**
 * Admit one launch of an action per environment, so a double press does not run
 * it twice. Returns the release, or null when one is already in flight. The
 * action names what was chosen, so picking another agent is a new launch.
 * Release with `retryable` when it failed.
 */
export function claimTabLaunch(
  action: string,
  environmentId: string,
): ((options?: { retryable: boolean }) => void) | null {
  const key = `${action}\0${environmentId}`;
  if (claims.has(key)) return null;
  claims.add(key);
  const heldUntil = Date.now() + TAB_LAUNCH_CLAIM_MIN_MS;
  let released = false;
  return (options) => {
    if (released) return;
    released = true;
    const remaining = heldUntil - Date.now();
    // A launch that failed may be retried at once; only a double press waits.
    if (options?.retryable || remaining <= 0) claims.delete(key);
    else setTimeout(() => claims.delete(key), remaining);
  };
}

/** Test support: forget every launch and claim. */
export function resetTabLaunches(): void {
  for (const timer of arrivalTimers.values()) clearTimeout(timer);
  arrivalTimers.clear();
  claims.clear();
  stopWatchingLayouts?.();
  stopWatchingLayouts = null;
  useTabLaunchStore.setState({ launches: new Map() });
}
