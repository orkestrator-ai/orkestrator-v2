import { useEffect, useMemo, useState } from "react";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  isLoopedReviewTerminalPhase,
  useLoopedReviewStore,
} from "@/stores/loopedReviewStore";
import {
  connectStructuredReviewAgent,
} from "@/lib/structured-review-agent";
import { LoopedReviewTab } from "./LoopedReviewTab";
import {
  claimLoopedReviewController,
  releaseLoopedReviewController,
} from "@/lib/backend";
import { createUuid } from "@/lib/uuid";

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
  claimController?: typeof claimLoopedReviewController;
  releaseController?: typeof releaseLoopedReviewController;
}

const CONTROLLER_LEASE_MS = 15_000;
const CONTROLLER_RENEW_MS = 5_000;

function LoopedReviewController({
  workflowId,
  environmentId,
  isLocal,
  connectAgent,
  pollIntervalMs,
  missingSessionPollLimit,
  claimController,
  releaseController,
}: {
  workflowId: string;
  environmentId: string;
  isLocal: boolean;
  connectAgent?: typeof connectStructuredReviewAgent;
  pollIntervalMs?: number;
  missingSessionPollLimit?: number;
  claimController: typeof claimLoopedReviewController;
  releaseController: typeof releaseLoopedReviewController;
}) {
  const [ownsLease, setOwnsLease] = useState(false);
  const [controllerId] = useState(createUuid);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      try {
        const result = await claimController(
          workflowId,
          controllerId,
          CONTROLLER_LEASE_MS,
        );
        if (cancelled) return;
        setOwnsLease(result.granted);
      } catch {
        if (!cancelled) setOwnsLease(false);
      }
      if (!cancelled) timer = setTimeout(renew, CONTROLLER_RENEW_MS);
    };
    void renew();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      void releaseController(
        workflowId,
        controllerId,
      );
    };
  }, [claimController, controllerId, releaseController, workflowId]);

  if (!ownsLease) return null;
  return (
    <LoopedReviewTab
      data={{ workflowId, environmentId, isLocal }}
      isActive={false}
      driveWorkflow
      controllerOnly
      connectAgent={connectAgent}
      pollIntervalMs={pollIntervalMs}
      missingSessionPollLimit={missingSessionPollLimit}
    />
  );
}

export function LoopedReviewSupervisor({
  connectAgent,
  pollIntervalMs,
  missingSessionPollLimit,
  claimController = claimLoopedReviewController,
  releaseController = releaseLoopedReviewController,
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
            <LoopedReviewController
              key={`looped-review-supervisor-${workflow.id}`}
              workflowId={workflow.id}
              environmentId={workflow.environmentId}
              isLocal={environment.environmentType === "local"}
              connectAgent={connectAgent}
              pollIntervalMs={pollIntervalMs}
              missingSessionPollLimit={missingSessionPollLimit}
              claimController={claimController}
              releaseController={releaseController}
            />
          );
        })}
    </>
  );
}
