import type { AgentModelParameter } from "./native-agent.js";

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
    resolvedModel: "claude-sonnet-5-5",
    name: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
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

/** The Claude bridge reads `parameterValues[CLAUDE_ULTRACODE_PARAMETER_ID]`. */
export const CLAUDE_ULTRACODE_PARAMETER_ID = "ultracode";

/** The fields of a Claude catalogue entry its parameters depend on. */
export interface ClaudeParameterModel {
  id: string;
  resolvedModel?: string;
  supportedEffortLevels?: readonly string[];
}

/**
 * Whether Claude Code can run Ultracode on this model.
 *
 * The SDK's `ModelInfo` has no Ultracode flag, and Claude Code gates it on the
 * models that support `xhigh` effort, so the catalogue's effort list is the
 * static signal. It cannot see the other half of the gate — whether dynamic
 * workflows are enabled for the account — which the bridge checks at runtime.
 */
export function claudeModelSupportsUltracode(model: ClaudeParameterModel): boolean {
  return model.supportedEffortLevels?.includes("xhigh") === true;
}

/**
 * Provider-neutral parameter descriptors for one Claude model.
 *
 * The single definition for every backend catalogue projection, so a control
 * cannot exist on one read of the catalogue and be missing from another.
 * `thinking` and `context1m` are settings-backed defaults the input bar
 * suppresses (`SUPPRESSED_COMPOSER_PARAMETERS`); Ultracode is a per-session
 * toggle the input bar renders like any other model parameter.
 */
export function claudeModelParameters(model: ClaudeParameterModel): AgentModelParameter[] {
  return [
    {
      id: "thinking",
      label: "Thinking",
      kind: "select",
      options: [
        { id: "adaptive", label: "Adaptive" },
        { id: "budget-8192", label: "8K budget" },
        { id: "budget-16384", label: "16K budget" },
        { id: "disabled", label: "Disabled" },
      ],
      defaultValue: "adaptive",
      scope: "session",
    },
    ...(/opus|sonnet/i.test(`${model.id} ${model.resolvedModel ?? ""}`)
      ? [
          {
            id: "context1m",
            label: "1M context beta",
            kind: "toggle" as const,
            defaultValue: false,
            scope: "session" as const,
          },
        ]
      : []),
    ...(claudeModelSupportsUltracode(model)
      ? [
          {
            id: CLAUDE_ULTRACODE_PARAMETER_ID,
            label: "Ultracode",
            kind: "toggle" as const,
            defaultValue: false,
            scope: "session" as const,
          },
        ]
      : []),
  ];
}
