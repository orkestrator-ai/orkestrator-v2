import type {
  ReviewModelCatalog,
  ReviewModelOption,
  ReviewTabType,
} from "@/components/review/ReviewLaunchDialog";
import type { ClaudeModel } from "@/lib/claude-types";
import { FALLBACK_CLAUDE_MODELS } from "@/lib/claude-fallback-models";
import { CODEX_MODELS } from "@/lib/codex-models";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import {
  isSelectableOpenCodeModelId,
  openCodeModelDisplayLabel,
  openCodeModelProviderId,
} from "@orkestrator/protocol/native-agent";
import type { DefaultAgent, Environment, GlobalConfig, RepositoryConfig } from "@/types";

/**
 * `resolvedModel` mirrors the bridge's own catalog. Configuration stores a
 * Claude model in that resolved space (`claude-sonnet-5`) while these entries
 * are keyed by alias, so without it no configured Claude default can ever be
 * matched back to the option that represents it.
 */
function claudeReviewModelOption(model: ClaudeModel): ReviewModelOption {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    reasoningEfforts: model.supportedEffortLevels?.length
      ? [...model.supportedEffortLevels]
      : model.supportsEffort
        ? ["low", "medium", "high"]
        : [],
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    ...(model.supportsFastMode !== false ? { supportsSpeed: true as const } : {}),
  };
}

/** The renderer's shared Claude fallback, shaped like a live catalogue entry. */
const CLAUDE_FALLBACK_MODELS: ReviewModelOption[] =
  FALLBACK_CLAUDE_MODELS.map(claudeReviewModelOption);

/** Pi's own session default: where a Pi tab with no model starts. */
const PI_DEFAULT_MODEL: ReviewModelOption = {
  id: "default",
  name: "Pi default",
  reasoningEfforts: [],
};

const OPENCODE_DEFAULT_MODEL: ReviewModelOption = {
  id: "default",
  name: "Default",
  description: "Use OpenCode's last selected model",
  reasoningEfforts: [],
};

export function includeOpenCodeDefaultModel(models: ReviewModelOption[]): ReviewModelOption[] {
  return [
    OPENCODE_DEFAULT_MODEL,
    ...models.filter((model) => model.id !== OPENCODE_DEFAULT_MODEL.id),
  ];
}

/**
 * Add OpenCode ids that a picker already knows about (favourites, TUI recents)
 * but that the live/cached catalogue has not listed yet.
 *
 * A catalogue that is only the synthetic "Default" placeholder is replaced so
 * launchers do not keep offering a sentinel once concrete models exist.
 */
export function includeMissingOpenCodeModels(
  models: ReviewModelOption[],
  modelIds: readonly string[],
  allowedProviders: readonly string[],
): ReviewModelOption[] {
  const extras: ReviewModelOption[] = [];
  const existing = new Set(models.map((model) => model.id));
  for (const modelId of modelIds) {
    if (existing.has(modelId)) continue;
    if (!isSelectableOpenCodeModelId(modelId, allowedProviders)) continue;
    const providerId = openCodeModelProviderId(modelId);
    if (!providerId) continue;
    existing.add(modelId);
    extras.push({
      id: modelId,
      name: openCodeModelDisplayLabel(modelId),
      providerLabel: providerId,
      description: providerId,
      reasoningEfforts: [],
    });
  }
  if (extras.length === 0) return models;
  const withoutPlaceholder = models.length === 1 && models[0]?.id === "default" ? [] : models;
  return [...withoutPlaceholder, ...extras];
}

/**
 * Model options every launcher starts from.
 *
 * OpenCode has no renderer-side live catalogue, so its entry is the unpinned
 * `"default"` placeholder; launchers that know a project overlay the backend's
 * durable OpenCode model cache on top of it.
 */
export function buildReviewModelCatalog(
  models: Pick<
    ReturnType<typeof useAgentModelCatalogStore.getState>,
    "claudeModels" | "codexModels" | "cursorModels" | "grokModels" | "piModels"
  > = useAgentModelCatalogStore.getState(),
): ReviewModelCatalog {
  const liveClaudeModels = models.claudeModels.map(claudeReviewModelOption);
  const claude = liveClaudeModels.length > 0 ? liveClaudeModels : CLAUDE_FALLBACK_MODELS;

  const codexModels = models.codexModels;
  const codex = (codexModels.length > 0 ? codexModels : CODEX_MODELS).map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    reasoningEfforts: [...(model.reasoningEfforts ?? ["medium", "high"])],
    supportsSpeed: true as const,
  }));

  const cachedAcpCatalog = models;
  const toLaunchOptions = (models: typeof cachedAcpCatalog.cursorModels) =>
    models.map((model) => ({
      id: model.id,
      name: model.label,
      ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
      description: model.description,
      reasoningEfforts: Array.from(
        new Set(model.reasoning?.map((option) => option.id).filter((id) => id !== "default") ?? []),
      ),
      ...(model.supportsSpeed ? { supportsSpeed: true as const } : {}),
      ...(model.sessionDefault ? { sessionDefault: true as const } : {}),
      ...(model.connected === false ? { connected: false as const } : {}),
    }));
  const cursor = toLaunchOptions(cachedAcpCatalog.cursorModels);
  const grok = toLaunchOptions(cachedAcpCatalog.grokModels);
  const pi = toLaunchOptions(cachedAcpCatalog.piModels);

  return {
    claude: claude.length > 0 ? claude : CLAUDE_FALLBACK_MODELS,
    codex,
    cursor:
      cursor.length > 0
        ? cursor
        : [{ id: "default", name: "Cursor automatic", reasoningEfforts: [] }],
    grok:
      grok.length > 0
        ? grok
        : [{ id: "default", name: "Grok Build default", reasoningEfforts: [] }],
    // A Pi catalogue that marks no connected row as where a session starts
    // leaves a defaulted launch to Pi's own session default (the shared launch
    // resolver's rule), so that choice is offered as a row of its own.
    pi: pi.some((model) => model.sessionDefault && model.connected !== false)
      ? pi
      : [PI_DEFAULT_MODEL, ...pi],
    opencode: [{ id: "default", name: "Default", reasoningEfforts: [] }],
  };
}

export function resolveDefaultReviewTabType(options: {
  defaultAgent: DefaultAgent;
  environment: Pick<Environment, "agentSettings"> | undefined;
  global: GlobalConfig;
  repositoryConfig?: RepositoryConfig;
}): ReviewTabType {
  // The review launcher exposes per-run native model and reasoning controls.
  // Environment mode preferences still govern ordinary tabs.
  return options.defaultAgent;
}
