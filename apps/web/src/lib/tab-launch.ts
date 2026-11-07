import type { StoreApi } from "zustand/vanilla";
import {
  cancelPaneTabActivation,
  flushPaneTabActivation,
  requestPaneTabActivation,
} from "@/lib/pane-layout-authoritative";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { paneLayoutStore, type PaneLayoutState } from "@/stores/paneLayoutStore";
import {
  tabLaunchStore,
  type TabLaunchState,
  type TabLaunchSurface,
} from "@/stores/tabLaunchStore";

/**
 * A tab launched by the user takes focus at once, whatever the backend still
 * has to do. Until the layout carries the real tab, the pane shows a focused
 * placeholder; until the launch request answers, it shows shimmer outlines.
 *
 * Launches live here rather than in a component, so one survives its button
 * being unmounted or the user switching environment while it runs.
 *
 * Environment and tab ids belong to one node, so the launches, their arrival
 * timers and the double-press claims are held per node scope (plan item
 * 3003). Each function acts on the `scope` it is given, or on the app's
 * command scope when it is given none. Disposing a scope clears its timers
 * and stops its layout watch (invariant 15).
 */

/** How long an answered launch waits for its tab before the placeholder goes. */
const ARRIVAL_GRACE_MS = 15_000;

export interface TabLaunchHandle {
  /** The request answered, naming the tab it landed in. */
  settled: (landedTabId?: string) => void;
  /** The request failed. The caller reports why. */
  failed: () => void;
}

/** One node scope's launch bookkeeping. */
interface TabLaunches {
  readonly scope: NodeScope;
  readonly store: StoreApi<TabLaunchState>;
  /** The node's pane layouts, where a launched tab arrives (plan item 3013). */
  readonly layouts: StoreApi<PaneLayoutState>;
  readonly arrivalTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly claims: Set<string>;
  /** Timers that release a claim after a double press could still land. */
  readonly claimTimers: Set<ReturnType<typeof setTimeout>>;
  stopWatchingLayouts: (() => void) | null;
}

function clearTabLaunches(launches: TabLaunches): void {
  for (const timer of launches.arrivalTimers.values()) clearTimeout(timer);
  launches.arrivalTimers.clear();
  for (const timer of launches.claimTimers) clearTimeout(timer);
  launches.claimTimers.clear();
  launches.claims.clear();
  launches.stopWatchingLayouts?.();
  launches.stopWatchingLayouts = null;
}

const tabLaunches = defineScopedSlot<TabLaunches>("tab-launches", (scope) => {
  const launches: TabLaunches = {
    scope,
    store: scope.store(tabLaunchStore),
    layouts: scope.store(paneLayoutStore),
    arrivalTimers: new Map(),
    claims: new Set(),
    claimTimers: new Set(),
    stopWatchingLayouts: null,
  };
  scope.onDispose("tab-launches", () => clearTabLaunches(launches));
  return launches;
});

const timerKey = (environmentId: string, tabId: string) => `${environmentId}\0${tabId}`;

function forget(launches: TabLaunches, environmentId: string, tabId: string): void {
  const key = timerKey(environmentId, tabId);
  const timer = launches.arrivalTimers.get(key);
  if (timer) clearTimeout(timer);
  launches.arrivalTimers.delete(key);
  launches.store.getState().remove(environmentId, tabId);
  if (launches.store.getState().launches.size === 0) {
    launches.stopWatchingLayouts?.();
    launches.stopWatchingLayouts = null;
  }
}

function reconcileArrivals(launches: TabLaunches): void {
  const { launches: entriesByEnvironment, update } = launches.store.getState();
  const layouts = launches.layouts.getState();
  for (const [environmentId, entries] of Array.from(entriesByEnvironment)) {
    for (const entry of entries) {
      if (entry.arrived || !layouts.findPaneWithTab(entry.tabId, environmentId)) continue;
      if (entry.settled) forget(launches, environmentId, entry.tabId);
      else update(environmentId, entry.tabId, { arrived: true });
      if (entry.focused) flushPaneTabActivation(environmentId, launches.scope);
    }
  }
}

/** Show the launched tab now. Call before awaiting the request that creates it. */
export function beginTabLaunch(
  environmentId: string,
  launch: { tabId: string; title: string; surface: TabLaunchSurface },
  scope: NodeScope = appCommandScope(),
): TabLaunchHandle {
  const launches = tabLaunches(scope);
  launches.store.getState().add(environmentId, launch);
  // The tab that had focus no longer does, so it stops taking the user's keys.
  (document.activeElement as HTMLElement | null)?.blur?.();
  requestPaneTabActivation(environmentId, launch.tabId, scope);
  launches.stopWatchingLayouts ??= launches.layouts.subscribe(() => reconcileArrivals(launches));
  reconcileArrivals(launches);
  const { tabId } = launch;
  const current = () =>
    launches.store
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
        cancelPaneTabActivation(environmentId, tabId, scope);
        forget(launches, environmentId, tabId);
        if (entry.focused) requestPaneTabActivation(environmentId, landedTabId, scope);
        return;
      }
      if (entry.arrived) {
        forget(launches, environmentId, tabId);
        return;
      }
      launches.store.getState().update(environmentId, tabId, { settled: true });
      launches.arrivalTimers.set(
        timerKey(environmentId, tabId),
        setTimeout(() => {
          cancelPaneTabActivation(environmentId, tabId, scope);
          forget(launches, environmentId, tabId);
        }, ARRIVAL_GRACE_MS),
      );
    },
    failed: () => {
      // A launch that answered and was then refused still owns its tab.
      if (answered) return;
      answered = true;
      if (current()?.focused) cancelPaneTabActivation(environmentId, undefined, scope);
      forget(launches, environmentId, tabId);
    },
  };
}

/** The user picked a tab or opened another, so no launch may take focus from it. */
export function cancelTabLaunchFocus(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  const { store } = tabLaunches(scope);
  const launches = store.getState().launches.get(environmentId);
  if (!launches?.some((entry) => entry.focused)) return;
  store.getState().blur(environmentId);
  cancelPaneTabActivation(environmentId, undefined, scope);
}

/** The user picked a launch's placeholder in the tab strip. */
export function focusTabLaunch(
  environmentId: string,
  tabId: string,
  scope: NodeScope = appCommandScope(),
): void {
  tabLaunches(scope).store.getState().focus(environmentId, tabId);
  requestPaneTabActivation(environmentId, tabId, scope);
}

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
  scope: NodeScope = appCommandScope(),
): ((options?: { retryable: boolean }) => void) | null {
  const { claims, claimTimers } = tabLaunches(scope);
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
    if (options?.retryable || remaining <= 0) {
      claims.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      claimTimers.delete(timer);
      claims.delete(key);
    }, remaining);
    claimTimers.add(timer);
  };
}

/** Test support: forget every launch and claim of `scope`. */
export function resetTabLaunches(scope: NodeScope = appCommandScope()): void {
  const launches = tabLaunches(scope);
  clearTabLaunches(launches);
  launches.store.setState({ launches: new Map() });
}
