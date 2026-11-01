/**
 * When an environment's setup counts as finished, and when an agent may run in
 * it.
 *
 * `setupOverride` is the user's persisted "proceed anyway" after a setup
 * failure (`override_environment_setup`). It is an explicit decision to use the
 * workspace as it is, so it counts exactly like a completed setup. That command
 * writes `setupPhase: "ready"` and `setupScriptsComplete: true` beside it, and
 * every write that moves setup back off ready clears it, so the three normally
 * agree; this predicate keeps the launch, the queued-prompt drain, mail delivery,
 * the startup-agent handoff and the public API from disagreeing if they do not.
 *
 * `setupScriptsComplete` is the pre-`setupPhase` record of the same fact and
 * is still honoured for environments written before the phase existed.
 */
export interface EnvironmentSetupState {
  setupPhase?: string | null;
  setupScriptsComplete?: boolean | null;
  setupOverride?: boolean | null;
}

export interface EnvironmentAgentReadinessState extends EnvironmentSetupState {
  status?: string | null;
}

/** Setup has finished, or the user chose to proceed past a failed setup. */
export function isEnvironmentSetupSettled(
  environment: EnvironmentSetupState | null | undefined,
): boolean {
  if (!environment) return false;
  return (
    environment.setupPhase === "ready" ||
    environment.setupScriptsComplete === true ||
    environment.setupOverride === true
  );
}

/** The environment is running and its setup is settled, so an agent may run. */
export function isEnvironmentReadyForAgents(
  environment: EnvironmentAgentReadinessState | null | undefined,
): boolean {
  return environment?.status === "running" && isEnvironmentSetupSettled(environment);
}
