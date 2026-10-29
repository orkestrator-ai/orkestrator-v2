/**
 * The Multi Review engine setting and the graph-engine record fields (item
 * 301): the setting resolves with its override, graph-engine records
 * validate, and every stored bespoke record shape stays readable unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_DEFAULT_ENGINE,
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewEngine,
  isMultiReviewWorkflow,
  resolveMultiReviewEngine,
} from "./multi-review";
import type { StructuredReviewReport } from "./structured-review";

const report: StructuredReviewReport = {
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

const session = {
  agent: "claude",
  model: "opus",
  sessionKey: "fix-key",
  providerSessionId: "provider-fix",
  requestIds: ["request-1"],
  status: "idle",
  startedAt: new Date(0).toISOString(),
};

/** A bespoke record as every release before item 301 stored it. */
const bespoke = {
  version: MULTI_REVIEW_WORKFLOW_VERSION,
  controller: "backend",
  id: "workflow-1",
  environmentId: "env-1",
  projectId: "project-1",
  targetBranch: "main",
  reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
  fixModel: { agent: "claude", model: "opus" },
  phase: "reviewing",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  backendRevision: 3,
};

const graph = {
  ...bespoke,
  id: "workflow-2",
  engine: "graph",
  graphRun: { runId: "multi-review-workflow-2", projectedRevision: 4 },
};

describe("the engine setting", () => {
  test("defaults to bespoke; the override wins; unknown values are ignored", () => {
    expect(MULTI_REVIEW_DEFAULT_ENGINE).toBe("bespoke");
    expect(resolveMultiReviewEngine(undefined, undefined)).toBe("bespoke");
    expect(resolveMultiReviewEngine("graph", undefined)).toBe("graph");
    expect(resolveMultiReviewEngine("graph", " BESPOKE ")).toBe("bespoke");
    expect(resolveMultiReviewEngine("bespoke", "graph")).toBe("graph");
    expect(resolveMultiReviewEngine("graph", "")).toBe("graph");
    expect(resolveMultiReviewEngine("graph", "turbo")).toBe("graph");
    expect(resolveMultiReviewEngine("turbo", undefined)).toBe("bespoke");
    expect(isMultiReviewEngine("graph")).toBe(true);
    expect(isMultiReviewEngine("Graph")).toBe(false);
  });
});

describe("stored Multi Review records", () => {
  test("bespoke records of every earlier shape stay readable and are unchanged", () => {
    expect(isMultiReviewWorkflow(bespoke)).toBe(true);
    expect(
      isMultiReviewWorkflow({
        ...bespoke,
        phase: "completed",
        consolidatedReport: report,
        fixSession: session,
      }),
    ).toBe(true);
    // The graph engine's relaxations are graph-only: a bespoke Fix still needs
    // its session and journaled request.
    expect(
      isMultiReviewWorkflow({ ...bespoke, phase: "completed", consolidatedReport: report }),
    ).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...bespoke,
        phase: "fixing",
        consolidatedReport: report,
        fixSession: session,
      }),
    ).toBe(false);
  });

  test("a graph-engine record names its run, and only a graph record may", () => {
    expect(isMultiReviewWorkflow(graph)).toBe(true);
    expect(
      isMultiReviewWorkflow({ ...graph, graphRun: { runId: "multi-review-x", settled: true } }),
    ).toBe(true);
    expect(isMultiReviewWorkflow({ ...graph, graphRun: undefined })).toBe(false);
    expect(isMultiReviewWorkflow({ ...bespoke, graphRun: graph.graphRun })).toBe(false);
    expect(isMultiReviewWorkflow({ ...graph, engine: "bespoke" })).toBe(false);
    for (const graphRun of [
      {},
      { runId: "" },
      { runId: "x".repeat(129) },
      { runId: "r", projectedRevision: -1 },
      { runId: "r", projectedRevision: 1.5 },
      { runId: "r", settled: "yes" },
      { runId: "r", extra: true },
    ]) {
      expect(isMultiReviewWorkflow({ ...graph, graphRun })).toBe(false);
    }
  });

  test("a graph Fix is fixing from admission and completes without a journaled request", () => {
    expect(isMultiReviewWorkflow({ ...graph, phase: "fixing", consolidatedReport: report })).toBe(
      true,
    );
    expect(
      isMultiReviewWorkflow({
        ...graph,
        phase: "completed",
        consolidatedReport: report,
        fixSession: session,
      }),
    ).toBe(true);
    // The report is still required, as for any review past consolidation.
    expect(isMultiReviewWorkflow({ ...graph, phase: "ready" })).toBe(false);
  });
});
