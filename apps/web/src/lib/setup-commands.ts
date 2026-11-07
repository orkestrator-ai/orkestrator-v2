import { environmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createConfigIntegrationsApi } from "@/lib/backend/config-integrations";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { Environment } from "@/types";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("environment");

/** `scope`'s setup commands; the command scope keeps the mocked named exports. */
function setupApi(scope: NodeScope) {
  return backendApiForScope<
    ReturnType<typeof createConfigIntegrationsApi>,
    "approveEnvironmentSetup" | "overrideEnvironmentSetup" | "runEnvironmentSetup"
  >(scope, createConfigIntegrationsApi, backend);
}

/** Persist the user-facing setup override in the authoritative environment. */
export async function forceResolveSetupRuntime(
  environmentId: string,
  scope: NodeScope,
): Promise<Environment | undefined> {
  const store = scope.store(environmentStore).getState();
  if (!store.getEnvironmentById(environmentId)) {
    log.warn("setup.unknown-environment", {
      scope: environmentId,
      action: "forceResolveSetupRuntime",
    });
    return undefined;
  }
  const updated = await setupApi(scope).overrideEnvironmentSetup(environmentId);
  store.updateEnvironment(environmentId, updated);
  return updated;
}

/** Retry a failed setup and project its authoritative result into the store. */
export async function retrySetupRuntime(
  environmentId: string,
  scope: NodeScope,
): Promise<Environment | undefined> {
  const store = scope.store(environmentStore).getState();
  if (!store.getEnvironmentById(environmentId)) {
    log.warn("setup.unknown-environment", { scope: environmentId, action: "retrySetupRuntime" });
    return undefined;
  }
  const updated = await setupApi(scope).runEnvironmentSetup(environmentId);
  store.updateEnvironment(environmentId, updated);
  return updated;
}

/**
 * Run a held setup's reviewed commands; `remember` approves them for the
 * project on this machine too.
 */
export async function approveSetupRuntime(
  environmentId: string,
  hash: string,
  remember: boolean,
  scope: NodeScope,
): Promise<Environment | undefined> {
  const store = scope.store(environmentStore).getState();
  if (!store.getEnvironmentById(environmentId)) {
    log.warn("setup.unknown-environment", { scope: environmentId, action: "approveSetupRuntime" });
    return undefined;
  }
  const updated = await setupApi(scope).approveEnvironmentSetup(environmentId, hash, remember);
  store.updateEnvironment(environmentId, updated);
  return updated;
}

export function isSetupPending(params: { setupPhase?: Environment["setupPhase"] }): boolean {
  return (
    params.setupPhase === undefined ||
    params.setupPhase === "pending" ||
    params.setupPhase === "running"
  );
}

export function isSetupBlocked(params: { setupPhase?: Environment["setupPhase"] }): boolean {
  return params.setupPhase !== "ready";
}
