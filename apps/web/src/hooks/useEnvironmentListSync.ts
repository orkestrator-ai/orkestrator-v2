import { useEffect, useLayoutEffect, useRef } from "react";
import { useNodeScope } from "@/lib/node-scope/providers";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.environment");

/**
 * Kept exported for backwards compatibility; the periodic safety net now runs
 * through `resource-sync`'s manifest timer and the global store binding, so
 * this hook no longer runs its own interval — doing both refreshed every
 * project twice per tick.
 */
export const ENVIRONMENT_LIST_RESYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps every project's environment snapshot converged across clients.
 *
 * Refreshes on the backend `environment` change feed and on an explicit
 * fallback reconciliation. Manifest recovery lives in the global store
 * binding so it continues when a mobile drawer unmounts this hook. Refreshes
 * are deduplicated per project so a burst of announcements (a reorder announces
 * once per moved environment) collapses into one read.
 *
 * An announcement names the environment that changed, so a lone change reads
 * only that record through `refreshEnvironment`, which resolves `false` when
 * the backend cannot serve it. Several changes waiting at once read the list,
 * as does anything without a project, so a burst stays one read.
 *
 * It hears the change feed of the node scope it renders in: a leaf's
 * `NodeWorkspaceHost` keeps that leaf's environments current, which the
 * window's sidebar draws from while the leaf is warm or live (5007).
 */
export function useEnvironmentListSync(
  projectIds: string[],
  refreshProject: (projectId: string) => Promise<void>,
  refreshEnvironment?: (projectId: string, environmentId: string) => Promise<boolean>,
): void {
  const projectIdsRef = useRef(projectIds);
  const refreshProjectRef = useRef(refreshProject);
  const refreshEnvironmentRef = useRef(refreshEnvironment);
  const inFlightProjectIdsRef = useRef(new Set<string>());
  const rerunProjectIdsRef = useRef(new Set<string>());
  const pendingEnvironmentIdsRef = useRef(new Map<string, Set<string>>());
  const singleReadsUnavailableRef = useRef(false);
  const scope = useNodeScope();

  // Latest inputs for the long-lived subscription below, published at commit.
  useLayoutEffect(() => {
    projectIdsRef.current = projectIds;
    refreshProjectRef.current = refreshProject;
    refreshEnvironmentRef.current = refreshEnvironment;
  });

  useEffect(() => {
    let disposed = false;

    // A refresh already running was started before the mutation that prompted
    // this one, so it cannot contain it. Dropping the request would leave the
    // list stale until the next slow resync, so record it and re-run once the
    // in-flight read finishes instead.
    const refreshProjectOnce = async (projectId: string, environmentId?: string): Promise<void> => {
      if (disposed || !projectIdsRef.current.includes(projectId)) return;
      if (environmentId === undefined) {
        rerunProjectIdsRef.current.add(projectId);
      } else {
        const pendingIds = pendingEnvironmentIdsRef.current.get(projectId) ?? new Set<string>();
        pendingEnvironmentIdsRef.current.set(projectId, pendingIds.add(environmentId));
      }
      if (inFlightProjectIdsRef.current.has(projectId)) return;
      inFlightProjectIdsRef.current.add(projectId);
      try {
        // Loops rather than recurses so a project announcing continuously
        // cannot grow an unbounded promise chain. Any number of requests
        // arriving during one read collapse into a single follow-up.
        do {
          const wholeProject = rerunProjectIdsRef.current.delete(projectId);
          const changedIds = pendingEnvironmentIdsRef.current.get(projectId);
          pendingEnvironmentIdsRef.current.delete(projectId);
          if (disposed || !projectIdsRef.current.includes(projectId)) break;
          try {
            const refreshOne = refreshEnvironmentRef.current;
            const lone =
              !wholeProject &&
              refreshOne &&
              !singleReadsUnavailableRef.current &&
              changedIds?.size === 1
                ? Array.from(changedIds)[0]!
                : null;
            const served = lone !== null && (await refreshOne!(projectId, lone));
            if (lone !== null && !served) singleReadsUnavailableRef.current = true;
            if (!served) await refreshProjectRef.current(projectId);
          } catch (error) {
            // A failed read is still a read that predates the mutation, so a
            // queued request has to survive it rather than be lost with it.
            log.warn("list.refresh-failed", { projectId, error: formatLogError(error) });
          }
        } while (
          !disposed &&
          projectIdsRef.current.includes(projectId) &&
          (rerunProjectIdsRef.current.has(projectId) ||
            pendingEnvironmentIdsRef.current.has(projectId))
        );
      } finally {
        inFlightProjectIdsRef.current.delete(projectId);
        rerunProjectIdsRef.current.delete(projectId);
        pendingEnvironmentIdsRef.current.delete(projectId);
      }
    };

    const refreshAll = async () => {
      await Promise.allSettled(
        projectIdsRef.current.map((projectId) => refreshProjectOnce(projectId)),
      );
    };

    const unsubscribe = onResourceChanged(
      "environment",
      (change) => {
        if (change.projectId) {
          if (projectIdsRef.current.includes(change.projectId)) {
            void refreshProjectOnce(change.projectId, change.id);
          }
          return;
        }
        // Rolling-upgrade fallback for older backends without project attribution.
        void refreshAll();
      },
      scope,
    );
    // Keep the explicit/rolling-upgrade recovery route without duplicating the
    // global manifest hydration owned by store-resource-sync.
    const unsubscribeResync = onResourceResync((request) => {
      // Manifest recovery is backend-store-owned so it still runs while the
      // mobile sidebar is closed and this hook is unmounted.
      if (request.reason === "manifest") return;
      if (request.resources !== null && !request.resources.has("environment")) return;
      // Possibly a different backend now: let the next lone change try again.
      singleReadsUnavailableRef.current = false;
      return refreshAll();
    }, scope);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeResync();
    };
  }, [scope]);
}
