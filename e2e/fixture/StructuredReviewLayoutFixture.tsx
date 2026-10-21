import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  StructuredReviewFindingsView,
  StructuredReviewReportView,
} from "../../apps/web/src/components/review/StructuredReviewReportView";
import { TEST_STRUCTURED_REVIEW_REPORT } from "../../apps/web/src/components/build-pipeline/structured-review-test-fixture";

const token = "x".repeat(80);
const report: StructuredReviewReport = {
  ...TEST_STRUCTURED_REVIEW_REPORT,
  reviewScope: {
    ...TEST_STRUCTURED_REVIEW_REPORT.reviewScope,
    commandsRun: [
      {
        command: token,
        result: "passed" as const,
        summary: "Command summary wraps within the validation card after the long token.",
      },
    ],
  },
  issues: [0, 1].map((index) => ({
    ...TEST_STRUCTURED_REVIEW_REPORT.issues[0]!,
    title: `Layout finding ${index + 1}`,
    evidence: `${token} Surrounding evidence text wraps within the issue card after the long token.`,
  })),
  strengths: [0, 1].map((index) => ({
    description: `Strength ${index + 1}`,
    file: `src/strength-${index}.ts`,
    line: null,
  })),
  testCoverageGaps: [0, 1].map((index) => ({
    file: `test-${index}.ts`,
    untestedBehavior: `Coverage gap ${index + 1}`,
  })),
};

export function StructuredReviewLayoutFixture() {
  return (
    <main className="bg-background text-foreground">
      {/* Mirrors the clipping boundary around a transcript JSON payload. */}
      <div data-testid="report-pane" className="overflow-hidden" style={{ width: 400 }}>
        <StructuredReviewReportView report={report} showRawJson={false} />
      </div>
      <div data-testid="findings-pane" className="overflow-hidden" style={{ width: 400 }}>
        <StructuredReviewFindingsView findings={report} />
      </div>
    </main>
  );
}
