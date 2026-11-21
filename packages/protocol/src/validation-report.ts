/**
 * The review package's reading summary of its own validation evidence.
 *
 * A round's validation runs the whole plan once, and an aggregate suite that
 * fails for reasons that have nothing to do with the change (a test already
 * broken on the target branch, a host conflict) used to bury the one result a
 * reader needed: whether the change's own tests passed. Readers then left the
 * change unverified, or spent the round reproducing the unrelated failure.
 *
 * The report answers that first. `changedTests` lists the commands the plan
 * scoped to this change's own tests (`scope: "changed"`) with their results,
 * apart from every other command. `failures` lists every failing test the
 * failure triage named, each with one plain label; `pre-existing` marks a test
 * that also failed on the merge base (rerun on a checkout of it, the target
 * branch's CI there, or another pipeline validated on the same merge base). It is derived from the package's
 * own `validation`, `validationPlan` and `failureTriage` when the package is
 * sealed, and never runs anything. Browser-safe.
 */

import type { ReviewValidationPlan } from "./review-validation.js";
import {
  MAX_TRIAGED_FAILURES,
  VALIDATION_FAILURE_RUNNERS,
  type TriagedValidationFailure,
  type ValidationFailureRunner,
  type ValidationFailureTriage,
} from "./validation-failure-triage.js";

export const VALIDATION_REPORT_VERSION = 1;

/**
 * One label per failing test, in the order a reader should care about them.
 *
 * - `caused-by-change`: the triage verdict is `related`.
 * - `pre-existing`: the same test also failed on the merge base: when its
 *   file was rerun on a checkout of that commit, on the target branch's CI
 *   there, or in another pipeline validated on that base without having
 *   changed it.
 * - `flaky`: it failed and then passed when the runner retried it.
 * - `unrelated`: the triage established it is not this branch's doing on
 *   other evidence (its complete import graph reaches no changed file).
 * - `undetermined`: the evidence cannot decide; the reader judges it.
 */
export const VALIDATION_REPORT_FAILURE_LABELS = [
  "caused-by-change",
  "pre-existing",
  "flaky",
  "unrelated",
  "undetermined",
] as const;
export type ValidationReportFailureLabel = (typeof VALIDATION_REPORT_FAILURE_LABELS)[number];

export type ValidationReportCommandStatus = "passed" | "failed" | "skipped" | "incomplete";

export interface ValidationReportCommand {
  /** The plan command's id. */
  id: string;
  /** Exactly the package's `validation[].command` this entry reports. */
  command: string;
  status: ValidationReportCommandStatus;
  exitCode: number | null;
}

export interface ValidationReportFailure {
  /** Exactly the package's `validation[].command` whose output named the test. */
  command: string;
  runner: ValidationFailureRunner;
  file: string | null;
  name: string;
  label: ValidationReportFailureLabel;
  /**
   * What rerunning the test's file on a checkout of the merge base showed:
   * `failed` there too, or `passed` (the rerun did not report it failing).
   * Absent when it was not rerun.
   */
  onMergeBase?: "failed" | "passed";
}

export interface ValidationReport {
  version: typeof VALIDATION_REPORT_VERSION;
  /**
   * The plan's `scope: "changed"` commands and their results, in plan order.
   * Empty when the plan named none; {@link changedTestsNote} then says why.
   */
  changedTests: ValidationReportCommand[];
  /** Why {@link changedTests} is empty, or what it cannot show. */
  changedTestsNote?: string;
  /** `git merge-base HEAD origin/<target>` the `pre-existing` labels refer to. */
  mergeBase: string | null;
  /** Every failing test the triage listed, most actionable label first. */
  failures: ValidationReportFailure[];
  /** Failures the triage counted but did not list (its own caps). */
  omittedFailures: number;
  /**
   * Failed or incomplete commands whose output did not account for their
   * failure (a type error, a crash, a timeout, a count mismatch), and failed
   * commands the triage did not read at all. Judge each from its diagnostics.
   */
  unexplainedCommands: string[];
  counts: Record<ValidationReportFailureLabel, number>;
}

export const MAX_VALIDATION_REPORT_COMMANDS = 32;
const MAX_TEXT_LENGTH = 8_192;

/** Notes the report uses; exported so tests and prompts can name them. */
export const CHANGED_TESTS_NOTE_NO_PLAN =
  "This package has no validation plan, so no command was scoped to the change's own tests.";
