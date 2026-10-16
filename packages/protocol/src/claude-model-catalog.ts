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
  // Claude Code 2.1.293 made Haiku 5.5 the default Haiku. Unlike 4.5 it takes
  // effort levels (default medium) and runs adaptive thinking only.
  {
    id: "haiku",
    resolvedModel: "claude-haiku-5-5",
    name: "Haiku",
    description: "Haiku 5.5 · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

/**
 * Ultracode is offered as a reasoning level, after the effort levels. The
 * Claude bridge turns it into the CLI's `ultracode` flag plus `high` effort.
 */
export const CLAUDE_ULTRACODE_REASONING_ID = "ultracode";

/** Convert the composer selection to Claude CLI effort and flag settings. */
export function claudeCliReasoningSelection(reasoningId: string | undefined): {
  effort: string | undefined;
  ultracode: boolean;
} {
  const ultracode = reasoningId === CLAUDE_ULTRACODE_REASONING_ID;
  return { effort: ultracode ? "high" : reasoningId, ultracode };
}

/** Preserve sessions saved when Ultracode was a separate toggle. */
export function claudeReasoningSelection(
  reasoningId: string | undefined,
  parameterValues: Record<string, string | boolean> | undefined,
): string | undefined {
  return parameterValues?.ultracode === true ? CLAUDE_ULTRACODE_REASONING_ID : reasoningId;
}

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
 * The reasoning level ids a native Claude model offers: its effort levels, plus
 * Ultracode where the model can run it.
 *
 * The single definition for every backend catalogue projection. Terminal
 * launches and the raw catalogue keep the plain effort levels, since the CLI's
 * `--effort` flag has no Ultracode value.
 */
export function claudeModelReasoningIds(
  model: ClaudeParameterModel,
  efforts: readonly string[] = model.supportedEffortLevels ?? [],
): string[] {
  return claudeModelSupportsUltracode(model)
    ? [...efforts, CLAUDE_ULTRACODE_REASONING_ID]
    : [...efforts];
}

/**
 * Provider-neutral parameter descriptors for one Claude model.
 *
 * The single definition for every backend catalogue projection, so a control
 * cannot exist on one read of the catalogue and be missing from another.
 * `thinking` and `context1m` are settings-backed defaults the input bar
 * suppresses (`SUPPRESSED_COMPOSER_PARAMETERS`).
 *
 * Every model gets the same thinking options, although some (Haiku 5.5 since
 * Claude Code 2.1.293) run adaptive thinking only. The SDK's `ModelInfo` says
 * whether a model *supports* adaptive thinking, not whether it is the only
 * mode, so there is no provider signal to narrow the list on (verified against
 * Agent SDK 0.3.296); a name-based guess would go stale with the next model.
 * If `ModelInfo` gains one, drop `disabled` and the budgets for those models.
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
  ];
}

/**
 * Claude model ids a newer Claude Code replaced, mapped to their successor.
 *
 * Configuration stores models in the resolved space, so a default saved while
 * 2.1.276 was current names `claude-fable-5[1m]` or `claude-opus-5[1m]`, and
 * 2.1.280's catalogue offers neither. 2.1.284 did the same to Sonnet: its
 * `sonnet` alias resolves to `claude-sonnet-5-5`, not `claude-sonnet-5`. 2.1.287
 * renamed the Fable 5.1 row from `claude-fable-5-1` to the `fable` alias (its
 * `resolvedModel` is unchanged), so a saved `[1m]` row id needs a successor.
 * 2.1.293 moved the `haiku` alias from Haiku 4.5 to `claude-haiku-5-5`.
 * Successors are followed in a chain. Without this a saved choice silently
 * became the first catalogue entry. Consulted only after an exact match fails,
 * so an environment still on an older CLI keeps the id it reports.
 */
export const SUPERSEDED_CLAUDE_MODEL_IDS: Readonly<Record<string, string>> = {
  "claude-fable-5": "claude-fable-5-1",
  "claude-fable-5[1m]": "claude-fable-5-1[1m]",
  "claude-fable-5-1[1m]": "fable[1m]",
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-5[1m]": "claude-opus-5-5[1m]",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-haiku-4-5": "claude-haiku-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-5-5",
};
