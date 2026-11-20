import { describe, expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { serializeFramedEvidence } from "@orkestrator/protocol/review-evidence-frames";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { CONSOLIDATED_REVIEW_EXAMPLE } from "./review-consolidation-example.js";
import { consolidationScopeLists } from "./review-consolidation-scope.js";
import {
  CONSOLIDATION_RERUN_SUMMARY_PREFIX,
  MAX_DISPUTED_REVIEW_CHECKS,
  disputedCheckResolutionIssues,
  disputedChecksSection,
  disputedReviewChecks,
} from "./review-disputed-checks.js";
import {
  consolidationScopeFilledByBackend,
  deriveConsolidatedProvenance,
} from "./review-fanout-provenance.js";

type Scope = StructuredReviewReport["reviewScope"];

function reportWith(scope: Partial<Scope>): StructuredReviewReport {
  const base = CONSOLIDATED_REVIEW_EXAMPLE as unknown as StructuredReviewReport;
  return {
    ...base,
    issues: [],
    testCoverageGaps: [],
    reviewScope: {
      ...base.reviewScope,
      filesReviewed: ["src/a.ts"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      ...scope,
    },
  };
}

function reviewer(id: string, report: StructuredReviewReport): ReviewerRecord {
  return { id, agent: "claude", model: "haiku", status: "completed", report } as ReviewerRecord;
}

const PGBOUNCER = "bun test ./tests/pgbouncer.test.ts";
const passed = reportWith({
  commandsRun: [
    { command: PGBOUNCER, result: "passed", summary: "4 passed." },
    { command: "bun run typecheck", result: "passed", summary: "Clean." },
  ],
});
const failed = reportWith({
  commandsRun: [
    { command: `  ${PGBOUNCER.replace(" ", "  ")} `, result: "failed", summary: "1 failed." },
    { command: "bun run typecheck", result: "passed", summary: "Clean." },
  ],
});

describe("disputedReviewChecks", () => {
  test("finds a command one reviewer saw pass and another saw fail", () => {
    expect(disputedReviewChecks([passed, failed])).toEqual([
      {
        command: PGBOUNCER,
        results: [
          { reviewer: 1, result: "passed" },
          { reviewer: 2, result: "failed" },
        ],
      },
    ]);
  });

  test("agreeing reviewers and single-reviewer commands are not disputes", () => {
    expect(disputedReviewChecks([passed, passed])).toEqual([]);
    expect(
      disputedReviewChecks([
        passed,
        reportWith({ commandsRun: [{ command: "bun x", result: "failed", summary: "No." }] }),
      ]),
    ).toEqual([]);
  });

  test("bounds the list", () => {
    const commands = Array.from({ length: MAX_DISPUTED_REVIEW_CHECKS + 3 }, (_, i) => `cmd ${i}`);
    const one = reportWith({
      commandsRun: commands.map((command) => ({ command, result: "passed", summary: "ok" })),
    });
    const two = reportWith({
      commandsRun: commands.map((command) => ({ command, result: "failed", summary: "no" })),
    });
    expect(disputedReviewChecks([one, two])).toHaveLength(MAX_DISPUTED_REVIEW_CHECKS);
  });
});

describe("disputedCheckResolutionIssues", () => {
  const disputes = disputedReviewChecks([passed, failed]);

  test("accepts one re-run entry with the marker", () => {
    const report = reportWith({
      commandsRun: [
        {
          command: PGBOUNCER,
          result: "failed",
          summary: `${CONSOLIDATION_RERUN_SUMMARY_PREFIX} 1 of 4 failed (connection refused).`,
        },
      ],
    });
    expect(disputedCheckResolutionIssues(report, disputes)).toEqual([]);
  });

  test("accepts a check listed once as not re-run", () => {
    const report = reportWith({
      commandsNotRun: [{ command: PGBOUNCER, reason: "Needs a database this session lacks." }],
    });
    expect(disputedCheckResolutionIssues(report, disputes)).toEqual([]);
  });

  test("refuses an unresolved, duplicated or unmarked dispute", () => {
    expect(disputedCheckResolutionIssues(reportWith({}), disputes)).toMatchObject([
      { path: "$.reviewScope.commandsRun", code: "missing_field" },
    ]);
    expect(
      disputedCheckResolutionIssues(
        reportWith({
          commandsRun: [...passed.reviewScope.commandsRun, failed.reviewScope.commandsRun[0]!],
        }),
        disputes,
      ),
    ).toMatchObject([{ path: "$.reviewScope.commandsRun[0]", code: "invalid_value" }]);
    expect(
      disputedCheckResolutionIssues(
        reportWith({
          commandsRun: [{ command: PGBOUNCER, result: "failed", summary: "1 failed." }],
        }),
        disputes,
      ),
    ).toMatchObject([{ path: "$.reviewScope.commandsRun[0].summary", code: "invalid_value" }]);
  });
});

describe("consolidation with a disputed check", () => {
  const reviewers = [reviewer("r1", passed), reviewer("r2", failed)];

  test("the backend does not fill the scope lists in", () => {
    expect(consolidationScopeLists([passed, failed])).toBeUndefined();
    expect(consolidationScopeFilledByBackend(reviewers)).toBe(false);
    expect(consolidationScopeLists([passed, passed])).toBeDefined();
  });

  test("the prompt asks for one re-run and every scope list", () => {
    const prompt = createMultiReviewConsolidationPrompt({
      targetBranch: "main",
      reports: reviewers.map((entry) => ({
        reviewerId: entry.id,
        agent: entry.agent,
        model: entry.model,
        report: entry.report!,
      })),
      scopeFilledByBackend: true,
    });
    expect(prompt).toContain("## Disputed checks");
    expect(prompt).toContain("Re-run the first disputed check once");
    expect(prompt).toContain(CONSOLIDATION_RERUN_SUMMARY_PREFIX);
    expect(prompt).toContain("and the one disputed-check re-run below");
    expect(prompt).not.toContain("The backend fills in");
  });

  test("an undisputed panel gets the prompt it got before", () => {
    const prompt = createMultiReviewConsolidationPrompt({
      targetBranch: "main",
      reports: [passed, passed].map((report, index) => ({
        reviewerId: `r${index}`,
        agent: "claude",
        model: "haiku",
        report,
      })),
    });
    expect(prompt).not.toContain("Disputed checks");
    expect(prompt).not.toContain("disputed-check re-run");
    expect(disputedChecksSection([], serializeFramedEvidence)).toBe("");
  });

  test("provenance refuses a consolidated report that leaves the dispute open", () => {
    const unresolved = deriveConsolidatedProvenance(
      reportWith({ commandsRun: [{ command: PGBOUNCER, result: "failed", summary: "1 failed." }] }),
      reviewers,
    );
    expect(unresolved.issues.map((issue) => issue.path)).toEqual([
      "$.reviewScope.commandsRun[0].summary",
    ]);
    const resolved = deriveConsolidatedProvenance(
      reportWith({
        commandsRun: [
          {
            command: PGBOUNCER,
            result: "passed",
            summary: `${CONSOLIDATION_RERUN_SUMMARY_PREFIX} 4 passed on re-run.`,
          },
        ],
      }),
      reviewers,
    );
    expect(resolved.issues).toEqual([]);
  });
});
