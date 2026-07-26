import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatStructuredReviewReport,
  isReviewFindingPool,
  isReviewReconciliation,
  isStructuredReviewReport,
  parseReviewFindingPool,
  parseReviewReconciliation,
  parseStructuredReviewReport,
  REVIEW_FINDING_POOL_JSON_SCHEMA,
  REVIEW_RECONCILIATION_JSON_SCHEMA,
  ReviewContractValidationError,
  safeParseReviewFindingPool,
  safeParseReviewReconciliation,
  safeParseStructuredReviewReport,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  type ReviewFindingPool,
  type ReviewReconciliation,
  type StructuredReviewReport,
} from "../../../packages/protocol/src/structured-review";

const emptyReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "No relevant changes were present.",
    before: "The repository was unchanged.",
    after: "The repository remains unchanged.",
    keyCodeChanges: [],
    userImpact: "There is no user-visible effect.",
  },
  riskProfile: {
    changeTypes: [],
    riskAreas: [],
    overallRisk: "low",
    reasoning: "No change was available to assess.",
  },
  testResults: {
    total: 0,
    passed: 0,
    failed: 0,
    failures: [],
  },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: {
    ready: "yes",
    reasoning: "There are no reviewed changes requiring fixes.",
  },
  summaryOfChange: "No relevant change was found.",
  reviewSummary: "No high-confidence issues were found in the reviewed scope.",
} satisfies StructuredReviewReport;

const fullyPopulatedReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: {
      sha: "d34db33f",
      subject: "feat(review): add structured reports",
    },
    filesReviewed: [
      "packages/protocol/src/structured-review.ts",
      "apps/web/src/components/review/StructuredReview.tsx",
    ],
    filesSkipped: [
      {
        file: "apps/web/dist/index.js",
        reason: "Generated build output.",
      },
    ],
    filesLeftUncommitted: [
      {
        file: ".env.local",
        reason: "May contain credentials.",
      },
    ],
    commandsRun: [
      {
        command: "bun test tests/unit/protocol --parallel",
        result: "failed",
        summary: "One review-renderer assertion failed.",
      },
    ],
    commandsNotRun: [
      {
        command: "bun run e2e",
        reason: "A browser binary is unavailable in this environment.",
      },
    ],
    limitations: ["External provider behavior was not exercised."],
  },
  whatChanged: {
    overview:
      "Native reviews now return one provider-independent structured report.",
    before: "Review output was accepted only as nearby Markdown transcript text.",
    after: "Provider results are validated before the report is displayed.",
    keyCodeChanges: [
      {
        file: "packages/protocol/src/structured-review.ts",
        line: 1,
        description: "Exports the shared review contract.",
      },
      {
        file: "apps/web/src/components/review/StructuredReview.tsx",
        line: null,
        description: "Renders validated reports.",
      },
    ],
    userImpact: "Users get consistent, readable reviews from each native agent.",
  },
  riskProfile: {
    changeTypes: ["feature", "test"],
    riskAreas: ["public-api", "llm"],
    overallRisk: "medium",
    reasoning: "Every native review integration consumes the new contract.",
  },
  testResults: {
    total: 2,
    passed: 1,
    failed: 1,
    failures: [
      {
        testName: "shows evidence",
        file: "StructuredReview.test.tsx",
        errorMessage: "Expected evidence text to be visible.",
      },
    ],
  },
  strengths: [
    {
      description: "The protocol is independent of provider SDK types.",
      file: "packages/protocol/src/structured-review.ts",
      line: 1,
    },
  ],
  issues: [
    {
      severity: "P1",
      confidence: 94,
      category: "correctness",
      title: "A malformed result can advance the workflow",
      file: "apps/web/src/stores/review.ts",
      line: 82,
      symbol: "completeReview",
      description:
        "The completion branch records success before validating the result.",
      evidence: "completeReview sets phase to completed before calling parse.",
      suggestion: "Validate first and persist success only after parsing succeeds.",
      verification:
        "Return malformed provider data and assert that the workflow pauses.",
      alternativeFixes: [
        "Validate in the bridge before sending completion.",
        "Make completion accept only a branded validated result.",
      ],
    },
    {
      severity: "P2",
      confidence: 81,
      category: "testing",
      title: "Module-level state recovery has no test",
      file: "apps/web/src/stores/review.ts",
      line: null,
      symbol: "",
      description: "The recovery path is not directly exercised.",
      evidence: "The test suite contains no persisted snapshot fixture.",
      suggestion: "Add a remount test using a persisted workflow snapshot.",
      verification: "Run the focused store suite.",
    },
  ],
  testCoverageGaps: [
    {
      file: "apps/web/src/stores/review.ts",
      untestedBehavior: "Recovery after malformed structured output.",
    },
  ],
  verdict: {
    ready: "with-fixes",
    reasoning: "Validation ordering must be fixed before completion is safe.",
  },
  summaryOfChange:
    "The change introduces a fixed structured contract for native reviews. It also adds a readable report renderer.",
  reviewSummary:
    "One high-confidence correctness issue and one coverage weakness were found.",
} satisfies StructuredReviewReport;

