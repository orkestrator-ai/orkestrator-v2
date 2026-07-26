import { useEffect, useRef } from "react";
import { onResourceChanged } from "@/lib/resource-sync";

/**
 * Safety-net poll interval.
 *
 * The backend change feed is the primary path; this exists only to close the
 * window where a client was disconnected (laptop asleep, gateway restarted,
 * SSE dropped) and therefore missed the announcements it would otherwise have
 * acted on. It is deliberately far slower than the 5s poll it replaces.
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

  projectIdsRef.current = projectIds;
  refreshProjectRef.current = refreshProject;

  useEffect(() => {
    const refreshAll = async () => {
      const refreshes = projectIdsRef.current
        .filter((projectId) => !inFlightProjectIdsRef.current.has(projectId))
        .map(async (projectId) => {
          inFlightProjectIdsRef.current.add(projectId);
          try {
            await refreshProjectRef.current(projectId);
          } finally {
            inFlightProjectIdsRef.current.delete(projectId);
          }
        });

      await Promise.allSettled(refreshes);
    };

    // An environment announcement carries the environment id, not its project.
    // A newly created environment is unknown to this client, so its project
    // cannot be derived — refresh the whole visible set instead.
    const unsubscribe = onResourceChanged("environment", () => {
      void refreshAll();
    });

    const intervalId = window.setInterval(() => {
      void refreshAll();
    }, ENVIRONMENT_LIST_RESYNC_INTERVAL_MS);

    return () => {
      unsubscribe();
      window.clearInterval(intervalId);
    };
  }, []);
}
