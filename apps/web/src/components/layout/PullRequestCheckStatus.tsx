import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

function getCheckStatus(checkSummary: PrCheckSummary) {
  const failed = checkSummary.total - checkSummary.passed - checkSummary.pending;
  const state = checkSummary.pending > 0 ? "running" : failed > 0 ? "failed" : "passed";
  const announcement =
    failed > 0
      ? `${checkSummary.passed} of ${checkSummary.total} CI checks passed; ${failed} failed${checkSummary.pending > 0 ? `; ${checkSummary.pending} still running` : "; all checks complete"}`
      : checkSummary.pending > 0
        ? `${checkSummary.passed} of ${checkSummary.total} CI checks passed; ${checkSummary.pending} still running`
        : `${checkSummary.passed} of ${checkSummary.total} CI checks passed; all checks complete`;

  return { announcement, state } as const;
}

export function PullRequestCheckStatus({
  checkSummary,
  className,
}: {
  checkSummary: PrCheckSummary;
  className?: string;
}) {
  const { state } = getCheckStatus(checkSummary);
  const StatusIcon = state === "failed" ? XCircle : state === "running" ? Loader2 : CheckCircle2;

  return (
    <span
      aria-hidden="true"
      data-state={state}
      data-pr-check-status="visual"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 tabular-nums",
        state === "failed"
          ? "text-red-600 dark:text-red-400"
          : state === "running"
            ? "text-amber-700 dark:text-amber-400"
            : "text-green-600 dark:text-green-400",
        className,
      )}
    >
      <StatusIcon
        data-status-icon={state}
        className={cn("size-3 shrink-0", state === "running" && "animate-spin")}
      />
      ({checkSummary.passed}/{checkSummary.total})
    </span>
  );
}

export function PullRequestCheckStatusAnnouncement({
  checkSummary,
}: {
  checkSummary: PrCheckSummary;
}) {
  const { announcement, state } = getCheckStatus(checkSummary);

  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-state={state}
      className="sr-only"
    >
      {announcement}
    </span>
  );
}