const findingPool = {
  issues: [
    {
      poolId: "issue-001",
      ...fullyPopulatedReport.issues[0],
    },
  ],
  coverageGaps: [
    {
      poolId: "gap-001",
      ...fullyPopulatedReport.testCoverageGaps[0],
    },
  ],
} satisfies ReviewFindingPool;

const reconciliation = {
  newIssues: [fullyPopulatedReport.issues[1]],
  issueUpdates: [
    {
      poolId: "issue-001",
      finding: {
        ...fullyPopulatedReport.issues[0],
        confidence: 98,
        evidence: "A second pass confirmed the ordering from a persisted snapshot.",
      },
    },
  ],
  newCoverageGaps: [],
  coverageGapUpdates: [
    {
      poolId: "gap-001",
      finding: {
        file: "apps/web/src/stores/review.ts",
        untestedBehavior:
          "Recovery after malformed output and after a renderer remount.",
      },
    },
  ],
} satisfies ReviewReconciliation;

describe("structured review report contract", () => {
  test("publishes the contract as a resolvable protocol package export", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "packages/protocol/package.json"), "utf8"),
    ) as { exports: Record<string, string> };

    expect(packageJson.exports["./structured-review"]).toBe(
      "./src/structured-review.ts",
    );
    expect(
      Bun.resolveSync(
        "@orkestrator/protocol/structured-review",
        join(process.cwd(), "apps/web"),
      ),
    ).toBe(join(process.cwd(), "packages/protocol/src/structured-review.ts"));
  });

  test("accepts a complete report with empty finding and activity lists", () => {
    expect(parseStructuredReviewReport(emptyReport)).toBe(emptyReport);
    expect(safeParseStructuredReviewReport(emptyReport)).toEqual({
      success: true,
      data: emptyReport,
    });
    expect(isStructuredReviewReport(emptyReport)).toBe(true);
  });

  test("accepts every fully populated report field and optional fixes", () => {
    const parsed = parseStructuredReviewReport(fullyPopulatedReport);

    expect(parsed).toBe(fullyPopulatedReport);
    expect(parsed.issues[0]?.alternativeFixes).toHaveLength(2);
    expect(parsed.whatChanged.keyCodeChanges[1]?.line).toBeNull();
    expect(parsed.reviewScope.commit?.sha).toBe("d34db33f");
  });

  test("rejects plaintext, incomplete, incompatible, and unknown data with typed errors", () => {
    for (const invalid of [
      "## Review Scope\nA plaintext report",
      null,
      [],
      {},
      { ...emptyReport, reviewSummary: undefined },
      { ...emptyReport, unexpectedSection: "accepted by accident" },
      {
        ...emptyReport,
        issues: [
          {
            ...fullyPopulatedReport.issues[0],
            confidence: 101,
          },
        ],
      },
      {
        ...emptyReport,
        testResults: {
          total: 2,
          passed: 2,
          failed: 1,
          failures: [],
        },
      },
    ]) {
      expect(() => parseStructuredReviewReport(invalid)).toThrow(
        ReviewContractValidationError,
      );
      expect(isStructuredReviewReport(invalid)).toBe(false);
    }

    const result = safeParseStructuredReviewReport({
      ...emptyReport,
      verdict: { ready: "maybe", reasoning: "Unknown verdict." },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ReviewContractValidationError);
      expect(result.error.contract).toBe("structured-review-report");
      expect(result.error.issues).toContainEqual({
        path: "$.verdict.ready",
        code: "invalid_value",
        message: "Expected one of yes, with-fixes, no.",
      });
    }
  });

  test("defines strict portable JSON Schema for every report section", () => {
    expect(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.required).toEqual([
      "reviewScope",
      "whatChanged",
      "riskProfile",
      "testResults",
      "strengths",
      "issues",
      "testCoverageGaps",
      "verdict",
      "summaryOfChange",
      "reviewSummary",
    ]);
    expect(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.issues.items.properties
        .confidence,
    ).toEqual({ type: "integer", minimum: 0, maximum: 100 });
    expect(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.issues.items.required,
    ).toContain("alternativeFixes");
    expect(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.issues.items.properties
        .alternativeFixes,
    ).toEqual({
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
    });
    expect(() => JSON.stringify(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA)).not.toThrow();
  });

  test("keeps optional alternative fixes ergonomic after strict wire validation", () => {
    const parsed = parseStructuredReviewReport({
      ...emptyReport,
      issues: [{
        severity: "P2",
        confidence: 80,
        category: "maintainability",
        title: "Consider an alternative",
        file: "src/review.ts",
        line: null,
        symbol: "",
        description: "The provider used the strict-schema null sentinel.",
        evidence: "The wire value is null.",
        suggestion: "Keep the domain field optional.",
        verification: "Parse the report.",
        alternativeFixes: null,
      }],
    });

    expect(parsed.issues[0]).not.toHaveProperty("alternativeFixes");
  });
});

