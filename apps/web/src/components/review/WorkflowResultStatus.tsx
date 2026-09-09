import {
  workflowResultSubmissionLabel,
  type WorkflowResultKind,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Projection only. The backend owns the submission lifecycle; this view reads
 * the state it wrote into the workflow snapshot and never polls, cancels, or
 * retries. Acceptance is deliberately presented as "received", not as a pass:
 * a report can be accepted while its verdict is negative, and the backend still
 * has settlement checks to run.
 */
export function WorkflowResultStatus({
  state,
  kind,
  className,
}: {
  state: WorkflowResultSubmissionState | undefined;
  kind: WorkflowResultKind;
  className?: string;
}) {
  if (!state) return null;
  const label = workflowResultSubmissionLabel(state, kind);
  const Icon =
    state === "received" ? CheckCircle2 : state === "needs-attention" ? AlertTriangle : Loader2;
  return (
    <div
      data-testid="workflow-result-status"
      data-state={state}
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground",
        state === "needs-attention" && "text-amber-500",
        className,
      )}
    >
      <Icon
        className={cn(
          "h-3 w-3 shrink-0",
          state === "preparing" || state === "correcting" ? "animate-spin" : "",
        )}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}
