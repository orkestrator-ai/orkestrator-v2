/**
 * Multi Review's turns as one table: what each step submits and the workspace
 * boundary it runs under.
 *
 * The service and the interactive Fix dispatch take their turn options and
 * result kinds from here. The built-in Multi Review template
 * (`@orkestrator/protocol/graphs/builtins`) describes the same steps, and
 * `graph-builtin-templates.test.ts` pins the two together: a change here
 * fails that test until the template says the same.
 */
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  type AgentInteractionPolicy,
} from "@orkestrator/protocol/agent-interactions";
import type { MultiReviewStepKind } from "@orkestrator/protocol/multi-review";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";

/** The stages of a review, in the order it meets them. */
export const MULTI_REVIEW_STAGE_KEYS = [
  "prepare",
  "validation",
  "reviewer",
  "consolidate",
  "fix",
  "pr",
] as const;
export type MultiReviewStageKey = (typeof MULTI_REVIEW_STAGE_KEYS)[number];

export interface MultiReviewStepTurn {
  /** The workflow result the step's turn submits. */
  result: WorkflowResultKind;
  /**
   * A report turn under the read-only mutation boundary, without provider
   * planning; otherwise a writable build-mode turn.
   */
  readOnly: boolean;
}

/**
 * The structured steps on the shared preparation/consolidation session, and
 * the structured Fix of records from before the interactive Fix.
 */
export const MULTI_REVIEW_STEP_TURNS: Readonly<Record<MultiReviewStepKind, MultiReviewStepTurn>> =
  Object.freeze({
    prepare: Object.freeze({ result: "validation-plan", readOnly: false }),
    consolidate: Object.freeze({ result: "consolidated-review", readOnly: true }),
    fix: Object.freeze({ result: "fix-result", readOnly: false }),
  });

/** Each reviewer submits one structured report, in a read-only plan-mode turn over the package. */
export const MULTI_REVIEW_REVIEWER_RESULT_KIND: WorkflowResultKind = "review-report";

export function multiReviewStepResultKind(step: MultiReviewStepKind): WorkflowResultKind {
  return MULTI_REVIEW_STEP_TURNS[step].result;
}

/** The provider turn options of a structured step. */
export function multiReviewStepTurnOptions(step: MultiReviewStepKind): {
  mode: "build";
  readOnly: boolean;
} {
  return { mode: "build", readOnly: MULTI_REVIEW_STEP_TURNS[step].readOnly };
}

/**
 * The default Fix: an ordinary interactive tab in build mode that the user can
 * talk to. It submits no typed result; its handoff turn finishing on its own
 * is the proof of completion that queues an automatic pull request.
 */
export const MULTI_REVIEW_INTERACTIVE_FIX: Readonly<{
  mode: "build";
  interactionPolicy: AgentInteractionPolicy;
}> = Object.freeze({ mode: "build", interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY });
