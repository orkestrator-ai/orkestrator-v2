import type { AgentPlatform } from "./agent-platforms.js";
import {
  SUPERSEDED_CLAUDE_MODEL_IDS,
  CLAUDE_FALLBACK_MODEL_CATALOG,
} from "./claude-model-catalog.js";

/**
 * Normalize a backend-reported model identifier for user-facing attribution.
 *
 * Claude Code uses angle-bracketed values such as `<synthetic>` for generated
 * assistant records. Those values describe the record, not a model, so they
 * must never be rendered as the assistant's name.
 */
export function normalizeBackendModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const modelId = value.trim();
  if (!modelId || /^<[^>]*>$/.test(modelId)) return undefined;
  return modelId;
}

/** Root assistant records are the only ones that may attribute the main turn. */
export function isRootAssistantRecord(parentToolUseId: unknown, isSidechain?: unknown): boolean {
  const hasNoParent =
    parentToolUseId == null ||
    (typeof parentToolUseId === "string" && parentToolUseId.trim().length === 0);
  const isMainChain = isSidechain === undefined || isSidechain === false;
  return hasNoParent && isMainChain;
}

/** Match saved ids in catalogue, alias or resolved space, following retired Claude ids. */
export function resolveCatalogModelId(
  agent: AgentPlatform,
  models: readonly { id: string; resolvedModel?: string; aliases?: readonly string[] }[],
  modelId: string | undefined,
): string | undefined {
  const match = (id: string): string | undefined =>
    models.find((model) => model.id === id)?.id ??
    models.find((model) => model.resolvedModel === id || model.aliases?.includes(id))?.id ??
    (agent === "claude"
      ? models.find((model) =>
          CLAUDE_FALLBACK_MODEL_CATALOG.some(
            (fallback) =>
              !model.resolvedModel && fallback.id === model.id && fallback.resolvedModel === id,
          ),
        )?.id
      : undefined);
  if (!modelId) return undefined;
  const seen = new Set<string>();
  for (
    let next: string | undefined = modelId;
    next && !seen.has(next);
    next = agent === "claude" ? SUPERSEDED_CLAUDE_MODEL_IDS[next] : undefined
  ) {
    const found = match(next);
    if (found) return found;
    seen.add(next);
  }
  return undefined;
}

/**
 * The model a launch falls back to when no saved choice matches: the one the
 * catalogue marks as where a new session starts, else its first entry.
 *
 * Every "use the defaults" launch must land where a tab with no model would,
 * or a review row and a worker launched from the same settings disagree.
 */
export function sessionDefaultModel<T extends { sessionDefault?: boolean }>(
  models: readonly T[],
): T | undefined {
  return models.find((model) => model.sessionDefault === true) ?? models[0];
}