export const CHANGED_TESTS_NOTE_NONE_PLANNED =
  "The validation plan scoped no command to the change's own tests; read their result from the full suites.";
export const CHANGED_TESTS_NOTE_UNMATCHED =
  "The recorded validation does not line up with the plan, so the changed tests' commands could not be identified.";

/** The label one triaged failure gets; see {@link VALIDATION_REPORT_FAILURE_LABELS}. */
export function validationReportFailureLabel(
  failure: Pick<TriagedValidationFailure, "verdict" | "reasons" | "outcome">,
): ValidationReportFailureLabel {
  // Merge-base evidence comes first: the triage itself makes either reason
  // `unrelated`, whatever the import graph said.
  if (
    failure.reasons.includes("failed-on-merge-base") ||
    failure.reasons.includes("failed-on-target-ci") ||
    failure.reasons.includes("failed-on-same-base")
  )
    return "pre-existing";
  if (failure.verdict === "related") return "caused-by-change";
  if (failure.verdict === "undetermined") return "undetermined";
  if (failure.outcome === "flaky" || failure.reasons.includes("passed-on-retry")) return "flaky";
  return "unrelated";
}

interface ReportValidationEntry {
  command: string;
  status: ValidationReportCommandStatus;
  exitCode: number | null;
}

/**
 * Builds the report from what a package holds. `validation` must be in plan
 * order (it is: preparation maps each run result in place), and a plan whose
 * command count differs is not matched by position.
 */
