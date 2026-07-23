import type { ReviewModelCatalog, ReviewModelOption, ReviewTabType } from "@/components/review/ReviewLaunchDialog";
import { CODEX_MODELS } from "@/lib/codex-client";
import { resolveClaudeConfig } from "@/lib/claude-mode-resolver";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { DefaultAgent, Environment, GlobalConfig, RepositoryConfig } from "@/types";

const CLAUDE_FALLBACK_MODELS: ReviewModelOption[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Use Claude's recommended model",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5[1m]",
    name: "Fable 5",
    description: "Most capable for difficult, long-running tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Efficient for routine tasks",
    reasoningEfforts: ["low", "medium", "high", "max"],
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fastest for quick tasks",
    reasoningEfforts: [],
  },
];

function withPreferredModel(
  models: ReviewModelOption[],
  preferredId: string | undefined,
): ReviewModelOption[] {
  if (!preferredId || models.some((model) => model.id === preferredId)) return models;
  return [
    {
      id: preferredId,
      name: preferredId,
      description: "Current default",
      reasoningEfforts: [],
    },
    ...models,
  ];
}

export function buildReviewModelCatalog(
  environmentId: string | undefined,
  global: Pick<GlobalConfig, "claudeModel" | "codexModel" | "opencodeModel">,
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
  }));
  const claude = withPreferredModel(
    liveClaudeModels.length > 0 ? liveClaudeModels : CLAUDE_FALLBACK_MODELS,
    global.claudeModel,
  );

  const codexModels = useCodexStore.getState().models;
  const codex = withPreferredModel(
    (codexModels.length > 0 ? codexModels : CODEX_MODELS).map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      reasoningEfforts: [...(model.reasoningEfforts ?? ["medium", "high"])],
    })),
    global.codexModel,
  );

  const liveOpenCodeModels = environmentId
    ? useOpenCodeStore.getState().getModels(environmentId)
    : [];
  const opencode = withPreferredModel(
    liveOpenCodeModels.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.provider,
      reasoningEfforts: [...(model.variants ?? [])],
    })),
    global.opencodeModel,
  );

  return {
    claude: claude.length > 0 ? claude : CLAUDE_FALLBACK_MODELS,
    codex,
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
  const { defaultAgent, environment, global, repositoryConfig } = options;

  if (defaultAgent === "claude") {
    const resolved = resolveClaudeConfig(global, repositoryConfig, environment);
    if (resolved.mode !== "native") return "claude-cli";
    return resolved.nativeBackend === "tmux" ? "claude-tmux" : "claude-native";
  }

  if (defaultAgent === "opencode") {
    return (environment?.opencodeMode ?? global.opencodeMode) === "native"
      ? "opencode-native"
      : "opencode-cli";
  }

  return (environment?.codexMode ?? global.codexMode) === "native"
    ? "codex-native"
    : "codex-cli";
}
