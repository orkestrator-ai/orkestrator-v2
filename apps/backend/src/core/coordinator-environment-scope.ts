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
  return records.some(
    (association) =>
      association.coordinatorId === scope.coordinatorId &&
      !association.pending &&
      association.nodeId === node?.nodeId &&
      (((association.kind === "build-pipeline" || association.kind === "graph-run") &&
        association.createdEnvironmentId === environmentId) ||
        (association.kind === "environment" &&
          association.resourceId === environmentId &&
          Boolean(association.baseCommit))),
  );
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
