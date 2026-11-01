/**
 * The saved build workflow an untouched launch runs.
 *
 * Shared by the renderer's build launchers and the coordinator's
 * `start_build_pipeline`, so a pipeline a coordinator starts with no step,
 * reviewer or preparation choices runs exactly what the Build button would:
 * the same Multi Review count and models, preparation/consolidation, fix,
 * verification, PR and conflict-resolution defaults.
 */
import {
  resolveActionDefault,
  type ActionDefaultKey,
  type AgentActionDefault,
} from "./action-defaults.js";
import { firstEnabledAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import {
  resolveActionDefaults,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  resolveMultiReviewSettings,
  type AgentSettingsTiers,
} from "./agent-settings.js";
import {
  MAX_BUILD_PIPELINE_REVIEWERS,
  type BuildPipelineAgent,
  type BuildStepConfig,
  type BuildStepConfigs,
  type StartBuildPipelineInput,
} from "./build-pipeline.js";

/**
 * `launch_build_pipeline`: a start request whose choices are all optional. The
 * backend fills whatever is left out from the saved Build defaults, so a client
 * sends only what the user explicitly chose.
 */
export type LaunchBuildPipelineInput = Omit<StartBuildPipelineInput, "agentType"> & {
  agentType?: BuildPipelineAgent;
};

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
  tiers: AgentSettingsTiers,
  key: ActionDefaultKey,
  enabledAgents: readonly AgentPlatform[],
): BuildStepConfig {
  const configuredFallback = resolveDefaultAgent(tiers);
  const fallbackAgent = enabledAgents.includes(configuredFallback)
    ? configuredFallback
    : (enabledAgents[0] ?? configuredFallback);
  const action = resolveActionDefault(resolveActionDefaults(tiers), key, {
    fallbackAgent,
    enabledAgents,
  });
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
  tiers: AgentSettingsTiers,
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

/**
 * The one configured build workflow used after a ticket exists.
 *
 * Both feature creation and ticket Build calls consume this shape. Explicit
 * launcher choices are layered over it at dispatch time; untouched launches
 * therefore use the same Multi Review count/models, preparation/consolidation,
 * fix, verification, PR, and conflict-resolution defaults.
 */
export function buildPipelineConfiguredDefaults(
  tiers: AgentSettingsTiers,
  enabledAgents: readonly AgentPlatform[],
): BuildPipelineConfiguredDefaults {
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
    const selection =
      index === 0
        ? { ...review }
        : index === 1
          ? { ...review2 }
          : configuredReviewer(
              multiReview.additionalReviewers[index - 2],
              review,
              tiers,
              enabledAgents,
            );
    // The saved focus for this position travels with its row, exactly as the
    // Multi Review button's rows carry it.
    const lens = multiReview.reviewerLenses[index];
    return lens ? { ...selection, lens: { ...lens } } : selection;
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

/** The pipeline's build agent when the launcher names none: the first enabled default. */
export function defaultBuildPipelineAgent(
  tiers: AgentSettingsTiers,
  enabledAgents: readonly AgentPlatform[],
): BuildPipelineAgent {
  return firstEnabledAgentPlatform(enabledAgents, resolveDefaultAgent(tiers)) as BuildPipelineAgent;
}
