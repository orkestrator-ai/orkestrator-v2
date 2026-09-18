import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function PullRequestCheckStatus({
  checkSummary,
  isGrid = false,
}: {
  checkSummary: PrCheckSummary;
  isGrid?: boolean;
}) {
  const failed = checkSummary.total - checkSummary.passed - checkSummary.pending;
  const state = failed > 0 ? "failed" : checkSummary.pending > 0 ? "running" : "passed";
  const StatusIcon = state === "failed" ? XCircle : state === "running" ? Loader2 : CheckCircle2;

  return (
    <div
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
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-transparent px-3 text-sm font-medium",
        state === "failed"
          ? "border-red-600 text-red-600 dark:text-red-400"
          : state === "running"
            ? "border-orange-500 text-orange-600 dark:text-orange-400"
            : "border-green-600 text-red-600 dark:text-red-400",
        isGrid && "px-2.5 text-xs",
      )}
    >
      <StatusIcon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", state === "running" && "animate-spin")}
      />
      {checkSummary.passed}/{checkSummary.total} checks
      <span className="sr-only">
        {checkSummary.pending > 0
          ? `; ${checkSummary.pending} still running`
          : "; all checks complete"}
      </span>
    </div>
  );
}
