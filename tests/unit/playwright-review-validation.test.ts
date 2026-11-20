import { describe, expect, test } from "bun:test";
import {
  REVIEW_VALIDATION_DEADLINE_MARGIN_MS,
  REVIEW_VALIDATION_REPORTER,
  reviewValidationRunOptions,
} from "../playwright-review-validation";

const NOW = 1_800_000_000_000;
const review = (deadline?: string): NodeJS.ProcessEnv => ({
  ORKESTRATOR_REVIEW_VALIDATION: "1",
  ...(deadline === undefined ? {} : { ORKESTRATOR_VALIDATION_DEADLINE_MS: deadline }),
});

describe("reviewValidationRunOptions", () => {
  test("a person's run keeps the config's reporter and sets no global timeout", () => {
    expect(reviewValidationRunOptions("line", {}, NOW)).toEqual({ reporter: "line" });
    // A deadline alone does not make a run review validation.
    expect(
      reviewValidationRunOptions(
        [["html"]],
        { ORKESTRATOR_VALIDATION_DEADLINE_MS: String(NOW + 600_000) },
        NOW,
      ),
    ).toEqual({ reporter: [["html"]] });
  });

  test("review validation streams one line per finished test", () => {
    expect(reviewValidationRunOptions("line", review(), NOW)).toEqual({
      reporter: REVIEW_VALIDATION_REPORTER,
    });
  });

  test("a future deadline stops the run a margin before the worker kills it", () => {
    expect(reviewValidationRunOptions("line", review(String(NOW + 1_200_000)), NOW)).toEqual({
      reporter: REVIEW_VALIDATION_REPORTER,
      globalTimeout: 1_200_000 - REVIEW_VALIDATION_DEADLINE_MARGIN_MS,
    });
  });

  test("a short budget leaves a proportional margin, including the second suite", () => {
    const env = review(String(NOW + 60_000));
    expect(reviewValidationRunOptions("line", env, NOW).globalTimeout).toBe(48_000);
    expect(reviewValidationRunOptions("line", env, NOW + 59_000).globalTimeout).toBe(800);
    expect(reviewValidationRunOptions("line", env, NOW + 60_001).globalTimeout).toBe(1);
  });

  test.each(["", "soon", "12.5", "-5", "1e15", "Infinity"])(
    "an unusable deadline %p sets no global timeout",
    (deadline) => {
      expect(reviewValidationRunOptions("line", review(deadline), NOW)).toEqual({
        reporter: REVIEW_VALIDATION_REPORTER,
      });
    },
  );
});
