import type { NativeAgentCostSource } from "@orkestrator/protocol/native-agent";

/**
 * Whether a Pi cost is a bill or a catalogue estimate.
 *
 * pi-ai 1.5.0 sets `Usage.cost.totalFromProvider` on each response: true when
 * `total` "is the billed cost reported by the provider", false (or absent)
 * when it "is a catalog estimate" (`types.d.ts`). Only OpenRouter sets it
 * true, from the response's own accounting (`utils/openrouter-cost.js`); every
 * other provider's total is `calculateCost` over the model's catalogue rates
 * (`models.js`), and pi-coding-agent's `combineUsage` calls a sum
 * provider-reported "only when every part is".
 *
 * The bridge's turn cost is a delta of `getSessionStats().cost`, which sums
 * every usage-bearing entry in the session (`agent-session.js`): `usage`
 * entries, compaction and branch summaries that carry usage, tool results that
 * carry usage, and every assistant message. Those same entries are counted
 * here, so the counts move exactly when that sum can. A turn is billed only
 * when every part it added says so; one part that does not makes it an
 * estimate. A part that reported nothing at all (no tokens and no cost: an
 * aborted or failed response) adds nothing to the sum and is not counted.
 */
export interface PiCostParts {
  /** Usage-bearing session entries that reported anything. */
  parts: number;
  /** Of those, the ones whose `cost.total` Pi says the provider billed. */
  providerParts: number;
}

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown; totalFromProvider?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The usage `getSessionStats` would add for this entry, if any. */
function entryUsage(entry: unknown): UsageLike | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "usage") return isRecord(entry.usage) ? entry.usage : undefined;
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    return isRecord(entry.usage) ? entry.usage : undefined;
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  if (message.role !== "assistant" && message.role !== "toolResult") return undefined;
  return isRecord(message.usage) ? message.usage : undefined;
}

function reportedAnything(usage: UsageLike): boolean {
  return (
    positive(usage.cost?.total) ||
    positive(usage.totalTokens) ||
    positive(usage.input) ||
    positive(usage.output) ||
    positive(usage.cacheRead) ||
    positive(usage.cacheWrite)
  );
}

/** Count the session's priced parts. Never throws: a malformed entry is skipped. */
export function countPiCostParts(entries: readonly unknown[]): PiCostParts {
  let parts = 0;
  let providerParts = 0;
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (!usage || !reportedAnything(usage)) continue;
    parts += 1;
    if (usage.cost?.totalFromProvider === true) providerParts += 1;
  }
  return { parts, providerParts };
}

function sourceOf(parts: number, providerParts: number): NativeAgentCostSource | undefined {
  if (parts <= 0) return undefined;
  return providerParts === parts ? "provider" : "estimate";
}

/** The source of the whole session's cost. */
export function piSessionCostSource(current: PiCostParts): NativeAgentCostSource | undefined {
  return sourceOf(current.parts, current.providerParts);
}

/**
 * The source of the cost one turn added, from the counts before and after it.
 *
 * Without a usable baseline (state saved by an older bridge, or a session
 * whose entries were replaced so the counts went backwards) the turn's own
 * parts cannot be told apart. It is still billed when every part in the
 * session is, and otherwise left unknown.
 */
export function piTurnCostSource(
  current: PiCostParts,
  baseline: PiCostParts | undefined,
): NativeAgentCostSource | undefined {
  if (baseline) {
    const parts = current.parts - baseline.parts;
    const providerParts = current.providerParts - baseline.providerParts;
    if (parts >= 0 && providerParts >= 0 && providerParts <= parts) {
      return sourceOf(parts, providerParts);
    }
  }
  return current.parts > 0 && current.providerParts === current.parts ? "provider" : undefined;
}

/** The source of one response's own cost, when nothing else is known. */
export function piUsageCostSource(usage: UsageLike | undefined): NativeAgentCostSource | undefined {
  if (!usage || !reportedAnything(usage)) return undefined;
  return usage.cost?.totalFromProvider === true ? "provider" : "estimate";
}
