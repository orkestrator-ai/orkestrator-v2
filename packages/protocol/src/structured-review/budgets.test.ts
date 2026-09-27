import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_REVIEW_MAX_ISSUES,
  STRUCTURED_REVIEW_MAX_LABEL_BYTES,
  STRUCTURED_REVIEW_MAX_REPORT_BYTES,
  STRUCTURED_REVIEW_MAX_TEXT_BYTES,
  structuredReviewReportBudgetIssues,
} from "./budgets.js";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "./schema.js";
import type { ReviewIssue, StructuredReviewReport } from "./types.js";

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    severity: "P2",
    confidence: 80,
    category: "correctness",
    title: "Issue",
    file: "src/a.ts",
    line: 1,
    symbol: "run",
    description: "Description",
    evidence: "Evidence",
    suggestion: "Suggestion",
    verification: "Verification",
    ...overrides,
  };
}

function report(overrides: Partial<StructuredReviewReport> = {}): StructuredReviewReport {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: null,
      filesReviewed: ["src/a.ts"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Overview",
      before: "Before",
      after: "After",
      keyCodeChanges: [],
      userImpact: "Impact",
    },
    riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low" },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "Ready" },
    summaryOfChange: "Summary",
    reviewSummary: "Review",
    ...overrides,
  };
}

describe("structured review report budgets", () => {
  test("text fields accept the exact limit and reject one byte more", () => {
    expect(
      structuredReviewReportBudgetIssues(
        report({ issues: [issue({ evidence: "x".repeat(STRUCTURED_REVIEW_MAX_TEXT_BYTES) })] }),
      ),
    ).toEqual([]);
    const over = structuredReviewReportBudgetIssues(
      report({ issues: [issue({ evidence: "x".repeat(STRUCTURED_REVIEW_MAX_TEXT_BYTES + 1) })] }),
    );
    expect(over).toHaveLength(1);
    expect(over[0]!.path).toBe("$.issues[0].evidence");
  });

  test("limits are UTF-8 bytes, not characters", () => {
    // Three bytes per character: under the limit in characters, over in bytes.
    const text = "€".repeat(Math.floor(STRUCTURED_REVIEW_MAX_TEXT_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(STRUCTURED_REVIEW_MAX_TEXT_BYTES);
    expect(structuredReviewReportBudgetIssues(report({ reviewSummary: text }))).toHaveLength(1);
  });

  test("labels such as file paths have a tighter bound", () => {
    const path = "a".repeat(STRUCTURED_REVIEW_MAX_LABEL_BYTES + 1);
    expect(
      structuredReviewReportBudgetIssues(report({ issues: [issue({ file: path })] }))[0]?.path,
    ).toBe("$.issues[0].file");
  });

  test("list counts accept the limit and reject one more", () => {
    const atLimit = Array.from({ length: STRUCTURED_REVIEW_MAX_ISSUES }, () => issue());
    expect(structuredReviewReportBudgetIssues(report({ issues: atLimit }))).toEqual([]);
    const over = structuredReviewReportBudgetIssues(report({ issues: [...atLimit, issue()] }));
    expect(over).toEqual([expect.objectContaining({ path: "$.issues", code: "invalid_value" })]);
  });

  test("an oversized report asks for concise regeneration without quoting it", () => {
    const secret = "CONFIDENTIAL-TOKEN ";
    const huge = report({
      strengths: Array.from({ length: 40 }, () => ({
        description: secret.repeat(1_500),
        file: "src/a.ts",
        line: 1,
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(
      STRUCTURED_REVIEW_MAX_REPORT_BYTES,
    );
    const issues = structuredReviewReportBudgetIssues(huge);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("$");
    expect(issues[0]!.message).toContain(String(STRUCTURED_REVIEW_MAX_REPORT_BYTES));
    expect(JSON.stringify(issues)).not.toContain("CONFIDENTIAL");
  });

  test("feedback is bounded even when every field is over budget", () => {
    const big = "x".repeat(STRUCTURED_REVIEW_MAX_TEXT_BYTES + 1);
    const issues = structuredReviewReportBudgetIssues(
      report({ issues: Array.from({ length: 50 }, () => issue({ description: big })) }),
    );
    expect(issues.length).toBeLessThanOrEqual(20);
  });

  test("every bounded list path exists in the provider schema", () => {
    const schema = STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as unknown as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    for (const path of ["issues", "testCoverageGaps", "strengths"]) {
      expect(schema.properties[path]).toBeDefined();
    }
    expect(schema.properties.reviewScope?.properties?.filesReviewed).toBeDefined();
  });
});
