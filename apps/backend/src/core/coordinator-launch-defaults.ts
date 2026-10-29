/**
 * What a coordinator launch runs when it leaves a model choice out.
 *
 * Coordinators are told to omit models and efforts so work runs on the user's
 * saved defaults. An omitted choice must therefore mean exactly what the
 * matching button means, or "use the defaults" silently becomes "use whatever
 * the backend happens to fall back to".
 *
 * Multi Review rows follow the button (`ActionBar.view.tsx` and
 * `MultiReviewLaunchDialog.tsx`), resolved over the backend's catalogue:
 *
 * - Reviewer 1 is the Review action default; Reviewer 2 is Review 2 when it
 *   names an enabled platform, else Review; Reviewer 3 onward are the saved
 *   additional reviewers, each falling back to Review.
 * - Preparation/consolidation and Fix use their own action default when it
 *   names an enabled platform, else Review.
 * - Each row layers its action's model, effort and speed over that platform's
 *   resolved settings, then picks the preferred catalogue model, else the
 *   connected model a tab with no model would start on (the one the catalogue
 *   marks `sessionDefault`, such as Pi's saved default), else the first
 *   connected one, keeping the effort and speed only when that model offers them.
 *   A Pi catalogue that marks no connected row leaves the model `default`, so
 *   the session starts where a Pi tab would rather than on the first row.
 *
 * Build pipelines use the shared `buildPipelineConfiguredDefaults`, the same
 * resolver the Build button uses.
 */
