import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  isAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { getUsageHistory, type UsageHistoryReport } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccountMachine } from "../account-machine";
import { useSettingsConfig } from "../settings-config";
import { PlanUsageSection } from "../PlanUsageSection";
import { UsageBreakdownTable } from "./UsageBreakdownTable";
import {
  UsageEnvironmentList,
  UsageMixBar,
  UsagePlatformList,
  UsageStatStrip,
} from "./UsageSummary";
import { UsageTrendChart } from "./UsageTrendChart";
import {
  formatCost,
  formatCount,
  formatDayLabel,
  formatTokens,
  metricValue,
  type UsageMetric,
} from "./usage-format";
import { SETTINGS_CARD_CLASS, SettingsPageLayout } from "../SettingsPageLayout";
import { cn } from "@/lib/utils";

/**
 * The Usage pane of global settings.
 *
 * Three views over one recording: `tokens` and `cost` re-read the same report
 * (the metric only changes what is drawn and ranked), while `limits` asks each
 * platform what its plan has left — a live provider read that has nothing to
 * do with recorded history.
 *
 * The report is recorded from the per-turn usage providers already report, so
 * it starts the day this app first ran a turn with recording in place: the
 * header says when that was rather than implying the range is complete.
 */

type UsageView = UsageMetric | "limits";

