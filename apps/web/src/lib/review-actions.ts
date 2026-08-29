import {
  MULTI_REVIEW_ADDRESS_PROMPT,
  multiReviewCustomFixPrompt as multiReviewCustomFixPromptFromProtocol,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

export const ADDRESS_ALL_REVIEW_PROMPT = MULTI_REVIEW_ADDRESS_PROMPT;

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
