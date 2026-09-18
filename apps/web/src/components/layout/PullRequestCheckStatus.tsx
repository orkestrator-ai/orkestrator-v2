import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { cn } from "@/lib/utils";

export function PullRequestCheckStatus({
  checkSummary,
  isGrid = false,
}: {
  checkSummary: PrCheckSummary;
  isGrid?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={
        checkSummary.pending > 0
          ? `${checkSummary.passed} of ${checkSummary.total} CI checks passed; ${checkSummary.pending} still running`
          : `${checkSummary.passed} of ${checkSummary.total} CI checks passed; all checks complete`
      }
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-lg border bg-transparent px-3 text-sm font-medium",
        checkSummary.pending > 0
          ? "border-orange-500 text-orange-600 dark:text-orange-400"
          : checkSummary.passed === checkSummary.total
            ? "border-green-600 text-green-600 dark:text-green-400"
            : "border-red-600 text-red-600 dark:text-red-400",
        isGrid && "px-2.5 text-xs",
      )}
    >
      {checkSummary.passed}/{checkSummary.total} checks
      <span className="sr-only">
        {checkSummary.pending > 0
          ? `; ${checkSummary.pending} still running`
          : "; all checks complete"}
      </span>
    </div>
  );
}
