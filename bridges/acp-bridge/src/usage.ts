import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";

/**
 * Token accounting for one completed ACP turn.
 *
 * Three carriers exist in the wild:
 *
 * - Grok's vendor `_meta` / `turn_completed` / `response_completed`, which
 *   spell the same breakdown differently in each.
 * - ACP `PromptResponse.usage` (`totalTokens`, `inputTokens`, `thoughtTokens`,
 *   cache splits).
 * - ACP `usage_update` (`used` occupancy, `size` window, optional USD `cost`).
 *
 * Cursor's current CLI adapter (`cursor-agent` 2026.08.11) still returns
 * `{ stopReason: "end_turn" }` with none of these, even though its TUI has the
 * numbers. An unparseable payload therefore yields `null` instead of a zeroed
 * snapshot: a usage meter reading "0 / 0" is a false statement, not a
 * neutral one. When Cursor (or any ACP agent) starts emitting the standard
 * carriers, this parser is what surfaces them.
 */
export interface AcpTurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  apiDurationMs?: number;
  /** ACP `usage_update.used` — tokens currently occupying the context window. */
  contextUsedTokens?: number;
  /** ACP `usage_update.size` — the live context window in tokens. */
  contextWindow?: number;
  /** ACP `usage_update.cost.amount` when `currency` is USD. */
  costUsd?: number;
}

const TOKEN_FIELD_ALIASES = {
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
    "cachedWriteTokens",
    "cacheCreationTokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "cache_creation_tokens",
  ],
  reasoningTokens: ["reasoningTokens", "reasoning_tokens", "thoughtTokens", "thought_tokens"],
  apiDurationMs: ["apiDurationMs", "api_duration_ms"],
  contextUsedTokens: ["contextUsedTokens", "context_used_tokens", "usedTokens", "used_tokens"],
  contextWindow: ["contextWindow", "context_window"],
} as const satisfies Record<Exclude<keyof AcpTurnUsage, "costUsd">, readonly string[]>;

/** One trillion tokens; anything larger is a vendor bug, not a session. */
const MAX_TOKENS = 1e12;
/** One billion dollars; anything larger is not a session cost we will display. */
const MAX_USD = 1e9;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS
    ? Math.round(value)
    : undefined;
}

function money(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_USD
    ? value
    : undefined;
}

function parseUsdCost(value: Record<string, unknown>): number | undefined {
  const direct = money(value.costUsd) ?? money(value.cost_usd);
  if (direct !== undefined) return direct;
  const cost = isObject(value.cost) ? value.cost : undefined;
  if (!cost) return undefined;
  const currency = typeof cost.currency === "string" ? cost.currency.trim().toUpperCase() : "";
  // Grok's `costUsdTicks` has no documented scale, so a missing currency is
  // not treated as USD. Only an explicit dollar amount is safe to show.
  if (currency !== "USD") return undefined;
  return money(cost.amount);
}

function parseAcpTurnUsageObject(value: Record<string, unknown>): AcpTurnUsage | null {
  const nested = isObject(value.usage) ? value.usage : undefined;
  const usage: AcpTurnUsage = {};
  for (const [field, aliases] of Object.entries(TOKEN_FIELD_ALIASES)) {
    for (const alias of aliases) {
      const parsed = count(nested?.[alias]) ?? count(value[alias]);
      if (parsed !== undefined) {
        usage[field as keyof typeof TOKEN_FIELD_ALIASES] = parsed;
        break;
      }
    }
  }
  const costUsd = parseUsdCost(nested ?? {}) ?? parseUsdCost(value);
  if (costUsd !== undefined) usage.costUsd = costUsd;

  // ACP `usage_update` uses `used`/`size`, which are too generic to accept on
  // every payload. The discriminator is required; persist restore already
  // stores the mapped `contextUsedTokens` / `contextWindow` names. `type` is
  // the same fallback `applySessionUpdate` already uses for every kind.
  const kind =
    typeof value.sessionUpdate === "string"
      ? value.sessionUpdate
      : typeof value.type === "string"
        ? value.type
        : "";
  if (kind === "usage_update") {
    const occupancy = count(value.used);
    const window = count(value.size);
    if (occupancy !== undefined && usage.contextUsedTokens === undefined) {
      usage.contextUsedTokens = occupancy;
    }
    if (window !== undefined && usage.contextWindow === undefined) {
      usage.contextWindow = window;
    }
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Read usage out of a vendor payload, whether it nests the numbers under
 * `usage` (`turn_completed`, `PromptResponse.usage`) or flattens them
 * alongside it (the prompt result `_meta`, which carries both). Nested values
 * win; `_meta` fills gaps so a Grok result still parses when the whole
 * `PromptResponse` is passed rather than `_meta` alone.
 */
export function parseAcpTurnUsage(value: unknown): AcpTurnUsage | null {
  if (!isObject(value)) return null;
  const fromMeta = isObject(value._meta) ? parseAcpTurnUsageObject(value._meta) : null;
  const fromValue = parseAcpTurnUsageObject(value);
  const merged = { ...(fromMeta ?? {}), ...(fromValue ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Project one turn's usage onto the provider-neutral snapshot the agent info
 * panel renders.
 *
 * Occupancy prefers ACP `usage_update.used` when present. Otherwise the turn's
 * token total is the closest thing Grok offers: an agent's input already
 * contains the whole conversation. Cost is taken only from an explicit USD
 * `usage_update.cost`; Grok's `costUsdTicks` is still ignored because the tick
 * is undocumented.
 */
export function acpContextUsage(
  usage: AcpTurnUsage,
  details: { modelId?: string; durationMs?: number; updatedAt: string },
): NativeAgentContextUsage | null {
  const usedTokens =
    usage.contextUsedTokens ??
    usage.totalTokens ??
    (usage.inputTokens === undefined && usage.outputTokens === undefined
      ? undefined
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  if (usedTokens === undefined) return null;
  const durationMs = count(details.durationMs);
  const contextWindow =
    usage.contextWindow !== undefined && usage.contextWindow > 0 ? usage.contextWindow : undefined;
  const percentage =
    contextWindow === undefined
      ? undefined
      : Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100));
  return {
    usedTokens,
    ...(contextWindow === undefined ? {} : { maximumTokens: contextWindow }),
    ...(percentage === undefined ? {} : { percentage }),
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.apiDurationMs === undefined ? {} : { apiDurationMs: usage.apiDurationMs }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(details.modelId ? { modelId: details.modelId } : {}),
    source: "provider",
    updatedAt: details.updatedAt,
  };
}
