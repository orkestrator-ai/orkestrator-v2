/**
 * Where a `costUsd` came from.
 *
 * - `provider`: the amount the provider says it billed or charged (Cursor's
 *   `chargedCents`, an OpenRouter-billed Pi response, an explicit ACP USD
 *   `cost`).
 * - `estimate`: computed from token counts and a price table, by the provider's
 *   own client or SDK (Claude's `total_cost_usd`, OpenCode's catalogue cost,
 *   Pi's catalogue fallback).
 *
 * An absent source means nobody said: an older bridge, a stored record that
 * predates the field, or a provider whose amount could be either. Readers
 * treat it as they always have, and never as a bill or an estimate.
 */
export type NativeAgentCostSource = "provider" | "estimate";

export const NATIVE_AGENT_COST_SOURCES: readonly NativeAgentCostSource[] = Object.freeze([
  "provider",
  "estimate",
]);

export function isNativeAgentCostSource(value: unknown): value is NativeAgentCostSource {
  return value === "provider" || value === "estimate";
}

/** One amount that may be summed into a total, with what it says about itself. */
export interface NativeAgentCostPart {
  costUsd?: number;
  costSource?: NativeAgentCostSource;
}

/**
 * The source of a total built from `parts`.
 *
 * Only parts that carry an amount count. A total containing any estimate is an
 * estimate; it is provider-billed only when every priced part is; any other mix
 * (a part with no source beside provider-billed ones) is unknown, so absent.
 * A total with no priced part has no source either.
 */
export function combineNativeAgentCostSources(
  parts: Iterable<NativeAgentCostPart>,
): NativeAgentCostSource | undefined {
  let priced = false;
  let allProvider = true;
  for (const part of parts) {
    if (typeof part.costUsd !== "number" || !Number.isFinite(part.costUsd)) continue;
    priced = true;
    if (part.costSource === "estimate") return "estimate";
    if (part.costSource !== "provider") allProvider = false;
  }
  return priced && allProvider ? "provider" : undefined;
}
