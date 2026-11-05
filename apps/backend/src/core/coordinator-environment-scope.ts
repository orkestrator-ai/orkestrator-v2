import { COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import { reconcilePipelineCreation } from "./coordinator-pipeline-origin.js";
import { MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS } from "./coordinator-workflow-retention.js";

/**
 * Which environments a coordinator may send work to.
 *
 * A worker's mail is untrusted, and an injected worker can ask the coordinator
 * to have some other environment run something, which that environment then
 * does under its own, possibly looser, policy. So a coordinator acts only on
 * environments it created, unless the project's
 * `coordinatorOtherEnvironments` setting says otherwise.
 *
 * The answer is per coordinator, not per conversation: every worker belongs to
 * the main coordinator whichever conversation launched it, and takeover and
 * adoption only move a record between that coordinator's conversations. Asking
 * an environment something proves nothing, so a delegation record (which has no
 * `baseCommit`) does not count. Neither does the absence of any record: an
 * environment with no recorded origin is treated as not this coordinator's,
 * because a hand-made environment looks exactly the same. It gets the refusal,
 * which names the setting.
 */

export const MAX_REMOTE_RECEIPT_LOOKUPS = 16;
const REMOTE_RECEIPT_REFRESH_MS = 60_000;
const remoteRefresh = new WeakMap<CommandContext, Map<string, { at: number; projectId: string }>>();

interface CoordinatorScope {
  projectId: string;
  coordinatorId: string;
}

/** A connected node, for the workflows a coordinator ran there. */
export interface CoordinatorEnvironmentNode {
  nodeId: string;
  projectId: string;
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Creation receipts, unlike workflow membership, are durable authority. */
export async function coordinatorCreatedEnvironment(
  context: CommandContext,
  scope: CoordinatorScope,
  environmentId: string,
  node?: CoordinatorEnvironmentNode,
): Promise<boolean> {
  const records = await context.storage.coordinators.listCoordinatorWorkflowAssociations(
    scope.projectId,
  );
  if (
    records.some(
      (association) =>
        association.coordinatorId === scope.coordinatorId &&
        !association.pending &&
        association.nodeId === node?.nodeId &&
        (((association.kind === "build-pipeline" || association.kind === "graph-run") &&
          association.createdEnvironmentId === environmentId) ||
          (association.kind === "environment" &&
            association.resourceId === environmentId &&
            Boolean(association.baseCommit))),
    )
  )
    return true;
  // Repair is bounded per check and cooled down per receipt. Rotate through
  // the bounded store so early active records cannot starve later launches.
  if (node) {
    let refresh = remoteRefresh.get(context);
    if (!refresh) {
      refresh = new Map();
      remoteRefresh.set(context, refresh);
    }
    const eligible = records.filter(
      (association) =>
        association.coordinatorId === scope.coordinatorId &&
        association.nodeId === node.nodeId &&
        !association.pending &&
        association.kind === "build-pipeline" &&
        association.createsEnvironment === true &&
        !association.createdEnvironmentId &&
        !association.environmentCreationSettledAt,
    );
    const liveIds = new Set(records.map((association) => association.id));
    for (const [id, checked] of Array.from(refresh.entries())) {
      if (checked.projectId === scope.projectId && !liveIds.has(id)) refresh.delete(id);
    }
    const now = Date.now();
    const batch = eligible
      .filter(
        (association) => now - (refresh.get(association.id)?.at ?? 0) >= REMOTE_RECEIPT_REFRESH_MS,
      )
      .sort((a, b) => (refresh.get(a.id)?.at ?? 0) - (refresh.get(b.id)?.at ?? 0))
      .slice(0, MAX_REMOTE_RECEIPT_LOOKUPS);
    // Mark before awaiting so simultaneous checks share the cooldown too.
    for (const association of batch) {
      refresh.delete(association.id);
      refresh.set(association.id, { at: now, projectId: scope.projectId });
    }
    // The store is globally bounded; cap stale cache entries after deletion too.
    while (refresh.size > MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) {
      refresh.delete(refresh.keys().next().value!);
    }
    for (const association of batch) {
      let pipeline: {
        snapshot?: {
          projectId?: string;
          environmentId?: string;
          coordinatorLaunchId?: string;
          phase?: string;
        };
      } | null;
      try {
        pipeline = await node.call("get_build_pipeline", { pipelineId: association.resourceId });
      } catch {
        continue; // A transport failure is never evidence of deletion.
      }
      if (pipeline === null || pipeline?.snapshot?.projectId === node.projectId) {
        const created = await reconcilePipelineCreation(
          context.storage,
          association,
          pipeline === null ? null : pipeline.snapshot,
          now,
        );
        if (created === environmentId) return true;
      }
    }
  }
  return false;
}

/**
 * Refuses unless this coordinator created the environment or the project allows
 * others. Call it before anything happens: the refusal is the whole answer.
 */
export async function assertCoordinatorMayActOnEnvironment(
  context: CommandContext,
  scope: CoordinatorScope,
  environmentId: string,
  node?: CoordinatorEnvironmentNode,
): Promise<void> {
  const config = await context.storage.loadConfig();
  if (config.repositories[scope.projectId]?.coordinatorOtherEnvironments === true) return;
  if (await coordinatorCreatedEnvironment(context, scope, environmentId, node)) return;
  throw new Error(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
}

/**
 * Before provisioning publishes an environment, a settled launch association
 * authorizes controls on that workflow alone. It never grants authority over
 * an environment: once one exists the creation/opt-in boundary applies again.
 * Callers must first verify the workflow's project against the target node.
 */
export async function assertCoordinatorMayControlWorkflow(
  context: CommandContext,
  scope: CoordinatorScope,
  workflow: {
    kind: "build-pipeline" | "graph-run";
    resourceId: string;
    environmentId?: string;
  },
  node?: CoordinatorEnvironmentNode,
): Promise<void> {
  if (workflow.environmentId) {
    await assertCoordinatorMayActOnEnvironment(context, scope, workflow.environmentId, node);
    return;
  }
  const records = await context.storage.coordinators.listCoordinatorWorkflowAssociations(
    scope.projectId,
  );
  if (
    records.some(
      (association) =>
        association.projectId === scope.projectId &&
        association.coordinatorId === scope.coordinatorId &&
        !association.pending &&
        association.kind === workflow.kind &&
        association.resourceId === workflow.resourceId &&
        association.nodeId === node?.nodeId,
    )
  )
    return;
  throw new Error(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
}
