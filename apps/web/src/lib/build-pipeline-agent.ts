import type { AppConfig, ClaudeMode, CodexMode, DefaultAgent, OpenCodeMode } from "@/types";

export function resolveBuildPipelineAgent(
  config: AppConfig,
  projectId: string,
): DefaultAgent {
  return config.repositories[projectId]?.defaultAgent
    ?? config.global.defaultAgent
    ?? "claude";
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
  return pipelineAgent
    ?? environmentDefaultAgent
    ?? resolveBuildPipelineAgent(config, projectId);
}

export function getBuildEnvironmentAgentSettings(agentType: DefaultAgent): {
  defaultAgent: DefaultAgent;
  claudeMode: ClaudeMode | null;
  opencodeMode: OpenCodeMode | null;
  codexMode: CodexMode | null;
  shouldLaunchClaude: boolean;
} {
  return {
    defaultAgent: agentType,
    claudeMode: agentType === "claude" ? "native" : null,
    opencodeMode: agentType === "opencode" ? "native" : null,
    codexMode: agentType === "codex" ? "native" : null,
    shouldLaunchClaude: agentType === "claude",
  };
}
