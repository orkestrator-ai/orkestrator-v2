import { agentSettingsTiers } from "@/lib/agent-settings";
import { resolvedActionDefault } from "@/lib/agent-settings";
import {
  resolveActionDefaults,
  resolveAgentPlatformSettings,
  resolveMultiReviewSettings,
} from "@orkestrator/protocol/agent-settings";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentActionDefault, ActionDefaultKey } from "@orkestrator/protocol/action-defaults";
import {
  MAX_BUILD_PIPELINE_REVIEWERS,
  type BuildStepConfig,
  type BuildStepConfigs,
} from "@orkestrator/protocol/build-pipeline";
import type { LaunchAgent } from "@/lib/agent-launch";
import { resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { AppConfig, EnvironmentType } from "@/types";

export interface BuildLaunchDefaults {
  defaultAgent: LaunchAgent;
  defaultEnvironmentType: EnvironmentType;
  preferredModels: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts: Partial<Record<LaunchAgent, string>>;
  preferredFastModes: Partial<Record<LaunchAgent, boolean>>;
}

export interface BuildPipelineConfiguredDefaults {
  steps: BuildStepConfigs;
  reviewers: BuildStepConfig[];
  reviewPreparation: BuildStepConfig;
}

function actionSelection(
  tiers: ReturnType<typeof agentSettingsTiers>,
  key: ActionDefaultKey,
  enabledAgents: readonly AgentPlatform[],
): BuildStepConfig {
  const action = resolvedActionDefault(tiers, key, enabledAgents);
  const platform = resolveAgentPlatformSettings(tiers, action.agent);
  const model = action.model ?? platform.model;
  const reasoningEffort = action.reasoningEffort ?? platform.reasoningEffort;
  const fastMode = action.fastMode ?? platform.fastMode;
  return {
    agent: action.agent,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

function configuredReviewer(
  entry: AgentActionDefault | null | undefined,
  fallback: BuildStepConfig,
  tiers: ReturnType<typeof agentSettingsTiers>,
  enabledAgents: readonly AgentPlatform[],
): BuildStepConfig {
  if (!entry?.platform || !enabledAgents.includes(entry.platform)) return { ...fallback };
  const platform = resolveAgentPlatformSettings(tiers, entry.platform);
  const model = entry.model ?? platform.model;
  const reasoningEffort = entry.reasoningEffort ?? platform.reasoningEffort;
  const fastMode = entry.fastMode ?? platform.fastMode;
  return {
    agent: entry.platform,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

/**
 * The one configured build workflow used after a ticket exists.
 *
 * Both feature creation and ticket Build calls consume this shape. Explicit
 * launcher choices are layered over it at dispatch time; untouched launches
 * therefore use the same Multi Review count/models, preparation/consolidation,
 * fix, verification, PR, and conflict-resolution defaults.
 */
export function buildPipelineConfiguredDefaults(
  config: AppConfig,
  projectId: string,
): BuildPipelineConfiguredDefaults {
  const tiers = agentSettingsTiers(config, projectId || undefined);
  const enabledAgents = config.global.enabledAgentPlatforms ?? AGENT_PLATFORMS;
  const configuredActions = resolveActionDefaults(tiers);
  const review = actionSelection(tiers, "review", enabledAgents);
  const review2 =
    configuredActions.review2?.platform &&
    enabledAgents.includes(configuredActions.review2.platform)
      ? actionSelection(tiers, "review2", enabledAgents)
      : review;
  const multiReview = resolveMultiReviewSettings(tiers);
  const reviewerCount = Math.min(
    MAX_BUILD_PIPELINE_REVIEWERS,
    Math.max(1, multiReview.reviewerCount),
  );
  const reviewers = Array.from({ length: reviewerCount }, (_, index) => {
    if (index === 0) return { ...review };
    if (index === 1) return { ...review2 };
    return configuredReviewer(
      multiReview.additionalReviewers[index - 2],
      review,
      tiers,
      enabledAgents,
    );
  });
  const reviewPreparation =
    configuredActions.reviewPreparation?.platform &&
    enabledAgents.includes(configuredActions.reviewPreparation.platform)
      ? actionSelection(tiers, "reviewPreparation", enabledAgents)
      : { ...review };

  return {
    steps: {
      review: reviewers[0],
      address: actionSelection(tiers, "fixReviewIssues", enabledAgents),
      verify: actionSelection(tiers, "verify", enabledAgents),
      pr: actionSelection(tiers, "pr", enabledAgents),
      "resolve-conflicts": actionSelection(tiers, "resolve", enabledAgents),
    },
    reviewers,
    reviewPreparation,
  };
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
  const preferredFastModes: Partial<Record<AgentPlatform, boolean>> = {};
  for (const platform of AGENT_PLATFORMS) {
    const resolved = resolveAgentPlatformSettings(tiers, platform);
    // `"default"` is a placeholder no provider knows, so it is dropped rather
    // than offered as a selection.
    if (resolved.model && resolved.model !== "default") preferredModels[platform] = resolved.model;
    if (resolved.reasoningEffort && resolved.reasoningEffort !== "default") {
      preferredReasoningEfforts[platform] = resolved.reasoningEffort;
    }
    if (typeof resolved.fastMode === "boolean") preferredFastModes[platform] = resolved.fastMode;
  }
  return {
    defaultAgent,
    defaultEnvironmentType:
      repository?.lastEnvironmentType ?? (projectHasLocalPath ? "local" : "containerized"),
    preferredModels,
    preferredReasoningEfforts,
    preferredFastModes,
  };
}
