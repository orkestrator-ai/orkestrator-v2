import { resolvedDefaultAgent } from "@/lib/agent-settings";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AppConfig, ClaudeMode, CodexMode, DefaultAgent, OpenCodeMode } from "@/types";
import { firstEnabledAgentPlatform } from "@orkestrator/protocol/agent-platforms";

export function resolveBuildPipelineAgent(config: AppConfig, projectId: string): DefaultAgent {
  return firstEnabledAgentPlatform(
    config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    resolvedDefaultAgent(config, projectId),
  );
}

export function resolveActiveBuildPipelineAgent({
  pipelineAgent,
  environmentDefaultAgent,
  config,
  projectId,
}: {
  pipelineAgent?: DefaultAgent;
  environmentDefaultAgent?: DefaultAgent;
  config: AppConfig;
  projectId: string;
}): DefaultAgent {
  return pipelineAgent ?? environmentDefaultAgent ?? resolveBuildPipelineAgent(config, projectId);
}

export type AgentModeSettings = {
  defaultAgent: DefaultAgent;
  claudeMode: ClaudeMode | null;
  opencodeMode: OpenCodeMode | null;
  codexMode: CodexMode | null;
};

/**
 * Route the selected agent's mode into its own backend slot and null the two
 * that were not selected.
 *
 * The backend keeps one mode column per agent, so leaving a stale mode on an
 * agent the environment is no longer using would make a later agent switch
 * inherit a mode the user never chose for it. Every caller that writes agent
 * settings must null the other two, which is why this lives here rather than
 * being restated at each call site.
 */
/**
 * The environment overrides a newly created environment should carry.
 *
 * Only the launching agent's own column is pinned. The other platforms are left
 * unset so they keep inheriting — writing all three would freeze this
 * environment against later repository or app changes it never opted out of.
 */
export function resolveAgentModeSettings(
  agentType: DefaultAgent,
  modes: {
    claudeMode: ClaudeMode;
    opencodeMode: OpenCodeMode;
    codexMode: CodexMode;
  },
): AgentSettingsTier {
  const mode =
    agentType === "claude"
      ? modes.claudeMode
      : agentType === "codex"
        ? modes.codexMode
        : modes.opencodeMode;
  return { defaultAgent: agentType, platforms: { [agentType]: { mode } } };
}

export type BuildEnvironmentAgentSettings = AgentSettingsTier & {
  /**
   * Which agent this pipeline will open, for both the transient options store
   * and the durable `pendingAgentLaunch` intent.
   *
   * Deliberately the agent itself rather than a Claude-only boolean: every
   * pipeline opens a native agent surface, so every pipeline needs the launch
   * recorded durably. The persisted flag stays a boolean because the identity
   * is carried by `defaultAgent`, written in the same backend call and read
   * back by the restore path in `TerminalContainer`.
   */
  launchAgent: DefaultAgent;
};

export function getBuildEnvironmentAgentSettings(
  agentType: DefaultAgent,
): BuildEnvironmentAgentSettings {
  return {
    // A build pipeline always drives the agent through its native surface, so
    // the selected agent's mode is forced rather than taken from user config.
    ...resolveAgentModeSettings(agentType, {
      claudeMode: "native",
      opencodeMode: "native",
      codexMode: "native",
    }),
    launchAgent: agentType,
  };
}
