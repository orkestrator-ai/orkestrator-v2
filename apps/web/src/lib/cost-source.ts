import type { NativeAgentCostSource } from "@orkestrator/protocol/native-agent";

/**
 * How a dollar amount says where it came from, the same way for every
 * provider. The source is decided by the bridges (`costSource` beside each
 * `costUsd`); the renderer only reads it, so nothing here names a platform.
 *
 * - `estimate`: "~$0.12", titled {@link ESTIMATED_COST_TITLE} (`CostAmount`).
 * - `provider` or unknown: "$0.12", unchanged. An unknown source is shown the
 *   way every cost was shown before sources existed, never as a bill or an
 *   estimate it may not be.
 */
export const ESTIMATED_COST_TITLE = "Estimated from token counts";

/** The amount for a screen reader, which reads `~` as "tilde". */
export function spokenCostText(amount: string, source: NativeAgentCostSource | undefined): string {
  return source === "estimate" ? `${amount}, estimated` : amount;
}
