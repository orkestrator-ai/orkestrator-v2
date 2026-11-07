import { useEffect } from "react";
import {
  COORDINATOR_ACTIVITY_COMMAND,
  type CoordinatorActivityState,
} from "@orkestrator/protocol/coordinator-activity";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { isUnknownViewCommandError } from "@orkestrator/protocol/view-sync";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createCoordinatorApi } from "@/lib/backend/coordinator";
import { subscribeNativeObservationInvalidations } from "@/lib/native-observation-events";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/** Bursts of hints (a dispatch writes its session record more than once) share one read. */
export const COORDINATOR_ACTIVITY_COALESCE_MS = 150;

export interface CoordinatorActivityStoreState {
  /** Projects whose coordinator is working or waiting; an absent project is idle. */
  projects: Map<string, CoordinatorActivityState>;
  /** Keeps the projection current while at least one consumer is mounted. */
  retain: () => () => void;
  /** Reads the backend now. Exported for tests. */
  refresh: () => Promise<void>;
  /** Stops every subscription and forgets the projection. For tests. */
  reset: () => void;
}

function sameProjects(
  a: ReadonlyMap<string, CoordinatorActivityState>,
  b: ReadonlyMap<string, CoordinatorActivityState>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [projectId, state] of a) if (b.get(projectId) !== state) return false;
  return true;
}

/**
 * Each project's coordinator activity, as the spinner on its icon shows it,
 * per node: a node's coordinators run there (plan item 3011).
 *
 * Presentation only: the activity lives in the backend's activity observer
 * (`list_coordinator_activity`), and this is a projection of it. Hints re-read
 * it — an activity transition or content change of a coordinator session, a
 * coordinator session record written (a dispatch), the coordinator workspace
 * changing, and the transport's resync and safety checks, which also cover a
 * missed hint. Hints are coalesced into one read, and one read runs at a
 * time. Against a backend that predates the command nothing is shown.
 */
export const coordinatorActivityStore = defineScopedStore<CoordinatorActivityStoreState>(
  "coordinator-activity",
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
            listCoordinatorActivity: backend.listCoordinatorActivity,
          }).listCoordinatorActivity();
          const projects = new Map(Object.entries(snapshot.projects));
          if (!sameProjects(get().projects, projects)) set({ projects });
        } catch (error) {
          if (isUnknownViewCommandError(error, COORDINATOR_ACTIVITY_COMMAND)) {
            unsupported = true;
            if (get().projects.size > 0) set({ projects: new Map() });
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
      }, COORDINATOR_ACTIVITY_COALESCE_MS);
    }

    const subscribe = (): Array<() => void> => [
      // The node's own observation announcements (plan item 3009).
      subscribeNativeObservationInvalidations((invalidation) => {
        if (invalidation.kind === "all" || coordinatorIdFromRuntimeId(invalidation.environmentId)) {
          schedule();
        }
      }, scope),
      onResourceChanged(
        "native-agent-session",
        (change) => {
          if (coordinatorIdFromRuntimeId(change.id)) schedule();
        },
        scope,
      ),
      onResourceChanged("coordinator", () => schedule(), scope),
      onResourceResync(() => schedule(), scope),
      onViewSafetyCheck(() => schedule(), scope),
    ];

    const stop = () => {
      for (const unsubscribe of subscriptions ?? []) unsubscribe();
      subscriptions = null;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    // A retainer left mounted when the scope goes leaves no timer or listener.
    scope.onDispose("coordinator-activity", stop);

    return {
      projects: new Map(),
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
        set({ projects: new Map() });
      },
    };
  },
);

/**
 * Reads the nearest node scope's activity; other code uses
 * `scope.store(coordinatorActivityStore)`.
 */
export const useCoordinatorActivityStore = scopedStoreHook(coordinatorActivityStore);

/** One project's coordinator activity, kept current while the caller is mounted. */
export function useCoordinatorActivity(
  projectId: string | null | undefined,
): CoordinatorActivityState | null {
  const retain = useCoordinatorActivityStore((state) => state.retain);
  useEffect(() => retain(), [retain]);
  return useCoordinatorActivityStore((state) =>
    projectId ? (state.projects.get(projectId) ?? null) : null,
  );
}
