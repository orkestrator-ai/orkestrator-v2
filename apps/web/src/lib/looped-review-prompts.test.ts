import { describe, expect, test } from "bun:test";
import {
  createDiscoveryPrompt,
  createFixPoolPrompt,
  createLoopedReviewPrPrompt,
  createReconciliationPrompt,
  createReviewPackagePrompt,
  REVIEW_PACKAGE_JSON_SCHEMA,
} from "./looped-review-prompts";
import type { ReviewPackage } from "@/stores/loopedReviewStore";
import type {
  ReviewFindingPool,
  StructuredReviewReport,
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

describe("looped-review prompts", () => {
  test("prepares one complete immutable package with safety and ticket context", () => {
    const prompt = createReviewPackagePrompt({
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
    expect(prompt).toContain("complete `origin/develop...HEAD` diff");
    expect(prompt).toContain("Do not silently truncate");
    expect(prompt).toContain("Structured reviews");
    expect(REVIEW_PACKAGE_JSON_SCHEMA.required).toContain("completeDiff");
    expect(REVIEW_PACKAGE_JSON_SCHEMA.required).toContain("validation");
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
