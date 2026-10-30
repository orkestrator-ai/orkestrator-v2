import { useEnvironmentDisplayActivity } from "./useEnvironmentDisplayActivity";
import { environmentNameSignal, type EnvironmentNameSignal } from "@/lib/environment-name-signal";
import { localEnvironmentPrMergeState } from "@/lib/pr-merge-readiness";
import type { PrMergeState, ReadyToMergeEnvironment } from "@/lib/pr-merge-readiness";
import { useEnvironmentStore } from "@/stores";
import { usePrMonitorStore } from "@/stores/prMonitorStore";

/**
 * Whether this machine's environment has a pull request ready to merge or
 * blocked by conflicts. The selector resolves to a string, so a row
 * re-renders only when the answer changes, not on every monitor event.
 */
export function useEnvironmentPrMergeState(
  environmentId: string,
  environment: ReadyToMergeEnvironment | null | undefined,
): PrMergeState | null {
  return usePrMonitorStore((state) =>
    environment
      ? localEnvironmentPrMergeState(
          environment,
          state.states.get(environmentId) ?? null,
          state.syncStatus,
        )
      : null,
  );
}

/**
 * The name signal for an environment known only by ID (the selected one, a
 * search hit), using the same displayed activity and running gate as the sidebar.
 */
export function useEnvironmentIdNameSignal(
  environmentId: string | null,
): EnvironmentNameSignal | null {
  const environment = useEnvironmentStore((state) =>
    environmentId
      ? state.environments.find((candidate) => candidate.id === environmentId)
      : undefined,
  );
  const prMergeState = useEnvironmentPrMergeState(environmentId ?? "", environment);
  const deleting = useEnvironmentStore((state) =>
    environmentId ? state.isDeleting(environmentId) : false,
  );
  const { displayedActivityState, isRunning } = useEnvironmentDisplayActivity(environment);
  return deleting
    ? null
    : environmentNameSignal({
        waitingOnUser: isRunning && displayedActivityState === "waiting",
        prMergeState,
      });
}
