import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { cn } from "@/lib/utils";

export function PullRequestCheckStatus({
  checkSummary,
  className,
}: {
  checkSummary: PrCheckSummary;
  className?: string;
}) {
  const failed = checkSummary.total - checkSummary.passed - checkSummary.pending;
  const state = checkSummary.pending > 0 ? "running" : failed > 0 ? "failed" : "passed";

  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-state={state}
      aria-label={
        failed > 0
          ? `${checkSummary.passed} of ${checkSummary.total} CI checks passed; ${failed} failed${checkSummary.pending > 0 ? `; ${checkSummary.pending} still running` : "; all checks complete"}`
          : checkSummary.pending > 0
            ? `${checkSummary.passed} of ${checkSummary.total} CI checks passed; ${checkSummary.pending} still running`
            : `${checkSummary.passed} of ${checkSummary.total} CI checks passed; all checks complete`
      }
      className={cn(
        "shrink-0 tabular-nums",
        state === "failed"
          ? "text-red-600 dark:text-red-400"
          : state === "running"
            ? "text-yellow-600 dark:text-yellow-400"
            : "text-green-600 dark:text-green-400",
        className,
      )}
    >
      ({checkSummary.passed}/{checkSummary.total})
    </span>
  );
}
