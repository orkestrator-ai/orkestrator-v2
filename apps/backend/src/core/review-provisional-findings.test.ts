import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  REVIEW_PROVISIONAL_FINDINGS_MAX,
  REVIEW_PROVISIONAL_FINDING_MAX_BYTES,
  isReviewerRecord,
  type ReviewerProvisionalFinding,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import type { ReviewIssue, StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { consolidationReports } from "./review-fanout.js";
import {
  ProvisionalFindingInbox,
  appendProvisionalFindings,
  dropProvisionalFindings,
  parseReportedFinding,
} from "./review-provisional-findings.js";

const SCOPE = { environmentId: "env-1", projectId: "project-1" };
const KEY = "11111111-1111-4111-8111-111111111111";

function issue(title: string, overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    severity: "P1",
    confidence: 85,
    category: "correctness",
    title,
    file: "src/review.ts",
    line: 12,
    symbol: "review",
    description: "The clock resets when the step restarts.",
    evidence: "restartStep clears stepRuntimes",
    suggestion: "Keep the previous runtime",
    verification: "Restart a step and read its runtime",
    ...overrides,
  };
}

function reviewer(overrides: Partial<ReviewerRecord> = {}): ReviewerRecord {
  return {
    id: "reviewer-1",
    agent: "claude",
    model: "opus",
    status: "running",
    requestId: KEY,
    resultTransport: "tool-v1",
    providerSessionId: "session-1",
    ...overrides,
  };
}

function workflow(overrides: Partial<MultiReviewWorkflow> = {}): MultiReviewWorkflow {
  return {
    version: 1,
    controller: "backend",
    id: "multi-1",
    environmentId: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [reviewer()],
    fixModel: { agent: "claude", model: "opus" },
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    backendRevision: 1,
    ...overrides,
  };
}

function inbox(open = true) {
  const wakes: string[] = [];
  const state = { open };
  const findings = new ProvisionalFindingInbox({
    slotOpen: async () => state.open,
    wake: (environmentId) => wakes.push(environmentId),
    now: () => new Date("2026-10-16T00:01:00.000Z"),
  });
  return { findings, wakes, state };
}

describe("reported finding validation", () => {
  test("accepts one issue of the report contract and gives it a stable id", () => {
    const first = parseReportedFinding(issue("Clock resets"));
    // Key order and the provider schema's null sentinels do not change the id.
    const reordered = parseReportedFinding({
      ...Object.fromEntries(Object.entries(issue("Clock resets")).reverse()),
      alternativeFixes: null,
      reviewModels: null,
      reviewSourceIds: null,
    });
    expect(first.ok && reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.id).toMatch(/^[0-9a-f]{24}$/);
    expect(reordered.id).toBe(first.id);
    expect(reordered.issue).not.toHaveProperty("reviewModels");
  });

  test("drops provenance a provider tried to assign", () => {
    const parsed = parseReportedFinding({
      ...issue("Clock resets"),
      reviewModels: ["claude"],
      reviewSourceIds: ["r1-issue-0"],
    });
    expect(parsed.ok && parsed.issue).not.toHaveProperty("reviewSourceIds");
  });

  test("names the fields that break the contract", () => {
    const parsed = parseReportedFinding({ ...issue("Clock resets"), severity: "P9", line: -1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["$.finding.severity", "$.finding.line"]),
    );
    expect(parseReportedFinding("not a finding").ok).toBe(false);
  });

  test("applies the structured-review budgets and the per-finding byte bound", () => {
    const longTitle = parseReportedFinding(issue("x".repeat(2_000)));
    expect(!longTitle.ok && longTitle.issues[0]?.path).toBe("$.finding.title");
    // Each prose field is within its own budget; together they are not.
    const prose = "y".repeat(5 * 1024);
    const large = parseReportedFinding(
      issue("Large", {
        description: prose,
        evidence: prose,
        suggestion: prose,
        verification: prose,
      }),
    );
    expect(large.ok).toBe(false);
    expect(!large.ok && large.issues[0]?.message).toContain(
      String(REVIEW_PROVISIONAL_FINDING_MAX_BYTES),
    );
  });
});

