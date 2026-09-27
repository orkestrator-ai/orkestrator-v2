/**
 * Claude Code's shipped model catalogue used when a live SDK catalogue is not
 * available. Keep this provider-neutral so both the bridge and renderer can
 * project it into their local model types without maintaining two copies.
 */
export type ClaudeFallbackEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeFallbackModel {
  id: string;
  resolvedModel: string;
  name: string;
  description: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeFallbackEffortLevel[];
}

export const CLAUDE_FALLBACK_MODEL_CATALOG: readonly ClaudeFallbackModel[] = [
  {
    id: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    name: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    name: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    name: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    resolvedModel: "claude-sonnet-5",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    name: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];
