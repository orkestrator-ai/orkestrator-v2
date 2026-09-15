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
  /**
   * Present only when the pipeline actually fans out. A single reviewer keeps
   * the classic inline review-package path; synthesising a preparation model
   * here would start an extra Package Preparation Session on the backend.
   */
  reviewPreparation?: BuildStepConfig;
}

/**
 * `"default"` is a UI placeholder no provider knows. Pinning it would send the
 * backend a model or effort it cannot resolve, so it is dropped instead.
 */
function pinOrOmit(value: string | undefined): string | undefined {
  if (!value || value === "default") return undefined;
  return value;
}

function actionSelection(
  tiers: ReturnType<typeof agentSettingsTiers>,
  key: ActionDefaultKey,
  enabledAgents: readonly AgentPlatform[],
): BuildStepConfig {
  const action = resolvedActionDefault(tiers, key, enabledAgents);
  const platform = resolveAgentPlatformSettings(tiers, action.agent);
  const model = pinOrOmit(action.model ?? platform.model);
  const reasoningEffort = pinOrOmit(action.reasoningEffort ?? platform.reasoningEffort);
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
  const model = pinOrOmit(entry.model ?? platform.model);
  const reasoningEffort = pinOrOmit(entry.reasoningEffort ?? platform.reasoningEffort);
  const fastMode = entry.fastMode ?? platform.fastMode;
  return {
    agent: entry.platform,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

function actionHasUsablePlatform(
  entry: AgentActionDefault | undefined,
  enabledAgents: readonly AgentPlatform[],
): boolean {
  return Boolean(entry?.platform && enabledAgents.includes(entry.platform));
}

/** OpenCode ids a launcher must keep visible while the project catalogue loads. */
export function configuredOpenCodeModelIds(defaults: BuildPipelineConfiguredDefaults): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const consider = (step?: BuildStepConfig) => {
    if (step?.agent !== "opencode") return;
    const model = pinOrOmit(step.model);
    if (!model || seen.has(model)) return;
    seen.add(model);
    ids.push(model);
  };
  for (const step of Object.values(defaults.steps)) consider(step);
  for (const reviewer of defaults.reviewers) consider(reviewer);
  consider(defaults.reviewPreparation);
  return ids;
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
    reviewerCount > 1
      ? actionHasUsablePlatform(configuredActions.reviewPreparation, enabledAgents)
        ? actionSelection(tiers, "reviewPreparation", enabledAgents)
        : { ...review }
      : undefined;
  const verify = actionHasUsablePlatform(configuredActions.verify, enabledAgents)
    ? actionSelection(tiers, "verify", enabledAgents)
    : actionSelection(tiers, "fixReviewIssues", enabledAgents);

  return {
    steps: {
      review: reviewers[0],
      address: actionSelection(tiers, "fixReviewIssues", enabledAgents),
      verify,
      pr: actionSelection(tiers, "pr", enabledAgents),
      "resolve-conflicts": actionSelection(tiers, "resolve", enabledAgents),
    },
    reviewers,
    ...(reviewPreparation ? { reviewPreparation } : {}),
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