describe("provisional finding inbox", () => {
  test("takes findings only from a running tool-mode reviewer of a live review", async () => {
    const { findings } = inbox();
    expect(findings.accepts(SCOPE, KEY)).toBe(false);
    findings.track(workflow());
    expect(findings.accepts(SCOPE, KEY)).toBe(true);
    // Another environment's credential can never reach this reviewer.
    expect(findings.accepts({ ...SCOPE, environmentId: "env-2" }, KEY)).toBe(false);
    expect(
      await findings.report({ ...SCOPE, environmentId: "env-2" }, KEY, issue("Clock resets")),
    ).toMatchObject({ ok: false, error: { code: "not_accepting" } });

    for (const settled of [
      workflow({ reviewers: [reviewer({ status: "completed" })] }),
      workflow({ reviewers: [reviewer({ status: "failed" })] }),
      workflow({ reviewers: [reviewer({ resultTransport: "structured-output-v1" })] }),
      workflow({ phase: "cancelled", reviewers: [reviewer({ status: "cancelled" })] }),
    ]) {
      findings.track(workflow());
      findings.track(settled);
      expect(findings.accepts(SCOPE, KEY)).toBe(false);
      expect(await findings.report(SCOPE, KEY, issue("Late"))).toMatchObject({
        ok: false,
        error: { code: "not_accepting" },
      });
    }
  });

  test("a restarted reviewer's old attempt is forgotten", () => {
    const { findings } = inbox();
    findings.track(workflow());
    const restartedKey = "22222222-2222-4222-8222-222222222222";
    findings.track(workflow({ reviewers: [reviewer({ requestId: restartedKey })] }));
    expect(findings.accepts(SCOPE, KEY)).toBe(false);
    expect(findings.accepts(SCOPE, restartedKey)).toBe(true);
    findings.forget("multi-1");
    expect(findings.accepts(SCOPE, restartedKey)).toBe(false);
  });

  test("refuses a closed attempt even while the reviewer still looks live", async () => {
    const { findings, state } = inbox();
    findings.track(workflow());
    state.open = false;
    expect(await findings.report(SCOPE, KEY, issue("After submission"))).toMatchObject({
      ok: false,
      error: { code: "attempt_closed", nextAction: "stop" },
    });
  });

  test("stages a finding, wakes the workflow and answers a retry with the same receipt", async () => {
    const { findings, wakes } = inbox();
    findings.track(workflow());
    const first = await findings.report(SCOPE, KEY, issue("Clock resets"));
    expect(first).toMatchObject({ ok: true, duplicate: false, provisionalCount: 1 });
    expect(wakes).toEqual(["env-1"]);
    const retry = await findings.report(SCOPE, KEY, issue("Clock resets"));
    expect(retry).toMatchObject({ ok: true, duplicate: true, provisionalCount: 1 });
    expect(first.ok && retry.ok && retry.findingId).toBe(first.ok ? first.findingId : "");
    expect(wakes).toHaveLength(1);

    const staged = findings.take(KEY);
    expect(staged).toEqual([
      {
        id: first.ok ? first.findingId : "",
        reportedAt: "2026-10-16T00:01:00.000Z",
        issue: issue("Clock resets"),
      },
    ]);
    expect(findings.take(KEY)).toEqual([]);
    // Handed to a pass, it is still known: a retry is still a duplicate.
    expect(await findings.report(SCOPE, KEY, issue("Clock resets"))).toMatchObject({
      ok: true,
      duplicate: true,
    });
  });

  test("returns correctable problems for an invalid finding without staging it", async () => {
    const { findings } = inbox();
    findings.track(workflow());
    const answer = await findings.report(SCOPE, KEY, { ...issue("Bad"), category: "vibes" });
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "invalid_finding", nextAction: "correct" },
    });
    expect(!answer.ok && answer.error.issues?.[0]?.path).toBe("$.finding.category");
    expect(findings.take(KEY)).toEqual([]);
  });

  test("keeps the first findings and refuses past the per-reviewer bound", async () => {
    const { findings } = inbox();
    // Forty already on the record, from earlier passes.
    const recorded = Array.from({ length: 40 }, (_, index) => ({
      id: index.toString(16).padStart(24, "0"),
      reportedAt: "2026-10-16T00:00:00.000Z",
      issue: issue(`Recorded ${index}`),
    }));
    findings.track(workflow({ reviewers: [reviewer({ provisionalFindings: recorded })] }));
    for (let index = 0; index < 10; index += 1) {
      expect(await findings.report(SCOPE, KEY, issue(`New ${index}`))).toMatchObject({ ok: true });
    }
    expect(await findings.report(SCOPE, KEY, issue("One too many"))).toMatchObject({
      ok: false,
      error: { code: "limit_reached", nextAction: "continue" },
    });
    expect(findings.take(KEY).map((finding) => finding.issue.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `New ${index}`),
    );
  });
});

