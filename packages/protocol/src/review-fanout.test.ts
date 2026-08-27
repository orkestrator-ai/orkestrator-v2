import { describe, expect, test } from "bun:test";
import {
  REVIEW_FANOUT_MAX_REVIEWERS,
  isReviewConsolidationSession,
  isReviewFanoutState,
  isReviewWorktreeSnapshotRecord,
  isReviewerModelSelection,
  isReviewerRecord,
  isReviewerRecordList,
  reviewersSettled,
  usableReviewerReports,
  type ReviewerRecord,
} from "./review-fanout.js";
import type { StructuredReviewReport } from "./structured-review.js";

const REPORT: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "None",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

function reviewer(overrides: Partial<ReviewerRecord> = {}): ReviewerRecord {
  return {
    id: "reviewer-1",
    agent: "claude",
    model: "sonnet",
    status: "pending",
    ...overrides,
  } as ReviewerRecord;
}

describe("reviewer model selection", () => {
  test("requires a platform and a non-blank model", () => {
    expect(isReviewerModelSelection({ agent: "claude", model: "sonnet" })).toBe(true);
    expect(isReviewerModelSelection({ agent: "claude", model: "  " })).toBe(false);
    expect(isReviewerModelSelection({ agent: "not-an-agent", model: "sonnet" })).toBe(false);
  });

  test("rejects unknown keys so a typo cannot ride along as a selection", () => {
    expect(isReviewerModelSelection({ agent: "claude", model: "sonnet", effort: "high" })).toBe(
      false,
    );
  });
});

describe("reviewer records", () => {
  test("accepts a live reviewer and rejects an unknown dispatch state", () => {
    expect(isReviewerRecord(reviewer({ status: "running", dispatchState: "sent" }))).toBe(true);
    expect(
      isReviewerRecord(reviewer({ status: "running", dispatchState: "half-sent" as never })),
    ).toBe(false);
  });

  test("bounds the schema repair budget", () => {
    expect(isReviewerRecord(reviewer({ schemaRepairAttempts: 3 }))).toBe(true);
    expect(isReviewerRecord(reviewer({ schemaRepairAttempts: 4 }))).toBe(false);
  });

  test("requires a 64-character digest so a truncated one cannot be compared", () => {
    expect(isReviewerRecord(reviewer({ progressDigest: "a".repeat(64) }))).toBe(true);
    expect(isReviewerRecord(reviewer({ progressDigest: "a".repeat(63) }))).toBe(false);
  });
});

describe("reviewer lists", () => {
  test("rejects duplicate ids, which would make provenance ambiguous", () => {
    expect(isReviewerRecordList([reviewer(), reviewer()])).toBe(false);
    expect(isReviewerRecordList([reviewer(), reviewer({ id: "reviewer-2" })])).toBe(true);
  });

  test("rejects a completed reviewer with no report", () => {
    expect(isReviewerRecordList([reviewer({ status: "completed" })])).toBe(false);
    expect(isReviewerRecordList([reviewer({ status: "completed", report: REPORT })])).toBe(true);
  });

  test("bounds the panel size", () => {
    const many = Array.from({ length: REVIEW_FANOUT_MAX_REVIEWERS + 1 }, (_, index) =>
      reviewer({ id: `reviewer-${index}` }),
    );
    expect(isReviewerRecordList(many)).toBe(false);
    expect(isReviewerRecordList(many.slice(0, REVIEW_FANOUT_MAX_REVIEWERS))).toBe(true);
    expect(isReviewerRecordList([])).toBe(false);
  });
});

describe("worktree snapshot records", () => {
  const snapshot = {
    status: "dirty" as const,
    head: "a".repeat(40),
    paths: ["src/app.ts"],
    fingerprint: "b".repeat(64),
    capturedAt: new Date(0).toISOString(),
  };

  test("accepts a well-formed dirty snapshot", () => {
    expect(isReviewWorktreeSnapshotRecord(snapshot)).toBe(true);
  });

  test("requires a clean snapshot to carry no paths", () => {
    expect(isReviewWorktreeSnapshotRecord({ ...snapshot, status: "clean" })).toBe(false);
    expect(isReviewWorktreeSnapshotRecord({ ...snapshot, status: "clean", paths: [] })).toBe(true);
  });

  test("requires a dirty snapshot to name at least one path", () => {
    expect(isReviewWorktreeSnapshotRecord({ ...snapshot, paths: [] })).toBe(false);
  });
});

describe("consolidation session", () => {
  const session = {
    sessionKey: "pipeline:review-consolidation",
    providerSessionId: "session-1",
    requestId: "request-1",
    state: "sent" as const,
    createdAt: new Date(0).toISOString(),
    agent: "claude" as const,
  };

  test("accepts a session with and without a pinned model", () => {
    expect(isReviewConsolidationSession(session)).toBe(true);
    expect(isReviewConsolidationSession({ ...session, model: "sonnet" })).toBe(true);
    expect(isReviewConsolidationSession({ ...session, model: "  " })).toBe(false);
  });

  test("rejects an unparsable creation timestamp", () => {
    expect(isReviewConsolidationSession({ ...session, createdAt: "not-a-date" })).toBe(false);
  });
});

describe("fan-out state", () => {
  test("accepts reviewers alone, and reviewers with a consolidated report", () => {
    expect(isReviewFanoutState({ reviewers: [reviewer()] })).toBe(true);
    expect(
      isReviewFanoutState({
        reviewers: [reviewer({ status: "completed", report: REPORT })],
        report: REPORT,
      }),
    ).toBe(true);
  });

  test("rejects an unknown field", () => {
    expect(isReviewFanoutState({ reviewers: [reviewer()], phase: "reviewing" })).toBe(false);
  });
});

describe("settlement helpers", () => {
  test("reports settled only once nothing can still produce a report", () => {
    expect(reviewersSettled([reviewer({ status: "running" })])).toBe(false);
    expect(reviewersSettled([reviewer({ status: "pending" })])).toBe(false);
    expect(
      reviewersSettled([reviewer({ status: "failed" }), reviewer({ status: "cancelled" })]),
    ).toBe(true);
  });

  test("counts only completed reviewers that actually carry a report", () => {
    const usable = reviewer({ id: "a", status: "completed", report: REPORT });
    const failed = reviewer({ id: "b", status: "failed" });
    expect(usableReviewerReports([usable, failed])).toEqual([usable]);
  });
});
