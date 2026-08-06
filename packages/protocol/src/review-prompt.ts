/**
 * Review instructions can contain a migrated legacy prompt, so the existing
 * limit is intentionally retained. The instruction is embedded inside
 * Orkestrator's fixed review framing and never replaces that framing.
 */
export const REVIEW_INSTRUCTION_MAX_LENGTH = 100_000;

/**
 * Legacy instructions may exceed this, so it is advisory rather than a
 * validation boundary. Keeping new instructions concise reduces repeated
 * context cost, especially across looped-review discovery passes.
 */
export const REVIEW_INSTRUCTION_RECOMMENDED_LENGTH = 8_000;

export class ReviewInstructionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInstructionValidationError";
  }
}

export function getReviewInstructionValidationError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return "Review instruction must be a string.";
  }
  if (value.trim().length === 0) {
    return "Review instruction cannot be empty. Enter an instruction or reset to the default.";
  }
  if (value.length > REVIEW_INSTRUCTION_MAX_LENGTH) {
    return `Review instruction must be ${REVIEW_INSTRUCTION_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  }
  return null;
}

export function parseReviewInstruction(value: unknown): string | undefined {
  const error = getReviewInstructionValidationError(value);
  if (error) throw new ReviewInstructionValidationError(error);
  return value as string | undefined;
}

/** @deprecated Use REVIEW_INSTRUCTION_MAX_LENGTH. */
export const REVIEW_PROMPT_MAX_LENGTH = REVIEW_INSTRUCTION_MAX_LENGTH;
/** @deprecated Use ReviewInstructionValidationError. */
export const ReviewPromptValidationError = ReviewInstructionValidationError;
/** @deprecated Use getReviewInstructionValidationError. */
export const getReviewPromptValidationError = getReviewInstructionValidationError;
/** @deprecated Use parseReviewInstruction. */
export const parseReviewPrompt = parseReviewInstruction;