import {
  reportsSessionDefault,
  resolveCatalogModelId,
  sessionDefaultModel,
} from "@orkestrator/protocol/model-id";
import {
  resolveActionDefault,
  type ActionDefaultKey,
  type ResolvedActionDefault,
} from "@orkestrator/protocol/action-defaults";
import {
  AGENT_PLATFORMS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  buildPipelineConfiguredDefaults,
  defaultBuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline-defaults";
import type { BuildStepConfig } from "@orkestrator/protocol/build-pipeline";
import {
  DEFAULT_MULTI_REVIEW_REVIEWER_COUNT,
  resolveActionDefaults,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentSettingsTier,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import {
  MULTI_REVIEW_MAX_REVIEWERS,
  MULTI_REVIEW_MIN_REVIEWERS,
  type MultiReviewModelSelection,
} from "@orkestrator/protocol/multi-review";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { CommandContext, CommandHandler } from "./commands-context.js";

export interface MultiReviewDefaultRows {
  reviewers: MultiReviewModelSelection[];
  reviewModel: MultiReviewModelSelection;
  fixModel: MultiReviewModelSelection;
}

export interface MultiReviewDefaultSettings {
  tiers: AgentSettingsTiers;
  /** The button reads reviewer count and extra reviewers from app settings only. */
  global: AgentSettingsTier | undefined;
  enabledAgentPlatforms: unknown;
}

/** Layer one action's choices over its platform's settings, as the launch dialog does. */
function withPlatformSettings(
  tiers: AgentSettingsTiers,
  action: ResolvedActionDefault,
): ResolvedActionDefault {
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

function concreteRow(
  preference: ResolvedActionDefault,
  catalog: readonly AgentModel[],
): MultiReviewModelSelection {
  const offered = catalog.filter(
    (model) => model.platform === preference.agent && model.connected !== false,
  );
  const preferredId = resolveCatalogModelId(preference.agent, offered, preference.model);
  const preferred = offered.find((model) => model.id === preferredId);
  // With no catalogue for this platform there is nothing to correct a saved
  // model against, so it is kept rather than replaced by a placeholder. With
  // nothing saved, the row runs where a tab with no model would: the first
  // catalogue entry can be one the login refuses (Pi on a ChatGPT login).
  // A Pi catalogue with no connected marked row is a cache written before the
  // mark existed, a disconnected default, or a login with no saved default;
  // only the session can tell which, so the row is left to it (`default`).
  const leftToSession =
    !preferred &&
    offered.length > 0 &&
    reportsSessionDefault(preference.agent) &&
    !offered.some((model) => model.sessionDefault === true);
  const selected = preferred ?? (leftToSession ? undefined : sessionDefaultModel(offered));
  const unavailable =
    !leftToSession && catalog.some((model) => model.platform === preference.agent) && !selected;
  const model =
    selected?.id ?? (unavailable || leftToSession ? "default" : preference.model) ?? "default";
  const effort = preference.reasoningEffort;
  const keepsEffort =
    effort !== undefined &&
    effort !== "default" &&
    ((!selected && !unavailable) || (selected?.reasoning ?? []).some(({ id }) => id === effort));
  const keepsSpeed =
    typeof preference.fastMode === "boolean" &&
    ((!selected && !unavailable) || selected?.supportsSpeed === true);
  return {
    agent: preference.agent,
    model,
    ...(keepsEffort ? { reasoningEffort: effort } : {}),
    ...(keepsSpeed ? { fastMode: preference.fastMode } : {}),
  };
}

export function multiReviewDefaultRows(
  settings: MultiReviewDefaultSettings,
  catalog: readonly AgentModel[],
): MultiReviewDefaultRows {
  const { tiers } = settings;
  const enabledAgents = normalizeAgentPlatforms(settings.enabledAgentPlatforms);
  const configuredFallback = resolveDefaultAgent(tiers);
  const fallbackAgent: AgentPlatform = enabledAgents.includes(configuredFallback)
    ? configuredFallback
    : (enabledAgents[0] ?? configuredFallback);
  const actionDefaults = resolveActionDefaults(tiers);
  const actionRow = (key: ActionDefaultKey) =>
    withPlatformSettings(
      tiers,
      resolveActionDefault(actionDefaults, key, { fallbackAgent, enabledAgents }),
    );
  /** Only an action that names an enabled platform replaces the Review row. */
  const configuredRow = (key: ActionDefaultKey) => {
    const platform = actionDefaults[key]?.platform;
    return platform && enabledAgents.includes(platform) ? actionRow(key) : undefined;
  };

  const review = actionRow("review");
  const storedCount =
    settings.global?.multiReview?.reviewerCount ?? DEFAULT_MULTI_REVIEW_REVIEWER_COUNT;
  const count = Math.min(
    MULTI_REVIEW_MAX_REVIEWERS,
    Math.max(MULTI_REVIEW_MIN_REVIEWERS, storedCount),
  );
  const additional = settings.global?.multiReview?.additionalReviewers ?? [];
  const reviewers = Array.from({ length: count }, (_, index) => {
    if (index === 0) return review;
    if (index === 1) return configuredRow("review2") ?? review;
    const entry = additional[index - DEFAULT_MULTI_REVIEW_REVIEWER_COUNT];
    if (!entry?.platform || !enabledAgents.includes(entry.platform)) return review;
    return withPlatformSettings(tiers, {
      agent: entry.platform,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      ...(entry.fastMode !== undefined ? { fastMode: entry.fastMode } : {}),
    });
  });
  return {
    reviewers: reviewers.map((row) => concreteRow(row, catalog)),
    reviewModel: concreteRow(configuredRow("reviewPreparation") ?? review, catalog),
    fixModel: concreteRow(configuredRow("fixReviewIssues") ?? review, catalog),
  };
}

/** The saved settings a coordinator launch inherits, read from persisted config. */
export function savedLaunchSettings(
  config: {
    global: { agentSettings?: AgentSettingsTier; enabledAgentPlatforms?: unknown };
    repositories: Record<string, { agentSettings?: AgentSettingsTier } | undefined>;
  },
  projectId: string,
  environment?: { agentSettings?: AgentSettingsTier },
): MultiReviewDefaultSettings {
  return {
    tiers: {
      environment: environment?.agentSettings,
      repository: config.repositories[projectId]?.agentSettings,
      global: config.global.agentSettings,
    },
    global: config.global.agentSettings,
    enabledAgentPlatforms: config.global.enabledAgentPlatforms,
  };
}

/**
 * A named step that leaves out its agent names only instructions (the
 * coordinator schema allows that): it keeps the saved selection it replaces.
 */
function withSavedSelection(step: unknown, saved: BuildStepConfig | undefined): unknown {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  if ((step as { agent?: unknown }).agent !== undefined || !saved) return step;
  return { ...saved, ...step, agent: saved.agent };
}

/**
 * A build request with every omitted choice filled from the Build button's defaults.
 *
 * Explicit steps are layered over the saved ones and explicit reviewers replace
 * them, exactly as `useBuildPipeline` does for the renderer. The build agent
 * defaults the way the launcher's does. Environment-tier settings are not
 * read: the launcher resolves before any worker exists.
 *
 * A step or preparation named without an agent carries only instructions and
 * keeps the saved selection: the build step the pipeline agent, a reviewer its
 * saved row, and preparation its saved model (Address's, which unconfigured
 * preparation borrows, when the saved review has one reviewer).
 */
export function buildPipelineInputWithDefaults(
  input: Record<string, unknown>,
  settings: MultiReviewDefaultSettings,
): Record<string, unknown> {
  const tiers = { repository: settings.tiers.repository, global: settings.tiers.global };
  const enabled = Array.isArray(settings.enabledAgentPlatforms)
    ? normalizeAgentPlatforms(settings.enabledAgentPlatforms)
    : undefined;
  const configured = buildPipelineConfiguredDefaults(tiers, enabled ?? AGENT_PLATFORMS);
  const explicitSteps =
    input.steps && typeof input.steps === "object" && !Array.isArray(input.steps)
      ? (input.steps as Record<string, unknown>)
      : {};
  // A named build step decides the pipeline agent, as it does in the launcher.
  const buildStep = explicitSteps.build as { agent?: unknown } | undefined;
  const agentType =
    buildStep?.agent ??
    input.agentType ??
    defaultBuildPipelineAgent(tiers, enabled ?? ["claude", "codex", "opencode"]);
  const saved: Record<string, BuildStepConfig | undefined> = {
    ...configured.steps,
    build: { agent: agentType as BuildStepConfig["agent"] },
  };
  const steps: Record<string, unknown> = { ...configured.steps };
  for (const [key, step] of Object.entries(explicitSteps)) {
    steps[key] = withSavedSelection(step, saved[key]);
  }
  const reviewers =
    input.reviewers ??
    configured.reviewers.map((reviewer, index) =>
      index === 0 && steps.review ? steps.review : reviewer,
    );
  if (Array.isArray(reviewers) && reviewers.length > 0) steps.review = reviewers[0];
  const reviewPreparation =
    input.reviewPreparation !== undefined
      ? withSavedSelection(
          input.reviewPreparation,
          configured.reviewPreparation ?? configured.steps.address,
        )
      : Array.isArray(reviewers) && reviewers.length > 1
        ? configured.reviewPreparation
        : undefined;
  return {
    ...input,
    agentType,
    steps,
    reviewers: Array.isArray(reviewers) && reviewers.length === 1 ? undefined : reviewers,
    reviewPreparation,
  };
}

/**
 * The environment's model catalogue for resolving omitted rows. Unreadable
 * means empty: rows then keep their saved model ids, or the agent's own default.
 */
export async function readLaunchModelCatalog(
  command: CommandHandler | undefined,
  environmentId: string,
  context: CommandContext,
): Promise<AgentModel[]> {
  if (!command) return [];
  try {
    const raw = await command({ environmentId }, context);
    return Array.isArray(raw) ? (raw as AgentModel[]) : [];
  } catch {
    return [];
  }
}

/**
 * A Multi Review request with omitted rows and auto-actions taken from saved defaults.
 *
 * The catalogue is read only when a row actually needs resolving.
 */
export async function multiReviewInputWithDefaults(
  input: Record<string, unknown>,
  settings: MultiReviewDefaultSettings,
  readCatalog: () => Promise<AgentModel[]>,
): Promise<Record<string, unknown>> {
  const rows =
    input.reviewers !== undefined && input.reviewModel !== undefined && input.fixModel !== undefined
      ? undefined
      : multiReviewDefaultRows(settings, await readCatalog());
  return {
    ...input,
    reviewers: input.reviewers ?? rows!.reviewers,
    reviewModel: input.reviewModel ?? rows!.reviewModel,
    fixModel: input.fixModel ?? rows!.fixModel,
    ...multiReviewAutomation(input, settings.global?.multiReview),
  };
}

/**
 * The auto-fix and auto-PR a coordinator Multi Review runs.
 *
 * Omitted values take the saved app-level settings, the ones the Multi Review
 * button reads (`ActionBar.view.tsx`). A requested `autoPr: true` asks for the
 * whole review → Fix → PR flow, so an omitted `autoFix` is turned on with it.
 * An explicit `autoFix: false` is kept: the PR then follows a Fix started with
 * `address_multi_review`, as the button allows. Either way the PR is queued
 * only with proof that a Fix finished, never before.
 */
export function multiReviewAutomation(
  input: { autoFix?: unknown; autoPr?: unknown },
  saved: { autoFix?: boolean; autoPr?: boolean } | undefined,
): { autoFix: boolean; autoPr: boolean } {
  const autoPr = typeof input.autoPr === "boolean" ? input.autoPr : (saved?.autoPr ?? false);
  const autoFix =
    typeof input.autoFix === "boolean"
      ? input.autoFix
      : input.autoPr === true || (saved?.autoFix ?? false);
  return { autoFix, autoPr };
}
