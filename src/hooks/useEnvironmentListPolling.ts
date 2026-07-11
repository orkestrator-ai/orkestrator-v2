import { useEffect, useRef } from "react";

export const ENVIRONMENT_LIST_POLL_INTERVAL_MS = 5_000;

/**
 * Poll every project's environment snapshot so separate app clients converge
 * after one of them creates, deletes, renames, or otherwise updates an environment.
 */
export function useEnvironmentListPolling(
  projectIds: string[],
  refreshProject: (projectId: string) => Promise<void>,
): void {
  const projectIdsRef = useRef(projectIds);
  const refreshProjectRef = useRef(refreshProject);
  const inFlightProjectIdsRef = useRef(new Set<string>());

  projectIdsRef.current = projectIds;
  refreshProjectRef.current = refreshProject;

  useEffect(() => {
    const poll = async () => {
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

    const intervalId = window.setInterval(() => {
      void poll();
    }, ENVIRONMENT_LIST_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);
}
