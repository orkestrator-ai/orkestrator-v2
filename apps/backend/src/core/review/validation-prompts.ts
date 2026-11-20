import {
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  reviewValidationDiscoveryBody,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";

// The schema lives with the plan's parser in the protocol, shared with graph types.
export { REVIEW_VALIDATION_PLAN_SCHEMA } from "@orkestrator/protocol/review-workflow";

export function reviewValidationDiscoveryPrompt(targetBranch: string): string {
  return `${REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION}\n\n${wrapSystemInstructions(
    reviewValidationDiscoveryBody(targetBranch),
  )}`;
}

export const IMPLEMENTATION_VALIDATION_HANDOFF =
  "Commit every relevant implementation and test change without bypassing hooks. Run focused checks needed during implementation. The next preparation stage discovers and executes final full validation once against the committed snapshot; do not run a separate full test/typecheck/build pass or prepare validation artifacts here.";
