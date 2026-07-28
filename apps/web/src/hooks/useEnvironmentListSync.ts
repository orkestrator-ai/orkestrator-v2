import { useEffect, useRef } from "react";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";

/**
 * Kept exported for backwards compatibility; the periodic safety net now runs
 * through `resource-sync`'s own `RESOURCE_RESYNC_INTERVAL_MS` timer (which
 * raises `onResourceResync`), so this hook no longer runs its own interval —
 * doing both refreshed every project twice per tick.
 */
export const ENVIRONMENT_LIST_RESYNC_INTERVAL_MS = 60_000;

/**
 * Keeps every project's environment snapshot converged across clients.
 *
 * Refreshes on the backend `environment` change feed, plus a slow periodic
 * resync so a client that was offline catches up without waiting for the next
 * mutation. Refreshes are deduplicated per project so a burst of announcements
 * (a reorder announces once per moved environment) collapses into one read.
 */
export function useEnvironmentListSync(
  projectIds: string[],
  refreshProject: (projectId: string) => Promise<void>,
): void {
  const projectIdsRef = useRef(projectIds);
  const refreshProjectRef = useRef(refreshProject);
  const inFlightProjectIdsRef = useRef(new Set<string>());
  const rerunProjectIdsRef = useRef(new Set<string>());

  projectIdsRef.current = projectIds;
  refreshProjectRef.current = refreshProject;

  useEffect(() => {
    let disposed = false;

    // A refresh already running was started before the mutation that prompted
    // this one, so it cannot contain it. Dropping the request would leave the
    // list stale until the next slow resync, so record it and re-run once the
    // in-flight read finishes instead.
    const refreshProjectOnce = async (projectId: string): Promise<void> => {
      if (disposed || !projectIdsRef.current.includes(projectId)) return;
      if (inFlightProjectIdsRef.current.has(projectId)) {
        rerunProjectIdsRef.current.add(projectId);
        return;
      }
      inFlightProjectIdsRef.current.add(projectId);
      try {
        // Loops rather than recurses so a project announcing continuously
        // cannot grow an unbounded promise chain. Any number of requests
        // arriving during one read collapse into a single follow-up.
        do {
          rerunProjectIdsRef.current.delete(projectId);
          if (disposed || !projectIdsRef.current.includes(projectId)) break;
          try {
            await refreshProjectRef.current(projectId);
          } catch (error) {
            // A failed read is still a read that predates the mutation, so a
            // queued request has to survive it rather than be lost with it.
            console.warn(
              `[EnvironmentListSync] Failed to refresh environments for ${projectId}:`,
              error,
            );
          }
        } while (
          !disposed
          && projectIdsRef.current.includes(projectId)
          && rerunProjectIdsRef.current.has(projectId)
        );
      } finally {
        inFlightProjectIdsRef.current.delete(projectId);
        rerunProjectIdsRef.current.delete(projectId);
      }
    };

    const refreshAll = async () => {
      await Promise.allSettled(
        projectIdsRef.current.map((projectId) => refreshProjectOnce(projectId)),
      );
    };

    // An environment announcement carries the environment id, not its project.
    // A newly created environment is unknown to this client, so its project
    // cannot be derived — refresh the whole visible set instead.
    const unsubscribe = onResourceChanged("environment", () => {
      void refreshAll();
    });
    // The periodic safety net is provided by resource-sync itself: its
    // interval raises a resync, which lands here. Running a second interval in
    // this hook doubled every scheduled refresh.
    const unsubscribeResync = onResourceResync(() => {
      void refreshAll();
    });

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeResync();
    };
  }, []);
}
