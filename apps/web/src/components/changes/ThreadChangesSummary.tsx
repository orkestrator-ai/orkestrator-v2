import { GitCompare } from "lucide-react";
import type { ChangeDiffTarget } from "@/types/paneLayout";
import { useChangeProjection } from "@/hooks/useChangeProjection";
import { projectionTitle } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";
import { ChangeCountBadge } from "./ChangeCountBadge";
import { ChangeStateTag } from "./ChangeStateTag";

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
  const diffIdentityId = projection.detail?.diffIdentityId ?? null;
  const canOpen = Boolean(diffIdentityId && onOpenDiff);
  const content = (
    <>
      <GitCompare aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">{THREAD_CHANGES_TITLE}</span>
      <ChangeCountBadge projection={projection} testId="thread-changes-badge" />
      <ChangeStateTag projection={projection} />
    </>
  );
  const classes = cn(
    "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground",
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
