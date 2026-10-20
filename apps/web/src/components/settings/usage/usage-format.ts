import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { UsageTotals } from "@/lib/backend";

/** Shared number shapes for the usage panes: tokens, money, shares and days. */

/** Three significant digits with a magnitude suffix: `4.93B`, `519M`, `338K`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (value < size) continue;
    const scaled = value / size;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(digits)}${suffix}`;
  }
  return Math.round(value).toLocaleString();
}

/** `$1,268.94`; a non-zero amount below a cent reads `<$0.01`. */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatShare(part: number, whole: number): string {
  if (!Number.isFinite(whole) || whole <= 0 || part <= 0) return "0%";
  const share = (part / whole) * 100;
  if (share < 0.1) return "<0.1%";
  return `${share.toFixed(share >= 10 ? 1 : 2)}%`;
}

export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

/** `20 Oct` — the axis and tooltip label for a `YYYY-MM-DD` key. */
export function formatDayLabel(day: string, options: { year?: boolean } = {}): string {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" } : {}),
  });
}

/** The metric a view ranks and draws by. */
export type UsageMetric = "tokens" | "cost";

export function metricValue(totals: UsageTotals, metric: UsageMetric): number {
  return metric === "cost" ? totals.costUsd : totals.totalTokens;
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatCost(value) : formatTokens(value);
}

/**
 * The bar fill matching each platform's accent. Written out rather than
 * derived from `PLATFORM_ICON_CLASS`, because Tailwind only emits classes it
 * can see as literal text in the source.
 */
export const PLATFORM_BAR_CLASS: Record<AgentPlatform, string> = {
  claude: "bg-orange-400",
  codex: "bg-emerald-400",
  opencode: "bg-green-500",
  cursor: "bg-violet-400",
  grok: "bg-sky-400",
  pi: "bg-amber-400",
};
