import type {
  NativeAgentContextUsage,
  NativeAgentCostSource,
} from "@orkestrator/protocol/native-agent";

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
  /**
   * ACP `usage_update.cost.amount` when `currency` is USD: the session's
   * cumulative cost, so a snapshot rather than one turn's spend.
   */
  costUsd?: number;
  /**
   * Grok's `PromptUsage.costUsdTicks`: what this turn (summed over its
   * attempts) cost, in exact integer ticks of 10^-10 USD. Read only through
   * `qualifiedCostUsdTicks`, which honours `costUsdTicksUnknown`.
   */
  costUsdTicks?: number;
  /**
   * Set when this turn's tick cost cannot be trusted: Grok flagged it
   * `costIsPartial` or `usageIsIncomplete`, the value was malformed, or one
   * attempt reported ticks and another did not. Latches for the turn.
   */
  costUsdTicksUnknown?: true;
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
} as const satisfies Record<
  Exclude<keyof AcpTurnUsage, "costUsd" | "costUsdTicks" | "costUsdTicksUnknown">,
  readonly string[]
>;

/** One trillion tokens; anything larger is a vendor bug, not a session. */
const MAX_TOKENS = 1e12;
/** One billion dollars; anything larger is not a session cost we will display. */
const MAX_USD = 1e9;

/**
 * Grok's tick: 1 USD = 10^10 ticks. Grok 1.0.77 documents it for headless
 * `total_cost_usd_ticks` ("1 USD = 10^10 ticks") and for `grok usage`
 * (`costUsdTicks` "is 10^10 ticks per USD (divide by `1e10` for dollars)").
 * The ACP carriers use the same `costUsdTicks` name in the same usage struct
 * family (see `parseCostUsdTicks`).
 */
export const GROK_TICKS_PER_USD = 1e10;

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

/**
 * What an ACP dollar amount is: the agent's own figure, never one this bridge
 * computed. The only amounts `parseUsdCost` accepts are ones the agent states
 * in dollars (ACP `usage_update.cost` with `currency: "USD"`, which ACP 2.7.0
 * (as since 2.4.0) defines as the session's "Total cumulative cost", or an explicit
 * `costUsd`/`cost_usd`), so the bridge passes them on as the provider's
 * amount. ACP does not say how an agent arrived at its figure; an agent that
 * reports a computed estimate in this field is indistinguishable here. Other
 * units (`"credits"`, a missing currency) are not dollars and are not shown.
 * Grok's `costUsdTicks` is also the agent's own figure, stated in exact
 * integer ticks rather than dollars; `ticksToUsd` only rescales it, so it
 * keeps this source (docs/todo/agent-engines/0007, task 11).
 */
export const ACP_COST_SOURCE: NativeAgentCostSource = "provider";

function parseUsdCost(value: Record<string, unknown>): number | undefined {
  const direct = money(value.costUsd) ?? money(value.cost_usd);
  if (direct !== undefined) return direct;
  const cost = isObject(value.cost) ? value.cost : undefined;
  if (!cost) return undefined;
  const currency = typeof cost.currency === "string" ? cost.currency.trim().toUpperCase() : "";
  // A missing currency is not treated as USD. Only an explicit dollar amount
  // is safe to show here; Grok's ticks are read by `parseCostUsdTicks`.
  if (currency !== "USD") return undefined;
  return money(cost.amount);
}

/** Keep off until the two-turn billing reconciliation in task 11 passes. */
export const GROK_TICK_COSTS_QUALIFIED = false;

function tickCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCostUsdTicks(
  usage: AcpTurnUsage,
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
): void {
  // Grok omits cost floats whenever either flag is set (`total_cost_usd`
  // "appears only when the server reported a complete cost"); the ticks
  // beside such a flag are a lower bound, not a bill.
  const flagged = sources.some(
    (source) =>
      source?.costIsPartial === true ||
      source?.usageIsIncomplete === true ||
      source?.costUsdTicksUnknown === true,
  );
  if (flagged) {
    usage.costUsdTicksUnknown = true;
    return;
  }
  const raw = sources.find((source) => source?.costUsdTicks !== undefined)?.costUsdTicks;
  if (raw === undefined) return;
  const ticks = tickCount(raw);
  if (ticks === undefined) usage.costUsdTicksUnknown = true;
  else usage.costUsdTicks = ticks;
}

function payloadKind(value: Record<string, unknown>): string {
  // `type` is the same fallback `applySessionUpdate` already uses for every kind.
  return typeof value.sessionUpdate === "string"
    ? value.sessionUpdate
    : typeof value.type === "string"
      ? value.type
      : "";
}

