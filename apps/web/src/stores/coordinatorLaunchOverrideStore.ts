import { useEffect } from "react";
import {
  COORDINATOR_LAUNCH_OVERRIDES_COMMAND,
  type CoordinatorLaunchOverride,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import { isUnknownViewCommandError } from "@orkestrator/protocol/view-sync";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createCoordinatorApi } from "@/lib/backend/coordinator";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** A launch is rare and the marker is not urgent, so a burst of store writes shares one read. */
export const COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS = 500;

export interface CoordinatorLaunchOverrideStoreState {
  /** Tabs whose launch overrode the default; every other tab is absent. */
  overrides: Map<string, CoordinatorLaunchOverride>;
  /** Keeps the projection current while at least one tab is mounted. */
  retain: () => () => void;
  /** Reads the backend now. Exported for tests. */
  refresh: () => Promise<void>;
  /** Stops every subscription and forgets the projection. For tests. */
  reset: () => void;
}

const overrideKey = (environmentId: string, tabId: string) => `${environmentId}\u0000${tabId}`;

function sameOverrides(
  a: ReadonlyMap<string, CoordinatorLaunchOverride>,
  b: ReadonlyMap<string, CoordinatorLaunchOverride>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, override] of a) {
    const other = b.get(key);
    if (!other || other.model !== override.model || other.reasoning !== override.reasoning)
      return false;
  }
  return true;
}

/**
 * Which worker tabs' launches overrode the default, for the marker on the
 * tab, per node (plan item 3011).
 *
 * One read answers every tab: the first tab mounted reads, the rest share the
 * answer, and the read names no project, so a tab with no delegation adds no
 * read of its own and nothing to fail. Presentation only: the delegations live
 * in the backend's coordinator store. Hints re-read it, a coordinator store
 * write and the transport's resync and safety checks, which also cover a missed
 * hint. Against a backend that predates the command nothing is shown; a resync
 * asks again, since the backend may have been upgraded behind this window.
 */
export const coordinatorLaunchOverrideStore =
  defineScopedStore<CoordinatorLaunchOverrideStoreState>(
    "coordinator-launch-override",
    (scope) => (set, get) => {
      let retainers = 0;
      let subscriptions: Array<() => void> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inFlight: Promise<void> | null = null;
      let rerun = false;
      let unsupported = false;

      const read = async (): Promise<void> => {
        if (inFlight) {
          rerun = true;
          return inFlight;
        }
        inFlight = (async () => {
          try {
            const snapshot = await backendApiForScope(scope, createCoordinatorApi, {
              listCoordinatorLaunchOverrides: backend.listCoordinatorLaunchOverrides,
            }).listCoordinatorLaunchOverrides();
            const overrides = new Map(
              snapshot.overrides.map((override) => [
                overrideKey(override.environmentId, override.tabId),
                override,
              ]),
            );
            if (!sameOverrides(get().overrides, overrides)) set({ overrides });
          } catch (error) {
            if (isUnknownViewCommandError(error, COORDINATOR_LAUNCH_OVERRIDES_COMMAND)) {
              unsupported = true;
              if (get().overrides.size > 0) set({ overrides: new Map() });
            }
            // Anything else keeps the last answer; the next hint or check reads again.
          }
        })();
        try {
          await inFlight;
        } finally {
          inFlight = null;
          if (rerun) {
            rerun = false;
            schedule();
          }
        }
      };

      function schedule(): void {
        if (unsupported || retainers === 0 || timer) return;
        timer = setTimeout(() => {
          timer = null;
          void read();
        }, COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS);
      }

      const subscribe = (): Array<() => void> => [
        onResourceChanged("coordinator", () => schedule(), scope),
        onResourceResync(() => {
          unsupported = false;
          schedule();
        }, scope),
        onViewSafetyCheck(() => schedule(), scope),
      ];

      const stop = () => {
        for (const unsubscribe of subscriptions ?? []) unsubscribe();
        subscriptions = null;
        if (timer) clearTimeout(timer);
        timer = null;
      };
      // A retainer left mounted when the scope goes leaves no timer or listener.
      scope.onDispose("coordinator-launch-override", stop);

      return {
        overrides: new Map(),
        retain: () => {
          retainers += 1;
          if (retainers === 1) {
            subscriptions = subscribe();
            if (!unsupported) void read();
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            retainers -= 1;
            if (retainers === 0) stop();
          };
        },
        refresh: () => read(),
        reset: () => {
          stop();
          retainers = 0;
          rerun = false;
          unsupported = false;
          set({ overrides: new Map() });
        },
      };
    },
  );

/**
 * Reads the nearest node scope's overrides; other code uses
 * `scope.store(coordinatorLaunchOverrideStore)`.
 */
export const useCoordinatorLaunchOverrideStore = scopedStoreHook(coordinatorLaunchOverrideStore);

/** One tab's launch override, or null. Kept current while the caller is mounted. */
export function useCoordinatorLaunchOverride(
  environmentId: string,
  tabId: string,
): CoordinatorLaunchOverride | null {
  const retain = useCoordinatorLaunchOverrideStore((state) => state.retain);
  useEffect(() => retain(), [retain]);
  return useCoordinatorLaunchOverrideStore(
    (state) => state.overrides.get(overrideKey(environmentId, tabId)) ?? null,
  );
}
