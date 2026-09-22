/**
 * The Claude catalogue offered before any bridge server has reported one.
 *
 * Claude is the only platform with a shipped list: its model ids are stable and
 * documented, whereas Codex, Cursor, Grok and OpenCode all resolve theirs from
 * a live provider. Without this, opening settings before starting an
 * environment would offer no Claude model at all, which used to be handled
 * inside the repository dialog and is now shared by all three tiers.
 *
 * This is the renderer's single copy: the tmux composer and the review launch
 * dialog derive theirs from it. It mirrors what Claude Code 2.1.280's
 * `supportedModels()` reports, and the bridge-side fallback in
 * bridges/claude-bridge/src/services/session-manager-interactions.ts, which the
 * renderer cannot import.
 */
import type { ClaudeModel } from "@/lib/claude-client";

export const FALLBACK_CLAUDE_MODELS: Array<ClaudeModel & { resolvedModel?: string }> = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-opus-5-5[1m]",
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-opus-5-5[1m]",
  },
  {
    id: "claude-fable-5-1[1m]",
    name: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-fable-5-1",
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-sonnet-5",
  },
  {
    id: "haiku",
    name: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    resolvedModel: "claude-haiku-4-5-20251001",
  },
];

/**
 * Claude model ids a newer Claude Code replaced, mapped to their successor.
 *
 * Configuration stores models in the resolved space, so a default saved while
 * 2.1.276 was current names `claude-fable-5[1m]` or `claude-opus-5[1m]`, and
 * 2.1.280's catalogue offers neither. Without this a saved choice silently
 * became the first catalogue entry. Consulted only after an exact match fails,
 * so an environment still on an older CLI keeps the id it reports.
 */
export const SUPERSEDED_CLAUDE_MODEL_IDS: Readonly<Record<string, string>> = {
  "claude-fable-5": "claude-fable-5-1",
  "claude-fable-5[1m]": "claude-fable-5-1[1m]",
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-5[1m]": "claude-opus-5-5[1m]",
};
