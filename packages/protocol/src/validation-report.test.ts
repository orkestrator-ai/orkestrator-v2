import { describe, expect, test } from "bun:test";
import {
  isReviewValidationPlan,
  REVIEW_VALIDATION_PLAN_SCHEMA,
  type ReviewValidationPlan,
} from "./review-validation.js";
import {
  validationFailureKey,
  type TriagedValidationFailure,
  type ValidationFailureReason,
  type ValidationFailureTriage,
} from "./validation-failure-triage.js";
import {
  buildValidationReport,
  CHANGED_TESTS_NOTE_NO_PLAN,
  CHANGED_TESTS_NOTE_NONE_PLANNED,
  CHANGED_TESTS_NOTE_UNMATCHED,
  isValidationReport,
  renderValidationReportMarkdown,
  validationReportFailureLabel,
} from "./validation-report.js";

const headRef = "b".repeat(40);
const mergeBase = "a".repeat(40);

function planCommand(
  id: string,
  command: string,
  scope?: "changed" | "general",
): ReviewValidationPlan["commands"][number] {
  return {
    id,
    command,
    cwd: ".",
    dependsOn: [],
    resources: [],
    weight: 1,
    timeoutMs: 60_000,
    ...(scope ? { scope } : {}),
  };
}

const plan: ReviewValidationPlan = {
  headRef,
  commands: [
    planCommand("changed", "bun test src/pairing.test.ts", "changed"),
    planCommand("suite", "mise run test", "general"),
    planCommand("types", "mise run typecheck", "general"),
  ],
  limitations: [],
};

const validation = [
  { command: "cd . && bun test src/pairing.test.ts", status: "passed" as const, exitCode: 0 },
  { command: "cd . && mise run test", status: "failed" as const, exitCode: 1 },
  { command: "cd . && mise run typecheck", status: "failed" as const, exitCode: 2 },
];

function failure(
  name: string,
  verdict: TriagedValidationFailure["verdict"],
  reasons: ValidationFailureReason[],
  outcome: TriagedValidationFailure["outcome"] = "failed",
): TriagedValidationFailure {
  return {
    key: validationFailureKey("bun", "src/x.test.ts", name),
    runner: "bun",
    file: "src/x.test.ts",
    name,
    outcome,
    verdict,
    reasons,
  };
}

const triage: ValidationFailureTriage = {
  version: 1,
  mergeBase,
  commands: [
    {
      command: "cd . && mise run test",
      failures: [
        failure("broken on main", "unrelated", ["no-changed-dependency", "failed-on-target-ci"]),
        failure("shared with another pipeline", "unrelated", [
          "reaches-changed-file-indirectly",
          "failed-on-same-base",
        ]),
        failure("mine", "related", ["imports-changed-file"]),
        failure("retried", "unrelated", ["passed-on-retry"], "flaky"),
        failure("e2e", "undetermined", ["not-import-traceable"]),
        failure("elsewhere", "unrelated", ["no-changed-dependency"]),
      ],
      omittedFailures: 3,
      unattributed: false,
    },
    { command: "cd . && mise run typecheck", failures: [], omittedFailures: 0, unattributed: true },
  ],
  limitations: [],
};