const RANGE_OPTIONS = [
  { value: "1", label: "Today" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

const ALL_ENVIRONMENTS = "all";
const ALL_PLATFORMS = "all";

/**
 * The platforms the filter offers: everything the report has ever recorded,
 * plus whatever is selected even when the report does not list it (its rows
 * may since have been pruned). Dropping the selected option would leave the
 * trigger blank with the filter still applied, and no way to read why the
 * pane is empty.
 */
export function usagePlatformFilterOptions(
  recorded: readonly AgentPlatform[],
  selected: string,
): AgentPlatform[] {
  const offered = new Set<AgentPlatform>(recorded);
  if (isAgentPlatform(selected)) offered.add(selected);
  return AGENT_PLATFORMS.filter((entry) => offered.has(entry));
}

interface UsageLoad {
  /** The filter the answer belongs to; a stale one is still being replaced. */
  key: string;
  report?: UsageHistoryReport;
  error?: string;
}

export function UsageSettings() {
  const [view, setView] = useState<UsageView>("tokens");
  const [range, setRange] = useState<string>("30");
  const [platform, setPlatform] = useState<string>(ALL_PLATFORMS);
  const [environmentId, setEnvironmentId] = useState<string>(ALL_ENVIRONMENTS);
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState<UsageLoad | null>(null);
  const [environmentOptions, setEnvironmentOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const { config } = useSettingsConfig();
  const { machine } = useAccountMachine();
  const enabledPlatforms = useMemo(
    () => normalizeAgentPlatforms(config.global.enabledAgentPlatforms),
    [config.global.enabledAgentPlatforms],
  );

  // The filter the pane is showing. Loading is derived from whether the last
  // answer belongs to it, so changing a filter never has to write state while
  // rendering, and the previous report stays on screen until the new one
  // lands instead of flashing a spinner.
  const queryKey = `${range}|${platform}|${environmentId}|${reloadToken}`;
  useEffect(() => {
    let cancelled = false;
    const [days, selectedPlatform, selectedEnvironment] = queryKey.split("|");
    getUsageHistory(
      {
        days: Number.parseInt(days ?? "30", 10),
        ...(selectedPlatform === ALL_PLATFORMS
          ? {}
          : { platform: selectedPlatform as AgentPlatform }),
        ...(selectedEnvironment === ALL_ENVIRONMENTS
          ? {}
          : { environmentId: selectedEnvironment as string }),
      },
      machine,
    )
      .then((next) => {
        if (cancelled) return;
        setLoaded({ key: queryKey, report: next });
        // The environment list has to outlive a filtered read, which only
        // reports the environment it was filtered to.
        if (selectedEnvironment !== ALL_ENVIRONMENTS || selectedPlatform !== ALL_PLATFORMS) return;
        setEnvironmentOptions(
          next.environments.map((entry) => ({
            id: entry.environmentId,
            label: entry.name
              ? entry.projectName
                ? `${entry.name} · ${entry.projectName}`
                : entry.name
              : "Deleted environment",
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The report already on screen is kept: a failed refresh leaves the
        // numbers that did load readable under the error rather than
        // replacing a working pane with one line of text.
        setLoaded((previous) => ({
          key: queryKey,
          error: err instanceof Error ? err.message : "Could not load usage",
          ...(previous?.report ? { report: previous.report } : {}),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [machine, queryKey]);

  const loading = loaded?.key !== queryKey;
  const report = loaded?.report ?? null;
  const error = loaded?.key === queryKey ? (loaded.error ?? null) : null;
  const metric: UsageMetric = view === "cost" ? "cost" : "tokens";
  const platformOptions = useMemo(
    () => usagePlatformFilterOptions(report?.recordedPlatforms ?? [], platform),
    [platform, report?.recordedPlatforms],
  );
  const totals = report?.totals;
  // Heaviest first, so a thin series is never buried under a thick one.
  const chartPlatforms = useMemo(
    () =>
      [...(report?.platforms ?? [])]
        .sort((left, right) => metricValue(right.totals, metric) - metricValue(left.totals, metric))
        .map((entry) => entry.platform),
    [metric, report?.platforms],
  );

  return (
    <SettingsPageLayout
      width="wide"
      title="Usage"
      description={
        view === "limits"
          ? "What each signed-in account has left in its current plan windows."
          : report?.recordingSince
            ? `Everything agents processed on this machine, recorded since ${formatDayLabel(report.recordingSince, { year: true })}.`
            : "Everything agents processed on this machine, recorded as turns finish."
      }
      actions={
        <>
          <SegmentedSelector
            ariaLabel="Usage view"
            value={view}
            onValueChange={(next) => setView(next as UsageView)}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
              { value: "limits", label: "Limits" },
            ]}
          />
          {view === "limits" ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              onClick={() => setReloadToken((token) => token + 1)}
              disabled={loading}
              aria-label="Refresh usage"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          )}
        </>
      }
    >
      {view === "limits" ? (
        <div className="space-y-4">
          {enabledPlatforms.map((entry) => (
            <section key={entry} className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {AGENT_PLATFORM_LABELS[entry]}
              </h3>
              <PlanUsageSection platform={entry} />
            </section>
          ))}
          {enabledPlatforms.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No agent platform is enabled, so there is no plan to report.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedSelector
              ariaLabel="Usage range"
              value={range}
              onValueChange={setRange}
              options={RANGE_OPTIONS.map((option) => ({ ...option }))}
            />
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger className="h-8 w-40 text-xs" aria-label="Filter by platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PLATFORMS}>All platforms</SelectItem>
                {platformOptions.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {AGENT_PLATFORM_LABELS[entry]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={environmentId} onValueChange={setEnvironmentId}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label="Filter by environment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ENVIRONMENTS}>All environments</SelectItem>
                {environmentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error ? (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          ) : null}

          {!report && loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : report && totals ? (
            <>
              <section aria-label="Daily usage" className={cn(SETTINGS_CARD_CLASS, "p-4")}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p
                    data-testid="usage-total"
                    className="text-2xl font-semibold tabular-nums text-foreground"
                  >
                    {metric === "cost"
                      ? formatCost(totals.costUsd)
                      : formatTokens(totals.totalTokens)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {metric === "cost" ? "spent" : "tokens processed"} ·{" "}
                    {formatCount(report.sessions)} sessions · {formatDayLabel(report.fromDay)} to{" "}
                    {formatDayLabel(report.toDay)}
                  </p>
                </div>
                <div className="mt-3">
                  <UsageTrendChart days={report.days} platforms={chartPlatforms} metric={metric} />
                </div>
              </section>

              <UsageStatStrip totals={totals} sessions={report.sessions} />
              <UsageMixBar totals={totals} />

              <div className="grid gap-6 lg:grid-cols-2">
                <UsagePlatformList
                  platforms={report.platforms}
                  metric={metric}
                  selected={platform === ALL_PLATFORMS ? undefined : platform}
                  onSelect={(next) => setPlatform(next ?? ALL_PLATFORMS)}
                />
                <UsageEnvironmentList environments={report.environments} metric={metric} />
              </div>

              <UsageBreakdownTable models={report.models} days={report.days} metric={metric} />
            </>
          ) : null}
        </>
      )}
    </SettingsPageLayout>
  );
}
