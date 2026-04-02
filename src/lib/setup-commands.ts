import type { Environment } from "@/types";

interface ShouldAutoResolveSetupCommandsOptions {
  isLocalEnvironment: boolean;
  isLocalEnvironmentReady: boolean;
  setupCommandsResolved: boolean;
  hasPendingCommands: boolean;
}

/**
 * A local environment with an existing worktree has already completed start flow,
 * so setup command resolution can be marked as known immediately.
 */
export const shouldResolveSetupCommandsOnSelection = (
  environment: Environment
): boolean =>
  environment.environmentType === "local" && Boolean(environment.worktreePath);

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
