import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import type { Environment } from "@/types";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("environment");

/** Persist the user-facing setup override in the authoritative environment. */
export async function forceResolveSetupRuntime(
  environmentId: string,
): Promise<Environment | undefined> {
  const store = useEnvironmentStore.getState();
  if (!store.getEnvironmentById(environmentId)) {
    console.warn("[setup-commands] forceResolveSetupRuntime: unknown environment", {
      environmentId,
    });
    return undefined;
  }
  const updated = await backend.overrideEnvironmentSetup(environmentId);
  store.updateEnvironment(environmentId, updated);
  return updated;
}

/** Retry a failed setup and project its authoritative result into the store. */
export async function retrySetupRuntime(environmentId: string): Promise<Environment | undefined> {
  const store = useEnvironmentStore.getState();
  if (!store.getEnvironmentById(environmentId)) {
    console.warn("[setup-commands] retrySetupRuntime: unknown environment", {
      environmentId,
    });
    return undefined;
  }
  const updated = await backend.runEnvironmentSetup(environmentId);
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
): Promise<Environment | undefined> {
  const store = useEnvironmentStore.getState();
  if (!store.getEnvironmentById(environmentId)) {
    log.warn("setup-approval.unknown-environment", { environmentId });
    return undefined;
  }
  const updated = await backend.approveEnvironmentSetup(environmentId, hash, remember);
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
