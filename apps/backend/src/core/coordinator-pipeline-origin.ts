import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import type { StorageService } from "./storage.js";

/** Also checked by background status reconciliation, independent of visible tabs or opt-in. */
export function needsPipelineCreationRepair(association: CoordinatorWorkflowAssociation): boolean {
  return (
    association.kind === "build-pipeline" &&
    Boolean(association.nodeId) &&
    !association.pending &&
    association.createsEnvironment === true &&
    !association.createdEnvironmentId &&
    !association.environmentCreationSettledAt
  );
}

/** Called only with an authoritative pipeline read; transport failures never reach here. */
export async function reconcilePipelineCreation(
  storage: StorageService,
  association: CoordinatorWorkflowAssociation,
  snapshot: unknown,
  now = Date.now(),
): Promise<string | undefined> {
  if (
    association.kind !== "build-pipeline" ||
    !association.nodeId ||
    association.pending ||
    association.createsEnvironment !== true ||
    association.createdEnvironmentId
  )
    return;
  if (snapshot !== null && (typeof snapshot !== "object" || !snapshot || Array.isArray(snapshot)))
    return;
  const pipeline = snapshot as {
    coordinatorLaunchId?: unknown;
    environmentId?: unknown;
    phase?: unknown;
  } | null;
  const owns = pipeline?.coordinatorLaunchId === association.id;
  const environmentId =
    typeof pipeline?.environmentId === "string" ? pipeline.environmentId.trim() : "";
  if (owns && environmentId) {
    await storage.coordinators.completeCoordinatorWorkflowAssociation(
      association.id,
      association.resourceId,
      environmentId,
    );
    return environmentId;
  }
  // An explicit restart reopens status observation. Restore repair eligibility
  // when that same admission becomes active again, without trusting a new caller.
  if (
    owns &&
    !environmentId &&
    !["complete", "failed", "cancelled"].includes(String(pipeline?.phase)) &&
    association.environmentCreationSettledAt
  ) {
    await storage.coordinators.updateCoordinatorWorkflowAssociation(association.id, (current) => {
      if (!current.environmentCreationSettledAt || current.createdEnvironmentId) return false;
      delete current.environmentCreationSettledAt;
      return true;
    });
    return;
  }
  if (
    pipeline === null ||
    !owns ||
    (!environmentId && ["complete", "failed", "cancelled"].includes(String(pipeline.phase)))
  ) {
    await storage.coordinators.updateCoordinatorWorkflowAssociation(association.id, (current) => {
      if (!needsPipelineCreationRepair(current)) return false;
      current.environmentCreationSettledAt = new Date(now).toISOString();
      return true;
    });
  }
}
