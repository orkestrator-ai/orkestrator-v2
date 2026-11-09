import { GitCompare } from "lucide-react";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { useChangeProjection } from "@/hooks/useChangeProjection";
import { projectionTitle } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";
import { ChangeCountBadge } from "./ChangeCountBadge";
import { ChangeStateTag, isProvisionalProjection } from "./ChangeStateTag";

export const THREAD_CHANGES_TITLE = "Thread changes";

/**
 * Compact `thread-net` summary for the current thread segment: the backend
 * badge, live/final state and the projection's own tooltip. Clicking opens
 * the immutable historical diff when the backend named a detail identity.
 * Renders nothing until the backend has answered for the resource.
 */
export function ThreadChangesSummary({
  resourceKey,
  onOpenDiff,
  className,
}: {
  resourceKey: string;
  onOpenDiff?: (title: string, target: ChangeDiffTarget) => void;
  className?: string;
}) {
  const projection = useChangeProjection(resourceKey);
  if (!projection) return null;
  const title = projectionTitle(projection);
  const provisional = isProvisionalProjection(projection);
  const noFileChanges =
    !projection.badge.visible &&
    (projection.state === "ready" || projection.state === "partial") &&
    projection.counters.changedFiles === 0 &&
    projection.hasFileChanges === false;
  const compactFinal =
    !provisional &&
    projection.state === "ready" &&
    projection.coverageState === "complete" &&
    projection.observationState === "fresh" &&
    !projection.reasonKeys.includes("changes.reason.interrupted");
  const diffIdentityId = projection.detail?.diffIdentityId ?? null;
  const canOpen = Boolean(diffIdentityId && onOpenDiff);
  const content = (
    <>
      <GitCompare aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only @2xl:not-sr-only">{THREAD_CHANGES_TITLE}</span>
      <ChangeCountBadge projection={projection} testId="thread-changes-badge" />
      {noFileChanges ? (
        // The system's own account of the turn, so "I didn't change any files"
        // is never only the model's word for it.
        <span data-testid="thread-changes-none" className="shrink-0">
          No file changes
        </span>
      ) : null}
      {/* A settled "Final" gives way on narrow panes; abnormal and incomplete states always show. */}
      <span aria-hidden="true" className={cn(compactFinal && "hidden @md:inline")}>
        ·
      </span>
      <ChangeStateTag projection={projection} className={cn(compactFinal && "hidden @md:flex")} />
    </>
  );
  const classes = cn(
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs text-muted-foreground",
    canOpen && "hover:bg-elevated hover:text-foreground",
    className,
  );
  if (!canOpen || !diffIdentityId || !onOpenDiff) {
    return (
      <span data-testid="thread-changes-summary" title={title} className={classes}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="thread-changes-summary"
      title={title}
      className={classes}
      onClick={() =>
        onOpenDiff(THREAD_CHANGES_TITLE, {
          kind: "historical",
          diffIdentityId,
          title: THREAD_CHANGES_TITLE,
        })
      }
    >
      {content}
    </button>
  );
}
