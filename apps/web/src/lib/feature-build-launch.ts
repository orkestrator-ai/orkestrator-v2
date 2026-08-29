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
import type {
  BuildStepConfig,
  BuildStepConfigs,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
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

function reviewerConfigs(models: FeatureBuildModelState): BuildStepConfig[] {
  const reviewers = models.reviewers.map(stepConfig);
  return reviewers.length > 0 ? reviewers : [stepConfig(models.build)];
}

/**
 * The per-step payload and reviewer panel.
 *
 * The feature launcher sends every resolved step and reviewer selection,
 * whether the editor is open or closed. Each row is an independent review,
 * even when two rows happen to name the same model: collapsing rows here
 * silently changes the workflow from fan-out plus consolidation to the classic
 * single-review path. An empty panel falls back to the build selection, keeping
 * this pure boundary valid even though the UI also prevents removing the last
 * reviewer.
 */
export function featureBuildStepConfigs(models: FeatureBuildModelState): {
  steps: BuildStepConfigs;
  reviewers: BuildStepConfig[];
} {
  const reviewers = reviewerConfigs(models);
  return {
    steps: {
      build: stepConfig(models.build),
      review: reviewers[0],
      address: stepConfig(models.address),
      pr: stepConfig(models.pr),
      "resolve-conflicts": stepConfig(models.resolve),
    },
    reviewers,
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
  images?: TaskSnapshotImage[];
  models: FeatureBuildModelState;
  requestId: string;
}

export function featureBuildRequest(input: FeatureBuildRequestInput): CreateFeatureBuildInput {
  const configured = featureBuildStepConfigs(input.models);
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
    // The editor's visibility never changes execution. Its resolved build
    // selection is also the pipeline harness, so the two cannot drift.
    agentType: input.models.build.agent,
    steps: configured.steps,
    // Review configuration is always explicit so the backend can distinguish
    // the default fan-out from the legacy single-review pipeline.
    reviewers: configured.reviewers,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    requestId: input.requestId,
  };
}

/**
 * What an idempotency key is allowed to stand for.
 *
 * The backend binds a `requestId` to the arguments it first saw and refuses to
 * reuse it for anything else, so a caller that keeps a key across an edit gets
 * a hard rejection rather than a new build. This is everything the backend
 * hashes — the request minus the key itself — so a launcher can tell "the same
 * request again", which must reuse the key, from "a different request", which
 * must mint a new one.
 *
 * Key order is normalised because the shape of the request depends on which
 * optional fields are present, and two objects that differ only in insertion
 * order are the same request.
 */
export function featureBuildIdentity(request: CreateFeatureBuildInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key, entry]) => key !== "requestId" && entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(request));
}
