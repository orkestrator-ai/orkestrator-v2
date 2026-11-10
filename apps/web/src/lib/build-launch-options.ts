import { agentSettingsTiers } from "@/lib/agent-settings";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { BuildStepConfig } from "@orkestrator/protocol/build-pipeline";
import {
  buildPipelineConfiguredDefaults as sharedBuildPipelineConfiguredDefaults,
  type BuildPipelineConfiguredDefaults,
} from "@orkestrator/protocol/build-pipeline-defaults";
import type { LaunchAgent } from "@/lib/agent-launch";
import { resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { AppConfig, EnvironmentType } from "@/types";

export type { BuildPipelineConfiguredDefaults };

export interface BuildLaunchDefaults {
  defaultAgent: LaunchAgent;
  defaultEnvironmentType: EnvironmentType;
  preferredModels: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts: Partial<Record<LaunchAgent, string>>;
  preferredFastModes: Partial<Record<LaunchAgent, boolean>>;
}

/** `"default"` is a UI placeholder no provider knows, so it is never pinned. */
function pinOrOmit(value: string | undefined): string | undefined {
  if (!value || value === "default") return undefined;
  return value;
}

/**
 * OpenCode ids a launcher must keep visible while the project catalogue loads.
 *
 * A row names only a model its action chose; one that leaves it out opens on
 * the platform's own model (`inheritedModel`, the launcher's preferred
 * OpenCode model), so that id is kept too.
 */
export function configuredOpenCodeModelIds(
  defaults: BuildPipelineConfiguredDefaults,
  inheritedModel?: string,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const consider = (step?: BuildStepConfig) => {
    if (step?.agent !== "opencode") return;
    const model = pinOrOmit(step.model ?? inheritedModel);
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
 * The resolver lives in the protocol package so a coordinator-started build
 * runs exactly the defaults this launcher would.
 */
export function buildPipelineConfiguredDefaults(
  config: AppConfig,
  projectId: string,
): BuildPipelineConfiguredDefaults {
  return sharedBuildPipelineConfiguredDefaults(
    agentSettingsTiers(config, projectId || undefined),
    config.global.enabledAgentPlatforms ?? AGENT_PLATFORMS,
  );
}

/**
 * The configured workflow as a launcher panel opens it.
 *
 * A configured row names only a model its action chose, so the stage can
 * resolve an inherited default when it starts (to-do 7546). A panel that
 * resolves each row against the catalogue still has to open an unpinned row
 * on its platform's own saved model, as the build row does, rather than on the
 * catalogue's first entry; this fills that model in for display.
 */
export function buildPipelineLauncherDefaults(
  config: AppConfig,
  projectId: string,
): BuildPipelineConfiguredDefaults {
  const tiers = agentSettingsTiers(config, projectId || undefined);
  const withPlatformModel = (step: BuildStepConfig): BuildStepConfig => {
    if (pinOrOmit(step.model)) return step;
    const model = pinOrOmit(resolveAgentPlatformSettings(tiers, step.agent).model);
    return model ? { ...step, model } : step;
  };
  const configured = buildPipelineConfiguredDefaults(config, projectId);
  const steps: BuildPipelineConfiguredDefaults["steps"] = {};
  for (const [key, step] of Object.entries(configured.steps) as Array<
    [keyof BuildPipelineConfiguredDefaults["steps"], BuildStepConfig | undefined]
  >) {
    if (step) steps[key] = withPlatformModel(step);
  }
  return {
    steps,
    reviewers: configured.reviewers.map(withPlatformModel),
    ...(configured.reviewPreparation
      ? { reviewPreparation: withPlatformModel(configured.reviewPreparation) }
      : {}),
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
