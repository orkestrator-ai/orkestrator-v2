import type { NativeAgentCostSource } from "@orkestrator/protocol/native-agent";
import { ESTIMATED_COST_TITLE } from "@/lib/cost-source";
import { cn } from "@/lib/utils";

/**
 * A formatted dollar amount that says whether it is an estimate.
 *
 * Every place a turn, session or history cost is shown renders it through
 * this, so an estimate reads the same everywhere: a leading `~` and the
 * {@link ESTIMATED_COST_TITLE} tooltip, with the word "estimated" for screen
 * readers instead of the tilde. A provider-billed or unknown amount is the
 * plain amount. `data-cost-source` carries the source for tests and probes.
 */
export function CostAmount({
  amount,
  source,
  className,
}: {
  /** Already formatted, e.g. `$0.12`; formatting differs between surfaces. */
  amount: string;
  source: NativeAgentCostSource | undefined;
  className?: string;
}) {
  if (source !== "estimate") {
    return (
      <span className={className} data-cost-source={source}>
        {amount}
      </span>
    );
  }
  return (
    <span
      className={cn("cursor-help", className)}
      title={ESTIMATED_COST_TITLE}
      data-cost-source="estimate"
    >
      <span aria-hidden="true">~</span>
      {amount}
      <span className="sr-only">, estimated</span>
    </span>
  );
}
