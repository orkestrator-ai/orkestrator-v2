import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getReviewPromptValidationError,
  parseReviewPrompt,
  REVIEW_PROMPT_MAX_LENGTH,
  ReviewPromptValidationError,
} from "../../../packages/protocol/src/review-prompt";

describe("review prompt protocol validation", () => {
  test("accepts an omitted prompt and preserves valid prompt whitespace", () => {
    expect(parseReviewPrompt(undefined)).toBeUndefined();
    expect(parseReviewPrompt("  Review {{targetBranch}}.  ")).toBe(
      "  Review {{targetBranch}}.  ",
    );
  });

  test("accepts the maximum length and rejects longer prompts", () => {
    expect(parseReviewPrompt("x".repeat(REVIEW_PROMPT_MAX_LENGTH))).toHaveLength(
      REVIEW_PROMPT_MAX_LENGTH,
    );
    expect(getReviewPromptValidationError("x".repeat(REVIEW_PROMPT_MAX_LENGTH + 1)))
      .toContain("100,000 characters or fewer");
  });

  test("rejects blank and non-string prompt values with a typed error", () => {
    for (const invalid of [" \n\t ", null, 123, {}, []]) {
      expect(() => parseReviewPrompt(invalid)).toThrow(ReviewPromptValidationError);
    }
    expect(getReviewPromptValidationError("  ")).toContain("cannot be empty");
    expect(getReviewPromptValidationError(123)).toContain("must be a string");
  });

  test("publishes the review-prompt contract from the protocol package", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../packages/protocol/package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.["./review-prompt"]).toBe("./src/review-prompt.ts");
  });
});
