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
  reviewValidationArtifactPaths,
} from "@orkestrator/protocol/review-artifacts";
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
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
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
    expect(prompt).toContain(
      ".orkestrator/review-artifacts/package-2/validation-01.stdout.txt",
    );
    expect(prompt).toContain("Do not return the bare filename.");
    expect(prompt).toContain("counting skipped commands");
    // The prompt must name the exact paths the backend recomputes and compares
    // against, for the second entry as well as the first. Numbering by execution
    // order instead of array position shifts every ordinal after a skip.
    for (const index of [0, 1]) {
      const { stdoutPath, stderrPath } = reviewValidationArtifactPaths(
        "package-2",
        index,
      );
      expect(prompt).toContain(stdoutPath);
      expect(prompt).toContain(stderrPath);
    }
    expect(prompt).toContain(
      ".orkestrator/review-artifacts/package-2/validation-02.stdout.txt",
    );
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
    const fix = createFixPoolPrompt({ pool: emptyPool, targetBranch: "main" });
    expect(fix).toContain("Complete active pool");
    expect(fix).toContain(
      "preserved branch state, disproved findings, and other informational observations in notes",
    );
    expect(fix).toContain("Limitations are blockers only");
    expect(fix).toContain(
      "Set complete=false if any command's final result is failed or limitations is non-empty",
    );
    // A re-run after a repair must be reported once, or the superseded attempt
    // stalls the loop on an already-green worktree.
    expect(fix).toContain(
      "commandsRun records the final state of each validation command, not every attempt",
    );
    expect(REVIEW_FIX_RESULT_JSON_SCHEMA.required).toContain("notes");
    // notes belongs to the fix contract alone; it must not leak into the others.
    for (
      const schema of [
        REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
        REVIEW_PR_RESULT_JSON_SCHEMA,
        LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA,
      ]
    ) {
      expect(schema.required as readonly string[]).not.toContain("notes");
    }
    const pr = createLoopedReviewPrPrompt("release");
    expect(pr).toContain("origin/release");
    expect(pr).toContain("final fresh session");
  });

  test("serializes the complete pool into the fix prompt", () => {
    const pool: ReviewFindingPool = {
      issues: [{
        poolId: "issue-1",
        severity: "P1",
        confidence: 90,
        category: "correctness",
        title: "Lost result",
        file: "src/review.ts",
        line: 42,
        symbol: "applyResult",
        description: "The result can be lost.",
        evidence: "The lease is cleared first.",
        suggestion: "Consume the lease atomically.",
        verification: "Pause before result resolution.",
        alternativeFixes: ["Record the result while paused."],
      }],
      coverageGaps: [{
        poolId: "gap-1",
        file: "src/review.ts",
        untestedBehavior: "The paused result lease.",
      }],
    };
    const prompt = createFixPoolPrompt({ pool, targetBranch: "develop" });

    // The agent fixes from this text alone, so every finding must survive.
    expect(prompt).toContain(JSON.stringify(pool, null, 2));
    expect(prompt).toContain("Target branch: develop");
  });

  test("omits the context block when no ticket context exists", () => {
    const prompt = createReviewPreparationPrompt({
      round: 1,
      packageId: "package-1",
      targetBranch: "main",
    });

    expect(prompt).not.toContain("Available ticket and project context");
    expect(prompt).toContain("## Preparation workflow");
  });
});
