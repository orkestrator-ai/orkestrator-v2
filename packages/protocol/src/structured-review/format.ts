import type {
  ReviewCoverageGap,
  ReviewIssue,
  ReviewScopedFile,
  StructuredReviewReport,
} from "./types";
import { parseStructuredReviewReport } from "./validation";

function text(value: string): string {
  return value.length > 0 ? value : "Not provided.";
}

function location(file: string, line: number | null): string {
  if (line === null) return text(file);
  return `${text(file)}:${line}`;
}

function bullet(label: string, value: string): string {
  const lines = text(value).replace(/\r\n?/g, "\n").split("\n");
  return `- ${label}: ${lines[0]}${lines
    .slice(1)
    .map((line) => `\n  ${line}`)
    .join("")}`;
}

function simpleList(values: readonly string[], emptyLabel = "None."): string {
  return values.length > 0
    ? values.map((value) => `  - ${text(value)}`).join("\n")
    : `  - ${emptyLabel}`;
}

function scopedFileList(values: readonly ReviewScopedFile[]): string {
  return values.length > 0
    ? values
        .map((entry) => `  - ${text(entry.file)} — ${text(entry.reason)}`)
        .join("\n")
    : "  - None.";
}

function formatIssue(issue: ReviewIssue, index: number): string {
  const lines = [
    `### ${index + 1}. [${issue.severity}][conf:${issue.confidence}][${issue.category}]`,
    `#### ${text(issue.title)}`,
    bullet("File", location(issue.file, issue.line)),
    bullet("Symbol", issue.symbol),
    bullet("Description", issue.description),
    bullet("Evidence", issue.evidence),
    bullet("Suggestion", issue.suggestion),
    bullet("Verification", issue.verification),
  ];
  if (issue.alternativeFixes !== undefined) {
    lines.push("- Alternative fixes:");
    lines.push(simpleList(issue.alternativeFixes));
  }
  return lines.join("\n");
}

function formatCoverageGap(gap: ReviewCoverageGap): string {
  return `- ${text(gap.file)} — ${text(gap.untestedBehavior)}`;
}

/**
 * Formats a validated report in the established review-section order.
 *
 * The input is validated again at the display boundary on purpose. Renderers
 * can safely accept persisted or provider-originated `unknown` data without
 * accidentally presenting an incomplete result as a successful review.
 *
 * Legacy test results are tolerated here: this renders a report that was
 * already accepted somewhere upstream, so refusing to display it would lose the
 * result rather than catch a bad one.
 */
export function formatStructuredReviewReport(value: unknown): string {
  const report: StructuredReviewReport = parseStructuredReviewReport(value, {
    allowLegacyTestResults: true,
  });
  const commit = report.reviewScope.commit;
  const failures =
    report.testResults.failures.length > 0
      ? report.testResults.failures
          .map(
            (failure) =>
              `  - ${text(failure.testName)} (${text(failure.file)}) — ${text(
                failure.errorMessage,
              )}`,
          )
          .join("\n")
      : "  - None.";

  return [
    "## Review Scope",
    bullet("Target branch", report.reviewScope.targetBranch),
    bullet("Base ref", report.reviewScope.baseRef),
    bullet(
      "Commit created",
      commit ? `${text(commit.sha)} — ${text(commit.subject)}` : "None.",
    ),
    "- Files reviewed:",
    simpleList(report.reviewScope.filesReviewed),
    "- Files skipped:",
    scopedFileList(report.reviewScope.filesSkipped),
    "- Files left uncommitted:",
    scopedFileList(report.reviewScope.filesLeftUncommitted),
    "- Commands run:",
    report.reviewScope.commandsRun.length > 0
      ? report.reviewScope.commandsRun
          .map(
            (command) =>
              `  - ${text(command.command)} — ${command.result} (${text(
                command.summary,
              )})`,
          )
          .join("\n")
      : "  - None.",
    "- Commands not run:",
    report.reviewScope.commandsNotRun.length > 0
      ? report.reviewScope.commandsNotRun
          .map(
            (command) =>
              `  - ${text(command.command)} — ${text(command.reason)}`,
          )
          .join("\n")
      : "  - None.",
    "- Limitations:",
    simpleList(report.reviewScope.limitations),
    "",
    "## What Changed",
    bullet("Overview", report.whatChanged.overview),
    bullet("Before", report.whatChanged.before),
    bullet("After", report.whatChanged.after),
    "- Key code changes:",
    report.whatChanged.keyCodeChanges.length > 0
      ? report.whatChanged.keyCodeChanges
          .map(
            (change) =>
              `  - ${location(change.file, change.line)} — ${text(
                change.description,
              )}`,
          )
          .join("\n")
      : "  - None.",
    bullet("User impact", report.whatChanged.userImpact),
    "",
    "## Risk Profile",
    bullet(
      "Change type",
      report.riskProfile.changeTypes.length > 0
        ? report.riskProfile.changeTypes.join(", ")
        : "None.",
    ),
    bullet(
      "Risk areas",
      report.riskProfile.riskAreas.length > 0
        ? report.riskProfile.riskAreas.join(", ")
        : "None.",
    ),
    bullet("Overall risk", report.riskProfile.overallRisk),
    bullet("Reasoning", report.riskProfile.reasoning),
    "",
    "## Test Results",
    bullet("Total", String(report.testResults.total)),
    bullet("Passed", String(report.testResults.passed)),
    bullet("Failed", String(report.testResults.failed)),
    bullet("Not run", String(report.testResults.notRun)),
    "- Failures:",
    failures,
    "",
    "## Strengths",
    report.strengths.length > 0
      ? report.strengths
          .map(
            (strength) =>
              `- ${text(strength.description)} — ${location(
                strength.file,
                strength.line,
              )}`,
          )
          .join("\n")
      : "- None.",
    "",
    "## Issues",
    report.issues.length > 0
      ? report.issues.map(formatIssue).join("\n\n")
      : "No high-confidence issues were found in the reviewed scope.",
    "",
    "## Test Coverage Gaps",
    report.testCoverageGaps.length > 0
      ? report.testCoverageGaps.map(formatCoverageGap).join("\n")
      : "- None.",
    "",
    "## Verdict",
    bullet("Ready", report.verdict.ready),
    bullet("Reasoning", report.verdict.reasoning),
    "",
    "## Summary of change",
    "",
    text(report.summaryOfChange),
    "",
    "## Review summary",
    "",
    text(report.reviewSummary),
  ].join("\n");
}
