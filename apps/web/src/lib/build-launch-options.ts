import { agentSettingsTiers } from "@/lib/agent-settings";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { LaunchAgent } from "@/lib/agent-launch";
import { resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { AppConfig, EnvironmentType } from "@/types";

export interface BuildLaunchDefaults {
  defaultAgent: LaunchAgent;
  defaultEnvironmentType: EnvironmentType;
  preferredModels: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts: Partial<Record<LaunchAgent, string>>;
}

/**
 * What the build launcher opens pre-filled with.
 *
 * Each platform's own resolved model and effort, from the shared tier resolver.
 *
 * A model id only means something inside its own platform's catalogue, so every
 * platform resolves separately rather than being seeded from one
 * repository-wide value — which is what used to offer a Codex model as a Claude
 * default.
 */
export function buildLaunchDefaults(
  config: AppConfig,
  projectId: string,
  projectHasLocalPath: boolean,
): BuildLaunchDefaults {
  const repository = config.repositories[projectId];
  const defaultAgent = resolveBuildPipelineAgent(config, projectId);
  const tiers = agentSettingsTiers(config, projectId);
  const preferredModels: Partial<Record<AgentPlatform, string>> = {};
  const preferredReasoningEfforts: Partial<Record<AgentPlatform, string>> = {};
  for (const platform of AGENT_PLATFORMS) {
    const resolved = resolveAgentPlatformSettings(tiers, platform);
    // `"default"` is a placeholder no provider knows, so it is dropped rather
    // than offered as a selection.
    if (resolved.model && resolved.model !== "default") preferredModels[platform] = resolved.model;
    if (resolved.reasoningEffort && resolved.reasoningEffort !== "default") {
      preferredReasoningEfforts[platform] = resolved.reasoningEffort;
    }
  }
  return {
    defaultAgent,
    defaultEnvironmentType:
      repository?.lastEnvironmentType ?? (projectHasLocalPath ? "local" : "containerized"),
    preferredModels,
    preferredReasoningEfforts,
  };
}
