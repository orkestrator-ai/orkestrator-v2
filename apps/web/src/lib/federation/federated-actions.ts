/**
 * Explicit-owner actions on another node's resources, sent through the
 * command node (`invoke_on_node`), which routes them to the owner.
 *
 * Every action takes the concrete reference it was started with, so its
 * destination is captured when the user starts it — a later change of
 * focus, filter or selection cannot retarget it. The command names are the
 * node's ordinary ones. A lost answer is recorded by the command node as
 * outcome-unknown and surfaces as `OutcomeUnknownError`; it is never resent.
 */

import type { EnvironmentRef, ProjectRef } from "@orkestrator/protocol/federation";
import type { PortalStore } from "@/lib/portal/portal-store";

export async function startFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await portal.invokeOnNode(ref.backendId, "start_environment_background", {
    environmentId: ref.environmentId,
  });
}

export async function stopFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await portal.invokeOnNode(ref.backendId, "stop_environment", {
    environmentId: ref.environmentId,
  });
}

/** Persists a drag within one project of its node, in that node's own order. */
export async function reorderFederatedEnvironments(
  portal: PortalStore,
  ref: ProjectRef,
  environmentIds: readonly string[],
): Promise<void> {
  await portal.invokeOnNode(ref.backendId, "reorder_environments", {
    projectId: ref.projectId,
    environmentIds: [...environmentIds],
  });
}

/** Called only from the user's confirmation, which names the node and the environment. */
export async function deleteFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await portal.invokeOnNode(ref.backendId, "delete_environment", {
    environmentId: ref.environmentId,
  });
}

/**
 * Creating an environment inside a project instance targets that project's
 * node. There is no placement or load balancing.
 */
export async function createFederatedEnvironment(
  portal: PortalStore,
  ref: ProjectRef,
  input: { name?: string; environmentType?: "local" | "containerized" } = {},
): Promise<{ id: string }> {
  return portal.invokeOnNode<{ id: string }>(ref.backendId, "create_environment", {
    projectId: ref.projectId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.environmentType ? { environmentType: input.environmentType } : {}),
  });
}

export async function updateFederatedMachineProfile(
  portal: PortalStore,
  backendRef: { backendId: ProjectRef["backendId"] },
  update: { expectedRevision: number; displayName?: string; colorToken?: string },
): Promise<unknown> {
  return portal.invokeOnNode(backendRef.backendId, "update_backend_profile", update);
}
