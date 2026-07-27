import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

export const TEST_STRUCTURED_REVIEW_REPORT: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "base-sha",
    commit: {
      sha: "review-sha",
      subject: "fix: address review findings",
    },
    filesReviewed: ["src/review.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [{
      command: "bun test",
      result: "passed",
      summary: "Tests passed.",
    }],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Updates the review workflow.",
    before: "The workflow could miss a retry.",
    after: "The workflow preserves the retry.",
    keyCodeChanges: [{
      file: "src/review.ts",
      line: 42,
      description: "Persists the request before dispatch.",
    }],
    userImpact: "Interrupted reviews can be retried safely.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: ["recovery"],
    overallRisk: "medium",
    reasoning: "The change affects long-running workflow state.",
  },
  testResults: {
    total: 1,
    passed: 1,
    failed: 0,
    notRun: 0,
    failures: [],
  },
  strengths: [{
    description: "Uses a durable request identifier.",
    file: "src/review.ts",
    line: 40,
  }],
  issues: [{
    severity: "P1",
    confidence: 95,
    category: "correctness",
    title: "Retry state is not persisted",
    file: "src/review.ts",
    line: 42,
    symbol: "dispatchReview",
    description: "A reconnect can dispatch the review twice.",
    evidence: "The request identifier is written after the provider call.",
    suggestion: "Persist the request identifier before dispatch.",
    verification: "Disconnect during dispatch and confirm only one turn runs.",
  }],
  testCoverageGaps: [{
    file: "src/review.test.ts",
    untestedBehavior: "Recovery after a transport disconnect.",
  }],
  verdict: {
    ready: "with-fixes",
    reasoning: "The retry finding and coverage gap should be addressed.",
  },
  summaryOfChange: "Adds durable structured review dispatch.",
  reviewSummary: "The workflow is sound after the retry fix.",
};

export const TEST_STRUCTURED_REVIEW_OUTPUT = {
  ok: true as const,
  provider: "claude" as const,
  value: TEST_STRUCTURED_REVIEW_REPORT,
};
