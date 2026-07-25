import { useMemo } from "react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  isLoopedReviewTerminalPhase,
  useLoopedReviewStore,
} from "@/stores/loopedReviewStore";
import {
  connectStructuredReviewAgent,
} from "@/lib/structured-review-agent";
import { LoopedReviewTab } from "./LoopedReviewTab";

/**
 * App-lifetime workflow driver.
 *
 * The visible tab is deliberately not the owner of background progress. A
 * workflow therefore keeps reconciling its backend-persisted dispatch after the
 * tab is hidden, closed, remounted, or restored after application startup.
 */
interface LoopedReviewSupervisorProps {
  connectAgent?: typeof connectStructuredReviewAgent;
  pollIntervalMs?: number;
  missingSessionPollLimit?: number;
}

export function LoopedReviewSupervisor({
  connectAgent,
  pollIntervalMs,
  missingSessionPollLimit,
}: LoopedReviewSupervisorProps = {}) {
  const workflows = useLoopedReviewStore((state) => state.workflows);
  const environments = useEnvironmentStore((state) => state.environments);
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment])),
    [environments],
  );

  return (
    <>
      {[...workflows.values()]
        .filter((workflow) => !isLoopedReviewTerminalPhase(workflow.phase))
        .map((workflow) => {
          const environment = environmentById.get(workflow.environmentId);
          if (!environment) return null;
          return (
            <LoopedReviewTab
              key={`looped-review-supervisor-${workflow.id}`}
              data={{
                workflowId: workflow.id,
                environmentId: workflow.environmentId,
                isLocal: environment.environmentType === "local",
              }}
              isActive={false}
              driveWorkflow
              controllerOnly
              connectAgent={connectAgent}
              pollIntervalMs={pollIntervalMs}
              missingSessionPollLimit={missingSessionPollLimit}
            />
          );
        })}
    </>
  );
}
