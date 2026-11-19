import { GitCommitHorizontal, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Label } from "@/components/ui/label";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type { LaunchBaseState } from "@/lib/launch-base";
import { cn } from "@/lib/utils";

/**
 * The "Base" row of the create dialog: the exact commit a new local
 * environment starts from, how current it is, and a way to read it again.
 */
export function LaunchBaseRow({
  state,
  onRefresh,
  disabled,
  now,
}: {
  state: LaunchBaseState;
  onRefresh: () => void;
  disabled?: boolean;
  /** For tests; the current time otherwise. */
  now?: Date;
}) {
  if (state.status === "idle") return null;
  return (
    <div
      className="shrink-0 border-t border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6"
      data-testid="launch-base-row"
    >
      <Label className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0">Base</Label>
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        role="status"
        aria-live="polite"
      >
        <LaunchBaseStatus state={state} now={now} />
        {(state.status === "unavailable" ||
          (state.status === "ready" && state.freshness === "last-fetched")) && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onRefresh}
            disabled={disabled}
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function LaunchBaseStatus({
  state,
  now,
}: {
  state: Exclude<LaunchBaseState, { status: "idle" }>;
  now?: Date;
}) {
  if (state.status === "resolving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Refreshing the base branch…
      </span>
    );
  }
  if (state.status === "unavailable") {
    return <span className="min-w-0 text-muted-foreground">{state.reason}</span>;
  }
  const lastFetched = state.freshness === "last-fetched";
  const detail =
    state.freshness === "fresh"
      ? state.fetchedAt
        ? `fetched ${formatRelativeTime(state.fetchedAt, now)}`
        : "fetched just now"
      : state.freshness === "local"
        ? "local branch, no remote"
        : state.fetchedAt
          ? `last fetched ${formatRelativeTime(state.fetchedAt, now)}; the remote could not be refreshed`
          : "last-fetched revision; the remote could not be refreshed";
  return (
    <>
      <span
        className={cn(
          "inline-flex min-w-0 flex-wrap items-center gap-1.5 font-mono",
          lastFetched ? "text-amber-400" : "text-foreground",
        )}
      >
        {lastFetched ? (
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <GitCommitHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{state.ref}</span>
        <span aria-hidden="true">@</span>
        {/* The whole commit is the reproducible input, so all of it is shown. */}
        <span className="select-all break-all" data-commit={state.commit}>
          {state.commit}
        </span>
      </span>
      <span className={cn(lastFetched ? "text-amber-400/80" : "text-muted-foreground")}>
        {detail}
      </span>
    </>
  );
}
