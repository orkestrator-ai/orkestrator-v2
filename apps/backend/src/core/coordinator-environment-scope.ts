import { COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";

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

interface CoordinatorScope {
  projectId: string;
  coordinatorId: string;
}

/** A connected node, for the workflows a coordinator ran there. */
export interface CoordinatorEnvironmentNode {
  nodeId: string;
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

function snapshotId(value: unknown): string | undefined {
  const snapshot = (value as { snapshot?: { id?: unknown } } | null)?.snapshot;
  return typeof snapshot?.id === "string" ? snapshot.id : undefined;
}

/** Whether this coordinator launched the environment, or runs a workflow of its own there. */
export async function coordinatorCreatedEnvironment(
  context: CommandContext,
  scope: CoordinatorScope,
  environmentId: string,
  node?: CoordinatorEnvironmentNode,
): Promise<boolean> {
  const records = (
    await context.storage.coordinators.listCoordinatorWorkflowAssociations(scope.projectId)
  ).filter(
    (association) =>
      association.coordinatorId === scope.coordinatorId &&
      !association.pending &&
      association.nodeId === node?.nodeId,
  );
  if (
    records.some(
      (association) =>
        association.kind === "environment" &&
        association.resourceId === environmentId &&
        association.baseCommit,
    )
  )
    return true;
  const ids = (kind: string) =>
    new Set(
      records
        .filter((association) => association.kind === kind)
        .map((association) => association.resourceId),
    );
  const pipelines = ids("build-pipeline");
  const reviews = ids("multi-review");
  if (node) {
    if (pipelines.size > 0) {
      // The environment names its pipeline; the pipeline confirms it, since a
      // fork made in the node's own UI can keep the source's link.
      const environment = await node.call<{ buildPipelineId?: unknown }>("get_environment", {
        environmentId,
      });
      if (
        typeof environment?.buildPipelineId === "string" &&
        pipelines.has(environment.buildPipelineId)
      ) {
        const pipeline = await node.call<{ snapshot?: { environmentId?: unknown } }>(
          "get_build_pipeline",
          { pipelineId: environment.buildPipelineId },
        );
        if (pipeline?.snapshot?.environmentId === environmentId) return true;
      }
    }
    if (reviews.size === 0) return false;
    const listed = await node.call<unknown>("list_multi_review_workflows", { environmentId });
    return Array.isArray(listed) && listed.some((entry) => reviews.has(snapshotId(entry) ?? ""));
  }
  if (pipelines.size > 0) {
    const listed = await context.storage.listBuildPipelinesForEnvironment(
      scope.projectId,
      environmentId,
    );
    if (listed.some((pipeline) => pipelines.has(pipeline.id))) return true;
  }
  if (reviews.size > 0) {
    const listed = await context.storage.listMultiReviewWorkflows(environmentId);
    if (listed.some((entry) => reviews.has(snapshotId(entry) ?? ""))) return true;
  }
  for (const runId of ids("graph-run")) {
    const run = await context.storage.graphRuns.getGraphRun(runId);
    if (run?.environmentId === environmentId) return true;
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
  if (await coordinatorCreatedEnvironment(context, scope, environmentId, node)) return;
  const config = await context.storage.loadConfig();
  if (config.repositories[scope.projectId]?.coordinatorOtherEnvironments === true) return;
  throw new Error(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
}
