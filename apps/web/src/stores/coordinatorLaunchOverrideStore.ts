import { useEffect } from "react";
import { useStore } from "zustand";
import {
  COORDINATOR_LAUNCH_OVERRIDES_COMMAND,
  coordinatorLaunchOverrideKey,
  type CoordinatorLaunchOverride,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import { isUnknownViewCommandError } from "@orkestrator/protocol/view-sync";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createCoordinatorApi } from "@/lib/backend/coordinator";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope, useSignal, useWindowScope } from "@/lib/node-scope/providers";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** A launch is rare and the marker is not urgent, so a burst of store writes shares one read. */
export const COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS = 500;

export interface CoordinatorLaunchOverrideStoreState {
  /**
   * Tabs whose launch overrode the default, keyed by
   * `coordinatorLaunchOverrideKey`: this node's own tabs with no node, and
   * workers its coordinators launched on other nodes by that node. Every
   * other tab is absent.
   */
  overrides: Map<string, CoordinatorLaunchOverride>;
  /** Keeps the projection current while at least one tab is mounted. */
  retain: () => () => void;
  /** Reads the backend now. Exported for tests. */
  refresh: () => Promise<void>;
  /** Stops every subscription and forgets the projection. For tests. */
  reset: () => void;
}

function sameOverrides(
  a: ReadonlyMap<string, CoordinatorLaunchOverride>,
  b: ReadonlyMap<string, CoordinatorLaunchOverride>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, override] of a) {
    const other = b.get(key);
    if (
      !other ||
      other.nodeId !== override.nodeId ||
      other.model !== override.model ||
      other.reasoning !== override.reasoning
    )
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
      /** When the in-flight read started; see `retain`. */
      let inFlightStartedAt = 0;
      let rerun = false;
      let unsupported = false;

      const read = async (): Promise<void> => {
        if (inFlight) {
          rerun = true;
          return inFlight;
        }
        inFlightStartedAt = Date.now();
        inFlight = (async () => {
          try {
            const snapshot = await backendApiForScope(scope, createCoordinatorApi, {
              listCoordinatorLaunchOverrides: backend.listCoordinatorLaunchOverrides,
            }).listCoordinatorLaunchOverrides();
            const overrides = new Map(
              [...snapshot.overrides, ...(snapshot.remoteOverrides ?? [])].map((override) => [
                coordinatorLaunchOverrideKey(
                  override.nodeId,
                  override.environmentId,
                  override.tabId,
                ),
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
            // A remount (React StrictMode's effect replay, or a strip that
            // unmounts and mounts again at once) re-retains while the read its
            // first mount started is still running. That read is no older than
            // the coalescing window, as fresh as any hint gets, so it answers
            // the remount too rather than queueing a second read behind it.
            const recentRead =
              inFlight !== null &&
              Date.now() - inFlightStartedAt < COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS;
            if (!unsupported && !recentRead) void read();
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

/**
 * The scope that keeps the delegations of a tab rendered on `scope`, when that
 * is another scope: the window's command scope, for a tab on another node's
 * scope. A worker a command node's coordinator launched on a leaf
 * has its delegation on the command node, so the leaf's own answer lacks it.
 * Null for a tab on the command scope, and while the window has no command
 * scope (a test's lone leaf scope).
 */
function delegatingScope(scope: NodeScope, scopes: readonly NodeScope[]): NodeScope | null {
  if (scope.role === "command") return null;
  return scopes.find((candidate) => candidate.role === "command" && !candidate.disposed) ?? null;
}

/**
 * One tab's launch override, or null. Kept current while the caller is mounted.
 *
 * A tab on the command scope reads its own node's answer. A tab on another
 * node's scope reads both that node's answer (its own coordinator's workers)
 * and the command scope's row for this node, which is how a worker the command
 * node launched there is marked. The command node's answer is read once for
 * every tab in the window, so a leaf tab adds no read of its own. While the
 * command node is unreachable its last answer stays; a leaf opened directly as
 * its own command node has no other scope to ask and shows only its own.
 */
export function useCoordinatorLaunchOverride(
  environmentId: string,
  tabId: string,
): CoordinatorLaunchOverride | null {
  const scope = useNodeScope();
  const windowScope = useWindowScope();
  const scopes = useSignal(windowScope.nodeScopes);
  const ownStore = scope.store(coordinatorLaunchOverrideStore);
  const delegating = delegatingScope(scope, scopes);
  const delegatingStore = delegating?.store(coordinatorLaunchOverrideStore) ?? null;
  useEffect(() => {
    const releases = [ownStore.getState().retain()];
    if (delegatingStore) releases.push(delegatingStore.getState().retain());
    return () => {
      for (const release of releases) release();
    };
  }, [ownStore, delegatingStore]);
  const own = useStore(
    ownStore,
    (state) =>
      state.overrides.get(coordinatorLaunchOverrideKey(undefined, environmentId, tabId)) ?? null,
  );
  // The hook is called whatever the scope; with nothing to ask it reads its own store as null.
  const nodeId = delegating ? scope.nodeId : null;
  const delegated = useStore(delegatingStore ?? ownStore, (state) =>
    nodeId
      ? (state.overrides.get(coordinatorLaunchOverrideKey(nodeId, environmentId, tabId)) ?? null)
      : null,
  );
  return own ?? delegated;
}
