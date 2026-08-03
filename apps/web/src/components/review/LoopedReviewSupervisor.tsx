import { useEffect } from "react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { hydrateLoopedReviewWorkflowsForEnvironment } from "@/lib/looped-review-persistence";

/**
 * Renderer-side hydration companion for the backend looped-review supervisor.
 *
 * It never selects phases, creates provider sessions, polls output, or writes
 * workflow transitions. Resource-change events perform incremental refreshes;
 * this mount snapshot closes gaps after renderer exit/remount.
 */
interface LoopedReviewSupervisorProps {
  hydrateWorkflows?: typeof hydrateLoopedReviewWorkflowsForEnvironment;
}

export function LoopedReviewSupervisor({
  hydrateWorkflows = hydrateLoopedReviewWorkflowsForEnvironment,
}: LoopedReviewSupervisorProps = {}) {
  const environmentIds = useEnvironmentStore((state) =>
    state.environments.map((environment) => environment.id).sort().join(",")
  );

  useEffect(() => {
    for (const environmentId of environmentIds.split(",").filter(Boolean)) {
      void hydrateWorkflows(environmentId).catch((error) => {
        console.warn(
          `[looped-review] Failed to hydrate workflows for ${environmentId}:`,
          error,
        );
      });
    }
  }, [environmentIds, hydrateWorkflows]);

  return null;
}
