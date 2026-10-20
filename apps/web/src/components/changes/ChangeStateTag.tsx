import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import { changeReason } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";

/** The backend reason key that marks a measurement as still in progress. */
export const PROVISIONAL_REASON_KEY = "changes.reason.provisional";

/** True when the backend marked this projection provisional (a live, unfinished measurement). */
export function isProvisionalProjection(projection: ChangeProjection): boolean {
  return projection.reasonKeys.includes(PROVISIONAL_REASON_KEY);
}

/**
 * "Live" for a provisional projection, "Final" for a settled ready/partial
 * one, otherwise the backend's own state word (stale, unavailable, …).
 * Presentation only: the decision comes from the projection's reason keys
 * and state. `showReason` spells out the provisional reason inline so a live
 * measurement never reads as a finished one.
 */
export function ChangeStateTag({
  projection,
  showReason = false,
  className,
}: {
  projection: ChangeProjection;
  showReason?: boolean;
  className?: string;
}) {
  const provisional = isProvisionalProjection(projection);
  const interrupted = projection.reasonKeys.includes("changes.reason.interrupted");
  const text = interrupted
    ? "Interrupted"
    : provisional
      ? "Live"
      : projection.state === "ready" || projection.state === "partial"
        ? "Final"
        : projection.state.charAt(0).toUpperCase() + projection.state.slice(1);
  const reason = interrupted
    ? changeReason("changes.reason.interrupted")
    : provisional
      ? changeReason(PROVISIONAL_REASON_KEY)
      : null;
  return (
    <span
      data-testid="change-state-tag"
      data-change-state={provisional ? "live" : projection.state}
      title={reason ?? undefined}
      className={cn(
        "flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide",
        provisional ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        className,
      )}
    >
      {provisional ? (
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      <span>{text}</span>
      {showReason && reason ? (
        <span className="normal-case tracking-normal">— {reason}</span>
      ) : null}
    </span>
  );
}
