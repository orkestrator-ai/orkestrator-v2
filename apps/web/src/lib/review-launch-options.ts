import type { ReviewModelCatalog, ReviewModelOption, ReviewTabType } from "@/components/review/ReviewLaunchDialog";
import { CODEX_MODELS } from "@/lib/codex-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import type { DefaultAgent, Environment, GlobalConfig, RepositoryConfig } from "@/types";

/**
 * `resolvedModel` mirrors the bridge's own catalog. Configuration stores a
 * Claude model in that resolved space (`claude-sonnet-5`) while these entries
 * are keyed by alias, so without it no configured Claude default can ever be
 * matched back to the option that represents it.
 */
const CLAUDE_FALLBACK_MODELS: ReviewModelOption[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-opus-5[1m]",
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-opus-5[1m]",
  },
  {
    id: "claude-fable-5[1m]",
    name: "Fable 5",
    description: "Most capable for difficult, long-running tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-fable-5",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-sonnet-5",
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fastest for quick tasks",
    reasoningEfforts: [],
    resolvedModel: "claude-haiku-4-5-20251001",
  },
];

const OPENCODE_DEFAULT_MODEL: ReviewModelOption = {
  id: "default",
  name: "Default",
  description: "Use OpenCode's last selected model",
  reasoningEfforts: [],
};

export function includeOpenCodeDefaultModel(
  models: ReviewModelOption[],
): ReviewModelOption[] {
  return [
    OPENCODE_DEFAULT_MODEL,
    ...models.filter((model) => model.id !== OPENCODE_DEFAULT_MODEL.id),
  ];
}

export function buildReviewModelCatalog(
  environmentId: string | null | undefined,
): ReviewModelCatalog {
  const liveClaudeModels = useClaudeStore.getState().models.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    reasoningEfforts:
      model.supportedEffortLevels?.length
        ? [...model.supportedEffortLevels]
        : model.supportsEffort
          ? ["low", "medium", "high"]
          : [],
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
  }));
  const claude = liveClaudeModels.length > 0
    ? liveClaudeModels
    : CLAUDE_FALLBACK_MODELS;

  const codexModels = useCodexStore.getState().models;
  const codex = (codexModels.length > 0 ? codexModels : CODEX_MODELS).map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      reasoningEfforts: [...(model.reasoningEfforts ?? ["medium", "high"])],
    }));

  const openCodeState = useOpenCodeStore.getState();
  const liveOpenCodeModels = environmentId === null
    ? []
    : environmentId
      ? openCodeState.getModels(environmentId)
      : Array.from(openCodeState.models.values())
        .flat()
        .filter(
          (model, index, models) =>
            models.findIndex((candidate) => candidate.id === model.id) === index,
        );
  const opencode = liveOpenCodeModels.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.provider,
    reasoningEfforts: [...(model.variants ?? [])],
  }));

  const cachedAcpCatalog = useAgentModelCatalogStore.getState();
  const toLaunchOptions = (models: typeof cachedAcpCatalog.cursorModels) =>
    models.map((model) => ({
      id: model.id,
      name: model.label,
      description: model.description,
      reasoningEfforts: Array.from(new Set(
        model.reasoning
          ?.map((option) => option.id)
          .filter((id) => id !== "default") ?? [],
      )),
    }));
  const cursor = toLaunchOptions(cachedAcpCatalog.cursorModels);
  const grok = toLaunchOptions(cachedAcpCatalog.grokModels);

  return {
    claude: claude.length > 0 ? claude : CLAUDE_FALLBACK_MODELS,
    codex,
    cursor: cursor.length > 0
      ? cursor
      : [{ id: "default", name: "Cursor automatic", reasoningEfforts: [] }],
    grok: grok.length > 0
      ? grok
      : [{ id: "default", name: "Grok Build default", reasoningEfforts: [] }],
    opencode: opencode.length > 0
      ? opencode
      : [{ id: "default", name: "Default", reasoningEfforts: [] }],
  };
}

export function resolveDefaultReviewTabType(options: {
  defaultAgent: DefaultAgent;
  environment: Pick<
    Environment,
    "claudeMode" | "claudeNativeBackend" | "opencodeMode" | "codexMode"
  > | undefined;
  global: GlobalConfig;
  repositoryConfig?: RepositoryConfig;
}): ReviewTabType {
  // The review launcher exposes per-run native model and reasoning controls.
  // Environment mode preferences still govern ordinary tabs.
  return options.defaultAgent;
}
