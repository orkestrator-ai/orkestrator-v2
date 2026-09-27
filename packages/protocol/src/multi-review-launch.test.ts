import { describe, expect, test } from "bun:test";
import {
  multiReviewDuplicateReviewerCount,
  multiReviewDuplicateReviewerGroups,
  multiReviewDuplicateWarning,
  multiReviewWorkEstimate,
  multiReviewWorkSummary,
} from "./multi-review-launch.js";

describe("Multi Review launch facts", () => {
  test("detects exact duplicates by launch identity", () => {
    const reviewers = [
      { agent: "claude", model: "opus", reasoningEffort: "high" },
      { agent: "claude", model: " opus ", reasoningEffort: "high" },
      { agent: "claude", model: "opus", reasoningEffort: "medium" },
      { agent: "codex", model: "opus", reasoningEffort: "high" },
      { agent: "claude", model: "opus", reasoningEffort: "high", fastMode: true },
      { agent: "claude", model: "opus", reasoningEffort: "high" },
    ];
    // Any behaviour-affecting difference — effort, platform, speed — is distinct.
    expect(multiReviewDuplicateReviewerGroups(reviewers)).toEqual([[1, 2, 6]]);
    expect(multiReviewDuplicateReviewerCount(reviewers)).toBe(2);
    expect(multiReviewDuplicateReviewerGroups([reviewers[0]!, reviewers[2]!])).toEqual([]);
  });

  test("an unpinned model differs from the same placeholder pinned", () => {
    expect(
      multiReviewDuplicateReviewerGroups([
        { agent: "claude", model: "default" },
        { agent: "claude", model: "default", modelUnpinned: true },
      ]),
    ).toEqual([]);
  });

  test("warnings are factual and name every position", () => {
    expect(multiReviewDuplicateWarning([1, 2])).toBe(
      "Reviewers 1 and 2 use the same configuration. This may provide a second sample of that configuration, but often produces overlapping findings and approximately two review turns.",
    );
    expect(multiReviewDuplicateWarning([1, 3, 4])).toContain("Reviewers 1, 3 and 4");
    expect(multiReviewDuplicateWarning([1, 3, 4])).toContain("approximately 3 review turns");
  });

  test("the work summary counts turns, not currency", () => {
    const estimate = multiReviewWorkEstimate({ reviewerCount: 3, autoFix: false });
    expect(estimate).toMatchObject({
      reviewerTurns: 3,
      preparationTurns: 1,
      consolidationTurns: 1,
      validationRuns: 1,
      fixTurns: 0,
    });
    const summary = multiReviewWorkSummary(estimate);
    expect(summary).toContain("3 reviewer turns");
    expect(summary).toContain("not included");
    expect(summary).not.toMatch(/[$€£]/);
    expect(
      multiReviewWorkSummary(multiReviewWorkEstimate({ reviewerCount: 1, autoFix: true })),
    ).toContain("1 reviewer turn, and 1 consolidation turn, then 1 fix turn");
  });
});
