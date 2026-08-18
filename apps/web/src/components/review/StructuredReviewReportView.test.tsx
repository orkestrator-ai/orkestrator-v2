import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { StructuredReviewReportView } from "./StructuredReviewReportView";

afterEach(cleanup);
beforeEach(() => {
  useMessagePartExpansionStore.getState().reset();
});

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
  testResults: { total: 1, passed: 1, failed: 0, notRun: 0, failures: [] },
  strengths: [{ description: "Typed boundary", file: "src/example.ts", line: 12 }],
  issues: [
    {
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
    },
  ],
  testCoverageGaps: [
    {
      file: "src/example.test.ts",
      untestedBehavior: "Recovery after disconnect.",
    },
  ],
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
    expect(screen.getByRole("heading", { name: /Retry state can drift/ })).toBeTruthy();
    expect(screen.getByText("Disconnect and retry.")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "LI" &&
          element.textContent?.includes("Recovery after disconnect.") === true,
      ),
    ).toBeTruthy();
    expect(screen.getByText("0 not run")).toBeTruthy();
  });

  test("hides raw JSON until deliberate inspection", () => {
    render(<StructuredReviewReportView report={report} />);
    expect(screen.queryByLabelText("Raw structured review JSON") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Inspect raw JSON/ }));
    expect(screen.getByLabelText("Raw structured review JSON").textContent).toContain(
      '"reviewScope"',
    );
    fireEvent.click(screen.getByRole("button", { name: /Hide raw JSON/ }));
    expect(screen.queryByLabelText("Raw structured review JSON") === null).toBe(true);
  });

  test("infers the not-run count for a legacy report already held in memory", () => {
    render(
      <StructuredReviewReportView
        report={
          {
            ...report,
            testResults: {
              total: 8_107,
              passed: 8_094,
              failed: 0,
              failures: [],
            },
          } as any
        }
      />,
    );

    expect(screen.getByText("13 not run")).toBeTruthy();
  });

  test("clamps an inferred not-run count that would go negative", () => {
    render(
      <StructuredReviewReportView
        report={
          {
            ...report,
            testResults: {
              total: 2,
              passed: 3,
              failed: 1,
              failures: [],
            },
          } as any
        }
      />,
    );

    expect(screen.getByText("0 not run")).toBeTruthy();
    expect(screen.queryByText("-2 not run") === null).toBe(true);
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
            commandsRun: [
              {
                command: "bun test",
                result: "failed",
                summary: "one failure",
              },
            ],
            commandsNotRun: [{ command: "docker build", reason: "not affected" }],
            limitations: ["Provider integration unavailable"],
          },
          testResults: {
            total: 2,
            passed: 1,
            failed: 1,
            notRun: 0,
            failures: [
              {
                testName: "restores state",
                file: "src/recovery.test.ts",
                errorMessage: "expected paused",
              },
            ],
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

  test("collapses every section behind a disclosure when asked", () => {
    render(<StructuredReviewReportView report={report} collapsibleSections />);

    // Collapsed content is unmounted, not hidden: this report is the largest
    // thing in a transcript that already scrolls.
    expect(screen.queryByText("Adds structured reviews.") === null).toBe(true);
    expect(screen.queryByText("Long-running state changed.") === null).toBe(true);
    // A collapsed report still says what it concluded.
    expect(screen.getByText(/Ready: with-fixes · 1 issue · 1 coverage gap/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();
    expect(screen.queryByText("Long-running state changed.") === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    expect(screen.queryByText("Adds structured reviews.") === null).toBe(true);
  });

  test("keeps the raw JSON inspector out of the report when it is suppressed", () => {
    render(<StructuredReviewReportView report={report} showRawJson={false} />);

    expect(screen.queryByRole("button", { name: /Inspect raw JSON/ }) === null).toBe(true);
    expect(screen.queryByText("Validated JSON Schema") === null).toBe(true);
    expect(screen.getByRole("heading", { name: "Structured review report" })).toBeTruthy();
    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();
  });

  test("drops its own title and verdict line when the caller already names it", () => {
    // A transcript fold-out shows both on its trigger, so the card opening
    // onto a duplicate of the row just clicked is what this suppresses.
    render(
      <StructuredReviewReportView
        report={report}
        collapsibleSections
        showRawJson={false}
        showHeading={false}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Structured review report" }) === null).toBe(true);
    expect(screen.queryByText(/^Ready: /) === null).toBe(true);
    // The article stays named for assistive technology even with no visible
    // heading, and the sections themselves are untouched.
    expect(screen.getByLabelText("Structured review report")).toBeTruthy();
    expect(screen.getByRole("button", { name: /What Changed/ })).toBeTruthy();
  });

  test("still offers the raw inspector when only the heading is suppressed", () => {
    render(<StructuredReviewReportView report={report} showHeading={false} />);

    expect(screen.queryByRole("heading", { name: "Structured review report" }) === null).toBe(true);
    expect(screen.getByText("Validated JSON Schema")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect raw JSON/ })).toBeTruthy();
  });

  test("keeps an expanded section open across a re-render of the report", () => {
    const { rerender } = render(<StructuredReviewReportView report={report} collapsibleSections />);
    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();

    // A build pipeline re-renders this on every backend push. Deriving the
    // section component per render would remount it and silently collapse
    // whatever the user had opened.
    rerender(
      <StructuredReviewReportView report={{ ...report }} collapsibleSections className="changed" />,
    );

    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();
  });

  test("keeps a persisted section open across a full unmount", () => {
    const view = render(
      <StructuredReviewReportView
        report={report}
        collapsibleSections
        sectionExpansionKey="review-1/section"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();

    view.unmount();
    render(
      <StructuredReviewReportView
        report={report}
        collapsibleSections
        sectionExpansionKey="review-1/section"
      />,
    );

    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();
  });

  test("closes a section again on a second click of its disclosure", () => {
    render(<StructuredReviewReportView report={report} collapsibleSections />);
    const disclosure = screen.getByRole("button", { name: /What Changed/ });

    fireEvent.click(disclosure);
    expect(screen.getByText("Adds structured reviews.")).toBeTruthy();

    // Collapsed sections are unmounted, not hidden — the point of the mode is
    // that a report inside a transcript stays small, so this must actually
    // close and not merely toggle a chevron.
    fireEvent.click(disclosure);
    expect(screen.queryByText("Adds structured reviews.") === null).toBe(true);
  });

  test("summarizes a collapsed report's counts in both singular and plural", () => {
    const { rerender } = render(<StructuredReviewReportView report={report} collapsibleSections />);
    expect(
      screen.getByText("Ready: with-fixes · 1 issue · 1 coverage gap · medium risk"),
    ).toBeTruthy();

    rerender(
      <StructuredReviewReportView
        collapsibleSections
        report={{
          ...report,
          issues: [],
          testCoverageGaps: [],
          riskProfile: { ...report.riskProfile, overallRisk: "low" },
          verdict: { ready: "yes", reasoning: "Nothing to address." },
        }}
      />,
    );
    expect(screen.getByText("Ready: yes · 0 issues · 0 coverage gaps · low risk")).toBeTruthy();

    rerender(
      <StructuredReviewReportView
        collapsibleSections
        report={{
          ...report,
          issues: [report.issues[0]!, report.issues[0]!],
          testCoverageGaps: [
            report.testCoverageGaps[0]!,
            report.testCoverageGaps[0]!,
            report.testCoverageGaps[0]!,
          ],
          riskProfile: { ...report.riskProfile, overallRisk: "high" },
        }}
      />,
    );
    expect(
      screen.getByText("Ready: with-fixes · 2 issues · 3 coverage gaps · high risk"),
    ).toBeTruthy();
  });

  test("names the report by its heading, for the caller and for assistive tech", () => {
    render(<StructuredReviewReportView report={report} heading="Verification review" />);

    expect(screen.getByLabelText("Verification review")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verification review" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Structured review report" }) === null).toBe(true);
  });

  test("renders each section's body, not only its heading", () => {
    render(<StructuredReviewReportView report={report} />);

    // The ordering test asserts headings, so every one of these could render
    // the wrong field and still pass without this.
    expect(screen.getByText("One fix is required.")).toBeTruthy();
    expect(screen.getByText("Introduces structured reviews.")).toBeTruthy();
    expect(screen.getByText("The design is sound after the retry fix.")).toBeTruthy();
    expect(screen.getByText("Long-running state changed.")).toBeTruthy();
    expect(screen.getByText("Reviews were plaintext.")).toBeTruthy();
    expect(screen.getByText("Reviews are validated.")).toBeTruthy();
    expect(screen.getByText(/Review results are readable\./)).toBeTruthy();
    // Risk and change-type chips.
    expect(screen.getByText("medium risk")).toBeTruthy();
    expect(screen.getByText("feature")).toBeTruthy();
    expect(screen.getByText("workflow")).toBeTruthy();
    // A strength is its description plus where it lives.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "LI" && element.textContent === "Typed boundary src/example.ts:12",
      ),
    ).toBeTruthy();
  });

  test("locates a finding by file and line, and by file alone when there is none", () => {
    const issueLocation = () =>
      screen.getByText(
        (_, element) => element?.tagName === "P" && element.className.includes("font-mono"),
      ).textContent;
    const keyChange = () =>
      screen.getByText(
        (_, element) =>
          element?.tagName === "LI" && element.textContent?.includes("Parses reports.") === true,
      ).textContent;

    const { rerender } = render(<StructuredReviewReportView report={report} />);
    expect(issueLocation()).toBe("src/example.ts:18 · retry");
    expect(keyChange()).toBe("src/example.ts:12 — Parses reports.");

    rerender(
      <StructuredReviewReportView
        report={{
          ...report,
          issues: [{ ...report.issues[0]!, line: null, symbol: "" }],
          whatChanged: {
            ...report.whatChanged,
            keyCodeChanges: [
              {
                file: "src/example.ts",
                line: null,
                description: "Parses reports.",
              },
            ],
          },
        }}
      />,
    );
    // No line, and no trailing separator for an absent symbol.
    expect(issueLocation()).toBe("src/example.ts");
    expect(keyChange()).toBe("src/example.ts — Parses reports.");
  });

  test("shows a finding's alternative fixes only when it has any", () => {
    const { rerender } = render(<StructuredReviewReportView report={report} />);
    expect(screen.getByText("Alternative fixes")).toBeTruthy();
    expect(screen.getByText("Use a journal.")).toBeTruthy();

    rerender(
      <StructuredReviewReportView
        report={{
          ...report,
          issues: [{ ...report.issues[0]!, alternativeFixes: [] }],
        }}
      />,
    );
    expect(screen.queryByText("Alternative fixes") === null).toBe(true);
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

    expect(
      screen.getByText("No high-confidence issues were found in the reviewed scope."),
    ).toBeTruthy();
    expect(screen.getAllByText("None.").length).toBeGreaterThanOrEqual(2);
  });
});
