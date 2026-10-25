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

/** Stops, then starts again, as a container's Restart does on its own machine. */
export async function restartFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await stopFederatedEnvironment(portal, ref);
  await startFederatedEnvironment(portal, ref);
}

/**
 * Persists a fork on its own node. The caller opens it before requesting startup.
 */
export async function forkFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
  environmentType: "local" | "containerized",
): Promise<{ environmentId: string; projectId: string; name: string }> {
  if (environmentType === "containerized") {
    const docker = await portal.invokeOnNode<{ available: boolean }>(ref.backendId, "check_docker");
    if (!docker.available) throw new Error("Docker is unavailable on the owning machine");
  }
  const fork = await portal.invokeOnNode<{ id: string; projectId: string; name: string }>(
    ref.backendId,
    "fork_environment",
    { environmentId: ref.environmentId, environmentType },
  );
  return { environmentId: fork.id, projectId: fork.projectId, name: fork.name };
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

export async function updateFederatedMachineProfile(
  portal: PortalStore,
  backendRef: { backendId: ProjectRef["backendId"] },
  update: { expectedRevision: number; displayName?: string; colorToken?: string },
): Promise<unknown> {
  return portal.invokeOnNode(backendRef.backendId, "update_backend_profile", update);
}
