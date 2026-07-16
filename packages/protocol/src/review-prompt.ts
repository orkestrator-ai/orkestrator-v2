export const REVIEW_PROMPT_MAX_LENGTH = 100_000;

export class ReviewPromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPromptValidationError";
  }
}

export function getReviewPromptValidationError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return "Review prompt must be a string.";
  }
  if (value.trim().length === 0) {
    return "Review prompt cannot be empty. Enter a prompt or reset to the default.";
  }
  if (value.length > REVIEW_PROMPT_MAX_LENGTH) {
    return `Review prompt must be ${REVIEW_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  }
  return null;
}

export function parseReviewPrompt(value: unknown): string | undefined {
  const error = getReviewPromptValidationError(value);
  if (error) throw new ReviewPromptValidationError(error);
  return value as string | undefined;
}
