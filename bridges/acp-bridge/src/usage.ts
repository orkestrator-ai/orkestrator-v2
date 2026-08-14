import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";

/**
 * Token accounting for one completed ACP turn.
 *
 * ACP itself defines none, so this is entirely vendor `_meta`. Grok reports a
 * full breakdown three times over — the `session/prompt` result `_meta`, a
 * `turn_completed` session notification, and a `response_completed` one — and
 * spells the same fields differently in each, so every accepted spelling is
 * listed rather than assuming one carrier. Cursor reports nothing at all, which
 * is why an unparseable payload yields `null` instead of a zeroed snapshot: a
 * usage meter reading "0 / 0" is a false statement, not a neutral one.
 */
export interface AcpTurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  apiDurationMs?: number;
}

const FIELD_ALIASES = {
  totalTokens: ["totalTokens", "total_tokens"],
  inputTokens: ["inputTokens", "input_tokens"],
  outputTokens: ["outputTokens", "output_tokens"],
  cacheReadTokens: [
    "cachedReadTokens",
    "cacheReadTokens",
    "cache_read_input_tokens",
    "cached_read_tokens",
  ],
  cacheWriteTokens: [
    "cacheCreationTokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "cache_creation_tokens",
  ],
  reasoningTokens: ["reasoningTokens", "reasoning_tokens"],
  apiDurationMs: ["apiDurationMs", "api_duration_ms"],
} as const satisfies Record<keyof AcpTurnUsage, readonly string[]>;

/** One trillion tokens; anything larger is a vendor bug, not a session. */
const MAX_TOKENS = 1e12;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_TOKENS
    ? Math.round(value)
    : undefined;
}

/**
 * Read usage out of a vendor payload, whether it nests the numbers under
 * `usage` (`turn_completed`) or flattens them alongside it (the prompt result
 * `_meta`, which carries both). Nested values win; flattened ones fill gaps.
 */
export function parseAcpTurnUsage(value: unknown): AcpTurnUsage | null {
  if (!isObject(value)) return null;
  const nested = isObject(value.usage) ? value.usage : undefined;
  const usage: AcpTurnUsage = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const parsed = count(nested?.[alias]) ?? count(value[alias]);
      if (parsed !== undefined) {
        usage[field as keyof AcpTurnUsage] = parsed;
        break;
      }
    }
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Project one turn's usage onto the provider-neutral snapshot the agent info
 * panel renders.
 *
 * `usedTokens` is the turn's total because an agent's input already contains
 * the whole conversation, which makes it the closest thing ACP offers to
 * context occupancy. Cost is deliberately absent: Grok reports `costUsdTicks`
 * without documenting the tick, and a dollar figure derived from a guessed
 * scale would be indistinguishable from a correct one.
 */
export function acpContextUsage(
  usage: AcpTurnUsage,
  details: { modelId?: string; durationMs?: number; updatedAt: string },
): NativeAgentContextUsage | null {
  const usedTokens = usage.totalTokens
    ?? (usage.inputTokens === undefined && usage.outputTokens === undefined
      ? undefined
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  if (usedTokens === undefined) return null;
  const durationMs = count(details.durationMs);
  return {
    usedTokens,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.apiDurationMs === undefined ? {} : { apiDurationMs: usage.apiDurationMs }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(details.modelId ? { modelId: details.modelId } : {}),
    source: "provider",
    updatedAt: details.updatedAt,
  };
}