describe("validation report", () => {
  test("lists the change's own tests on their own, whatever the other suites did", () => {
    const report = buildValidationReport({
      validation,
      validationPlan: plan,
      failureTriage: triage,
    });
    expect(report.changedTests).toEqual([
      {
        id: "changed",
        command: "cd . && bun test src/pairing.test.ts",
        status: "passed",
        exitCode: 0,
      },
    ]);
    expect(report.changedTestsNote).toBeUndefined();
    expect(isValidationReport(report)).toBe(true);
  });

  test("labels each failure that also fails on the merge base as pre-existing", () => {
    const report = buildValidationReport({
      validation,
      validationPlan: plan,
      failureTriage: triage,
    });
    const labels = Object.fromEntries(report.failures.map((entry) => [entry.name, entry.label]));
    expect(labels).toEqual({
      "broken on main": "pre-existing",
      "shared with another pipeline": "pre-existing",
      mine: "caused-by-change",
      retried: "flaky",
      e2e: "undetermined",
      elsewhere: "unrelated",
    });
    // Most actionable first; equal labels keep the triage's order.
    expect(report.failures.map((entry) => entry.name)).toEqual([
      "mine",
      "broken on main",
      "shared with another pipeline",
      "retried",
      "elsewhere",
      "e2e",
    ]);
    expect(report.counts).toEqual({
      "caused-by-change": 1,
      "pre-existing": 2,
      flaky: 1,
      unrelated: 1,
      undetermined: 1,
    });
    expect(report.mergeBase).toBe(mergeBase);
    expect(report.omittedFailures).toBe(3);
    expect(report.unexplainedCommands).toEqual(["cd . && mise run typecheck"]);
  });

  test("merge-base evidence wins over the import graph", () => {
    expect(
      validationReportFailureLabel({
        verdict: "related",
        reasons: ["imports-changed-file", "failed-on-target-ci"],
        outcome: "failed",
      }),
    ).toBe("pre-existing");
  });

  test("says why there is no changed-tests result", () => {
    expect(buildValidationReport({ validation }).changedTestsNote).toBe(CHANGED_TESTS_NOTE_NO_PLAN);
    const legacy: ReviewValidationPlan = {
      ...plan,
      commands: plan.commands.map(({ scope: _scope, ...command }) => command),
    };
    expect(buildValidationReport({ validation, validationPlan: legacy }).changedTestsNote).toBe(
      CHANGED_TESTS_NOTE_NONE_PLANNED,
    );
    expect(
      buildValidationReport({ validation: validation.slice(1), validationPlan: plan })
        .changedTestsNote,
    ).toBe(CHANGED_TESTS_NOTE_UNMATCHED);
  });

  test("a failed command the triage never read is unexplained", () => {
    const report = buildValidationReport({ validation, validationPlan: plan });
    expect(report.failures).toEqual([]);
    expect(report.unexplainedCommands).toEqual([
      "cd . && mise run test",
      "cd . && mise run typecheck",
    ]);
  });

  test("the guard rejects an unknown label and a missing count", () => {
    const report = buildValidationReport({
      validation,
      validationPlan: plan,
      failureTriage: triage,
    });
    const badLabel = structuredClone(report);
    (badLabel.failures[0] as { label: string }).label = "maybe";
    expect(isValidationReport(badLabel)).toBe(false);
    const badCounts = structuredClone(report) as unknown as { counts: Record<string, number> };
    delete badCounts.counts["pre-existing"];
    expect(isValidationReport(badCounts)).toBe(false);
  });

  test("renders the changed tests first and names each label", () => {
    const markdown = renderValidationReportMarkdown(
      buildValidationReport({ validation, validationPlan: plan, failureTriage: triage }),
    );
    expect(markdown.indexOf("### Changed tests")).toBe(0);
    expect(markdown).toContain("- `cd . && bun test src/pairing.test.ts`: passed (exit 0)");
    expect(markdown).toContain(
      "- src/x.test.ts: broken on main — pre-existing (also fails on the merge base)",
    );
    expect(markdown).toContain("- src/x.test.ts: mine — caused by this change");
    expect(markdown).toContain(`Pre-existing failures also failed on merge base \`${mergeBase}\`.`);
  });
});

describe("validation plan scope", () => {
  test("the provider schema requires a scope from the fixed set", () => {
    const items = (
      REVIEW_VALIDATION_PLAN_SCHEMA.properties as {
        commands: { items: { required: string[]; properties: { scope: { enum: string[] } } } };
      }
    ).commands.items;
    expect(items.required).toContain("scope");
    expect(items.properties.scope.enum).toEqual(["changed", "general"]);
  });

  test("plans without a scope still parse; an unknown scope does not", () => {
    expect(isReviewValidationPlan(plan)).toBe(true);
    expect(
      isReviewValidationPlan({ ...plan, commands: [planCommand("suite", "mise run test")] }),
    ).toBe(true);
    expect(
      isReviewValidationPlan({
        ...plan,
        commands: [{ ...planCommand("suite", "mise run test"), scope: "focused" }],
      }),
    ).toBe(false);
  });
});
