import { isLocalEnvironmentReadyToMerge } from "@/lib/pr-merge-readiness";
import { useEnvironmentStore } from "@/stores";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import type { ReadyToMergeEnvironment } from "@/lib/pr-merge-readiness";

/**
 * Whether this machine's environment has a pull request ready to merge. The
 * selector resolves to a boolean, so a row re-renders only when the answer
 * changes, not on every monitor event.
 */
export function useEnvironmentReadyToMerge(
  environmentId: string,
  environment: ReadyToMergeEnvironment | null | undefined,
): boolean {
  return usePrMonitorStore((state) =>
    environment
      ? isLocalEnvironmentReadyToMerge(
          environment,
          state.states.get(environmentId) ?? null,
          state.syncStatus,
        )
      : false,
  );
}

/** The same answer for an environment known only by ID (the selected one). */
export function useEnvironmentIdReadyToMerge(environmentId: string | null): boolean {
  const environment = useEnvironmentStore((state) =>
    environmentId
      ? state.environments.find((candidate) => candidate.id === environmentId)
      : undefined,
  );
  return useEnvironmentReadyToMerge(environmentId ?? "", environment);
}