function assertOpenAiStrictCompatible(
  schema: unknown,
  path = "$",
): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return;
  }
  const record = schema as Record<string, unknown>;
  expect(record).not.toHaveProperty("uniqueItems");
  expect(record).not.toHaveProperty("minLength");

  if (record.type === "object") {
    const properties = record.properties as Record<string, unknown> | undefined;
    expect(record.additionalProperties).toBe(false);
    expect(new Set(record.required as string[] | undefined)).toEqual(
      new Set(Object.keys(properties ?? {})),
    );
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "enum") continue;
    if (Array.isArray(child)) {
      child.forEach((entry, index) =>
        assertOpenAiStrictCompatible(entry, `${path}.${key}[${index}]`),
      );
    } else {
      assertOpenAiStrictCompatible(child, `${path}.${key}`);
    }
  }
}

test("all provider-facing review schemas use the OpenAI strict subset recursively", () => {
  for (const schema of [
    STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
    REVIEW_FINDING_POOL_JSON_SCHEMA,
    REVIEW_RECONCILIATION_JSON_SCHEMA,
  ]) {
    assertOpenAiStrictCompatible(schema);
  }
});

describe("structured review readable formatting", () => {
  test("renders an empty report in the established section order", () => {
    const output = formatStructuredReviewReport(emptyReport);
    const headings = output
      .split("\n")
      .filter((line) => line.startsWith("## "));

    expect(headings).toEqual([
      "## Review Scope",
      "## What Changed",
      "## Risk Profile",
      "## Test Results",
      "## Strengths",
      "## Issues",
      "## Test Coverage Gaps",
      "## Verdict",
      "## Summary of change",
      "## Review summary",
    ]);
    expect(output).toContain(
      "No high-confidence issues were found in the reviewed scope.",
    );
    expect(output).toContain("- Commit created: None.");
    expect(output).not.toContain('"reviewScope"');
  });

  test("renders complete issue, coverage, evidence, and verification details", () => {
    const output = formatStructuredReviewReport(fullyPopulatedReport);

    for (const expected of [
      "### 1. [P1][conf:94][correctness]",
      "#### A malformed result can advance the workflow",
      "- File: apps/web/src/stores/review.ts:82",
      "- Symbol: completeReview",
      "- Evidence: completeReview sets phase to completed before calling parse.",
      "- Suggestion: Validate first and persist success only after parsing succeeds.",
      "- Verification: Return malformed provider data and assert that the workflow pauses.",
      "- Alternative fixes:",
      "apps/web/src/stores/review.ts — Recovery after malformed structured output.",
      "- Ready: with-fixes",
      "One high-confidence correctness issue and one coverage weakness were found.",
    ]) {
      expect(output).toContain(expected);
    }
    expect(output).not.toContain(JSON.stringify(fullyPopulatedReport));
  });

  test("validates unknown renderer input instead of formatting partial data", () => {
    expect(() =>
      formatStructuredReviewReport({
        ...emptyReport,
        issues: "No issues",
      }),
    ).toThrow(ReviewContractValidationError);
  });
});