function parseAcpTurnUsageObject(
  value: Record<string, unknown>,
  kind: string,
  carriesTicks: boolean,
): AcpTurnUsage | null {
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
  if (carriesTicks) parseCostUsdTicks(usage, [nested, value]);

  // ACP `usage_update` uses `used`/`size`, which are too generic to accept on
  // every payload. The discriminator is required; persist restore already
  // stores the mapped `contextUsedTokens` / `contextWindow` names.
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
 * `PromptResponse` is passed rather than `_meta` alone. The payload's own kind
 * governs its `_meta` too, so a `usage_update`'s `_meta` cannot smuggle in
 * ticks.
 */
export function parseAcpTurnUsage(
  value: unknown,
  source?: { provider: string; carrier: "notification" | "prompt-result" },
): AcpTurnUsage | null {
  if (!isObject(value)) return null;
  const kind = payloadKind(value);
  // Grok 1.0.77 puts PromptUsage on turn_completed and the prompt response.
  const carriesTicks =
    source?.provider === "grok" &&
    (source.carrier === "prompt-result"
      ? kind === "" && typeof value.stopReason === "string"
      : kind === "turn_completed");
  const fromMeta = isObject(value._meta)
    ? parseAcpTurnUsageObject(value._meta, kind, carriesTicks)
    : null;
  const fromValue = parseAcpTurnUsageObject(value, kind, carriesTicks);
  const merged = { ...fromMeta, ...fromValue };
  return Object.keys(merged).length > 0 ? merged : null;
}

export function parsePersistedAcpTurnUsage(value: unknown): AcpTurnUsage | null {
  return isObject(value) ? parseAcpTurnUsageObject(value, "", true) : null;
}

/** A turn's tick cost when it is trustworthy; `undefined` means unknown. */
export function qualifiedCostUsdTicks(usage: AcpTurnUsage | undefined): number | undefined {
  return usage?.costUsdTicksUnknown === true ? undefined : usage?.costUsdTicks;
}

export function ticksToUsd(ticks: number): number {
  return ticks / GROK_TICKS_PER_USD;
}

/**
 * Project one turn's usage onto the provider-neutral snapshot the agent info
 * panel renders.
 *
 * Occupancy prefers ACP `usage_update.used` when present. Otherwise the turn's
 * token total is the closest thing Grok offers: an agent's input already
 * contains the whole conversation.
 *
 * The caller supplies the session-scoped cost alongside the latest token usage.
 */
export function acpContextUsage(
  usage: AcpTurnUsage,
  details: {
    modelId?: string;
    durationMs?: number;
    lastTurnTokens?: number;
    sessionTokens?: number;
    sessionCostUsd?: number;
    turns?: NativeAgentContextUsage["turns"];
    source?: NativeAgentContextUsage["source"];
    updatedAt: string;
  },
): NativeAgentContextUsage | null {
  const observedTokens =
    usage.contextUsedTokens ??
    usage.totalTokens ??
    (usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
      ? undefined
      : (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0));
  const costUsd = details.sessionCostUsd ?? usage.costUsd;
  if (
    observedTokens === undefined &&
    costUsd === undefined &&
    !details.turns?.some((turn) => turn.costUsd !== undefined || turn.revision !== undefined)
  )
    return null;
  // The wire snapshot requires a number. With cost-only usage, omit the
  // context window and token metrics so no occupancy is presented.
  const usedTokens = observedTokens ?? 0;
  const durationMs = count(details.durationMs);
  const contextWindow =
    observedTokens !== undefined && usage.contextWindow !== undefined && usage.contextWindow > 0
      ? usage.contextWindow
      : undefined;
  const percentage =
    contextWindow === undefined
      ? undefined
      : Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100));
  return {
    usedTokens,
    ...(observedTokens === undefined ? { occupancyUnknown: true } : {}),
    ...(contextWindow === undefined ? {} : { maximumTokens: contextWindow }),
    ...(percentage === undefined ? {} : { percentage }),
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(details.lastTurnTokens === undefined ? {} : { lastTurnTokens: details.lastTurnTokens }),
    ...(details.sessionTokens === undefined ? {} : { sessionTokens: details.sessionTokens }),
    ...(details.turns?.length ? { turns: details.turns.slice(-20) } : {}),
    ...(usage.apiDurationMs === undefined ? {} : { apiDurationMs: usage.apiDurationMs }),
    ...(costUsd === undefined ? {} : { costUsd, costSource: ACP_COST_SOURCE }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(details.modelId ? { modelId: details.modelId } : {}),
    source: details.source ?? "provider",
    updatedAt: details.updatedAt,
  };
}

/** Fields that are snapshots of the session, not one attempt's consumption. */
const SNAPSHOT_USAGE_FIELDS: ReadonlySet<keyof AcpTurnUsage> = new Set([
  "contextUsedTokens",
  "contextWindow",
  // ACP defines `usage_update.cost.amount` as the session's cumulative cost.
  "costUsd",
]);

/** Tick fields are combined by `combineAttemptTicks`, never summed blindly. */
const TICK_USAGE_FIELDS: ReadonlySet<keyof AcpTurnUsage> = new Set([
  "costUsdTicks",
  "costUsdTicksUnknown",
]);

/** Sum consumption across attempts, retaining the latest session snapshots. */
export function accumulateAttemptUsage(
  previous: AcpTurnUsage | undefined,
  attempt: AcpTurnUsage,
): AcpTurnUsage {
  if (!previous) return attempt;
  const combined = { ...previous, ...attempt };
  for (const key of Object.keys(attempt) as Array<keyof AcpTurnUsage>) {
    if (!SNAPSHOT_USAGE_FIELDS.has(key) && !TICK_USAGE_FIELDS.has(key)) {
      (combined as Record<string, number>)[key] =
        ((previous[key] as number | undefined) ?? 0) + (attempt[key] as number);
    }
  }
  delete combined.costUsdTicks;
  const left = qualifiedCostUsdTicks(previous);
  const right = qualifiedCostUsdTicks(attempt);
  const ticks = left === undefined || right === undefined ? undefined : left + right;
  if (ticks !== undefined && Number.isSafeInteger(ticks)) combined.costUsdTicks = ticks;
  else if (left !== undefined || right !== undefined) combined.costUsdTicksUnknown = true;

  const previousTokens = acpUsageTokenCount(previous);
  const attemptTokens = acpUsageTokenCount(attempt);
  if (previousTokens !== undefined || attemptTokens !== undefined) {
    combined.totalTokens = (previousTokens ?? 0) + (attemptTokens ?? 0);
  }
  return combined;
}

export function acpUsageTokenCount(usage: AcpTurnUsage): number | undefined {
  return (
    usage.totalTokens ??
    (usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
      ? undefined
      : (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0))
  );
}
