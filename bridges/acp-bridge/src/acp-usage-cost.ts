import {
  GROK_TICK_COSTS_QUALIFIED,
  qualifiedCostUsdTicks,
  ticksToUsd,
  type AcpTurnUsage,
} from "./usage.js";

interface CostTotal {
  usd: number;
  ticks?: number;
}

export interface AcpSessionCost {
  /** Sum before the latest turn, retained even if that turn's cost is unknown. */
  beforeLastTurn?: CostTotal;
  total?: CostTotal;
}

export const EMPTY_SESSION_COST: CostTotal = { usd: 0 };

export function sessionCostUsd(
  total: CostTotal | undefined,
  ticksQualified = GROK_TICK_COSTS_QUALIFIED,
): number | undefined {
  if (!total) return undefined;
  if (total.ticks === undefined) return total.usd;
  return ticksQualified ? total.usd + ticksToUsd(total.ticks) : undefined;
}

export function updateSessionCost(
  beforeLastTurn: CostTotal | undefined,
  turn: AcpTurnUsage,
  ticksQualified = GROK_TICK_COSTS_QUALIFIED,
): { cost: AcpSessionCost; turnCostUsd?: number } {
  const ticks = qualifiedCostUsdTicks(turn);
  const prefixUsd = sessionCostUsd(beforeLastTurn, ticksQualified);
  const cumulativeUsd = turn.costUsd;
  const delta =
    cumulativeUsd !== undefined && prefixUsd !== undefined && cumulativeUsd >= prefixUsd
      ? cumulativeUsd - prefixUsd
      : undefined;
  const turnCostUsd =
    delta ?? (ticksQualified && ticks !== undefined ? ticksToUsd(ticks) : undefined);
  const summedTicks =
    beforeLastTurn && ticks !== undefined ? (beforeLastTurn.ticks ?? 0) + ticks : undefined;
  const total =
    cumulativeUsd !== undefined
      ? { usd: cumulativeUsd }
      : beforeLastTurn && summedTicks !== undefined && Number.isSafeInteger(summedTicks)
        ? { usd: beforeLastTurn.usd, ticks: summedTicks }
        : undefined;
  return { cost: { beforeLastTurn, total }, turnCostUsd };
}

function restoreCostTotal(value: unknown): CostTotal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { usd, ticks } = value as Record<string, unknown>;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 1e9) return undefined;
  if (ticks === undefined) return { usd };
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) return undefined;
  return { usd, ticks };
}

export function restoreSessionCost(value: unknown): AcpSessionCost | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { beforeLastTurn, total } = value as Record<string, unknown>;
  return { beforeLastTurn: restoreCostTotal(beforeLastTurn), total: restoreCostTotal(total) };
}
