import { displayedEnvironmentActivity } from "@orkestrator/protocol/environment-activity-order";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

/** The activity and running gate shared by sidebar rows, titles, and search. */
export function useEnvironmentDisplayActivity(environment: Environment | undefined) {
  const dockerAvailable = useDockerAvailability();
  const activity = useAgentActivityStore((state) =>
    environment
      ? resolveEnvironmentAgentActivity(
          environment,
          state.containerStates,
          state.containerStateUpdatedAt,
        )
      : "idle",
  );
  const activeBuild = useBuildPipelineStore((state) =>
    environment ? state.activeBuildEnvironmentIds.has(environment.id) : false,
  );
  // Pipeline sessions need not project agent activity onto their environment.
  // The sidebar's activity sort applies the same derivation to every row.
  return {
    displayedActivityState: displayedEnvironmentActivity(activity, activeBuild),
    isRunning:
      environment?.environmentType === "local" ||
      (dockerAvailable && environment?.status === "running"),
  };
}
