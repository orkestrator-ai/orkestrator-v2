import { useEnvironmentStore } from "@/stores/environmentStore";
import * as backend from "@/lib/backend";

const setupCompletionPersistenceInFlight = new Set<string>();

interface ShouldAutoResolveSetupCommandsOptions {
  isLocalEnvironment: boolean;
  isLocalEnvironmentReady: boolean;
  setupCommandsResolved: boolean;
  hasPendingCommands: boolean;
}

/**
 * Auto-resolve setup command state when local environment is already ready and
 * no setup command payload is waiting to be consumed.
 */
export const shouldAutoResolveSetupCommands = ({
  isLocalEnvironment,
  isLocalEnvironmentReady,
  setupCommandsResolved,
  hasPendingCommands,
}: ShouldAutoResolveSetupCommandsOptions): boolean =>
  isLocalEnvironment &&
  isLocalEnvironmentReady &&
  !setupCommandsResolved &&
  !hasPendingCommands;

/**
 * Determines whether setup is still pending for a given environment type.
 * Used to gate agent initialization and show the "waiting for setup" UI.
 */
/**
 * Persist that setup scripts have completed for an environment, and reflect
 * that in the in-memory store. Safe to call repeatedly; no-ops if already
 * marked complete. Fire-and-forget: errors are logged but not thrown.
 */
export function markSetupScriptsComplete(environmentId: string): void {
  const store = useEnvironmentStore.getState();
  const env = store.getEnvironmentById(environmentId);
  if (!env || env.setupScriptsComplete || setupCompletionPersistenceInFlight.has(environmentId)) {
    return;
  }

  setupCompletionPersistenceInFlight.add(environmentId);
  backend
    .setEnvironmentSetupComplete(environmentId, true)
    .then((updatedEnvironment) => {
      store.updateEnvironment(environmentId, updatedEnvironment);
    })
    .catch((err) => {
      console.error(
        "[setup-commands] Failed to persist setupScriptsComplete:",
        err
      );
    })
    .finally(() => {
      setupCompletionPersistenceInFlight.delete(environmentId);
    });
}

/**
 * Force the runtime setup-pending gates open for an environment without
 * persisting completion. Intended for the user-facing "skip waiting" override
 * when detection fails to fire. Does NOT drop pending setup commands so a
 * retry path is preserved if setup was merely slow.
 */
export function forceResolveSetupRuntime(environmentId: string): void {
  const store = useEnvironmentStore.getState();
  const env = store.getEnvironmentById(environmentId);
  if (!env) {
    console.warn(
      "[setup-commands] forceResolveSetupRuntime: unknown environment",
      { environmentId }
    );
    return;
  }
  if (env.environmentType === "local") {
    store.setSetupScriptsRunning(environmentId, false);
    store.setSetupCommandsResolved(environmentId, true);
  } else {
    store.setWorkspaceReady(environmentId, true);
  }
}

export function isSetupPending(params: {
  isLocal: boolean;
  setupCommandsResolved: boolean;
  hasPendingSetupCommands: boolean;
  setupScriptsRunning: boolean;
  workspaceReady: boolean;
}): boolean {
  if (params.isLocal) {
    return params.setupScriptsRunning || params.hasPendingSetupCommands || !params.setupCommandsResolved;
  }
  return !params.workspaceReady;
}
