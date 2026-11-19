import { createContext, useContext } from "react";
import type { PlanRevisionIndex } from "@/lib/plan-revisions";

/**
 * What the agent tab lets the plan card for its current plan do. Present only
 * while the provider's plan review applies (Cursor plan mode, idle); a card
 * never decides on its own that a plan may be implemented.
 */
export interface PlanCardActions {
  /** The only plan these actions apply to. */
  planKey: string;
  pending: boolean;
  /** Asks the agent to implement the plan identified by `planKey`. */
  implement: (planKey: string, title: string | undefined) => Promise<void> | void;
  /** Leaves plan mode without asking for anything. */
  switchToBuild: () => Promise<void> | void;
}

export interface PlanCardScope {
  index: PlanRevisionIndex;
  actions?: PlanCardActions;
}

/** Provided by the native agent tab; absent in previews and nested transcripts. */
export const PlanCardScopeContext = createContext<PlanCardScope | null>(null);

export function usePlanCardScope(): PlanCardScope | null {
  return useContext(PlanCardScopeContext);
}
