import {
  resolveActionDefault,
  type ActionDefaultKey,
  type ResolvedActionDefault,
} from "@orkestrator/protocol/action-defaults";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import {
  resolveActionDefaults,
  resolveDefaultAgent,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";

/**
 * The agent, model and effort an action-bar button would use in an
 * environment: its configured action default across the environment,
 * repository and global tiers, else the default agent, restricted to enabled
 * platforms. Backend launches that stand in for a button click use this so
 * they pick what the button would.
 */
export async function resolveEnvironmentActionDefault(
  storage: Pick<StorageService, "loadConfig">,
  environment: Pick<Environment, "agentSettings" | "projectId">,
  key: ActionDefaultKey,
): Promise<ResolvedActionDefault> {
  const config = await storage.loadConfig();
  const tiers: AgentSettingsTiers = {
    environment: environment.agentSettings,
    repository: config.repositories?.[environment.projectId]?.agentSettings,
    global: config.global.agentSettings,
  };
  const enabled = normalizeAgentPlatforms(config.global.enabledAgentPlatforms);
  const configuredFallback = resolveDefaultAgent(tiers);
  return resolveActionDefault(resolveActionDefaults(tiers), key, {
    fallbackAgent: enabled.includes(configuredFallback)
      ? configuredFallback
      : (enabled[0] ?? configuredFallback),
    enabledAgents: enabled,
  });
}
