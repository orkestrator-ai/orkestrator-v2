import { useMemo } from "react";
import { useEnvironmentDisplayActivity } from "./useEnvironmentDisplayActivity";
import { environmentNameSignal, type EnvironmentNameSignal } from "@/lib/environment-name-signal";
import {
  describeAutoMergeHold,
  localEnvironmentPrMergeReadiness,
  localEnvironmentPrMergeState,
  shimmerRequiresChecks,
} from "@/lib/pr-merge-readiness";
import type {
  AutoMergeHold,
  PrMergeState,
  ReadyToMergeEnvironment,
} from "@/lib/pr-merge-readiness";
import { useEnvironmentStore } from "@/stores";
import { useConfigStore } from "@/stores/configStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";

/**
 * Whether checks GitHub does not require hold back the green shimmer: this
 * machine's auto-merge "Require checks to pass" setting.
 */
export function useShimmerRequiresChecks(): boolean {
  return useConfigStore((state) => shimmerRequiresChecks(state.config.global));
}

/**
 * Whether this machine's environment has a pull request ready to merge or
 * blocked by conflicts. The selector resolves to a string, so a row
 * re-renders only when the answer changes, not on every monitor event.
 */
export function useEnvironmentPrMergeState(
  environmentId: string,
  environment: ReadyToMergeEnvironment | null | undefined,
): PrMergeState | null {
  const requireChecks = useShimmerRequiresChecks();
  return usePrMonitorStore((state) =>
    environment
      ? localEnvironmentPrMergeState(
          environment,
          state.states.get(environmentId) ?? null,
          state.syncStatus,
          requireChecks,
        )
      : null,
  );
}

/**
 * What auto-merge would wait for on this machine's environment, by the rule
 * it merges on, or null when it would merge now. Both selectors resolve to a
 * primitive or a stored object, so a re-render follows only a real change.
 */
export function useAutoMergeHold(
  environmentId: string,
  environment: ReadyToMergeEnvironment | null | undefined,
): AutoMergeHold | null {
  const requireChecks = useShimmerRequiresChecks();
  const reason = usePrMonitorStore((state) => {
    if (!environment) return null;
    const readiness = localEnvironmentPrMergeReadiness(
      environment,
      state.states.get(environmentId) ?? null,
      state.syncStatus,
      requireChecks,
    );
    return readiness.ready ? null : readiness.reason;
  });
  const checkSummary = usePrMonitorStore(
    (state) => state.states.get(environmentId)?.checkSummary ?? null,
  );
  return useMemo(() => describeAutoMergeHold(reason, checkSummary), [reason, checkSummary]);
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
