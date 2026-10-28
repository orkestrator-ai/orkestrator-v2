import { CheckCircle2, Circle, CircleHelp, XCircle } from "lucide-react";
import type { AcceptanceCriterionStatus } from "@orkestrator/protocol/ticket-sections";
import { cn } from "@/lib/utils";

/** A criterion's newest result, or `unchecked` when Verify has not judged it. */
export type CriterionState = AcceptanceCriterionStatus | "unchecked";

export const CRITERION_STATES: Record<
  CriterionState,
  { label: string; icon: typeof Circle; className: string }
> = {
  passed: { label: "Passed", icon: CheckCircle2, className: "text-emerald-500" },
  failed: { label: "Failed", icon: XCircle, className: "text-destructive" },
  "not-checked": { label: "Not checked", icon: CircleHelp, className: "text-amber-500" },
  unchecked: { label: "Not verified yet", icon: Circle, className: "text-muted-foreground/60" },
};

export function CriterionStatusIcon({ state }: { state: CriterionState }) {
  const { label, icon: Icon, className } = CRITERION_STATES[state];
  return <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-label={label} role="img" />;
}

export function criterionStateLabel(state: CriterionState): string {
  return CRITERION_STATES[state].label;
}
