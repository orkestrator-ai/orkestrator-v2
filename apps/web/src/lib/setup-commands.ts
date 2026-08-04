import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";
import type { Environment } from "@/types";

/** Persist the user-facing setup override in the authoritative environment. */
export function forceResolveSetupRuntime(environmentId: string): void {
  const store = useEnvironmentStore.getState();
  if (!store.getEnvironmentById(environmentId)) {
    console.warn("[setup-commands] forceResolveSetupRuntime: unknown environment", {
      environmentId,
    });
    return;
  }
  void backend.overrideEnvironmentSetup(environmentId)
    .then((updated) => store.updateEnvironment(environmentId, updated))
    .catch((error) => {
      console.error("[setup-commands] Failed to persist setup override:", error);
    });
}

export function isSetupPending(params: {
  setupPhase?: Environment["setupPhase"];
}): boolean {
  return params.setupPhase !== "ready";
}
