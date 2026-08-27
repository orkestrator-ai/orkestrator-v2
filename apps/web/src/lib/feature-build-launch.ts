/**
 * Turning the create-environment dialog's feature form into one backend request.
 *
 * The dialog collects a ticket and, behind "Advanced", a model per pipeline
 * step. Everything here is form shaping — resolving a configured default
 * against the live catalogue, and flattening the form into the command's
 * payload. No part of the build itself happens in the renderer: the backend
 * creates the ticket, the environment and the pipeline from this one object.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { BuildStepConfig, BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import type { CreateFeatureBuildInput } from "@orkestrator/protocol/feature-build";
import {
  defaultEffortFor,
  firstModelFor,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { createUuid } from "@/lib/uuid";
import type { EnvironmentType, NetworkAccessMode, PortMapping } from "@/types";

/** How the dialog's Build section is being used. */
export type BuildIntent = "feature" | "prompt";

export interface FeatureBuildStepSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
}

/** A reviewer row. The key is presentational: reviewers have no identity yet. */
export interface FeatureBuildReviewerRow extends FeatureBuildStepSelection {
  key: string;
}

/**
 * The five decisions "Customize models" exposes.
 *
 * Verify is deliberately absent. It re-checks the branch against the ticket
 * immediately after the address stage has changed it, so running it on a
 * different model than the one that just did the work adds a picker without
 * adding a choice worth making — {@link featureBuildStepConfigs} sends the
 * address selection for it.
 */
export interface FeatureBuildModelState {
  build: FeatureBuildStepSelection;
  reviewers: FeatureBuildReviewerRow[];
  address: FeatureBuildStepSelection;
  pr: FeatureBuildStepSelection;
  resolve: FeatureBuildStepSelection;
}

/** A configured action default, before it is matched against the catalogue. */
export interface ConfiguredStepDefault {
  agent: AgentPlatform;
  model?: string;
  reasoningEffort?: string;
}

/**
 * The concrete selection a configured default resolves to.
 *
 * Resolution goes through `firstModelFor`/`defaultEffortFor` — the same helpers
 * the review, multi-review and build launchers use — so a Claude preference
 * stored as `claude-sonnet-5` still matches the catalogue's `sonnet` entry.
 */
export function resolveFeatureBuildStep(
  configured: ConfiguredStepDefault,
  catalog: AgentModelCatalog,
): FeatureBuildStepSelection {
  const agent = configured.agent;
  const model = firstModelFor(
    agent,
    catalog,
    configured.model ? { [agent]: configured.model } : undefined,
  );
  const reasoningEffort = defaultEffortFor(
    agent,
    model,
    catalog,
    configured.reasoningEffort ? { [agent]: configured.reasoningEffort } : undefined,
  );
  return {
    agent,
    model,
    ...(reasoningEffort === "default" ? {} : { reasoningEffort }),
  };
}

export function featureBuildReviewerRow(
  configured: ConfiguredStepDefault,
  catalog: AgentModelCatalog,
): FeatureBuildReviewerRow {
  return { key: createUuid(), ...resolveFeatureBuildStep(configured, catalog) };
}

/**
 * The panel's opening state.
 *
 * Two reviewers, because a second opinion is the point of a multi-model review
 * and one reviewer would silently take the classic single-review path. Both
 * come from Settings' own `review` and `review2` entries, so the panel opens on
 * exactly what the standalone Multi Review launcher would.
 */
export function defaultFeatureBuildModels(options: {
  catalog: AgentModelCatalog;
  build: ConfiguredStepDefault;
  review: ConfiguredStepDefault;
  review2: ConfiguredStepDefault;
  address: ConfiguredStepDefault;
  pr: ConfiguredStepDefault;
  resolve: ConfiguredStepDefault;
}): FeatureBuildModelState {
  const { catalog } = options;
  return {
    build: resolveFeatureBuildStep(options.build, catalog),
    reviewers: [
      featureBuildReviewerRow(options.review, catalog),
      featureBuildReviewerRow(options.review2, catalog),
    ],
    address: resolveFeatureBuildStep(options.address, catalog),
    pr: resolveFeatureBuildStep(options.pr, catalog),
    resolve: resolveFeatureBuildStep(options.resolve, catalog),
  };
}

function stepConfig(selection: FeatureBuildStepSelection): BuildStepConfig {
  return {
    agent: selection.agent,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

/**
 * The per-step payload, or nothing at all.
 *
 * When the user has not opened "Customize models" the request carries no steps,
 * so the backend applies the repository and global defaults it would have used
 * anyway. Sending the panel's resolved values regardless would freeze whatever
 * the catalogue happened to hold when the dialog opened into the pipeline.
 */
export function featureBuildStepConfigs(models: FeatureBuildModelState): {
  steps: BuildStepConfigs;
  reviewers: BuildStepConfig[];
} {
  return {
    steps: {
      build: stepConfig(models.build),
      review: stepConfig(models.reviewers[0] ?? models.build),
      address: stepConfig(models.address),
      pr: stepConfig(models.pr),
      "resolve-conflicts": stepConfig(models.resolve),
    },
    reviewers: models.reviewers.map(stepConfig),
  };
}

export interface FeatureBuildRequestInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  environmentType: EnvironmentType;
  environmentName: string;
  networkAccessMode: NetworkAccessMode;
  portMappings: PortMapping[];
  /** The dialog's Default Agent, used when the models panel is closed. */
  defaultAgent: LaunchAgent;
  customizeModels: boolean;
  models: FeatureBuildModelState;
  requestId: string;
}

export function featureBuildRequest(input: FeatureBuildRequestInput): CreateFeatureBuildInput {
  const configured = input.customizeModels ? featureBuildStepConfigs(input.models) : null;
  const name = input.environmentName.trim();
  const portMappings = input.environmentType === "containerized" ? input.portMappings : [];
  return {
    projectId: input.projectId,
    title: input.title.trim(),
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    ...(input.acceptanceCriteria.trim()
      ? { acceptanceCriteria: input.acceptanceCriteria.trim() }
      : {}),
    environmentType: input.environmentType,
    environmentOptions: {
      ...(name ? { name } : {}),
      networkAccessMode: input.networkAccessMode,
      ...(portMappings.length > 0 ? { portMappings } : {}),
    },
    agentType: configured?.steps.build?.agent ?? input.defaultAgent,
    ...(configured ? { steps: configured.steps, reviewers: configured.reviewers } : {}),
    requestId: input.requestId,
  };
}
