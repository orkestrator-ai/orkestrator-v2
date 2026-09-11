import {
  MULTI_REVIEW_ADDRESS_USER_INSTRUCTION,
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
  multiReviewCustomFixPrompt as multiReviewCustomFixPromptFromProtocol,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

/** Generic review tabs do not inherit Multi Review's automated prompt contracts. */
export const ADDRESS_ALL_REVIEW_PROMPT = `${MULTI_REVIEW_ADDRESS_USER_INSTRUCTION}\n\n${MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION}`;

/**
 * Gives a fresh custom-fix session the report context that a resumed
 * consolidation session already owns. The complete report crosses the
 * boundary so the fix transcript can render the same durable reference beneath
 * the prompt; the continuation still scopes the requested work to actionable
 * issues and coverage gaps.
 */
export function multiReviewCustomFixPrompt(
  report: StructuredReviewReport,
  instruction: string,
): string {
  return multiReviewCustomFixPromptFromProtocol(report, instruction);
}
