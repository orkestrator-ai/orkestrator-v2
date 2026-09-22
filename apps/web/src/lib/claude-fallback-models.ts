/**
 * The Claude catalogue offered before any bridge server has reported one.
 *
 * Claude is the only platform with a shipped list: its model ids are stable and
 * documented, whereas Codex, Cursor, Grok and OpenCode all resolve theirs from
 * a live provider. Without this, opening settings before starting an
 * environment would offer no Claude model at all, which used to be handled
 * inside the repository dialog and is now shared by all three tiers.
 *
 * The tmux composer and launch surfaces derive from this renderer projection.
 * Its canonical data lives in @orkestrator/protocol so the Claude bridge's
 * fallback cannot drift from it.
 */
import type { ClaudeModel } from "@/lib/claude-client";
import { CLAUDE_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/claude-model-catalog";

export const FALLBACK_CLAUDE_MODELS: Array<ClaudeModel & { resolvedModel?: string }> =
  CLAUDE_FALLBACK_MODEL_CATALOG.map((model) => ({
    ...model,
    ...(model.supportedEffortLevels
      ? { supportedEffortLevels: [...model.supportedEffortLevels] }
      : {}),
  }));

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
