/**
 * Explicit-owner actions for machines observed from this renderer.
 *
 * Every action takes the concrete reference it was started with, so its
 * destination is captured when the user starts it — a later change of
 * focus, filter or selection cannot retarget it. The command names are the
 * backend's ordinary ones; only the client that carries them differs.
 */

import type { EnvironmentRef, ProjectRef } from "@orkestrator/protocol/federation";
import type { BackendClientRegistry } from "./registry";

export async function startFederatedEnvironment(
  registry: BackendClientRegistry,
  ref: EnvironmentRef,
): Promise<void> {
  await registry.require(ref.backendId).mutate(
    "start_environment_background",
    { environmentId: ref.environmentId },
    {
      label: "Start environment",
    },
  );
}

export async function stopFederatedEnvironment(
  registry: BackendClientRegistry,
  ref: EnvironmentRef,
): Promise<void> {
  await registry.require(ref.backendId).mutate(
    "stop_environment",
    { environmentId: ref.environmentId },
    {
      label: "Stop environment",
    },
  );
}

export async function deleteFederatedEnvironment(
  registry: BackendClientRegistry,
  ref: EnvironmentRef,
): Promise<void> {
  await registry.require(ref.backendId).mutate(
    "delete_environment",
    { environmentId: ref.environmentId },
    {
      label: "Delete environment",
    },
  );
}

/**
 * Creating an environment inside a project instance targets that project's
 * machine. There is no placement or load balancing.
 */
export async function createFederatedEnvironment(
  registry: BackendClientRegistry,
  ref: ProjectRef,
  input: { name?: string; environmentType?: "local" | "containerized" } = {},
): Promise<{ id: string }> {
  const runtime = registry.require(ref.backendId);
  const environment = await runtime.mutate<{ id: string }>(
    "create_environment",
    {
      projectId: ref.projectId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.environmentType ? { environmentType: input.environmentType } : {}),
    },
    { label: "Create environment" },
  );
  void runtime.requestHydrate();
  return environment;
}

export async function updateFederatedMachineProfile(
  registry: BackendClientRegistry,
  backendRef: { backendId: ProjectRef["backendId"] },
  update: { expectedRevision: number; displayName?: string; colorToken?: string },
): Promise<unknown> {
  return registry
    .require(backendRef.backendId)
    .mutate("update_backend_profile", update, { label: "Update machine profile" });
}
