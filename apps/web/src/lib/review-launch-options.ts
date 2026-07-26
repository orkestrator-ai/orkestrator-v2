import type { ReviewModelCatalog, ReviewModelOption, ReviewTabType } from "@/components/review/ReviewLaunchDialog";
import { CODEX_MODELS } from "@/lib/codex-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { DefaultAgent, Environment, GlobalConfig, RepositoryConfig } from "@/types";

const CLAUDE_FALLBACK_MODELS: ReviewModelOption[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
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
    description: "Sonnet 5 · Efficient for routine tasks",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Fastest for quick tasks",
    reasoningEfforts: [],
  },
];

export function buildReviewModelCatalog(
  environmentId: string | undefined,
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

  const liveOpenCodeModels = environmentId
    ? useOpenCodeStore.getState().getModels(environmentId)
    : [];
  const opencode = liveOpenCodeModels.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.provider,
      reasoningEfforts: [...(model.variants ?? [])],
    }));

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
  // Reviews are always native because only native providers can enforce and
  // return the shared structured-review schema. Environment mode preferences
  // still govern ordinary tabs.
  if (options.defaultAgent === "claude") return "claude-native";
  if (options.defaultAgent === "opencode") return "opencode-native";
  return "codex-native";
}
