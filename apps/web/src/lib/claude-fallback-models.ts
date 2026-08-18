/**
 * The Claude catalogue offered before any bridge server has reported one.
 *
 * Claude is the only platform with a shipped list: its model ids are stable and
 * documented, whereas Codex, Cursor, Grok and OpenCode all resolve theirs from
 * a live provider. Without this, opening settings before starting an
 * environment would offer no Claude model at all, which used to be handled
 * inside the repository dialog and is now shared by all three tiers.
 */
import type { ClaudeModel } from "@/lib/claude-client";

export const FALLBACK_CLAUDE_MODELS: ClaudeModel[] = [
  {
    id: "default",
    name: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "opus[1m]",
    name: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-fable-5[1m]",
    name: "Fable",
    description: "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "haiku", name: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];
