import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { UsageEnvironmentSummary, UsagePlatformSummary, UsageTotals } from "@/lib/backend";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";
import {
  formatCost,
  formatCount,
  formatMetric,
  formatShare,
  formatTokens,
  metricValue,
  PLATFORM_BAR_CLASS,
  type UsageMetric,
} from "./usage-format";

/** The numbers that sit under the chart: headline tiles, the token mix, and the two rankings. */

export function UsageStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
      <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function UsageStatStrip({ totals, sessions }: { totals: UsageTotals; sessions: number }) {
  const cacheable = totals.cacheReadTokens + totals.inputTokens;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <UsageStat
        label="Processed"
        value={formatTokens(totals.totalTokens)}
        hint={`${formatCount(totals.turns)} responses`}
      />
      <UsageStat
        label="Cached input"
        value={formatTokens(totals.cacheReadTokens)}
        hint={`${formatShare(totals.cacheReadTokens, cacheable)} of input`}
      />
      <UsageStat label="Uncached input" value={formatTokens(totals.inputTokens)} />
      <UsageStat label="Cache writes" value={formatTokens(totals.cacheWriteTokens)} />
      <UsageStat
        label="Output"
        value={formatTokens(totals.outputTokens)}
        hint={
          totals.reasoningTokens > 0
            ? `${formatTokens(totals.reasoningTokens)} reasoning`
            : undefined
        }
      />
      <UsageStat
        label="Spend"
        value={formatCost(totals.costUsd)}
        hint={
          totals.unpricedTokens > 0
            ? `${formatTokens(totals.unpricedTokens)} tokens unpriced`
            : `across ${formatCount(sessions)} sessions`
        }
      />
    </div>
  );
}

const MIX_SEGMENTS = [
  { key: "cacheReadTokens", label: "Cache read", className: "bg-sky-400/80" },
  { key: "inputTokens", label: "Input", className: "bg-emerald-400/80" },
  { key: "cacheWriteTokens", label: "Cache write", className: "bg-violet-400/80" },
  { key: "outputTokens", label: "Output", className: "bg-amber-400/80" },
] as const;

/** One full-width bar showing what the processed tokens were made of. */
export function UsageMixBar({ totals }: { totals: UsageTotals }) {
  const total = totals.totalTokens;
  return (
    <section aria-label="Tokens by type" className="space-y-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
        {MIX_SEGMENTS.map((segment) => {
          const value = totals[segment.key];
          if (total <= 0 || value <= 0) return null;
          return (
            <div
              key={segment.key}
              className={segment.className}
              style={{ width: `${(value / total) * 100}%` }}
              title={`${segment.label}: ${formatTokens(value)}`}
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {MIX_SEGMENTS.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", segment.className)} aria-hidden="true" />
            <span>{segment.label}</span>
            <span className="tabular-nums text-foreground">
              {formatTokens(totals[segment.key])}
            </span>
            <span className="tabular-nums">{formatShare(totals[segment.key], total)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Tokens the provider priced at nothing: shown as unpriced rather than free. */
function unpriced(totals: UsageTotals, metric: UsageMetric): boolean {
  return metric === "cost" && totals.costUsd === 0 && totals.totalTokens > 0;
}

export function UsagePlatformList({
  platforms,
  metric,
  selected,
  onSelect,
}: {
  platforms: readonly UsagePlatformSummary[];
  metric: UsageMetric;
  selected?: string;
  onSelect: (platform: string | undefined) => void;
}) {
  const largest = Math.max(...platforms.map((entry) => metricValue(entry.totals, metric)), 1);
  const whole = platforms.reduce((sum, entry) => sum + metricValue(entry.totals, metric), 0);
  return (
    <section aria-label="Platforms" className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Platforms</h3>
      {platforms.length === 0 ? (
        <p className="text-xs text-muted-foreground">No platform recorded usage in this range.</p>
      ) : (
        <ul className="space-y-1">
          {platforms.map((entry) => {
            const value = metricValue(entry.totals, metric);
            const active = selected === entry.platform;
            return (
              <li key={entry.platform}>
                <button
                  type="button"
                  onClick={() => onSelect(active ? undefined : entry.platform)}
                  aria-pressed={active}
                  className={cn(
                    "group relative flex w-full items-center gap-2.5 overflow-hidden rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted/40",
                    active && "border-border/70 bg-muted/50",
                  )}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: `${(value / largest) * 100}%` }}
                    className={cn(
                      "absolute inset-y-0 left-0 opacity-10",
                      PLATFORM_BAR_CLASS[entry.platform],
                    )}
                  />
                  <AgentPlatformIcon
                    platform={entry.platform}
                    accent
                    className="relative h-3.5 w-3.5 shrink-0"
                  />
                  <span className="relative flex-1 truncate text-xs text-foreground">
                    {AGENT_PLATFORM_LABELS[entry.platform]}
                  </span>
                  <span className="relative shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatCount(entry.sessions)} sessions
                  </span>
                  <span className="relative w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                    {formatShare(value, whole)}
                  </span>
                  <span
                    className={cn(
                      "relative w-16 shrink-0 text-right text-xs tabular-nums",
                      // A provider that reports no price is unpriced, not free.
                      unpriced(entry.totals, metric) ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {unpriced(entry.totals, metric) ? "Unpriced" : formatMetric(value, metric)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function UsageEnvironmentList({
  environments,
  metric,
  limit = 6,
}: {
  environments: readonly UsageEnvironmentSummary[];
  metric: UsageMetric;
  limit?: number;
}) {
  // Ranked by the metric on screen. The report arrives ordered by tokens, so
  // a cost view ranked by it would read as spend while being ordered by
  // something else — and `limit` could then cut the biggest spender out
  // entirely. `whole` stays over every environment, not just the shown ones.
  const ranked = [...environments].sort(
    (left, right) => metricValue(right.totals, metric) - metricValue(left.totals, metric),
  );
  const shown = ranked.slice(0, limit);
  const whole = environments.reduce((sum, entry) => sum + metricValue(entry.totals, metric), 0);
  return (
    <section aria-label="Environments" className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Busiest environments</h3>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">No environment recorded usage yet.</p>
      ) : (
        <ul className="space-y-1">
          {shown.map((entry) => (
            <li
              key={entry.environmentId}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {entry.name ?? "Deleted environment"}
                {entry.projectName ? (
                  <span className="text-muted-foreground"> · {entry.projectName}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {formatShare(metricValue(entry.totals, metric), whole)}
              </span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-foreground">
                {formatMetric(metricValue(entry.totals, metric), metric)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
