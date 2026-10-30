import { parseUsableAgentActivityTime } from "@/stores/agentActivityStore";
import type { AgentActivityState, Environment } from "@/types";

function activityTime(value: string | undefined): number {
  return parseUsableAgentActivityTime(value);
}

/**
 * Selects the freshest activity observation. Runtime events keep the current
 * frontend responsive, while the persisted environment snapshot hydrates a
 * frontend that never saw those events (or was suspended while they fired).
 */
export function resolveEnvironmentAgentActivity(
  environment: Environment,
  runtimeStates: Record<string, AgentActivityState>,
  runtimeUpdatedAt: Record<string, string>,
): AgentActivityState {
  const runtimeKeys = [
    environment.id,
    ...(environment.containerId ? [environment.containerId] : []),
  ];
  let runtimeState: AgentActivityState | undefined;
  let runtimeTime = Number.NEGATIVE_INFINITY;
  for (const key of runtimeKeys) {
    const candidate = runtimeStates[key];
    if (!candidate) continue;
    const candidateTime = activityTime(runtimeUpdatedAt[key]);
    if (!Number.isFinite(candidateTime)) continue;
    if (!runtimeState || candidateTime > runtimeTime) {
      runtimeState = candidate;
      runtimeTime = candidateTime;
    }
  }

  const persistedState = environment.agentActivityState;
  const persistedTime = activityTime(environment.agentActivityUpdatedAt);
  if (
    persistedState &&
    Number.isFinite(persistedTime) &&
    (!runtimeState || persistedTime >= runtimeTime)
  ) {
    return persistedState;
  }
  return runtimeState ?? "idle";
}
