import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { StructuredReviewReportView } from "./StructuredReviewReportView";

afterEach(cleanup);

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "base-sha",
    commit: null,
    filesReviewed: ["src/example.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [{ command: "bun test", result: "passed", summary: "All tests passed" }],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Adds structured reviews.",
    before: "Reviews were plaintext.",
    after: "Reviews are validated.",
    keyCodeChanges: [{ file: "src/example.ts", line: 12, description: "Parses reports." }],
    userImpact: "Review results are readable.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: ["workflow"],
    overallRisk: "medium",
    reasoning: "Long-running state changed.",
  },
  testResults: { total: 1, passed: 1, failed: 0, failures: [] },
  strengths: [{ description: "Typed boundary", file: "src/example.ts", line: 12 }],
  issues: [{
    severity: "P1",
    confidence: 91,
    category: "correctness",
    title: "Retry state can drift",
    file: "src/example.ts",
    line: 18,
    symbol: "retry",
    description: "The retry can use stale state.",
    evidence: "The request ID is replaced.",
    suggestion: "Persist it first.",
    verification: "Disconnect and retry.",
    alternativeFixes: ["Use a journal."],
  }],
  testCoverageGaps: [{
    file: "src/example.test.ts",
    untestedBehavior: "Recovery after disconnect.",
  }],
  verdict: { ready: "with-fixes", reasoning: "One fix is required." },
  summaryOfChange: "Introduces structured reviews.",
  reviewSummary: "The design is sound after the retry fix.",
};

describe("StructuredReviewReportView", () => {
  test("renders the familiar report order and detailed findings", () => {
    render(<StructuredReviewReportView report={report} />);
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings.filter((heading) => !heading?.startsWith("1. "))).toEqual([
      "Structured review report",
      "Review Scope",
      "What Changed",
      "Risk Profile",
      "Test Results",
      "Strengths",
      "Issues · 1",
      "Test Coverage Gaps · 1",
      "Verdict",
      "Summary of change",
      "Review summary",
    ]);
    expect(
      screen.getByRole("heading", { name: /Retry state can drift/ }),
    ).toBeTruthy();
    expect(screen.getByText("Disconnect and retry.")).toBeTruthy();
    expect(
      screen.getByText((_, element) =>
        element?.tagName === "LI"
        && element.textContent?.includes("Recovery after disconnect.") === true
      ),
    ).toBeTruthy();
  });

  test("hides raw JSON until deliberate inspection", () => {
    render(<StructuredReviewReportView report={report} />);
    expect(screen.queryByLabelText("Raw structured review JSON")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Inspect raw JSON/ }));
    expect(screen.getByLabelText("Raw structured review JSON").textContent)
      .toContain("\"reviewScope\"");
    fireEvent.click(screen.getByRole("button", { name: /Hide raw JSON/ }));
    expect(screen.queryByLabelText("Raw structured review JSON")).toBeNull();
  });

  test("renders commit, failed validation, skipped files, and limitations", () => {
    render(
      <StructuredReviewReportView
        report={{
          ...report,
          reviewScope: {
            ...report.reviewScope,
            commit: {
              sha: "abc123",
              subject: "fix: preserve recovery",
            },
            filesSkipped: [{ file: "dist/output.js", reason: "generated" }],
            filesLeftUncommitted: [{ file: ".env.local", reason: "sensitive" }],
            commandsRun: [{
              command: "bun test",
              result: "failed",
              summary: "one failure",
            }],
            commandsNotRun: [{ command: "docker build", reason: "not affected" }],
            limitations: ["Provider integration unavailable"],
          },
          testResults: {
            total: 2,
            passed: 1,
            failed: 1,
            failures: [{
              testName: "restores state",
              file: "src/recovery.test.ts",
              errorMessage: "expected paused",
            }],
          },
        }}
      />,
    );

    expect(screen.getByText(/fix: preserve recovery/)).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText(/dist\/output\.js/)).toBeTruthy();
    expect(screen.getByText(/\.env\.local/)).toBeTruthy();
    expect(screen.getByText(/Provider integration unavailable/)).toBeTruthy();
    expect(screen.getByText(/expected paused/)).toBeTruthy();
  });

  test("renders explicit empty states for findings, strengths, and coverage gaps", () => {
    render(
      <StructuredReviewReportView
        report={{
          ...report,
          reviewScope: {
            ...report.reviewScope,
            commandsRun: [],
          },
          strengths: [],
          issues: [],
          testCoverageGaps: [],
        }}
      />,
    );

    expect(screen.getByText("No high-confidence issues were found in the reviewed scope."))
      .toBeTruthy();
    expect(screen.getAllByText("None.").length).toBeGreaterThanOrEqual(2);
  });
});
