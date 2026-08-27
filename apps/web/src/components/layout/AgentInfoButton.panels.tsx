import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AgentRateLimitWindow, ContextUsageSnapshot } from "@/lib/context-usage";
import { formatTokenCount } from "@/lib/context-usage";
import type {
  NativeAgentRuntimeNotice,
  NativeAgentRuntimeNoticeOccurrence,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import type { CursorUsageResult } from "@orkestrator/protocol/cursor-usage";

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * An overdrawn allowance reports a negative remainder, and `formatUsd` would
 * render that as `$-50.0000` through its sub-cent branch. Sign it outside the
 * currency instead.
 */
function formatCents(value: number): string {
  return value < 0 ? `-${formatUsd(Math.abs(value) / 100)}` : formatUsd(value / 100);
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
  weekday: "long",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
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

function inventoryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const data = record(value).data;
  if (Array.isArray(data)) {
    return data.reduce((count, entry) => {
      const item = record(entry);
      const nested = item.skills ?? item.hooks ?? item.servers;
      return count + (Array.isArray(nested) ? nested.length : 1);
    }, 0);
  }
  return Object.keys(record(value)).filter((key) => key !== "error").length;
}

function formatNoticeTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

function runtimeNoticeGroups(
  health: unknown,
  runtime?: NativeAgentRuntimeSummary,
): NativeAgentRuntimeNotice[] {
  if (runtime) return (runtime.notices ?? []).slice(-5);
  const snapshot = record(health);
  const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
  const grouped = new Map<string, NativeAgentRuntimeNotice>();
  for (const candidate of notices) {
    const item = record(candidate);
    if (typeof item.message !== "string" || item.message.length === 0) continue;
    const method = typeof item.method === "string" ? item.method : undefined;
    const key = `${method ?? ""}\u0000${item.message}`;
    const existing = grouped.get(key);
    const occurrence: NativeAgentRuntimeNoticeOccurrence = {
      ...(typeof item.detail === "string" && item.detail.length > 0 ? { detail: item.detail } : {}),
      ...(typeof item.receivedAt === "string" && item.receivedAt.length > 0
        ? { receivedAt: item.receivedAt }
        : {}),
    };
    const occurrences = [
      ...(existing?.occurrences ?? []),
      ...(Object.keys(occurrence).length > 0 ? [occurrence] : []),
    ].slice(-5);
    if (existing) grouped.delete(key);
    grouped.set(key, {
      message: item.message,
      ...(method ? { method } : {}),
      count: (existing?.count ?? 0) + 1,
      ...(occurrences.length > 0 ? { occurrences } : {}),
    });
  }
  return [...grouped.values()].slice(-5);
}

function RuntimeNoticeCard({
  notice,
  noticeId,
  openNoticeId,
  onOpenNoticeChange,
}: {
  notice: NativeAgentRuntimeNotice;
  noticeId: string;
  openNoticeId: string | null;
  onOpenNoticeChange: (noticeId: string | null) => void;
}) {
  const count = notice.count ?? 1;
  const occurrences = notice.occurrences ?? [];
  return (
    <Dialog
      open={openNoticeId === noticeId}
      onOpenChange={(open) => onOpenNoticeChange(open ? noticeId : null)}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-left text-xs text-amber-100/80 transition-colors hover:border-amber-400/35 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          aria-label={`Show details for ${notice.message}`}
        >
          <span className="min-w-0 flex-1">
            {notice.message}
            {count > 1 ? ` (${count})` : ""}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform group-hover:translate-x-0.5 group-hover:opacity-90" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xl border-amber-500/20 bg-zinc-950 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Codex runtime notice</DialogTitle>
          <DialogDescription>
            {count === 1 ? "One occurrence" : `${count} occurrences`}. Sensitive values and local
            paths are redacted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="text-sm font-medium text-amber-100">{notice.message}</div>
            {notice.method ? (
              <div className="mt-1 font-mono text-[11px] text-amber-100/55">{notice.method}</div>
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
                      {occurrence.detail ?? "Codex did not provide additional detail."}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              Codex did not provide additional detail for this notice.
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
  const snapshot = record(response.rateLimits);
  const rateLimits: NonNullable<ContextUsageSnapshot["rateLimits"]> = [];
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
      label:
        typeof snapshot.limitName === "string" && key === "primary" ? snapshot.limitName : fallback,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    });
  }
  const rawCredits = record(snapshot.credits);
  const credits =
    Object.keys(rawCredits).length > 0
      ? {
          ...(typeof rawCredits.balance === "string" ? { balance: rawCredits.balance } : {}),
          ...(typeof rawCredits.hasCredits === "boolean"
            ? { hasCredits: rawCredits.hasCredits }
            : {}),
          ...(typeof rawCredits.unlimited === "boolean" ? { unlimited: rawCredits.unlimited } : {}),
        }
      : undefined;
  return {
    rateLimits,
    ...(credits ? { credits } : {}),
  };
}

export function CodexRuntimePanel({
  health,
  runtime,
  openNoticeId,
  onOpenNoticeChange,
}: {
  health: unknown;
  runtime?: NativeAgentRuntimeSummary;
  openNoticeId: string | null;
  onOpenNoticeChange: (noticeId: string | null) => void;
}) {
  const notices = runtimeNoticeGroups(health, runtime);
  if (runtime) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Metric label="MCP" value={String(runtime.mcpServers ?? 0)} />
          <Metric label="Skills" value={String(runtime.skills ?? 0)} />
          <Metric label="Hooks" value={String(runtime.hooks ?? 0)} />
        </div>
        <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
          <span>{runtime.state ?? "state unavailable"}</span>
          <span>{runtime.version ? `Codex ${runtime.version}` : "version unavailable"}</span>
        </div>
        {notices.length > 0 ? (
          <div className="space-y-1.5">
            {notices.map((notice) => {
              const noticeId = `${notice.method ?? "notice"}\u0000${notice.message}`;
              return (
                <RuntimeNoticeCard
                  key={noticeId}
                  notice={notice}
                  noticeId={noticeId}
                  openNoticeId={openNoticeId}
                  onOpenNoticeChange={onOpenNoticeChange}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }
  if (!health) {
    return <div className="text-xs text-muted-foreground">Loading Codex runtime…</div>;
  }
  const snapshot = record(health);
  const engine = record(snapshot.engine);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="MCP" value={String(inventoryCount(snapshot.mcp))} />
        <Metric label="Skills" value={String(inventoryCount(snapshot.skills))} />
        <Metric label="Hooks" value={String(inventoryCount(snapshot.hooks))} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>{typeof engine.state === "string" ? engine.state : "state unavailable"}</span>
        <span>
          {typeof engine.codexVersion === "string"
            ? `Codex ${engine.codexVersion}`
            : "version unavailable"}
        </span>
      </div>
      {notices.length > 0 ? (
        <div className="space-y-1.5">
          {notices.map((notice) => {
            const noticeId = `${notice.method ?? "notice"}\u0000${notice.message}`;
            return (
              <RuntimeNoticeCard
                key={noticeId}
                notice={notice}
                noticeId={noticeId}
                openNoticeId={openNoticeId}
                onOpenNoticeChange={onOpenNoticeChange}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Runtime facts for an agent with no bespoke panel of its own.
 *
 * Every count is optional because the neutral summary is assembled from
 * whatever the provider volunteered: Grok advertises its MCP servers, its
 * commands and its version, Cursor only its commands. Rendering a missing count
 * as "0" would report an absence of servers rather than an absence of an
 * answer, so unknown fields are omitted instead.
 */
export function AgentRuntimePanel({
  runtime,
  providerLabel,
}: {
  runtime: NativeAgentRuntimeSummary | undefined;
  providerLabel: string;
}) {
  const metrics = (
    [
      ["MCP", runtime?.mcpServers],
      ["Commands", runtime?.commands],
      ["Skills", runtime?.skills],
      ["Hooks", runtime?.hooks],
    ] as const
  ).flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: String(value) }]));

  if (metrics.length === 0 && !runtime?.state && !runtime?.version) {
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
    </div>
  );
}

export type AgentInfoUsageSnapshot = Omit<ContextUsageSnapshot, "totalTokens" | "percentUsed"> & {
  totalTokens?: number;
  percentUsed?: number;
};

export function CursorAccountUsagePanel({
  result,
  loading,
}: {
  result: CursorUsageResult | null;
  loading: boolean;
}) {
  if (loading && !result) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-4 py-4 text-sm text-muted-foreground">
        Loading Cursor account usage…
      </div>
    );
  }
  if (!result) return null;
  if (!result.ok) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-3">
        <div className="text-xs font-medium text-amber-100/90">Account usage unavailable</div>
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {result.message}
        </div>
      </div>
    );
  }

  const account = result.data;
  const limits: AgentRateLimitWindow[] = [
    ...(account.internalPercentages?.totalPercentUsed === undefined
      ? []
      : [
          {
            label: "Cursor quota",
            usedPercent: account.internalPercentages.totalPercentUsed,
            ...(account.cycle.endsAt ? { resetsAt: account.cycle.endsAt } : {}),
          },
        ]),
    ...(account.included.usedPercent === undefined
      ? []
      : [
          {
            label: "Included allowance",
            usedPercent: account.included.usedPercent,
            ...(account.cycle.endsAt ? { resetsAt: account.cycle.endsAt } : {}),
          },
        ]),
    ...account.buckets.flatMap((bucket) =>
      bucket.usedPercent === undefined
        ? []
        : [
            {
              label: bucket.label,
              usedPercent: bucket.usedPercent,
              ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}),
            },
          ],
    ),
  ];
  const hasMoney =
    account.included.usedCents !== undefined ||
    account.included.remainingCents !== undefined ||
    account.included.limitCents !== undefined ||
    account.onDemand?.usedCents !== undefined ||
    account.onDemand?.individualLimitCents !== undefined ||
    account.onDemand?.pooledLimitCents !== undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            Cursor account
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {account.plan ?? "Current billing cycle"}
          </div>
        </div>
        {account.cycle.endsAt ? (
          <div className="max-w-[13rem] text-right text-[10px] text-muted-foreground">
            Resets {formatResetDateTime(account.cycle.endsAt)}
          </div>
        ) : null}
      </div>

      {hasMoney ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          {account.included.usedCents !== undefined ? (
            <Metric label="Included used" value={formatCents(account.included.usedCents)} />
          ) : null}
          {account.included.remainingCents !== undefined ? (
            <Metric
              label="Included left"
              value={formatCents(account.included.remainingCents)}
              {...(account.included.remainingCents < 0 ? { detail: "over allowance" } : {})}
            />
          ) : null}
          {account.included.limitCents !== undefined ? (
            <Metric label="Included limit" value={formatCents(account.included.limitCents)} />
          ) : null}
          {account.onDemand?.usedCents !== undefined ? (
            <Metric label="On-demand" value={formatCents(account.onDemand.usedCents)} />
          ) : null}
          {account.onDemand?.individualLimitCents !== undefined ? (
            <Metric
              label="Spend limit"
              value={formatCents(account.onDemand.individualLimitCents)}
              detail={account.onDemand.limitType}
            />
          ) : account.onDemand?.pooledLimitCents !== undefined ? (
            <Metric
              label="Pooled limit"
              value={formatCents(account.onDemand.pooledLimitCents)}
              detail={account.onDemand.limitType}
            />
          ) : null}
        </div>
      ) : null}

      {limits.length > 0 ? <RateLimitsSection rateLimits={limits} /> : null}
      <div className="border-t border-border/60 pt-3 text-right text-[10px] text-muted-foreground">
        Cursor dashboard · refreshed {new Date(account.source.retrievedAt).toLocaleTimeString()}
      </div>
    </div>
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
        {usage.credits !== undefined ? (
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

      {displayedRateLimits && displayedRateLimits.length > 0 ? (
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
