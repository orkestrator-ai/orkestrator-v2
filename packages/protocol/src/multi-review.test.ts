import { describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_MAX_REVIEWERS,
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
} from "./multi-review";
import type { StructuredReviewReport } from "./structured-review";

const report: StructuredReviewReport = {
  reviewScope: { targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: [], filesSkipped: [], filesLeftUncommitted: [], commandsRun: [],
    commandsNotRun: [], limitations: [] },
  whatChanged: { overview: "Change", before: "Before", after: "After", keyCodeChanges: [], userImpact: "None" },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [], issues: [], testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change", reviewSummary: "Clean",
};

describe("multi review protocol", () => {
  test("accepts one-to-many reviewer selections and rejects unbounded input", () => {
    const input = {
      environmentId: "env-1", projectId: "project-1", targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    };
    expect(isStartMultiReviewInput(input)).toBe(true);
    expect(isStartMultiReviewInput({ ...input, reviewers: [] })).toBe(false);
    expect(isStartMultiReviewInput({
      ...input,
      reviewers: Array.from({ length: MULTI_REVIEW_MAX_REVIEWERS + 1 }, () => input.reviewers[0]),
    })).toBe(false);
  });

  test("requires a consolidated report in every actionable phase", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-1", environmentId: "env-1", projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "completed", report }],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      fixSession: {
        agent: "codex", model: "gpt-5.6", sessionKey: "fix-session",
        providerSessionId: "provider-fix", requestIds: ["request-1"], status: "idle",
        startedAt: new Date(0).toISOString(),
      },
      phase: "ready",
      consolidatedReport: report,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, consolidatedReport: undefined })).toBe(false);
  });

  test("rejects unsafe branches, empty instructions, and duplicate reviewer identities", () => {
    const input = {
      environmentId: "env-1", projectId: "project-1", targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      fixModel: { agent: "codex", model: "gpt-5.6" },
    };
    expect(isStartMultiReviewInput({ ...input, targetBranch: "main; touch /tmp/x" })).toBe(false);
    expect(isStartMultiReviewInput({ ...input, reviewInstruction: "  " })).toBe(false);
    expect(isStartMultiReviewInput({ ...input, reviewers: [{ ...input.reviewers[0], id: "injected" }] })).toBe(false);

    const reviewer = { id: "same", agent: "claude", model: "opus", status: "pending" };
    expect(isMultiReviewWorkflow({
      version: MULTI_REVIEW_WORKFLOW_VERSION, controller: "backend",
      id: "workflow-1", environmentId: "env-1", projectId: "project-1", targetBranch: "main",
      reviewers: [reviewer, reviewer], fixModel: input.fixModel, phase: "reviewing",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), backendRevision: 1,
    })).toBe(false);
  });
});
