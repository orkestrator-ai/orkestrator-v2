import { useEffect, useId, useState, type ComponentType, type SVGProps } from "react";
import { ChevronRight, CircuitBoard, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { SystemUsageSnapshot } from "@/lib/backend";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AgentRateLimitWindow, ContextUsageSnapshot } from "@/lib/context-usage";
import { formatTokenCount } from "@/lib/context-usage";
import type {
  NativeAgentAccountUsageWindow,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentRuntimeNotice,
  NativeAgentRuntimeSummary,
  NativeAgentTurnUsage,
} from "@orkestrator/protocol/native-agent";

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function SystemMetric({
  icon: Icon,
  label,
  value,
  align = "center",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: number | null | undefined;
  align?: "start" | "center" | "end";
}) {
  const [labelOpen, setLabelOpen] = useState(false);
  const formatted = typeof value === "number" ? `${Math.round(value)}%` : "—";
  const labelId = useId();
  return (
    <div
      className="relative min-w-0"
      onMouseEnter={() => setLabelOpen(true)}
      onMouseLeave={() => setLabelOpen(false)}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-1.5 py-2 text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={`${label}: ${formatted}`}
        aria-describedby={labelOpen ? labelId : undefined}
        onClick={() => setLabelOpen(true)}
        onFocus={() => setLabelOpen(true)}
        onBlur={() => setLabelOpen(false)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono text-xs tabular-nums text-foreground">{formatted}</span>
      </button>
      {labelOpen ? (
        <div
          id={labelId}
          role="tooltip"
          className={`pointer-events-none absolute top-[calc(100%+0.375rem)] z-50 w-max rounded-md border border-zinc-700/70 bg-zinc-900/95 px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ${
            align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"
          }`}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

export const SYSTEM_USAGE_STALE_AFTER_MS = 10_000;

export function isSystemUsageFresh(
  usage: SystemUsageSnapshot | null,
  checkedAt: number,
): usage is SystemUsageSnapshot {
  if (!usage) return false;
  const sampledAt = Date.parse(usage.sampledAt);
  return Number.isFinite(sampledAt) && checkedAt - sampledAt <= SYSTEM_USAGE_STALE_AFTER_MS;
}

export function SystemUsagePanel({
  usage,
  checkedAt,
}: {
  usage: SystemUsageSnapshot | null;
  checkedAt: number;
}) {
  const freshUsage = isSystemUsageFresh(usage, checkedAt) ? usage : null;
  const stale = usage !== null && freshUsage === null;
  return (
    <section className="mb-4 border-b border-border/60 pb-4" aria-label="System usage">
      <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        <span>System</span>
        {stale ? <span role="status">Data unavailable</span> : null}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <SystemMetric
          icon={Cpu}
          label="Central processing unit (CPU) usage"
          value={freshUsage?.cpuPercent}
          align="start"
        />
        <SystemMetric
          icon={MemoryStick}
          label="Random-access memory (RAM) usage"
          value={freshUsage?.ramPercent}
        />
        <SystemMetric
          icon={CircuitBoard}
          label="Graphics processing unit (GPU) usage"
          value={freshUsage?.gpuPercent}
        />
        <SystemMetric
          icon={HardDrive}
          label="Disk storage usage"
          value={freshUsage?.diskPercent}
          align="end"
        />
      </div>
    </section>
  );
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatCount(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

const RESET_DATE_TIME_FORMAT_OPTIONS = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} satisfies Intl.DateTimeFormatOptions;

const WEEK_MINUTES = 7 * 24 * 60;
const MINUTE_MS = 60_000;

function isWeeklyRateLimit(limit: AgentRateLimitWindow): boolean {
  return (
    limit.windowMinutes === WEEK_MINUTES ||
    (limit.windowMinutes === undefined && /\bweekly\b/i.test(limit.label))
  );
}

export function formatResetDateTime(value: string, locales?: Intl.LocalesArgument): string | null {
  const resetDate = new Date(value);
  if (!Number.isFinite(resetDate.getTime())) return null;
  return resetDate.toLocaleString(locales, RESET_DATE_TIME_FORMAT_OPTIONS);
}

/**
 * Locate the current time within a weekly rate-limit period.
 *
 * Window duration is authoritative when the provider supplies it. Claude's
 * structured usage response currently names weekly windows without including
 * their duration, so its explicit "Weekly" labels use the known seven-day
 * period as a compatibility fallback.
 */
export function weeklyWindowPosition(limit: AgentRateLimitWindow, nowMs: number): number | null {
  const durationMinutes = isWeeklyRateLimit(limit) ? WEEK_MINUTES : null;
  if (durationMinutes === null || !limit.resetsAt) return null;

  const resetMs = new Date(limit.resetsAt).getTime();
  if (!Number.isFinite(resetMs) || !Number.isFinite(nowMs)) return null;
  const durationMs = durationMinutes * MINUTE_MS;
  const periodStartMs = resetMs - durationMs;
  if (nowMs < periodStartMs || nowMs > resetMs) return null;
  return ((nowMs - periodStartMs) / durationMs) * 100;
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-sm tabular-nums text-foreground">{value}</div>
      {detail ? (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatNoticeTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

function RuntimeNoticeCard({
  notice,
  noticeId,
  providerLabel,
  openNoticeId,
  onOpenNoticeChange,
}: {
  notice: NativeAgentRuntimeNotice;
  noticeId: string;
  providerLabel: string;
  openNoticeId: string | null;
  onOpenNoticeChange: (noticeId: string | null) => void;
}) {
  const count = notice.count ?? 1;
  const occurrences = notice.occurrences ?? [];
  const severity = notice.severity ?? "warning";
  const appearance =
    severity === "error"
      ? {
          button:
            "border-destructive/35 bg-destructive/10 text-destructive hover:border-destructive/55 hover:bg-destructive/15 focus-visible:ring-destructive/60",
          dialog: "border-destructive/30",
          summary: "border-destructive/30 bg-destructive/10",
          title: "text-destructive",
          method: "text-destructive/65",
        }
      : severity === "info"
        ? {
            button:
              "border-border/70 bg-muted/20 text-foreground/80 hover:border-border hover:bg-muted/35 focus-visible:ring-ring/60",
            dialog: "border-border",
            summary: "border-border/70 bg-muted/20",
            title: "text-foreground",
            method: "text-muted-foreground",
          }
        : {
            button:
              "border-amber-500/20 bg-amber-500/5 text-amber-100/80 hover:border-amber-400/35 hover:bg-amber-500/10 focus-visible:ring-amber-400/60",
            dialog: "border-amber-500/20",
            summary: "border-amber-500/20 bg-amber-500/5",
            title: "text-amber-100",
            method: "text-amber-100/55",
          };
  return (
    <Dialog
      open={openNoticeId === noticeId}
      onOpenChange={(open) => onOpenNoticeChange(open ? noticeId : null)}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2",
            appearance.button,
          )}
          aria-label={`Show details for ${notice.message}`}
        >
          <span className="min-w-0 flex-1">
            {notice.message}
            {count > 1 ? ` (${count})` : ""}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform group-hover:translate-x-0.5 group-hover:opacity-90" />
        </button>
      </DialogTrigger>
      <DialogContent className={cn("max-w-xl sm:max-w-xl", appearance.dialog)}>
        <DialogHeader>
          <DialogTitle>
            {providerLabel} runtime {severity === "error" ? "error" : "notice"}
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? "One occurrence" : `${count} occurrences`}. Sensitive values and local
            paths are redacted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className={cn("rounded-lg border p-3", appearance.summary)}>
            <div className={cn("text-sm font-medium", appearance.title)}>{notice.message}</div>
            {notice.method ? (
              <div className={cn("mt-1 font-mono text-[11px]", appearance.method)}>
                {notice.method}
              </div>
            ) : null}
          </div>
          {occurrences.length > 0 ? (
            <div className="max-h-[min(55vh,28rem)] space-y-2 overflow-y-auto pr-1">
              {occurrences.map((occurrence, index) => {
                const time = formatNoticeTime(occurrence.receivedAt);
                return (
                  <div
                    key={`${occurrence.receivedAt ?? "unknown"}-${index}`}
                    className="rounded-lg border border-border/70 bg-muted/20 p-3"
                  >
                    {time ? (
                      <time
                        dateTime={occurrence.receivedAt}
                        className="mb-1.5 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        {time}
                      </time>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/85">
                      {occurrence.detail ?? `${providerLabel} did not provide additional detail.`}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              {providerLabel} did not provide additional detail for this notice.
            </div>
          )}
          {count > occurrences.length && occurrences.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Showing the {occurrences.length} most recent occurrences.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read the authoritative share state for an OpenCode session.
 *
 * The store's session record carries no share field, so the server's own
 * session document is the only snapshot that survives a tab switch or an app
 * restart. Probed structurally rather than against the SDK types so a partial
 * client (older server, test double) reports "not shared" instead of throwing.
 *
 * Follow-up for the lib owner: this belongs in `opencode-client.ts` as a typed
 * `getOpenCodeShareUrl(client, sessionId)`.
 */
export async function readOpenCodeShareUrl(
  client: unknown,
  sessionId: string,
): Promise<string | null> {
  const sessions = record(client).session;
  const get = record(sessions).get;
  if (typeof get !== "function") return null;
  const response = await (get as (parameters: { sessionID: string }) => Promise<unknown>).call(
    sessions,
    { sessionID: sessionId },
  );
  const url = record(record(record(response).data).share).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Turn the opaque rewind dry-run payload into something a person can act on.
 *
 * `rewindClaudeFiles` returns `unknown` — it is whatever the installed Agent
 * SDK hands back — so every shape is probed defensively and anything
 * unrecognised degrades to "no files reported" rather than to raw JSON. The
 * previous confirm dialog pasted `JSON.stringify(...).slice(0, 800)` into a
 * `window.confirm`, which truncated mid-structure and asked the user to approve
 * a destructive worktree mutation they could not read.
 */
export function summarizeRewindPreview(preview: unknown): {
  files: string[];
  fileCount: number;
} {
  const root = record(preview);
  const candidates = [
    root.files,
    root.restoredFiles,
    root.changedFiles,
    root.filesRestored,
    root.filesChanged,
    record(root.preview).files,
  ];
  const list =
    candidates.find((value): value is unknown[] => Array.isArray(value) && value.length > 0) ??
    candidates.find((value): value is unknown[] => Array.isArray(value)) ??
    [];
  const files = list.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const item = record(entry);
    for (const key of ["path", "file", "filePath", "name"]) {
      const value = item[key];
      if (typeof value === "string" && value.length > 0) return [value];
    }
    return [];
  });
  const reportedCount = [root.fileCount, root.count, root.totalFiles].find(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  return {
    files,
    fileCount: files.length > 0 ? files.length : (reportedCount ?? 0),
  };
}

/** One short line naming the message a destructive action is anchored to. */
export function describeRewindTarget(text: string | undefined): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "your most recent message";
  return normalized.length > 80 ? `“${normalized.slice(0, 80)}…”` : `“${normalized}”`;
}

export function codexLimitsFromHealth(health: unknown): {
  rateLimits: NonNullable<ContextUsageSnapshot["rateLimits"]>;
  credits?: NonNullable<ContextUsageSnapshot["credits"]>;
} {
  const response = record(record(health).rateLimits);
  const rateLimits: NonNullable<ContextUsageSnapshot["rateLimits"]> = [];
  const byLimitId = record(response.rateLimitsByLimitId);
  const keyedSnapshots = Object.entries(byLimitId).slice(0, 16);
  const snapshots =
    keyedSnapshots.length > 0
      ? keyedSnapshots.map(([limitId, value]) => ({ limitId, snapshot: record(value) }))
      : [{ limitId: undefined, snapshot: record(response.rateLimits) }];
  let credits: NonNullable<ContextUsageSnapshot["credits"]> | undefined;

  for (const { limitId, snapshot } of snapshots) {
    for (const [key, fallback] of [
      ["primary", "Primary"],
      ["secondary", "Secondary"],
    ] as const) {
      const window = record(snapshot[key]);
      if (Object.keys(window).length === 0) continue;
      const rawUsedPercent = finiteNumber(window.usedPercent);
      const usedPercent =
        rawUsedPercent === undefined ? undefined : Math.max(0, Math.min(100, rawUsedPercent));
      const resetsAt = epochSecondsToIso(window.resetsAt);
      const rawWindowMinutes = finiteNumber(window.windowDurationMins);
      const windowMinutes =
        rawWindowMinutes !== undefined && rawWindowMinutes >= 0 ? rawWindowMinutes : undefined;
      if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
        continue;
      }
      rateLimits.push({
        label: codexRateLimitLabel({
          snapshot,
          limitId,
          slot: key,
          fallback,
          windowMinutes,
          multiBucket: keyedSnapshots.length > 0,
        }),
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      });
    }
    credits ??= creditSnapshot(snapshot.credits);
  }
  credits ??= creditSnapshot(record(response.rateLimits).credits);
  return {
    rateLimits,
    ...(credits ? { credits } : {}),
  };
}

function creditSnapshot(value: unknown): NonNullable<ContextUsageSnapshot["credits"]> | undefined {
  const raw = record(value);
  const credits = {
    ...(typeof raw.balance === "string" ? { balance: raw.balance } : {}),
    ...(typeof raw.hasCredits === "boolean" ? { hasCredits: raw.hasCredits } : {}),
    ...(typeof raw.unlimited === "boolean" ? { unlimited: raw.unlimited } : {}),
  };
  return Object.keys(credits).length > 0 ? credits : undefined;
}

function codexRateLimitLabel({
  snapshot,
  limitId,
  slot,
  fallback,
  windowMinutes,
  multiBucket,
}: {
  snapshot: Record<string, unknown>;
  limitId: string | undefined;
  slot: "primary" | "secondary";
  fallback: string;
  windowMinutes: number | undefined;
  multiBucket: boolean;
}): string {
  const duration =
    windowMinutes === WEEK_MINUTES
      ? "Weekly limit"
      : windowMinutes === 24 * 60
        ? "Daily limit"
        : windowMinutes && windowMinutes % 60 === 0
          ? `${windowMinutes / 60}-hour limit`
          : undefined;
  const bucket =
    typeof snapshot.limitName === "string" && snapshot.limitName.trim().length > 0
      ? snapshot.limitName.trim()
      : limitId;
  if (multiBucket && bucket) return `${bucket} · ${duration ?? fallback}`;
  if (slot === "primary" && bucket) return bucket;
  return duration ?? (slot === "primary" ? "Usage limit" : "Secondary limit");
}

/**
 * Runtime facts for any agent, from the neutral projection alone.
 *
 * There is deliberately no per-provider variant of this. Every count is
 * optional because the summary is assembled from whatever the provider
 * volunteered: Codex advertises MCP servers, skills and hooks, Grok its MCP
 * servers, commands and version, Cursor only its commands. Rendering a missing
 * count as "0" would report an absence of servers rather than an absence of an
 * answer, so unknown fields are omitted instead.
 *
 * Drift and notices are shown for every platform on the same terms: the count
 * of events the bridge did not recognise, the names of the most recent ones,
 * and each provider diagnostic as its own expandable card. This is
 * presentation only — the bounding, redaction and grouping all happened in the
 * bridge and the backend before it got here.
 */
export function AgentRuntimePanel({
  runtime,
  providerLabel,
  openNoticeId,
  onOpenNoticeChange,
}: {
  runtime: NativeAgentRuntimeSummary | undefined;
  providerLabel: string;
  openNoticeId?: string | null;
  onOpenNoticeChange?: (noticeId: string | null) => void;
}) {
  const metrics = (
    [
      ["MCP", runtime?.mcpServers],
      ["Commands", runtime?.commands],
      ["Skills", runtime?.skills],
      ["Hooks", runtime?.hooks],
    ] as const
  ).flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: String(value) }]));

  const drift = runtime?.drift;
  // Routine lifecycle information belongs in the MCP inventory. The notice
  // stack is reserved for warnings and failures that need attention.
  const notices = (runtime?.notices ?? []).filter((notice) => notice.severity !== "info").slice(-5);

  if (
    metrics.length === 0 &&
    !runtime?.state &&
    !runtime?.version &&
    !drift &&
    notices.length === 0
  ) {
    return (
      <div className="text-xs text-muted-foreground">
        {providerLabel} does not report runtime details.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {metrics.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {metrics.map((metric) => (
            <Metric key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </div>
      ) : null}
      {runtime?.state || runtime?.version ? (
        <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span>{runtime.state ?? "state unavailable"}</span>
          <span>
            {runtime.version ? `${providerLabel} ${runtime.version}` : "version unavailable"}
          </span>
        </div>
      ) : null}
      {drift ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <div className="text-[11px] font-medium text-amber-100/90">
            {drift.unknownEvents === 1
              ? "1 event this bridge did not recognise"
              : `${drift.unknownEvents} events this bridge did not recognise`}
          </div>
          {drift.unknownKinds.length > 0 ? (
            <div className="mt-1 break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
              {drift.unknownKinds.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
      {notices.length > 0 ? (
        <div className="space-y-1.5">
          {notices.map((notice) => {
            const noticeId =
              notice.id ??
              `${notice.source ?? "bridge"}\u0000${notice.severity ?? "warning"}\u0000${notice.method ?? "notice"}\u0000${notice.message}`;
            return (
              <RuntimeNoticeCard
                key={noticeId}
                notice={notice}
                noticeId={noticeId}
                providerLabel={providerLabel}
                openNoticeId={openNoticeId ?? null}
                onOpenNoticeChange={onOpenNoticeChange ?? (() => undefined)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export type AgentInfoUsageSnapshot = Omit<ContextUsageSnapshot, "totalTokens" | "percentUsed"> & {
  totalTokens?: number;
  percentUsed?: number;
};

const DAILY_WINDOW_PREFIX = "daily:";
/** Trailing days the chart plots; providers report up to ninety buckets. */
const DAILY_CHART_DAYS = 30;

interface DailyTokenPoint {
  key: string;
  date: string;
  tokens: number;
}

/**
 * A day the chart can draw in full: a token count and nothing else.
 *
 * The chart plots one number per day, so any other populated field would be
 * dropped on the floor. Keep this in step with the payload fields of
 * `NativeAgentAccountUsageWindow`; a field missing here is a field the chart
 * would silently swallow.
 */
function isPlainTokenBucket(
  entry: NativeAgentAccountUsageWindow,
): entry is NativeAgentAccountUsageWindow & { tokens: number } {
  return (
    entry.tokens !== undefined &&
    entry.usedPercent === undefined &&
    entry.resetsAt === undefined &&
    entry.spendUsd === undefined &&
    entry.creditsRemaining === undefined &&
    entry.creditBalance === undefined &&
    entry.limitUsd === undefined
  );
}

/**
 * Separate the per-day token buckets from the account's quota windows.
 *
 * A provider can report months of daily buckets. Rendering one card per day
 * pushed the quota and credit windows the panel exists for far below the fold,
 * so the days become a single chart and only the remaining windows stay as
 * cards. A daily bucket the chart cannot represent in full — no token count to
 * plot, or a quota, reset or spend alongside it — falls back to a card where
 * every one of its fields can still be read.
 */
function splitAccountUsage(account: NativeAgentAccountUsageWindow[]): {
  windows: NativeAgentAccountUsageWindow[];
  daily: DailyTokenPoint[];
} {
  const windows: NativeAgentAccountUsageWindow[] = [];
  const daily: DailyTokenPoint[] = [];
  for (const entry of account) {
    const date = entry.window.startsWith(DAILY_WINDOW_PREFIX)
      ? entry.window.slice(DAILY_WINDOW_PREFIX.length)
      : null;
    if (date === null || !isPlainTokenBucket(entry)) {
      windows.push(entry);
      continue;
    }
    daily.push({ key: entry.window, date: entry.label ?? date, tokens: entry.tokens });
  }
  return { windows, daily };
}

/** Short day label, falling back to the provider's own string when unparseable. */
function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Daily token consumption as a compact bar chart.
 *
 * Bars are scaled against the peak day rather than any quota, because the
 * provider reports consumption without a daily ceiling. Hovering a column
 * reads its day out above the plot; the newest day is the standing readout so
 * the chart says something before it is touched.
 */
function DailyTokenChart({ points }: { points: DailyTokenPoint[] }) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const plotted = points.slice(-DAILY_CHART_DAYS);
  const oldest = plotted[0];
  const latest = plotted[plotted.length - 1];
  if (!oldest || !latest) return null;

  const peak = plotted.reduce((highest, point) => Math.max(highest, point.tokens), 0);
  const readout = plotted.find((point) => point.key === hoveredKey) ?? latest;

  return (
    <section className="space-y-2" aria-label="Daily tokens">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
          Daily tokens
        </div>
        <div className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {formatDayLabel(readout.date)}{" "}
          <span className="text-foreground">{formatTokenCount(readout.tokens)}</span>
        </div>
      </div>
      <div className="flex h-14 items-stretch gap-[2px]" onMouseLeave={() => setHoveredKey(null)}>
        {plotted.map((point) => (
          <div
            key={point.key}
            role="img"
            aria-label={`${formatDayLabel(point.date)}: ${formatTokenCount(point.tokens)} tokens`}
            title={`${formatDayLabel(point.date)} · ${formatTokenCount(point.tokens)}`}
            className="flex min-w-[3px] flex-1 cursor-default items-end"
            onMouseEnter={() => setHoveredKey(point.key)}
          >
            <div
              className={`w-full rounded-t-[2px] ${
                point.key === readout.key ? "bg-primary" : "bg-primary/50"
              }`}
              style={{
                height: `${peak > 0 ? Math.max(2, (point.tokens / peak) * 100) : 2}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{formatDayLabel(oldest.date)}</span>
        <span className="shrink-0 font-mono tabular-nums">
          Peak {plotted.length}d {formatTokenCount(peak)}
        </span>
        <span className="truncate">{formatDayLabel(latest.date)}</span>
      </div>
    </section>
  );
}

function AccountUsageSection({ account }: { account: NativeAgentAccountUsageWindow[] }) {
  const { windows, daily } = splitAccountUsage(account);
  return (
    <>
      {windows.length > 0 ? <AccountWindowsSection windows={windows} /> : null}
      {daily.length > 0 ? <DailyTokenChart points={daily} /> : null}
    </>
  );
}

function creditSnapshotValue(credits: NonNullable<ContextUsageSnapshot["credits"]>): string {
  if (credits.unlimited) return "Unlimited";
  if (credits.balance !== undefined) return credits.balance;
  return credits.hasCredits ? "Available" : "Unavailable";
}

/**
 * Codex reports its account limits through both the compatibility rate-limit
 * fields and provider-neutral account windows. Build one authoritative set for
 * presentation so the same quota and balance are not repeated later in the
 * pane. The freshly read rate-limit snapshot wins over retained account rows.
 */
function codexAccountUsage(
  account: NativeAgentAccountUsageWindow[] | undefined,
  rateLimits: AgentRateLimitWindow[] | undefined,
  credits: ContextUsageSnapshot["credits"],
): NativeAgentAccountUsageWindow[] {
  const retained = account ?? [];
  const otherWindows = retained.filter(
    (entry) =>
      entry.window !== "primary" && entry.window !== "secondary" && entry.window !== "credits",
  );
  const limitWindows = rateLimits?.length
    ? rateLimits.map((limit, index) => ({
        window: `codex-limit:${index}`,
        label: limit.label,
        ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
        ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
      }))
    : retained.filter((entry) => entry.window === "primary" || entry.window === "secondary");
  const retainedCredits = retained.find((entry) => entry.window === "credits");
  const creditWindow = credits
    ? {
        window: "credits",
        label: "Credits",
        creditBalance: creditSnapshotValue(credits),
      }
    : retainedCredits;
  return [...limitWindows, ...(creditWindow ? [creditWindow] : []), ...otherWindows];
}

function AccountWindowsSection({ windows }: { windows: NativeAgentAccountUsageWindow[] }) {
  return (
    <section className="space-y-2" aria-label="Account usage">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        Account
      </div>
      {windows.map((window) => {
        const resetLabel = window.resetsAt ? formatResetDateTime(window.resetsAt) : null;
        const creditValue =
          window.creditBalance ??
          (window.creditsRemaining !== undefined ? String(window.creditsRemaining) : undefined);
        const isCreditOnly =
          creditValue !== undefined &&
          window.tokens === undefined &&
          window.usedPercent === undefined &&
          window.spendUsd === undefined &&
          window.limitUsd === undefined &&
          resetLabel === null;
        const hasMetrics =
          window.tokens !== undefined ||
          window.spendUsd !== undefined ||
          window.limitUsd !== undefined ||
          (!isCreditOnly && creditValue !== undefined);

        return (
          <div key={window.window} className="rounded-lg border border-border/60 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 truncate text-xs font-medium text-foreground">
                {window.label ?? window.window}
              </div>
              {isCreditOnly ? (
                <div className="shrink-0 font-mono text-sm tabular-nums text-foreground">
                  {creditValue}
                </div>
              ) : resetLabel ? (
                <div
                  className="shrink-0 text-[10px] text-muted-foreground"
                  title={new Date(window.resetsAt!).toLocaleString()}
                >
                  Resets {resetLabel}
                </div>
              ) : null}
            </div>
            {window.usedPercent !== undefined ? (
              <div className="mt-2">
                <div className="mb-1 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {window.usedPercent.toFixed(window.usedPercent >= 10 ? 0 : 1)}% used
                </div>
                <Progress value={window.usedPercent} aria-label={`${window.usedPercent}% used`} />
              </div>
            ) : null}
            {hasMetrics ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {window.tokens !== undefined ? (
                  <Metric label="Tokens" value={formatTokenCount(window.tokens)} />
                ) : null}
                {window.spendUsd !== undefined ? (
                  <Metric label="Spend" value={formatUsd(window.spendUsd)} />
                ) : null}
                {window.limitUsd !== undefined ? (
                  <Metric label="Limit" value={formatUsd(window.limitUsd)} />
                ) : null}
                {!isCreditOnly && creditValue !== undefined ? (
                  <Metric label="Credits" value={creditValue} />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function TurnUsageSection({ turns }: { turns: NativeAgentTurnUsage[] }) {
  return (
    <section className="space-y-2" aria-label="Turn usage">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        Recent turns
      </div>
      {Array.from(turns)
        .reverse()
        .map((turn) => {
          const tokens =
            turn.totalTokens ??
            (turn.inputTokens ?? 0) +
              (turn.outputTokens ?? 0) +
              (turn.cacheReadTokens ?? 0) +
              (turn.cacheWriteTokens ?? 0);
          return (
            <div key={turn.turnId} className="rounded-lg border border-border/60 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                  {turn.turnId}
                </div>
                <div className="shrink-0 font-mono text-xs tabular-nums text-foreground">
                  {formatTokenCount(tokens)}
                  {turn.costUsd !== undefined ? ` · ${formatUsd(turn.costUsd)}` : ""}
                </div>
              </div>
              {turn.modelId || turn.requestId || turn.durationMs !== undefined ? (
                <div className="mt-1 truncate text-[10px] text-muted-foreground">
                  {[
                    turn.modelId,
                    turn.requestId,
                    turn.durationMs === undefined ? undefined : formatDuration(turn.durationMs),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </div>
          );
        })}
    </section>
  );
}

export function UsagePanel({
  usage,
  modelId,
  rateLimits,
}: {
  usage: AgentInfoUsageSnapshot | undefined;
  modelId: string | undefined;
  /** Claude reports these independently of context occupancy. */
  rateLimits?: AgentRateLimitWindow[];
}) {
  const displayedRateLimits = rateLimits ?? usage?.rateLimits;

  if (!usage) {
    if (displayedRateLimits && displayedRateLimits.length > 0) {
      return (
        <div className="space-y-4">
          <RateLimitsSection rateLimits={displayedRateLimits} />
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
            <span className="truncate">{modelId ?? "Model unavailable"}</span>
            <span className="shrink-0">Provider reported</span>
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
        Usage will appear after this session reports its first token snapshot.
      </div>
    );
  }

  const used = Math.max(0, usage.usedTokens);
  const isCodex = usage.source === "codex";
  const displayedAccount = isCodex
    ? codexAccountUsage(usage.account, displayedRateLimits, usage.credits)
    : (usage.account ?? []);
  const creditsRenderedInAccount =
    isCodex && displayedAccount.some((entry) => entry.window === "credits");
  const limitsRenderedInAccount = isCodex && Boolean(displayedRateLimits?.length);
  const contextWindow =
    usage.totalTokens !== undefined &&
    Number.isFinite(usage.totalTokens) &&
    usage.percentUsed !== undefined &&
    Number.isFinite(usage.percentUsed)
      ? {
          total: Math.max(0, usage.totalTokens),
          percentUsed: usage.percentUsed,
          remaining: Math.max(0, Math.max(0, usage.totalTokens) - used),
        }
      : null;

  return (
    <div className="space-y-4">
      {displayedAccount.length ? <AccountUsageSection account={displayedAccount} /> : null}
      {contextWindow ? (
        <div>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                Context
              </div>
              <div className="mt-1 font-mono text-xl tabular-nums text-foreground">
                {contextWindow.percentUsed.toFixed(contextWindow.percentUsed >= 10 ? 0 : 1)}%
              </div>
            </div>
            <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              <div>
                {formatTokenCount(used)} / {formatTokenCount(contextWindow.total)}
              </div>
              <div>{formatTokenCount(contextWindow.remaining)} available</div>
            </div>
          </div>
          <Progress
            value={contextWindow.percentUsed}
            aria-label={`${contextWindow.percentUsed.toFixed(0)} percent of context used`}
            className="h-1.5"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        {usage.inputTokens !== undefined ? (
          <Metric label="Input" value={formatTokenCount(usage.inputTokens)} />
        ) : null}
        {usage.outputTokens !== undefined ? (
          <Metric label="Output" value={formatTokenCount(usage.outputTokens)} />
        ) : null}
        {usage.cacheReadTokens !== undefined ? (
          <Metric label="Cache read" value={formatTokenCount(usage.cacheReadTokens)} />
        ) : null}
        {usage.reasoningTokens !== undefined ? (
          <Metric label="Reasoning" value={formatTokenCount(usage.reasoningTokens)} />
        ) : null}
        {usage.sessionTokens !== undefined ? (
          <Metric label="Session" value={formatTokenCount(usage.sessionTokens)} />
        ) : null}
        {usage.costUsd !== undefined ? (
          <Metric label="Cost" value={formatUsd(usage.costUsd)} />
        ) : null}
        {usage.durationMs !== undefined ? (
          <Metric label="Elapsed" value={formatDuration(usage.durationMs)} />
        ) : null}
        {usage.permissionDenials !== undefined ? (
          <Metric
            label="Denied"
            value={String(usage.permissionDenials)}
            detail="tool permissions"
          />
        ) : null}
        {usage.credits !== undefined && !creditsRenderedInAccount ? (
          <Metric
            label="Credits"
            value={
              usage.credits.unlimited
                ? "Unlimited"
                : (usage.credits.balance ??
                  (usage.credits.hasCredits ? "Available" : "Unavailable"))
            }
          />
        ) : null}
      </div>

      {usage.turns?.length ? <TurnUsageSection turns={usage.turns} /> : null}

      {displayedRateLimits && displayedRateLimits.length > 0 && !limitsRenderedInAccount ? (
        <RateLimitsSection rateLimits={displayedRateLimits} />
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
        <span className="truncate">{usage.modelId ?? modelId ?? "Model unavailable"}</span>
        <span className="shrink-0">{usage.estimated ? "Estimated" : "Provider reported"}</span>
      </div>
    </div>
  );
}

export function RateLimitsSection({ rateLimits }: { rateLimits: AgentRateLimitWindow[] }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const weeklyClockKey = JSON.stringify(
    rateLimits
      .filter(isWeeklyRateLimit)
      .map((limit) => [limit.label, limit.resetsAt ?? null, limit.windowMinutes ?? null]),
  );

  useEffect(() => {
    if (weeklyClockKey === "[]") return;

    const updateClock = () => setNowMs(Date.now());
    updateClock();
    const interval = window.setInterval(updateClock, MINUTE_MS);
    return () => window.clearInterval(interval);
  }, [weeklyClockKey]);

  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        Limits
      </div>
      {rateLimits.map((limit) => {
        const resetLabel = limit.resetsAt ? formatResetDateTime(limit.resetsAt) : null;
        const weekPosition = weeklyWindowPosition(limit, nowMs);
        return (
          <div key={`${limit.label}:${limit.resetsAt ?? ""}`}>
            <div className="mb-1.5 flex justify-between gap-3 text-xs">
              <span className="text-foreground">{limit.label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {limit.usedPercent === undefined
                  ? "Available"
                  : `${limit.usedPercent.toFixed(0)}% used`}
              </span>
            </div>
            {limit.usedPercent !== undefined ? (
              <div className="relative">
                {/*
                 * The label reports the provider's figure verbatim; the bar is
                 * clamped. `Progress` positions its indicator with
                 * `translateX(-(100 - value)%)`, so an over-quota percentage
                 * pushes the fill out of the clipped track and an account past
                 * its allowance would read as an empty bar.
                 */}
                <Progress value={Math.min(100, Math.max(0, limit.usedPercent))} className="h-1" />
                {weekPosition !== null ? (
                  <span
                    className="pointer-events-none absolute -inset-y-1 z-10 w-px bg-red-500 shadow-[0_0_2px_rgba(239,68,68,0.8)]"
                    style={{
                      left: `${weekPosition}%`,
                      transform: "translateX(-50%)",
                    }}
                    role="img"
                    aria-label={`Current point in weekly period: ${weekPosition.toFixed(0)}%`}
                    title={`Current point in weekly period: ${weekPosition.toFixed(0)}%`}
                  />
                ) : null}
              </div>
            ) : null}
            {resetLabel ? (
              <div className="mt-1 text-right text-[10px] text-muted-foreground">
                Resets {resetLabel}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const INTERACTION_KIND_LABELS: Record<string, string> = {
  question: "questions",
  "plan-approval": "plan approvals",
  "command-approval": "command approvals",
  "file-approval": "file approvals",
  permission: "permission requests",
  "mcp-form": "MCP forms",
  "mcp-url": "MCP sign-in links",
  elicitation: "dialogs",
  "terminal-selection": "terminal selections",
};

/**
 * What this agent can stop and ask for.
 *
 * The empty case is the reason this exists: an agent that never asks is
 * indistinguishable, from an empty pending list, from one whose questions are
 * failing to arrive. Saying so is the difference between "nothing to do" and
 * "something is wrong". Absent — rather than empty — means the platform did not
 * report, and nothing is claimed.
 */
export function AgentInteractionCapability({
  kinds,
  providerLabel,
}: {
  kinds: string[] | undefined;
  providerLabel: string;
}) {
  if (kinds === undefined) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        Approvals
      </div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {kinds.length === 0
          ? `${providerLabel} never stops to ask — it has no approval surface.`
          : `${providerLabel} can ask for ${kinds
              .map((kind) => INTERACTION_KIND_LABELS[kind] ?? kind)
              .join(", ")}.`}
      </div>
    </div>
  );
}

const MCP_STATUS_DOT: Record<NativeAgentMcpServer["status"], string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  failed: "bg-destructive",
  "needs-auth": "bg-amber-500",
  disabled: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/50",
};

/**
 * Adapters list actions in their own order, so rank them here: a signed-out or
 * disabled server is better served by the action that actually unblocks it than
 * by a reconnect that would fail the same way again, and `disable` is last
 * because it takes a working server away.
 */
const MCP_ACTION_ORDER = ["sign-in", "enable", "reconnect", "disable"] as const;

function orderedMcpActions(server: NativeAgentMcpServer): NativeAgentMcpServerAction[] {
  // The list arrives over the bridge wire; a provider that omits it entirely
  // means "no actions", not a crash on every row.
  const advertised = Array.isArray(server.actions) ? server.actions : [];
  return MCP_ACTION_ORDER.filter((action) => advertised.includes(action));
}

/**
 * The action a click on the server row itself performs.
 *
 * `disable` is deliberately excluded: OpenCode offers it as the *only* action
 * on a connected server, and a row whose visible text is just a name and a tool
 * count must not tear down a working connection on a stray click. It stays
 * reachable as an explicitly labelled button instead.
 */
function primaryMcpAction(server: NativeAgentMcpServer): NativeAgentMcpServerAction | null {
  return orderedMcpActions(server).find((action) => action !== "disable") ?? null;
}

function mcpActionLabel(action: NativeAgentMcpServerAction): string {
  return action.replaceAll("-", " ");
}

/**
 * One MCP server: an informational region that doubles as the primary control,
 * plus a labelled button for every remaining action.
 *
 * The region is only a button when there is a primary action to run; Cursor
 * publishes no actions at all, and rendering those rows as disabled buttons
 * greyed out healthy servers.
 */
function McpServerRow({
  server,
  busyAction,
  onAction,
}: {
  server: NativeAgentMcpServer;
  busyAction: string | null;
  onAction: (server: NativeAgentMcpServer, action: NativeAgentMcpServerAction) => void;
}) {
  const actions = orderedMcpActions(server);
  const primary = primaryMcpAction(server);
  const secondary = actions.filter((action) => action !== primary);
  const busy = busyAction !== null;
  // Exact keys rather than a prefix test, so `github` does not read `github-2`'s
  // pending action as its own.
  const pending = actions.some((action) => busyAction === `mcp-${server.id}-${action}`);
  const status = server.status.replaceAll("-", " ");
  // A connected server that reports no inventory is unknown, not empty: OpenCode
  // never sends `toolCount`, and rendering `0` there would be a claim, not a gap.
  const detail = pending
    ? "…"
    : server.status === "connected"
      ? (server.toolCount?.toString() ?? "—")
      : status;
  const title = [
    `${server.name} · ${status}`,
    server.error,
    primary ? `click to ${mcpActionLabel(primary)}` : undefined,
  ]
    .filter(Boolean)
    .join(" — ");
  const summary = (
    <>
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", MCP_STATUS_DOT[server.status])}
        aria-hidden="true"
      />
      <span className="truncate text-foreground">{server.name}</span>
      <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
        {detail}
      </span>
    </>
  );
  const summaryClassName = "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 text-left";
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pr-2.5">
        {primary ? (
          <button
            type="button"
            disabled={busy}
            title={title}
            className={cn(
              summaryClassName,
              "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:opacity-60 disabled:hover:bg-transparent",
            )}
            onClick={() => onAction(server, primary)}
          >
            {summary}
          </button>
        ) : (
          <div className={summaryClassName} title={title}>
            {summary}
          </div>
        )}
        {secondary.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            aria-label={`${mcpActionLabel(action)} ${server.name}`}
            className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 disabled:hover:bg-transparent"
            onClick={() => onAction(server, action)}
          >
            {mcpActionLabel(action)}
          </button>
        ))}
      </div>
      {server.error ? (
        <p className="break-words px-2.5 pb-1 pl-6 text-destructive">{server.error}</p>
      ) : null}
    </div>
  );
}

/**
 * MCP inventory as a single "Tools N" line that expands into a dense list.
 *
 * A session can carry hundreds of tools across a dozen servers; rendering one
 * card per server pushed everything else in the popover below the fold. The
 * collapsed line keeps the total visible, and still surfaces how many servers
 * are not connected so a failed server is not hidden by the collapse.
 */
export function McpServersPanel({
  servers,
  busyAction,
  onAction,
}: {
  servers: NativeAgentMcpServer[];
  busyAction: string | null;
  onAction: (server: NativeAgentMcpServer, action: NativeAgentMcpServerAction) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (servers.length === 0) return null;
  // Only servers that actually report an inventory contribute. When none does,
  // the total is unknown and saying `Tools 0` would be wrong rather than empty.
  const counted = servers.filter((server) => server.toolCount !== undefined);
  const toolTotal = counted.reduce((total, server) => total + (server.toolCount ?? 0), 0);
  const unhealthy = servers.filter(
    (server) => server.status === "failed" || server.status === "needs-auth",
  ).length;
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 text-xs"
      aria-label="MCP servers"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">
          Tools {counted.length === 0 ? "—" : toolTotal}
        </span>
        <span className="ml-auto text-muted-foreground">
          {formatCount(servers.length, "server")}
          {unhealthy > 0 ? <span className="text-destructive"> · {unhealthy} down</span> : null}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border/60 py-1">
          {servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              busyAction={busyAction}
              onAction={onAction}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