export function buildValidationReport(input: {
  validation: readonly ReportValidationEntry[];
  validationPlan?: ReviewValidationPlan;
  failureTriage?: ValidationFailureTriage;
}): ValidationReport {
  const { validation, validationPlan, failureTriage } = input;
  const changedTests: ValidationReportCommand[] = [];
  let changedTestsNote: string | undefined;
  if (!validationPlan) changedTestsNote = CHANGED_TESTS_NOTE_NO_PLAN;
  else if (validationPlan.commands.length !== validation.length)
    changedTestsNote = CHANGED_TESTS_NOTE_UNMATCHED;
  else {
    validationPlan.commands.forEach((planned, index) => {
      if (planned.scope !== "changed") return;
      const entry = validation[index]!;
      changedTests.push({
        id: planned.id,
        command: entry.command,
        status: entry.status,
        exitCode: entry.exitCode,
      });
    });
    if (changedTests.length === 0) changedTestsNote = CHANGED_TESTS_NOTE_NONE_PLANNED;
  }

  const order = new Map(VALIDATION_REPORT_FAILURE_LABELS.map((label, index) => [label, index]));
  const failures: ValidationReportFailure[] = (failureTriage?.commands ?? [])
    .flatMap((command) =>
      command.failures.map((failure) => ({
        command: command.command,
        runner: failure.runner,
        file: failure.file,
        name: failure.name,
        label: validationReportFailureLabel(failure),
        ...(failure.reasons.includes("failed-on-merge-base")
          ? { onMergeBase: "failed" as const }
          : failure.reasons.includes("passed-on-merge-base")
            ? { onMergeBase: "passed" as const }
            : {}),
      })),
    )
    // Stable: equal labels keep the triage's own order.
    .sort((left, right) => order.get(left.label)! - order.get(right.label)!);
  const counts = Object.fromEntries(
    VALIDATION_REPORT_FAILURE_LABELS.map((label) => [
      label,
      failures.filter((failure) => failure.label === label).length,
    ]),
  ) as Record<ValidationReportFailureLabel, number>;

  const triaged = new Map((failureTriage?.commands ?? []).map((entry) => [entry.command, entry]));
  const unexplainedCommands = validation
    .filter((entry) => entry.status === "failed" || entry.status === "incomplete")
    .filter((entry) => {
      const triage = triaged.get(entry.command);
      if (!triage) return true;
      return triage.unattributed || triage.failures.length === 0;
    })
    .map((entry) => entry.command)
    .slice(0, MAX_VALIDATION_REPORT_COMMANDS);

  return {
    version: VALIDATION_REPORT_VERSION,
    changedTests,
    ...(changedTestsNote ? { changedTestsNote } : {}),
    mergeBase: failureTriage?.mergeBase ?? null,
    failures,
    omittedFailures: (failureTriage?.commands ?? []).reduce(
      (total, command) => total + command.omittedFailures,
      0,
    ),
    unexplainedCommands,
    counts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function isCommand(value: unknown): value is string {
  // Match the package validation-entry limit, including the quoted cwd prefix.
  return typeof value === "string" && value.length > 0 && value.length <= 100_000;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const STATUSES: readonly string[] = ["passed", "failed", "skipped", "incomplete"];

export function isValidationReport(value: unknown): value is ValidationReport {
  if (
    !isRecord(value) ||
    value.version !== VALIDATION_REPORT_VERSION ||
    !Array.isArray(value.changedTests) ||
    value.changedTests.length > MAX_VALIDATION_REPORT_COMMANDS ||
    !value.changedTests.every(
      (entry) =>
        isRecord(entry) &&
        isText(entry.id) &&
        isCommand(entry.command) &&
        STATUSES.includes(String(entry.status)) &&
        (entry.exitCode === null || Number.isSafeInteger(entry.exitCode)),
    ) ||
    (value.changedTestsNote !== undefined && !isText(value.changedTestsNote)) ||
    !(
      value.mergeBase === null ||
      (typeof value.mergeBase === "string" && /^[a-f0-9]{40}$/.test(value.mergeBase))
    ) ||
    !Array.isArray(value.failures) ||
    value.failures.length > MAX_TRIAGED_FAILURES ||
    !value.failures.every(
      (entry) =>
        isRecord(entry) &&
        isCommand(entry.command) &&
        VALIDATION_FAILURE_RUNNERS.includes(entry.runner as ValidationFailureRunner) &&
        (entry.file === null || isText(entry.file)) &&
        isText(entry.name) &&
        VALIDATION_REPORT_FAILURE_LABELS.includes(entry.label as ValidationReportFailureLabel) &&
        (entry.onMergeBase === undefined ||
          entry.onMergeBase === "failed" ||
          entry.onMergeBase === "passed"),
    ) ||
    !isCount(value.omittedFailures) ||
    !Array.isArray(value.unexplainedCommands) ||
    value.unexplainedCommands.length > MAX_VALIDATION_REPORT_COMMANDS ||
    !value.unexplainedCommands.every(isCommand) ||
    !isRecord(value.counts)
  )
    return false;
  const counts = value.counts;
  return VALIDATION_REPORT_FAILURE_LABELS.every((label) => isCount(counts[label]));
}

const LABEL_TEXT: Record<ValidationReportFailureLabel, string> = {
  "caused-by-change": "caused by this change",
  "pre-existing": "pre-existing (also fails on the merge base)",
  flaky: "flaky (passed on retry)",
  unrelated: "unrelated to this change",
  undetermined: "undetermined",
};

/** Plain-text label for a reader, e.g. in a prompt or a summary line. */
export function validationReportLabelText(label: ValidationReportFailureLabel): string {
  return LABEL_TEXT[label];
}

/**
 * The report as short Markdown: the changed tests first, then each failing
 * test with its label. Bounded by the report's own caps.
 */
export function renderValidationReportMarkdown(report: ValidationReport): string {
  const lines = ["### Changed tests"];
  if (report.changedTests.length === 0) {
    lines.push(`- ${report.changedTestsNote ?? CHANGED_TESTS_NOTE_NONE_PLANNED}`);
  } else {
    for (const entry of report.changedTests) {
      const exit = entry.exitCode === null ? "" : ` (exit ${entry.exitCode})`;
      lines.push(`- \`${entry.command}\`: ${entry.status}${exit}`);
    }
    if (report.changedTestsNote) lines.push(`- ${report.changedTestsNote}`);
  }
  lines.push("", "### Failing tests");
  if (report.failures.length === 0 && report.unexplainedCommands.length === 0) {
    lines.push("- None.");
  }
  for (const failure of report.failures) {
    const where = failure.file ? `${failure.file}: ` : "";
    // A failure the merge base does not share points at the change (or a
    // flake that only shows under load), whatever its label.
    const base = failure.onMergeBase === "passed" ? "; passes when rerun on the merge base" : "";
    lines.push(`- ${where}${failure.name} — ${LABEL_TEXT[failure.label]}${base}`);
  }
  if (report.omittedFailures > 0) {
    lines.push(`- ${report.omittedFailures} more failing tests were counted but not listed.`);
  }
  for (const command of report.unexplainedCommands) {
    lines.push(`- \`${command}\` did not pass, and no listed test explains it; read its output.`);
  }
  if (report.counts["pre-existing"] > 0 && report.mergeBase) {
    lines.push("", `Pre-existing failures also failed on merge base \`${report.mergeBase}\`.`);
  }
  return lines.join("\n");
}
