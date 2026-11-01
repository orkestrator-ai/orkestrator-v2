import { describe, expect, test } from "bun:test";
import { READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS } from "./native-agent.js";
import {
  REVIEW_FANOUT_MAX_REVIEWERS,
  isReviewConsolidationSession,
  isReviewFanoutState,
  isReviewPanelOverlap,
  isReviewWorktreeSnapshotRecord,
  isReviewerModelSelection,
  isReviewerRecord,
  isReviewerRecordList,
  reviewerCouldNotStart,
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
    expect(isReviewerModelSelection({ agent: "claude", model: "sonnet", fastMode: true })).toBe(
      true,
    );
    expect(isReviewerModelSelection({ agent: "claude", model: "sonnet", fastMode: false })).toBe(
      true,
    );
    expect(isReviewerModelSelection({ agent: "claude", model: "sonnet", fastMode: "fast" })).toBe(
      false,
    );
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

  test("persists the spent result reminder as a boolean", () => {
    expect(isReviewerRecord(reviewer({ resultReminderSent: true }))).toBe(true);
    expect(isReviewerRecord(reviewer({ resultReminderSent: "yes" as never }))).toBe(false);
  });

  test("persists the spent restart continuation as a boolean", () => {
    expect(isReviewerRecord(reviewer({ restartContinuationSent: true }))).toBe(true);
    expect(isReviewerRecord(reviewer({ restartContinuationSent: 1 as never }))).toBe(false);
  });

  test("records a start failure as a boolean, read only on a failed reviewer", () => {
    const unstartable = reviewer({ status: "failed", error: "bridge missing", startFailed: true });
    expect(isReviewerRecord(unstartable)).toBe(true);
    expect(isReviewerRecord(reviewer({ agentStarted: true }))).toBe(true);
    expect(isReviewerRecord(reviewer({ agentStarted: false }))).toBe(true);
    expect(isReviewerRecord(reviewer({ agentStarted: "yes" as never }))).toBe(false);
    expect(isReviewerRecord(reviewer({ startFailed: "yes" as never }))).toBe(false);
    expect(reviewerCouldNotStart(unstartable)).toBe(true);
    expect(reviewerCouldNotStart(reviewer({ status: "failed", error: "session failed" }))).toBe(
      false,
    );
    // A retried reviewer that kept a stale flag is not reported while it runs.
    expect(reviewerCouldNotStart(reviewer({ status: "pending", startFailed: true }))).toBe(false);
  });

  test("requires a 64-character digest so a truncated one cannot be compared", () => {
    expect(isReviewerRecord(reviewer({ progressDigest: "a".repeat(64) }))).toBe(true);
    expect(isReviewerRecord(reviewer({ progressDigest: "a".repeat(63) }))).toBe(false);
  });

  test("accepts a bounded continuation prompt", () => {
    expect(isReviewerRecord(reviewer({ continuationPrompt: "Please continue" }))).toBe(true);
    expect(isReviewerRecord(reviewer({ continuationPrompt: "x".repeat(4_097) }))).toBe(false);
  });

  test("carries whether the model is a real selection or a placeholder", () => {
    // The string alone cannot answer it: `"default"` is a genuine Claude
    // catalog id, so an unpinned reviewer has to say so out loud.
    expect(isReviewerRecord(reviewer({ model: "default", modelUnpinned: true }))).toBe(true);
    expect(isReviewerRecord(reviewer({ model: "default" }))).toBe(true);
    expect(isReviewerRecord(reviewer({ modelUnpinned: "yes" as never }))).toBe(false);
  });

  test("carries a bounded model substitution", () => {
    const modelSubstitution = {
      requestedModelId: "opencode/claude-sonnet-5",
      modelId: "opencode-go/gpt-5.6-luna",
      message: "claude-sonnet-5 isn't available with your OpenCode login; using GPT-5.6 Luna.",
    };
    expect(isReviewerRecord(reviewer({ modelSubstitution }))).toBe(true);
    expect(
      isReviewerRecord(reviewer({ modelSubstitution: { ...modelSubstitution, modelId: "" } })),
    ).toBe(false);
    expect(isReviewerRecord(reviewer({ modelSubstitution: "substituted" as never }))).toBe(false);
  });

  test("carries a bounded reason its commands ran without the sandbox (todo 0190)", () => {
    const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
    expect(isReviewerRecord(reviewer({ commandSandboxOff: reason }))).toBe(true);
    expect(
      isReviewerRecord(
        reviewer({ commandSandboxOff: "x".repeat(READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS) }),
      ),
    ).toBe(true);
    expect(
      isReviewerRecord(
        reviewer({
          commandSandboxOff: "x".repeat(READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS + 1),
        }),
      ),
    ).toBe(false);
    expect(isReviewerRecord(reviewer({ commandSandboxOff: true as never }))).toBe(false);
  });

  test("accepts a non-negative token count and rejects malformed usage", () => {
    expect(isReviewerRecord(reviewer({ tokenCount: 12_345 }))).toBe(true);
    expect(isReviewerRecord(reviewer({ tokenCount: -1 }))).toBe(false);
    expect(isReviewerRecord(reviewer({ tokenCount: 1.5 }))).toBe(false);
    expect(isReviewerRecord(reviewer({ tokenCount: Number.NaN }))).toBe(false);
    expect(isReviewerRecord(reviewer({ tokenCount: Number.MAX_SAFE_INTEGER + 1 }))).toBe(false);
    expect(isReviewerRecord(reviewer({ cacheReadTokens: 0 }))).toBe(true);
    expect(isReviewerRecord(reviewer({ cacheReadTokens: 8_000 }))).toBe(true);
    expect(isReviewerRecord(reviewer({ cacheReadTokens: -1 }))).toBe(false);
    expect(isReviewerRecord(reviewer({ cacheReadTokens: 0.5 }))).toBe(false);
    expect(isReviewerRecord(reviewer({ usageFinalizationPolls: 12 }))).toBe(true);
    expect(isReviewerRecord(reviewer({ usageFinalizationPolls: 13 }))).toBe(false);
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
    expect(isReviewConsolidationSession({ ...session, model: "sonnet", fastMode: true })).toBe(
      true,
    );
    expect(isReviewConsolidationSession({ ...session, fastMode: "fast" })).toBe(false);
    expect(
      isReviewConsolidationSession({
        ...session,
        model: "opencode-go/gpt-5.6-luna",
        modelSubstitution: {
          requestedModelId: "opencode/claude-sonnet-5",
          modelId: "opencode-go/gpt-5.6-luna",
          message: "claude-sonnet-5 isn't available with your OpenCode login; using GPT-5.6 Luna.",
        },
      }),
    ).toBe(true);
    expect(isReviewConsolidationSession({ ...session, modelSubstitution: {} })).toBe(false);
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

  test("accepts a read-only guard baseline and rejects a malformed one", () => {
    const workspaceBaseline = {
      head: "1".repeat(40),
      paths: ["notes/a.md"],
      capturedAt: new Date(0).toISOString(),
    };
    expect(isReviewFanoutState({ reviewers: [reviewer()], workspaceBaseline })).toBe(true);
    expect(
      isReviewFanoutState({
        reviewers: [reviewer()],
        workspaceBaseline: { ...workspaceBaseline, head: "main" },
      }),
    ).toBe(false);
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

describe("panel overlap counts", () => {
  const overlap = {
    version: 1,
    reviewers: 2,
    sourceFindings: 3,
    citedSourceFindings: 3,
    consolidatedFindings: 2,
    singleSourceFindings: 1,
    positions: [
      {
        position: 1,
        sourceFindings: 1,
        citedSourceFindings: 1,
        consolidatedFindings: 1,
        singleSourceFindings: 0,
        novelFindings: 1,
      },
      {
        position: 3,
        sourceFindings: 2,
        citedSourceFindings: 2,
        consolidatedFindings: 2,
        singleSourceFindings: 1,
        novelFindings: 1,
      },
    ],
  };

  test("accepts counts with increasing configured positions", () => {
    expect(isReviewPanelOverlap(overlap)).toBe(true);
  });

  test("rejects unknown keys, text, negative counts and unordered positions", () => {
    expect(isReviewPanelOverlap({ ...overlap, version: 2 })).toBe(false);
    expect(isReviewPanelOverlap({ ...overlap, title: "a finding" })).toBe(false);
    expect(isReviewPanelOverlap({ ...overlap, sourceFindings: -1 })).toBe(false);
    expect(isReviewPanelOverlap({ ...overlap, reviewers: 3 })).toBe(false);
    expect(isReviewPanelOverlap({ ...overlap, positions: [...overlap.positions].reverse() })).toBe(
      false,
    );
    expect(
      isReviewPanelOverlap({
        ...overlap,
        positions: [{ ...overlap.positions[0], reviewerId: "reviewer-1" }, overlap.positions[1]],
      }),
    ).toBe(false);
    expect(
      isReviewPanelOverlap({
        ...overlap,
        positions: [overlap.positions[0], { ...overlap.positions[1], position: 33 }],
      }),
    ).toBe(false);
  });
});
