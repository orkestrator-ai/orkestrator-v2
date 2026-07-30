import { describe, expect, test } from "bun:test";
import type {
  ReviewOverallRisk,
  ReviewVerdictReady,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { structuredReviewVerdictSummary } from "./structured-review-summary";

function reportWithCounts(
  issueCount: number,
  coverageGapCount: number,
): StructuredReviewReport {
  return {
    ...TEST_STRUCTURED_REVIEW_REPORT,
    issues: Array.from(
      { length: issueCount },
      () => TEST_STRUCTURED_REVIEW_REPORT.issues[0]!,
    ),
    testCoverageGaps: Array.from(
      { length: coverageGapCount },
      () => TEST_STRUCTURED_REVIEW_REPORT.testCoverageGaps[0]!,
    ),
  };
}

describe("structuredReviewVerdictSummary", () => {
  test("uses plural labels when a report has no findings", () => {
    const report = reportWithCounts(0, 0);

    expect(structuredReviewVerdictSummary(report)).toBe(
      "Ready: with-fixes · 0 issues · 0 coverage gaps · medium risk",
    );
  });

  test("uses singular labels for exactly one issue and coverage gap", () => {
    const report = reportWithCounts(1, 1);

    expect(structuredReviewVerdictSummary(report)).toBe(
      "Ready: with-fixes · 1 issue · 1 coverage gap · medium risk",
    );
  });

  test("uses plural labels for multiple issues and coverage gaps", () => {
    const report = reportWithCounts(2, 3);

    expect(structuredReviewVerdictSummary(report)).toBe(
      "Ready: with-fixes · 2 issues · 3 coverage gaps · medium risk",
    );
  });

  test("includes every supported readiness verdict verbatim", () => {
    const readinessValues: ReviewVerdictReady[] = ["yes", "with-fixes", "no"];

    for (const ready of readinessValues) {
      const report = reportWithCounts(0, 0);
      report.verdict = { ...report.verdict, ready };

      expect(structuredReviewVerdictSummary(report)).toStartWith(
        `Ready: ${ready} ·`,
      );
    }
  });

  test("includes every supported overall risk verbatim", () => {
    const risks: ReviewOverallRisk[] = ["low", "medium", "high"];

    for (const overallRisk of risks) {
      const report = reportWithCounts(0, 0);
      report.riskProfile = { ...report.riskProfile, overallRisk };

      expect(structuredReviewVerdictSummary(report)).toEndWith(
        `· ${overallRisk} risk`,
      );
    }
  });

  test("does not mutate the report while deriving its summary", () => {
    const report = reportWithCounts(2, 3);
    const issues = report.issues;
    const coverageGaps = report.testCoverageGaps;
    const verdict = report.verdict;
    const riskProfile = report.riskProfile;

    structuredReviewVerdictSummary(report);

    expect(report.issues).toBe(issues);
    expect(report.testCoverageGaps).toBe(coverageGaps);
    expect(report.verdict).toBe(verdict);
    expect(report.riskProfile).toBe(riskProfile);
  });
});