describe("pooled finding and reconciliation contracts", () => {
  test("validates empty and populated pools with stable IDs", () => {
    expect(parseReviewFindingPool({ issues: [], coverageGaps: [] })).toEqual({
      issues: [],
      coverageGaps: [],
    });
    expect(parseReviewFindingPool(findingPool)).toBe(findingPool);
    expect(safeParseReviewFindingPool(findingPool).success).toBe(true);
    expect(isReviewFindingPool(findingPool)).toBe(true);
    expect(REVIEW_FINDING_POOL_JSON_SCHEMA.required).toEqual([
      "issues",
      "coverageGaps",
    ]);
  });

  test("rejects empty and duplicate stable pool IDs across finding kinds", () => {
    const duplicate = {
      issues: findingPool.issues,
      coverageGaps: [
        {
          ...findingPool.coverageGaps[0],
          poolId: "issue-001",
        },
      ],
    };
    const invalidId = {
      issues: [{ ...findingPool.issues[0], poolId: "" }],
      coverageGaps: [],
    };

    for (const invalid of [duplicate, invalidId]) {
      const result = safeParseReviewFindingPool(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ReviewContractValidationError);
        expect(result.error.contract).toBe("review-finding-pool");
      }
    }
  });

  test("distinguishes new findings from updates referencing stable pool IDs", () => {
    expect(parseReviewReconciliation(reconciliation)).toBe(reconciliation);
    expect(safeParseReviewReconciliation(reconciliation).success).toBe(true);
    expect(isReviewReconciliation(reconciliation)).toBe(true);
    expect(reconciliation.newIssues[0]).not.toHaveProperty("poolId");
    expect(reconciliation.issueUpdates[0]?.poolId).toBe("issue-001");
    expect(REVIEW_RECONCILIATION_JSON_SCHEMA.required).toEqual([
      "newIssues",
      "issueUpdates",
      "newCoverageGaps",
      "coverageGapUpdates",
    ]);
  });

  test("rejects incomplete and conflicting reconciliation operations", () => {
    const missingPoolId = {
      ...reconciliation,
      issueUpdates: [{ finding: fullyPopulatedReport.issues[0] }],
    };
    const duplicateUpdate = {
      ...reconciliation,
      issueUpdates: [
        reconciliation.issueUpdates[0],
        reconciliation.issueUpdates[0],
      ],
    };
    const duplicateAcrossKinds = {
      ...reconciliation,
      coverageGapUpdates: [
        {
          ...reconciliation.coverageGapUpdates[0],
          poolId: "issue-001",
        },
      ],
    };

    for (const invalid of [missingPoolId, duplicateUpdate, duplicateAcrossKinds]) {
      expect(() => parseReviewReconciliation(invalid)).toThrow(
        ReviewContractValidationError,
      );
      expect(isReviewReconciliation(invalid)).toBe(false);
    }
  });
});
