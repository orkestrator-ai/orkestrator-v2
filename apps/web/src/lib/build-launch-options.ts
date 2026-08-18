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
 * The repository's `defaultModel` and `defaultEffort` apply to the repository's
 * default agent only — they are stored per repository rather than per agent, and
 * the backend already resolves them that way for a pipeline that pins nothing.
 * Seeding every agent with them would offer a Codex model as a Claude default.
 */
export function buildLaunchDefaults(
  config: AppConfig,
  projectId: string,
  projectHasLocalPath: boolean,
): BuildLaunchDefaults {
  const repository = config.repositories[projectId];
  const defaultAgent = resolveBuildPipelineAgent(config, projectId);
  const repositoryModel = repository?.defaultModel;
  const repositoryEffort = repository?.defaultEffort;
  return {
    defaultAgent,
    defaultEnvironmentType:
      repository?.lastEnvironmentType ?? (projectHasLocalPath ? "local" : "containerized"),
    preferredModels: {
      claude: config.global.claudeModel,
      codex: config.global.codexModel,
      opencode: config.global.opencodeModel,
      ...(repositoryModel && repositoryModel !== "default"
        ? { [defaultAgent]: repositoryModel }
        : {}),
    },
    preferredReasoningEfforts: {
      codex: config.global.codexReasoningEffort,
      ...(repositoryEffort && repositoryEffort !== "default"
        ? { [defaultAgent]: repositoryEffort }
        : {}),
    },
  };
}
