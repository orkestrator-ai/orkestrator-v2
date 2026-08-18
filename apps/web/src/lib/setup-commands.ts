import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import type { Environment } from "@/types";

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
