/**
 * When a plan-usage reading was taken, and whether it is still current enough
 * to trust at a glance. Every Settings card that shows plan usage (the account
 * rows on the Claude and Codex pages, the plan usage card of every provider
 * page, and Settings → Usage) shows its bars through {@link UsageReadingBars}
 * and its age through {@link UsageReadingAge}, so the treatment is the same
 * everywhere (docs/architecture/agent-accounts.md, "Plan usage").
 *
 * A reading past `PLAN_USAGE_DISPLAY_STALE_MS` (30 minutes), or one served as
 * the last known reading after a failed read, is stale: its bars are muted
 * and it carries a "Stale" label. The card's own refresh button reads again.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { AccountQuotaList } from "@/components/layout/AgentInfoButton.panels";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";
import {
  isPlanUsageReadingStale,
  PLAN_USAGE_DISPLAY_STALE_MS,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";

const TICK_MS = 30_000;

/** Now, moving on every half minute so an age and a stale state stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

/** "9 Nov 2026, 14:03" in the reader's locale and time zone. */
export function formatReadingTime(fetchedAt: string): string {
  const date = new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "Updated 9 Nov 2026, 14:03 (3m ago) on beelink", with a "Stale" label once
 * the reading is past the display bound. `snapshot` null means no reading has
 * ever been taken, which it says.
 */
export function UsageReadingAge({
  snapshot,
  now: fixedNow,
  className,
}: {
  snapshot: Pick<PlanUsageSnapshot, "fetchedAt" | "stale" | "readOn" | "message"> | null;
  /** Fixed for tests; otherwise the clock, ticking every half minute. */
  now?: number;
  className?: string;
}) {
  const ticking = useNow();
  const now = fixedNow ?? ticking;
  if (!snapshot) {
    return (
      <p
        className={cn("text-[11px] text-muted-foreground", className)}
        data-testid="usage-reading-age"
      >
        Usage has not been read yet.
      </p>
    );
  }
  const stale = isPlanUsageReadingStale(snapshot, now);
  return (
    <div
      className={cn("space-y-0.5 text-[11px] leading-relaxed", className)}
      data-testid="usage-reading-age"
      data-stale={stale ? "true" : "false"}
    >
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          Updated{" "}
          <time dateTime={snapshot.fetchedAt} title={snapshot.fetchedAt}>
            {formatReadingTime(snapshot.fetchedAt)}
          </time>{" "}
          ({formatRelativeTime(snapshot.fetchedAt, new Date(now))})
          {snapshot.readOn ? (
            <>
              {" "}
              on <span className="font-medium text-foreground">{snapshot.readOn.nodeName}</span>
            </>
          ) : null}
        </span>
        {stale ? (
          <span
            className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
            title={`Older than ${PLAN_USAGE_DISPLAY_STALE_MS / 60_000} minutes, or the last reading kept after a failed one. Refresh to read it again.`}
          >
            Stale
          </span>
        ) : null}
      </p>
      {snapshot.stale && snapshot.message ? (
        <p className="text-muted-foreground/70">{snapshot.message}</p>
      ) : null}
    </div>
  );
}

/** A reading's bars, muted while it is stale, with its age below. */
export function UsageReadingBars({
  snapshot,
  now: fixedNow,
  empty,
}: {
  snapshot: PlanUsageSnapshot;
  now?: number;
  /** Shown instead of bars when the reading has no windows. */
  empty?: ReactNode;
}) {
  const ticking = useNow();
  const now = fixedNow ?? ticking;
  const stale = isPlanUsageReadingStale(snapshot, now);
  return (
    <div className="space-y-2">
      {snapshot.windows.length > 0 ? (
        <div
          className={cn(stale && "opacity-50 saturate-50")}
          data-testid="usage-reading-bars"
          data-stale={stale ? "true" : "false"}
        >
          <AccountQuotaList account={snapshot.windows} />
        </div>
      ) : (
        empty
      )}
      <UsageReadingAge snapshot={snapshot} now={now} />
    </div>
  );
}
