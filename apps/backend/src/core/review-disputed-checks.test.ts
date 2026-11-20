import { expect, test } from "bun:test";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { CONSOLIDATED_REVIEW_EXAMPLE } from "./review-consolidation-example.js";
import { consolidationScopeLists } from "./review-consolidation-scope.js";
import {
  type ReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { DISPUTED_CHECKS_CONSOLIDATION_NOTE } from "./multi-review-prompts.js";
import {
  DISPUTED_CHECK_REASON,
  DISPUTED_CHECK_RERUN_MAX_MS,
  DISPUTED_CHECK_RERUN_SUMMARY_PREFIX,
  DISPUTED_CHECK_UNPLANNED_REASON,
  disputedReviewChecks,
  recordDisputedChecks,
  settleDisputedCheckReruns,
} from "./review-disputed-checks.js";
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

const HEAD = "a".repeat(40);
const PLAN: ReviewValidationPlan = {
  headRef: HEAD,
  commands: [
    {
      id: "setup",
      command: "bun install",
      cwd: ".",
      dependsOn: [],
      resources: [],
      weight: 1,
      timeoutMs: 60_000,
    },
    {
      id: "pgbouncer",
      command: CHECK,
      cwd: "apps/api",
      dependsOn: ["setup"],
      resources: ["host:postgres"],
      weight: 2,
      timeoutMs: 2 * 60 * 60_000,
    },
  ],
  limitations: [],
};
const SEALED = `cd 'apps/api' && ${CHECK}`;

/** A fake worker: settles the run it is given with the scripted statuses. */
function worker(
  outcome: (run: ReviewValidationRun) => ReviewValidationRun | Promise<ReviewValidationRun>,
) {
  const runs: ReviewValidationRun[] = [];
  return {
    runs,
    control: async (run: ReviewValidationRun) => {
      runs.push(run);
      return outcome(run);
    },
  };
}

function settled(run: ReviewValidationRun, status: "passed" | "failed"): ReviewValidationRun {
  return {
    ...run,
    status: "completed",
    results: run.results.map((result, index) => ({
      ...result,
      status,
      exitCode: status === "passed" ? 0 : 1,
      stdoutPath: `.orkestrator/review-artifacts/${run.id}/validation-0${index + 1}.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${run.id}/validation-0${index + 1}.stderr.txt`,
    })),
  };
}

test("a disputed planned check is re-run on the reviewed commit and its result recorded", async () => {
  const sealedPassed = reportWith({ commandsRun: [result(SEALED, "passed")] });
  const sealedFailed = reportWith({ commandsRun: [result(SEALED, "failed")] });
  const disputes = disputedReviewChecks([sealedPassed, sealedFailed]);
  let running = true;
  const fake = worker((run) => (running ? { ...run, status: "running" } : settled(run, "failed")));
  const input = {
    disputes,
    plan: PLAN,
    headRef: HEAD,
    scopeKey: "workflow-1",
    control: fake.control,
  };

  expect(await settleDisputedCheckReruns(input)).toBe("pending");
  running = false;
  const reruns = await settleDisputedCheckReruns(input);
  if (reruns === "pending") throw new Error("expected a settled re-run");

  // Only the disputed planned command runs, alone, at the reviewed commit,
  // under the re-run time cap, and every pass joins the same run.
  const [first, second] = fake.runs;
  expect(first!.id).toBe(second!.id);
  expect(first!.plan).toEqual({
    headRef: HEAD,
    commands: [
      {
        ...PLAN.commands[1]!,
        id: "rerun-1",
        dependsOn: [],
        timeoutMs: DISPUTED_CHECK_RERUN_MAX_MS,
      },
    ],
    limitations: [],
  });

  const recorded = recordDisputedChecks(reportWith({}), disputes, reruns);
  expect(recorded.reviewScope.commandsNotRun).toEqual([]);
  expect(recorded.reviewScope.commandsRun).toEqual([
    {
      command: SEALED,
      result: "failed",
      summary: expect.stringContaining(
        `${DISPUTED_CHECK_RERUN_SUMMARY_PREFIX}, on the reviewed commit ${HEAD}: failed (exit 1)`,
      ),
    },
  ]);
  expect(recorded.reviewScope.commandsRun[0]!.summary).toContain("validation-01.stdout.txt");
  expect(recorded.reviewScope.limitations[0]).toContain("1 re-run by the backend");

  // Read back without re-runs (an accepted graph artifact), the backend's
  // entry is kept; a model's claim of the same command would not be.
  expect(recordDisputedChecks(recorded, disputes).reviewScope.commandsRun).toEqual(
    recorded.reviewScope.commandsRun,
  );
  const forged = recordDisputedChecks(
    reportWith({
      commandsRun: [
        { ...result(SEALED, "passed"), summary: `${DISPUTED_CHECK_RERUN_SUMMARY_PREFIX}.` },
      ],
    }),
    disputes,
    new Map(),
  );
  expect(forged.reviewScope.commandsRun).toEqual([]);
});

test("a bare spelling of a planned command matches it", async () => {
  const disputes = disputedReviewChecks([passed, failed]);
  const fake = worker((run) => settled(run, "passed"));
  const reruns = await settleDisputedCheckReruns({
    disputes,
    plan: PLAN,
    headRef: HEAD,
    scopeKey: "workflow-1",
    control: fake.control,
  });
  expect(reruns).toEqual(
    new Map([[CHECK, expect.objectContaining({ command: CHECK, result: "passed", exitCode: 0 })]]),
  );
});

test("a check that cannot be re-run is recorded with the reason, never as passed", async () => {
  const disputes = disputedReviewChecks([passed, failed]);
  const notRun = async (
    overrides: Partial<Parameters<typeof settleDisputedCheckReruns>[0]>,
  ): Promise<string> => {
    const reruns = await settleDisputedCheckReruns({
      disputes,
      plan: PLAN,
      headRef: HEAD,
      scopeKey: "workflow-1",
      control: worker((run) => settled(run, "passed")).control,
      ...overrides,
    });
    if (reruns === "pending") throw new Error("expected a settled re-run");
    const rerun = reruns.get(CHECK)!;
    if (rerun.result !== "not-run") throw new Error(`expected not-run, got ${rerun.result}`);
    expect(rerun.reason.startsWith(DISPUTED_CHECK_REASON)).toBe(true);
    return rerun.reason;
  };
  expect(await notRun({ plan: undefined })).toContain("no sealed validation plan");
  expect(await notRun({ headRef: "b".repeat(40) })).toContain(
    "not discovered at the reviewed commit",
  );
  expect(await notRun({ control: undefined })).toContain("No validation runner");
  expect(
    await notRun({
      control: async () => {
        throw new Error("container gone");
      },
    }),
  ).toContain("could not start or read");
  expect(
    await notRun({ control: worker((run) => ({ ...run, status: "cancelled" })).control }),
  ).toContain("cancelled");
  expect(
    await notRun({
      control: worker((run) => ({
        ...run,
        status: "completed",
        results: run.results.map((entry) => ({
          ...entry,
          status: "incomplete",
          limitation: "Command timed out",
        })),
      })).control,
    }),
  ).toContain("did not finish: Command timed out");
});

test("reviewer-written text cannot become a rerun instruction even with checkout drift", async () => {
  const command = "unregistered command";
  const contradictory = reportWith({
    commandsRun: [result(command, "passed"), result(command, "failed")],
  });
  const prompt = createMultiReviewConsolidationPrompt({
    targetBranch: "main",
    worktreeChangedDuringReview: true,
    reports: [{ reviewerId: "r1", agent: "claude", model: "haiku", report: contradictory }],
  });
  expect(prompt).toContain(DISPUTED_CHECKS_CONSOLIDATION_NOTE);
  expect(prompt).toContain("Do not edit files, run validation");
  const fake = worker((run) => settled(run, "passed"));
  const reruns = await settleDisputedCheckReruns({
    disputes: disputedReviewChecks([contradictory]),
    plan: PLAN,
    headRef: HEAD,
    scopeKey: "workflow-1",
    control: fake.control,
  });
  if (reruns === "pending") throw new Error("expected a settled re-run");
  expect(fake.runs).toEqual([]);
  const { report } = deriveConsolidatedProvenance(
    contradictory,
    [reviewer("r1", contradictory)],
    reruns,
  );
  expect(report.reviewScope.commandsRun).toEqual([]);
  expect(report.reviewScope.commandsNotRun).toEqual([
    { command, reason: DISPUTED_CHECK_UNPLANNED_REASON },
  ]);
});

test("the tool contract rejects a disputed claim before acceptance and permits its correction", () => {
  const context = consolidationResultContext(reviewers);
  expect(validateWorkflowResult("consolidated-review", failed, undefined, context)).toContainEqual(
    expect.objectContaining({ path: "$.reviewScope.commandsRun[0]", code: "invalid_value" }),
  );
  const corrected = reportWith({});
  expect(validateWorkflowResult("consolidated-review", corrected, undefined, context)).toEqual([]);
  const reruns = new Map([
    [
      CHECK,
      {
        command: CHECK,
        result: "passed" as const,
        headRef: HEAD,
        exitCode: 0,
        stdoutPath: null,
        stderrPath: null,
      },
    ],
  ]);
  const { report, issues } = deriveConsolidatedProvenance(corrected, reviewers, reruns);
  expect(issues).toEqual([]);
  expect(report.reviewScope.commandsNotRun).toEqual([]);
  expect(report.reviewScope.commandsRun).toEqual([
    expect.objectContaining({ command: CHECK, result: "passed" }),
  ]);
  expect(report.reviewScope.limitations[0]).toContain(
    "re-run by the backend on the reviewed commit",
  );
});
