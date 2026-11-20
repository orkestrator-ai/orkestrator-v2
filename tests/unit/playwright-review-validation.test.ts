import { describe, expect, test } from "bun:test";
import {
  REVIEW_VALIDATION_DEADLINE_MARGIN_MS,
  REVIEW_VALIDATION_MIN_GLOBAL_TIMEOUT_MS,
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
    expect(reviewValidationRunOptions("line", review(), NOW)).toEqual({ reporter: "list" });
  });

  test("a future deadline stops the run a margin before the worker kills it", () => {
    expect(reviewValidationRunOptions("line", review(String(NOW + 1_200_000)), NOW)).toEqual({
      reporter: "list",
      globalTimeout: 1_200_000 - REVIEW_VALIDATION_DEADLINE_MARGIN_MS,
    });
  });

  test("a deadline too close for the margin still leaves the minimum run", () => {
    for (const remaining of [1, REVIEW_VALIDATION_DEADLINE_MARGIN_MS, 100_000]) {
      expect(
        reviewValidationRunOptions("line", review(String(NOW + remaining)), NOW).globalTimeout,
      ).toBe(REVIEW_VALIDATION_MIN_GLOBAL_TIMEOUT_MS);
    }
  });

  test.each(["", "soon", "12.5", "-5", "1e15", "Infinity", String(NOW), String(NOW - 1)])(
    "an unusable or past deadline %p sets no global timeout",
    (deadline) => {
      expect(reviewValidationRunOptions("line", review(deadline), NOW)).toEqual({
        reporter: "list",
      });
    },
  );
});
