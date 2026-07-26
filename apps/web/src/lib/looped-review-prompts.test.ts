import { describe, expect, test } from "bun:test";
import {
  createDiscoveryPrompt,
  createFixPoolPrompt,
  createLoopedReviewPrPrompt,
  createReconciliationPrompt,
  createReviewPreparationPrompt,
  LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
} from "./looped-review-prompts";
import type { ReviewPackage } from "@/stores/loopedReviewStore";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  type ReviewFindingPool,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";

const reviewPackage: ReviewPackage = {
  id: "package-1",
  round: 1,
  preparedAt: "2026-07-25T00:00:00.000Z",
  targetBranch: "main",
  baseRef: "base",
  headRef: "head",
  commit: null,
  completeDiff: "diff --git a/a.ts b/a.ts",
  changedFiles: [],
  validation: [],
  skippedFiles: [],
  uncommittedFiles: [],
  limitations: [],
};

const emptyReport: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "base",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "Impact",
  },
  riskProfile: {
    changeTypes: [],
    riskAreas: [],
    overallRisk: "low",
    reasoning: "Low risk",
  },
  testResults: { total: 0, passed: 0, failed: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Clean" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

const emptyPool: ReviewFindingPool = { issues: [], coverageGaps: [] };

function assertOpenAiStrictCompatible(schema: unknown): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return;
  }
  const record = schema as Record<string, unknown>;
  expect(record).not.toHaveProperty("minLength");
  expect(record).not.toHaveProperty("uniqueItems");

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
      child.forEach((entry) => assertOpenAiStrictCompatible(entry));
    } else {
      assertOpenAiStrictCompatible(child);
    }
  }
}

describe("looped-review prompts", () => {
  test("uses the OpenAI strict subset recursively for every workflow output", () => {
    for (const schema of [
      REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
      LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA,
      REVIEW_FIX_RESULT_JSON_SCHEMA,
      REVIEW_PR_RESULT_JSON_SCHEMA,
    ]) {
      assertOpenAiStrictCompatible(schema);
    }
  });

  test("prepares deterministic validation artifacts for backend package generation", () => {
    const prompt = createReviewPreparationPrompt({
      round: 2,
      packageId: "package-2",
      targetBranch: "develop",
      context: {
        ticketTitle: "Structured reviews",
        comments: ["Keep inactive tabs safe"],
        imageNames: ["flow.png"],
        projectNotes: "Use Bun.",
      },
    });
    expect(prompt).toContain("Run the project's relevant full tests, typechecking, and build validation exactly once");
    expect(prompt).toContain("Orkestrator's backend—not you—will deterministically generate");
    expect(prompt).toContain(".orkestrator/review-artifacts/package-2");
    expect(prompt).toContain("without cleanup, redaction, summarization, or truncation");
    expect(prompt).toContain("Do not include Git refs, diffs, hashes, or file contents");
    expect(prompt).toContain("Structured reviews");
    expect(REVIEW_PREPARATION_RESULT_JSON_SCHEMA.required).toContain("validation");
    expect(REVIEW_PREPARATION_RESULT_JSON_SCHEMA.required).not.toContain("completeDiff");
  });

  test("discovery consumes the immutable package without rebuilding it", () => {
    const prompt = createDiscoveryPrompt({
      reviewPackage,
      reviewInstruction: "Pay special attention to recovery.",
    });
    expect(prompt).toContain("Do not modify files, commit, run git, run tests, typecheck, build");
    expect(prompt).toContain("Pay special attention to recovery.");
    expect(prompt).toContain(reviewPackage.completeDiff);
  });

  test("reconciliation uses the same report and stable-ID pool contract", () => {
    const prompt = createReconciliationPrompt({ report: emptyReport, pool: emptyPool });
    expect(prompt).toContain("same retained review-session context");
    expect(prompt).toContain("Orkestrator assigns IDs");
    expect(prompt).toContain("every report issue in issueOutcomes");
    expect(prompt).toContain("explicit existing outcome");
  });

  test("fix and PR prompts preserve the complete pool and existing PR workflow", () => {
    expect(createFixPoolPrompt({ pool: emptyPool, targetBranch: "main" }))
      .toContain("Complete active pool");
    const pr = createLoopedReviewPrPrompt("release");
    expect(pr).toContain("origin/release");
    expect(pr).toContain("final fresh session");
  });
});