describe("provisional findings on the reviewer record", () => {
  const finding = (title: string): ReviewerProvisionalFinding => {
    const parsed = parseReportedFinding(issue(title));
    if (!parsed.ok) throw new Error("invalid fixture");
    return { id: parsed.id, reportedAt: "2026-10-16T00:01:00.000Z", issue: parsed.issue };
  };

  test("appends oldest first, skips what it holds and stops at the bound", () => {
    const record = reviewer();
    expect(appendProvisionalFindings(record, [finding("A"), finding("B"), finding("A")])).toBe(
      true,
    );
    expect(record.provisionalFindings?.map((entry) => entry.issue.title)).toEqual(["A", "B"]);
    expect(appendProvisionalFindings(record, [finding("B")])).toBe(false);
    const many = Array.from({ length: REVIEW_PROVISIONAL_FINDINGS_MAX + 5 }, (_, index) =>
      finding(`Many ${index}`),
    );
    appendProvisionalFindings(record, many);
    expect(record.provisionalFindings).toHaveLength(REVIEW_PROVISIONAL_FINDINGS_MAX);
    expect(record.provisionalFindings?.[0]?.issue.title).toBe("A");
    expect(isReviewerRecord(record)).toBe(true);
    expect(dropProvisionalFindings(record)).toBe(true);
    expect(record).not.toHaveProperty("provisionalFindings");
    expect(dropProvisionalFindings(record)).toBe(false);
  });

  test("the record validator refuses findings past the bound or outside the contract", () => {
    expect(
      isReviewerRecord(
        reviewer({
          provisionalFindings: Array.from(
            { length: REVIEW_PROVISIONAL_FINDINGS_MAX + 1 },
            (_, index) => finding(`F${index}`),
          ),
        }),
      ),
    ).toBe(false);
    expect(
      isReviewerRecord(
        reviewer({ provisionalFindings: [{ ...finding("A"), issue: { title: "A" } as never }] }),
      ),
    ).toBe(false);
    expect(isReviewerRecord(reviewer({ provisionalFindings: [finding("A"), finding("A")] }))).toBe(
      false,
    );
  });

  test("never reach consolidation, which reads accepted reports only", () => {
    const report: StructuredReviewReport = {
      reviewScope: {
        targetBranch: "main",
        baseRef: "origin/main...HEAD",
        commit: null,
        filesReviewed: ["src/review.ts"],
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
        userImpact: "Impact",
      },
      riskProfile: { changeTypes: ["ui"], riskAreas: [], overallRisk: "low", reasoning: "Small" },
      testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
      strengths: [],
      issues: [issue("Accepted finding")],
      testCoverageGaps: [],
      verdict: { ready: "with-fixes", reasoning: "One issue" },
      summaryOfChange: "Change",
      reviewSummary: "One finding",
    };
    const reviewers = [
      reviewer({ status: "completed", report }),
      reviewer({
        id: "reviewer-2",
        status: "failed",
        error: "Session ended",
        provisionalFindings: [finding("Unconfirmed from a failed reviewer")],
      }),
      reviewer({
        id: "reviewer-3",
        status: "cancelled",
        provisionalFindings: [finding("Unconfirmed from a stopped reviewer")],
      }),
    ];
    const inputs = consolidationReports(reviewers);
    expect(inputs.map((entry) => entry.reviewerId)).toEqual(["reviewer-1"]);
    const prompt = createMultiReviewConsolidationPrompt({ targetBranch: "main", reports: inputs });
    expect(prompt).toContain("Accepted finding");
    expect(prompt).not.toContain("Unconfirmed from");
  });
});
