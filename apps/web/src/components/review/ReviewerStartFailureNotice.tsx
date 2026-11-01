import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { reviewerStartFailureNotice, type ReviewerStartFailure } from "./multi-review-steps";

/**
 * Names the reviewers whose agent could not start, with why, above a review's
 * graph. A failed node alone is easy to miss, and the review carries on with
 * the reviewers that did start.
 */
export function ReviewerStartFailureNotice({
  failures,
  panelSize,
  onShow,
  className,
}: {
  failures: readonly ReviewerStartFailure[];
  panelSize: number;
  /** Selects the first reviewer that could not start. */
  onShow?: () => void;
  className?: string;
}) {
  const notice = reviewerStartFailureNotice(failures, panelSize);
  if (!notice) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="reviewer-start-failures"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{notice.headline}</p>
        <ul className="mt-1 space-y-0.5 text-xs leading-relaxed break-words text-muted-foreground">
          {notice.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      {onShow ? (
        <button
          type="button"
          className="shrink-0 text-xs text-amber-500 underline-offset-2 hover:underline"
          onClick={onShow}
        >
          Show reviewer
        </button>
      ) : null}
    </section>
  );
}
