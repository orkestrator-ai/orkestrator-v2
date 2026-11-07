import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";

export type TabLaunchSurface = "agent" | "terminal" | "page";

/**
 * A tab the user just launched, until the backend has caught up.
 *
 * This is the renderer's only say in a backend-owned launch: that it happened.
 * What the tab is, where it lands and what it shows all arrive in the pane
 * layout, which is why nothing here is persisted or merged with it.
 */
export interface TabLaunch {
  tabId: string;
  title: string;
  /** Which outlines stand in for it. */
  surface: TabLaunchSurface;
  /** The user is looking at this launch; a tab they pick afterwards clears it. */
  focused: boolean;
  /** The authoritative layout holds the tab. */
  arrived: boolean;
  /** The launch request has answered. */
  settled: boolean;
}

/** Bounds one environment's launches; each is a click, and they settle quickly. */
const MAX_LAUNCHES_PER_ENVIRONMENT = 8;

export interface TabLaunchState {
  launches: Map<string, readonly TabLaunch[]>;
  add: (environmentId: string, launch: Pick<TabLaunch, "tabId" | "title" | "surface">) => void;
  update: (environmentId: string, tabId: string, patch: Partial<TabLaunch>) => void;
  remove: (environmentId: string, tabId: string) => void;
  blur: (environmentId: string) => void;
  focus: (environmentId: string, tabId: string) => void;
}

function withLaunches(
  launches: Map<string, readonly TabLaunch[]>,
  environmentId: string,
  next: readonly TabLaunch[],
): Map<string, readonly TabLaunch[]> {
  const updated = new Map(launches);
  if (next.length > 0) updated.set(environmentId, next);
  else updated.delete(environmentId);
  return updated;
}

/** Per node: environment and tab ids belong to one node (plan item 3003). */
export const tabLaunchStore = defineScopedStore<TabLaunchState>("tab-launch", () => (set) => ({
  launches: new Map(),
  add: (environmentId, launch) =>
    set(({ launches }) => {
      const others = (launches.get(environmentId) ?? []).map((entry) =>
        entry.focused ? { ...entry, focused: false } : entry,
      );
      const next: TabLaunch = { ...launch, focused: true, arrived: false, settled: false };
      return {
        launches: withLaunches(
          launches,
          environmentId,
          [...others, next].slice(-MAX_LAUNCHES_PER_ENVIRONMENT),
        ),
      };
    }),
  update: (environmentId, tabId, patch) =>
    set(({ launches }) => ({
      launches: withLaunches(
        launches,
        environmentId,
        (launches.get(environmentId) ?? []).map((entry) =>
          entry.tabId === tabId ? { ...entry, ...patch } : entry,
        ),
      ),
    })),
  remove: (environmentId, tabId) =>
    set(({ launches }) => ({
      launches: withLaunches(
        launches,
        environmentId,
        (launches.get(environmentId) ?? []).filter((entry) => entry.tabId !== tabId),
      ),
    })),
  blur: (environmentId) =>
    set(({ launches }) => {
      const current = launches.get(environmentId);
      if (!current?.some((entry) => entry.focused)) return { launches };
      return {
        launches: withLaunches(
          launches,
          environmentId,
          current.map((entry) => ({ ...entry, focused: false })),
        ),
      };
    }),
  focus: (environmentId, tabId) =>
    set(({ launches }) => ({
      launches: withLaunches(
        launches,
        environmentId,
        (launches.get(environmentId) ?? []).map((entry) => ({
          ...entry,
          focused: entry.tabId === tabId,
        })),
      ),
    })),
}));

/** Reads the nearest node scope's launches; other code uses `scope.store(tabLaunchStore)`. */
export const useTabLaunchStore = scopedStoreHook(tabLaunchStore);
