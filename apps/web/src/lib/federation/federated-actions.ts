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

import { dockerClient } from "@orkestrator/protocol/contract/domains/docker";
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import type { BackendId, EnvironmentRef, ProjectRef } from "@orkestrator/protocol/federation";
import type { PortalStore } from "@/lib/portal/portal-store";
import { routedBackendClient } from "@/lib/portal/routed-backend-client";
import { domainApi } from "@/lib/node-scope/domains/domain-api";

/** The `environments` domain on `backendId`, through the command node (plan item 7003). */
function nodeEnvironments(portal: PortalStore, backendId: BackendId) {
  return domainApi(routedBackendClient(portal, backendId), environmentsClient);
}

export async function startFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await nodeEnvironments(portal, ref.backendId).startEnvironmentBackground({
    environmentId: ref.environmentId,
  });
}

export async function stopFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await nodeEnvironments(portal, ref.backendId).stopEnvironment({
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
    const docker = await domainApi(
      routedBackendClient(portal, ref.backendId),
      dockerClient,
    ).checkDocker();
    if (!docker.available) throw new Error("Docker is unavailable on the owning machine");
  }
  const fork = await nodeEnvironments(portal, ref.backendId).forkEnvironment({
    environmentId: ref.environmentId,
    environmentType,
  });
  return { environmentId: fork.id, projectId: fork.projectId, name: fork.name };
}

/** Persists a drag within one project of its node, in that node's own order. */
export async function reorderFederatedEnvironments(
  portal: PortalStore,
  ref: ProjectRef,
  environmentIds: readonly string[],
): Promise<void> {
  await nodeEnvironments(portal, ref.backendId).reorderEnvironments({
    projectId: ref.projectId,
    environmentIds: [...environmentIds],
  });
}

/** Called only from the user's confirmation, which names the node and the environment. */
export async function deleteFederatedEnvironment(
  portal: PortalStore,
  ref: EnvironmentRef,
): Promise<void> {
  await nodeEnvironments(portal, ref.backendId).deleteEnvironment({
    environmentId: ref.environmentId,
  });
}
