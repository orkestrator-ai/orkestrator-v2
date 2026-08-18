import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getReviewInstructionValidationError,
  getReviewPromptValidationError,
  parseReviewInstruction,
  parseReviewPrompt,
  REVIEW_INSTRUCTION_MAX_LENGTH,
  REVIEW_INSTRUCTION_RECOMMENDED_LENGTH,
  ReviewInstructionValidationError,
  ReviewPromptValidationError,
} from "../../../packages/protocol/src/review-prompt";

describe("review instruction protocol validation", () => {
  test("accepts an omitted instruction and preserves valid whitespace", () => {
    expect(parseReviewInstruction(undefined)).toBeUndefined();
    expect(parseReviewInstruction("  Review {{targetBranch}}.  ")).toBe(
      "  Review {{targetBranch}}.  ",
    );
  });

  test("accepts the maximum length and rejects longer instructions", () => {
    expect(parseReviewInstruction("x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH))).toHaveLength(
      REVIEW_INSTRUCTION_MAX_LENGTH,
    );
    expect(
      getReviewInstructionValidationError("x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH + 1)),
    ).toContain("100,000 characters or fewer");
  });

  test("rejects blank and non-string values with a typed error", () => {
    for (const invalid of [" \n\t ", null, 123, {}, []]) {
      expect(() => parseReviewInstruction(invalid)).toThrow(ReviewInstructionValidationError);
    }
    expect(getReviewInstructionValidationError("  ")).toContain("cannot be empty");
    expect(getReviewInstructionValidationError(123)).toContain("must be a string");
  });

  test("publishes the review-instruction contract and legacy export path", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../packages/protocol/package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.["./review-instruction"]).toBe("./src/review-prompt.ts");
    expect(packageJson.exports?.["./review-prompt"]).toBe("./src/review-prompt.ts");
  });

  test("keeps the recommended length advisory rather than a validation boundary", () => {
    expect(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH).toBe(8_000);
    expect(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH).toBeLessThan(REVIEW_INSTRUCTION_MAX_LENGTH);
    // Legacy instructions may exceed it, so exceeding it must still validate.
    expect(
      getReviewInstructionValidationError("x".repeat(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH + 1)),
    ).toBeNull();
    expect(
      parseReviewInstruction("x".repeat(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH + 1)),
    ).toHaveLength(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH + 1);
  });

  test("publishes the recommended length on the review-instruction entry point", async () => {
    // GlobalSettings imports it from this specifier, not the source path.
    const entryPoint = await import("@orkestrator/protocol/review-instruction");

    expect(entryPoint.REVIEW_INSTRUCTION_RECOMMENDED_LENGTH).toBe(
      REVIEW_INSTRUCTION_RECOMMENDED_LENGTH,
    );
  });

  test("keeps deprecated validation aliases behaviorally compatible", () => {
    expect(ReviewPromptValidationError).toBe(ReviewInstructionValidationError);
    expect(getReviewPromptValidationError).toBe(getReviewInstructionValidationError);
    expect(parseReviewPrompt).toBe(parseReviewInstruction);
    expect(parseReviewPrompt("Review main.")).toBe("Review main.");
    expect(() => parseReviewPrompt("   ")).toThrow(ReviewPromptValidationError);
  });
});
