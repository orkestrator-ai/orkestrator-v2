import { expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { CONSOLIDATED_REVIEW_EXAMPLE } from "./review-consolidation-example.js";
import { consolidationScopeLists } from "./review-consolidation-scope.js";
import { DISPUTED_CHECK_REASON, disputedReviewChecks } from "./review-disputed-checks.js";
import {
  consolidationResultContext,
  deriveConsolidatedProvenance,
} from "./review-fanout-provenance.js";
import { validateWorkflowResult } from "./workflow-result-contracts.js";

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

const CHECK = 'bun test --test-name-pattern "two  spaces"';
const result = (command: string, outcome: "passed" | "failed") => ({
  command,
  result: outcome,
  summary: "Observed test outcome.",
});
const passed = reportWith({ commandsRun: [result(CHECK, "passed")] });
const failed = reportWith({ commandsRun: [result(CHECK, "failed")] });
const reviewers = [reviewer("r1", passed), reviewer("r2", failed)];

test("handles missing scope and distinguishes quoted whitespace", () => {
  expect(disputedReviewChecks([{} as StructuredReviewReport, passed])).toEqual(new Set());
  const other = reportWith({ commandsRun: [result(CHECK.replace("  ", " "), "failed")] });
  expect(disputedReviewChecks([passed, other])).toEqual(new Set());
  expect(disputedReviewChecks([passed, failed])).toEqual(new Set([CHECK]));
  expect(consolidationScopeLists([passed, other])).toBeDefined();
});

test("identifies long commands and disagreements beyond the display cap", () => {
  const commands = [...Array.from({ length: 10 }, (_, i) => `cmd ${i}`), "x".repeat(4096)];
  const reports = [
    reportWith({ commandsRun: commands.map((command) => result(command, "passed")) }),
    reportWith({ commandsRun: commands.map((command) => result(command, "failed")) }),
  ];
  expect(disputedReviewChecks(reports)).toEqual(new Set(commands));
  const derived = deriveConsolidatedProvenance(
    reports[0]!,
    reports.map((report, index) => reviewer(String(index), report)),
  );
  expect(derived.report.reviewScope.commandsRun).toEqual([]);
  expect(derived.report.reviewScope.commandsNotRun.map((entry) => entry.command)).toEqual(commands);
});

test("reviewer-written text cannot become a rerun instruction even with checkout drift", () => {
  const command = "unregistered command";
  const contradictory = reportWith({
    commandsRun: [result(command, "passed"), result(command, "failed")],
  });
  const prompt = createMultiReviewConsolidationPrompt({
    targetBranch: "main",
    worktreeChangedDuringReview: true,
    reports: [{ reviewerId: "r1", agent: "claude", model: "haiku", report: contradictory }],
  });
  expect(prompt).toContain("there is no rerun during consolidation");
  expect(prompt).toContain("Do not edit files, run validation");
  expect(prompt).not.toContain("Re-run the first disputed check");
  const { report } = deriveConsolidatedProvenance(contradictory, [reviewer("r1", contradictory)]);
  expect(report.reviewScope.commandsRun).toEqual([]);
  expect(report.reviewScope.commandsNotRun).toEqual([{ command, reason: DISPUTED_CHECK_REASON }]);
});

test("the tool contract rejects a disputed claim before acceptance and permits its correction", () => {
  const context = consolidationResultContext(reviewers);
  expect(validateWorkflowResult("consolidated-review", failed, undefined, context)).toContainEqual(
    expect.objectContaining({ path: "$.reviewScope.commandsRun[0]", code: "invalid_value" }),
  );
  const corrected = reportWith({});
  expect(validateWorkflowResult("consolidated-review", corrected, undefined, context)).toEqual([]);
  const { report, issues } = deriveConsolidatedProvenance(corrected, reviewers);
  expect(issues).toEqual([]);
  expect(report.reviewScope.commandsNotRun).toEqual([
    { command: CHECK, reason: DISPUTED_CHECK_REASON },
  ]);
  expect(report.reviewScope.limitations[0]).toContain("remain unverified");
});
