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
import type { ClaudeModel } from "@/lib/claude-types";
import { CLAUDE_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/claude-model-catalog";

export const FALLBACK_CLAUDE_MODELS: Array<ClaudeModel & { resolvedModel?: string }> =
  CLAUDE_FALLBACK_MODEL_CATALOG.map((model) => ({
    ...model,
    ...(model.supportedEffortLevels
      ? { supportedEffortLevels: [...model.supportedEffortLevels] }
      : {}),
  }));

export { SUPERSEDED_CLAUDE_MODEL_IDS } from "@orkestrator/protocol/claude-model-catalog";
