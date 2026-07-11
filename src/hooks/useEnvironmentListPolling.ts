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
  const isPollingRef = useRef(false);

  projectIdsRef.current = projectIds;
  refreshProjectRef.current = refreshProject;

  useEffect(() => {
    const poll = async () => {
      if (isPollingRef.current) {
        return;
      }

      isPollingRef.current = true;
      try {
        await Promise.allSettled(
          projectIdsRef.current.map((projectId) => refreshProjectRef.current(projectId)),
        );
      } finally {
        isPollingRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, ENVIRONMENT_LIST_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);
}
