import { useEffect, useMemo, useRef, useState } from "react";
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
  validateLoopedReviewController,
} from "@/lib/backend";
import { createUuid } from "@/lib/uuid";
import type { LoopedReviewControllerLease } from "./LoopedReviewTab";
import { persistLoopedReviewWorkflowNow } from "@/lib/looped-review-persistence";

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
  validateController?: typeof validateLoopedReviewController;
  releaseController?: typeof releaseLoopedReviewController;
  persistWorkflow?: typeof persistLoopedReviewWorkflowNow;
  controllerLeaseMs?: number;
  controllerRenewMs?: number;
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
  validateController,
  releaseController,
  persistWorkflow,
  controllerLeaseMs,
  controllerRenewMs,
}: {
  workflowId: string;
  environmentId: string;
  isLocal: boolean;
  connectAgent?: typeof connectStructuredReviewAgent;
  pollIntervalMs?: number;
  missingSessionPollLimit?: number;
  claimController: typeof claimLoopedReviewController;
  validateController: typeof validateLoopedReviewController;
  releaseController: typeof releaseLoopedReviewController;
  persistWorkflow?: typeof persistLoopedReviewWorkflowNow;
  controllerLeaseMs: number;
  controllerRenewMs: number;
}) {
  const [lease, setLease] = useState<LoopedReviewControllerLease | null>(null);
  const leaseRef = useRef<LoopedReviewControllerLease | null>(null);
  const [controllerId] = useState(createUuid);

  useEffect(() => {
    let cancelled = false;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const publishLease = (next: LoopedReviewControllerLease | null) => {
      leaseRef.current = next;
      setLease(next);
    };
    const clearExpiryTimer = () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
    };
    const installExpiryTimer = (next: LoopedReviewControllerLease) => {
      clearExpiryTimer();
      const expiresAtMs = Date.parse(next.expiresAt);
      const delay = Math.max(0, expiresAtMs - Date.now());
      expiryTimer = setTimeout(() => {
        if (
          leaseRef.current?.token === next.token
          && Date.parse(leaseRef.current.expiresAt) <= Date.now()
        ) {
          publishLease(null);
        }
      }, delay);
    };
    const renew = async () => {
      try {
        const result = await claimController(
          workflowId,
          controllerId,
          controllerLeaseMs,
        );
        if (cancelled) return;
        const expiresAtMs = Date.parse(result.expiresAt);
        if (
          !result.granted
          || !result.token
          || !Number.isFinite(expiresAtMs)
          || expiresAtMs <= Date.now()
        ) {
          clearExpiryTimer();
          publishLease(null);
        } else {
          const next = {
            ownerId: controllerId,
            token: result.token,
            expiresAt: result.expiresAt,
          };
          publishLease(next);
          installExpiryTimer(next);
        }
      } catch {
        if (!cancelled) {
          clearExpiryTimer();
          publishLease(null);
        }
      }
      if (!cancelled) renewTimer = setTimeout(renew, controllerRenewMs);
    };
    void renew();
    return () => {
      cancelled = true;
      if (renewTimer) clearTimeout(renewTimer);
      clearExpiryTimer();
      const currentLease = leaseRef.current;
      leaseRef.current = null;
      if (currentLease) {
        void releaseController(
          workflowId,
          controllerId,
          currentLease.token,
        );
      }
    };
  }, [
    claimController,
    controllerId,
    controllerLeaseMs,
    controllerRenewMs,
    releaseController,
    workflowId,
  ]);

  if (!lease) return null;
  return (
    <LoopedReviewTab
      data={{ workflowId, environmentId, isLocal }}
      isActive={false}
      driveWorkflow
      controllerOnly
      connectAgent={connectAgent}
      pollIntervalMs={pollIntervalMs}
      missingSessionPollLimit={missingSessionPollLimit}
      controllerLease={lease}
      validateControllerLease={validateController}
      persistWorkflow={persistWorkflow}
    />
  );
}

export function LoopedReviewSupervisor({
  connectAgent,
  pollIntervalMs,
  missingSessionPollLimit,
  claimController = claimLoopedReviewController,
  validateController = validateLoopedReviewController,
  releaseController = releaseLoopedReviewController,
  persistWorkflow,
  controllerLeaseMs = CONTROLLER_LEASE_MS,
  controllerRenewMs = CONTROLLER_RENEW_MS,
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
              validateController={validateController}
              releaseController={releaseController}
              persistWorkflow={persistWorkflow}
              controllerLeaseMs={controllerLeaseMs}
              controllerRenewMs={controllerRenewMs}
            />
          );
        })}
    </>
  );
}
