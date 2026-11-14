import { COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import {
  coordinatorEnvironmentRefusals,
  type CoordinatorRefusalSurface,
} from "./coordinator-environment-refusals.js";
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
interface RemoteReceiptRefresh {
  at: number;
  projectId: string;
  createdEnvironmentId?: string;
  pending?: Promise<string | undefined>;
}
const remoteRefresh = new WeakMap<CommandContext, Map<string, RemoteReceiptRefresh>>();

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
      if (checked.projectId === scope.projectId && !liveIds.has(id) && !checked.pending)
        refresh.delete(id);
    }
    const now = Date.now();
    const batch = eligible
      .filter(
        (association) =>
          refresh.get(association.id)?.pending ||
          refresh.get(association.id)?.createdEnvironmentId === environmentId ||
          now - (refresh.get(association.id)?.at ?? 0) >= REMOTE_RECEIPT_REFRESH_MS,
      )
      .sort((a, b) => (refresh.get(a.id)?.at ?? 0) - (refresh.get(b.id)?.at ?? 0))
      .slice(0, MAX_REMOTE_RECEIPT_LOOKUPS);
    for (const association of batch) {
      // Another caller may have started or completed this repair since batch
      // selection. Share its result, including the durable receipt publication.
      let checked = refresh.get(association.id);
      if (checked?.createdEnvironmentId === environmentId) return true;
      if (!checked?.pending) {
        if (checked && Date.now() - checked.at < REMOTE_RECEIPT_REFRESH_MS) continue;
        if (!checked) {
          // Keep pending work registered: evict only completed cache entries.
          for (const [id, entry] of Array.from(refresh.entries())) {
            if (refresh.size < MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) break;
            if (!entry.pending) refresh.delete(id);
          }
          if (refresh.size >= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) continue;
        }
        checked = { at: 0, projectId: scope.projectId };
        refresh.delete(association.id);
        refresh.set(association.id, checked);
        const entry = checked;
        entry.pending = (async () => {
          let pipeline: {
            snapshot?: {
              projectId?: string;
              environmentId?: string;
              coordinatorLaunchId?: string;
              phase?: string;
            };
          } | null;
          try {
            pipeline = await node.call("get_build_pipeline", {
              pipelineId: association.resourceId,
            });
          } catch {
            return; // A transport failure is never evidence of deletion.
          }
          if (pipeline === null || pipeline?.snapshot?.projectId === node.projectId) {
            entry.createdEnvironmentId = await reconcilePipelineCreation(
              context.storage,
              association,
              pipeline === null ? null : pipeline.snapshot,
            );
          }
          return entry.createdEnvironmentId;
        })().finally(() => {
          entry.at = Date.now();
          delete entry.pending;
        });
      }
      if ((await checked.pending) === environmentId) return true;
    }
  }
  return false;
}

/** Count the refusal (content-free; see `coordinator-environment-refusals.ts`), then make it. */
function refuse(surface: CoordinatorRefusalSurface, node?: CoordinatorEnvironmentNode): never {
  coordinatorEnvironmentRefusals.record(surface, node ? "remote" : "local");
  throw new Error(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
}

/**
 * Refuses unless this coordinator created the environment or the project allows
 * others. Call it before anything happens: the refusal is the whole answer.
 * `surface` says what was refused, for the refusal counter only.
 */
export async function assertCoordinatorMayActOnEnvironment(
  context: CommandContext,
  scope: CoordinatorScope,
  environmentId: string,
  node?: CoordinatorEnvironmentNode,
  surface: CoordinatorRefusalSurface = "tool",
): Promise<void> {
  const config = await context.storage.loadConfig();
  if (config.repositories[scope.projectId]?.coordinatorOtherEnvironments === true) return;
  if (await coordinatorCreatedEnvironment(context, scope, environmentId, node)) return;
  refuse(surface, node);
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
  surface: CoordinatorRefusalSurface = "tool",
): Promise<void> {
  if (workflow.environmentId) {
    await assertCoordinatorMayActOnEnvironment(
      context,
      scope,
      workflow.environmentId,
      node,
      surface,
    );
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
  refuse("workflow-control", node);
}
