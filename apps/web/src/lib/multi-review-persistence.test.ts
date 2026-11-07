import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  isMultiReviewWorkflow,
  type MultiReviewPhase,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { workflowVocabularyFixtures } from "./workflow-vocabulary.test-support";

// Other suites import the real command wrappers, so snapshot and restore per
// the Bun mock rules in AGENTS.md rather than leaving this module faked.
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };

const listMultiReviewWorkflowsMock = mock(async (_environmentId: string): Promise<unknown[]> => []);
const getMultiReviewWorkflowMock = mock(async (_workflowId: string): Promise<unknown> => null);
const getMultiReviewWorkflowConditionalMock = mock(
  async (_workflowId: string, _knownRevision?: number): Promise<unknown> => null,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  listMultiReviewWorkflows: listMultiReviewWorkflowsMock,
  getMultiReviewWorkflow: getMultiReviewWorkflowMock,
  getMultiReviewWorkflowConditional: getMultiReviewWorkflowConditionalMock,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const {
  findActiveMultiReviewWorkflow,
  hydrateMultiReviewWorkflow,
  hydrateMultiReviewWorkflowsForEnvironment,
  isMultiReviewWorkflowKnownUnavailable,
  resetMultiReviewPersistenceForTests,
} = await import("./multi-review-persistence");
const { multiReviewStore } = await import("@/stores/multiReviewStore");
const { appCommandStore } = await import("@/test/app-command-store");

const ENVIRONMENT_ID = "env-1";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

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

const ADDRESS_FINDINGS_SESSION = {
  agent: "claude",
  model: "opus",
  sessionKey: "fix-session",
  providerSessionId: "provider-fix",
  requestIds: ["request-1"],
  status: "idle",
  startedAt: TIMESTAMP,
};

/**
 * The validator demands a consolidated report and a live Address Findings session from every
 * post-consolidation phase, an active Address Findings request while fixing, and a
 * cancellation timestamp while cancelling. A snapshot missing them is rejected
 * outright, which would make the phase under test vacuous.
 */
function phaseFields(phase: MultiReviewPhase): Record<string, unknown> {
  const settled = ["ready", "fixing", "interactive", "completed"].includes(phase)
    ? { consolidatedReport: report, fixSession: ADDRESS_FINDINGS_SESSION }
    : {};
  return {
    ...settled,
    ...(phase === "fixing"
      ? {
          activeRequest: {
            kind: "fix",
            requestId: "request-fix",
            state: "sent",
            createdAt: TIMESTAMP,
          },
        }
      : {}),
    ...(phase === "paused" ? { pausedFromPhase: "consolidating", pausedStep: "consolidate" } : {}),
    ...(phase === "cancelling" ? { cancellingSince: TIMESTAMP } : {}),
  };
}

function entry(id: string, phase: MultiReviewPhase, revision = 1) {
  return {
    id,
    environmentId: ENVIRONMENT_ID,
    version: 1,
    revision,
    updatedAt: TIMESTAMP,
    snapshot: {
      version: 1,
      controller: "backend",
      id,
      environmentId: ENVIRONMENT_ID,
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ id: `${id}-r1`, agent: "claude", model: "opus", status: "completed", report }],
      fixModel: { agent: "claude", model: "opus" },
      phase,
      ...phaseFields(phase),
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      backendRevision: revision,
    },
  };
}

beforeEach(() => {
  listMultiReviewWorkflowsMock.mockReset();
  listMultiReviewWorkflowsMock.mockImplementation(async () => []);
  getMultiReviewWorkflowMock.mockReset();
  getMultiReviewWorkflowMock.mockImplementation(async () => null);
  getMultiReviewWorkflowConditionalMock.mockReset();
  getMultiReviewWorkflowConditionalMock.mockImplementation(async () => null);
  appCommandStore(multiReviewStore).setState({ workflows: new Map() });
  resetMultiReviewPersistenceForTests();
});

describe("findActiveMultiReviewWorkflow", () => {
  test("normalizes future live snapshots and restores authoritative state after reload", async () => {
    const { review, futureReview } = workflowVocabularyFixtures();
    expect(isMultiReviewWorkflow(review)).toBe(true);
    expect(isMultiReviewWorkflow(futureReview)).toBe(false);
    const incoming = JSON.parse(JSON.stringify(futureReview)) as MultiReviewWorkflow;
    appCommandStore(multiReviewStore).getState().replaceWorkflow(incoming);
    const projected = appCommandStore(multiReviewStore).getState().workflows.get(review.id);
    expect(projected).toEqual(review);
    expect(isMultiReviewWorkflow(projected)).toBe(true);

    const persisted = {
      id: review.id,
      environmentId: review.environmentId,
      version: 1,
      revision: 8,
      updatedAt: TIMESTAMP,
      snapshot: incoming,
    };
    appCommandStore(multiReviewStore).setState({ workflows: new Map() });
    getMultiReviewWorkflowMock.mockResolvedValue(persisted);
    const restored = await hydrateMultiReviewWorkflow(review.id);
    expect(restored).toEqual({ ...review, backendRevision: 8 });
    expect(isMultiReviewWorkflow(restored)).toBe(true);
    expect<unknown>(appCommandStore(multiReviewStore).getState().workflows.get(review.id)).toEqual(
      restored,
    );

    appCommandStore(multiReviewStore).setState({ workflows: new Map() });
    listMultiReviewWorkflowsMock.mockResolvedValue([{ ...persisted, revision: 9 }]);
    expect(await hydrateMultiReviewWorkflowsForEnvironment(review.environmentId)).toEqual([
      { ...review, backendRevision: 9 },
    ]);
    expect<unknown>(incoming).toEqual(futureReview);
  });

  test("future vocabulary still rejects malformed authoritative snapshots", async () => {
    const { review, futureReview } = workflowVocabularyFixtures();
    getMultiReviewWorkflowMock.mockResolvedValue({
      id: review.id,
      environmentId: review.environmentId,
      version: 1,
      revision: 8,
      updatedAt: TIMESTAMP,
      snapshot: { ...futureReview, reviewers: "invalid" },
    });
    expect(await hydrateMultiReviewWorkflow(review.id)).toBeNull();
    expect(appCommandStore(multiReviewStore).getState().workflows.has(review.id)).toBe(false);
  });
  test("reports no active workflow for an environment that has none", async () => {
    expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
  });

  /**
   * These are exactly the phases that block a new launch in the backend, and
   * the reason a closed tab strands the environment. `ready` and `failed` in
   * particular are *not* terminal even though nothing is executing.
   */
  test.each<MultiReviewPhase>([
    "reviewing",
    "consolidating",
    "ready",
    "fixing",
    "paused",
    "cancelling",
    "failed",
  ])("treats %s as the active workflow", async (phase) => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-active", phase)]);
    const active = await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(active).toMatchObject({ id: "wf-active", phase });
  });

  test.each<MultiReviewPhase>(["interactive", "completed", "cancelled"])(
    "leaves a %s workflow free for a new launch",
    async (phase) => {
      listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-done", phase)]);
      expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
    },
  );

  test("skips terminal history to find the one active workflow", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      entry("wf-old", "cancelled"),
      entry("wf-older", "completed"),
      entry("wf-live", "reviewing", 7),
    ]);
    const active = await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(active).toMatchObject({ id: "wf-live", backendRevision: 7 });
  });

  /**
   * The launcher acts on this answer, so a record the validator rejects must
   * not be reported as blocking: it would strand the environment behind a
   * workflow the rest of the app cannot render or cancel.
   */
  test("ignores a record whose snapshot does not validate", async () => {
    const malformed = entry("wf-bad", "reviewing");
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      { ...malformed, snapshot: { ...malformed.snapshot, reviewers: "not-an-array" } },
    ]);
    expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
  });

  /**
   * The launcher runs this before deciding whether to start a workflow, so a
   * failed read must not be answered as "nothing active" — that would start a
   * second review the backend then refuses. Rejecting is what keeps the launch
   * fail-closed, and it must reach the caller rather than be swallowed here.
   */
  test("propagates a failed backend read instead of reporting no active workflow", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    await expect(findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).rejects.toThrow(
      "backend unavailable",
    );
  });

  /**
   * A failed read must also leave the projection alone. Pruning the store on the
   * way to an error would drop a workflow whose tab is open and rendering.
   */
  test("leaves the store untouched when the backend read fails", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-live", "reviewing", 3)]);
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    listMultiReviewWorkflowsMock.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID).catch(() => undefined);
    expect(appCommandStore(multiReviewStore).getState().workflows.get("wf-live")).toMatchObject({
      id: "wf-live",
      phase: "reviewing",
      backendRevision: 3,
    });
  });

  test("stamps the authoritative revision onto the store", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      entry("wf-live", "reviewing", 12),
    ]);
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(appCommandStore(multiReviewStore).getState().workflows.get("wf-live")).toMatchObject({
      id: "wf-live",
      phase: "reviewing",
      backendRevision: 12,
    });
  });
});

describe("hydrateMultiReviewWorkflow", () => {
  test("reads a held workflow conditionally and keeps it when unchanged", async () => {
    const held = entry("wf-held", "reviewing", 4);
    getMultiReviewWorkflowMock.mockResolvedValue(held);
    await hydrateMultiReviewWorkflow("wf-held");
    getMultiReviewWorkflowConditionalMock.mockResolvedValue({ unchanged: true, revision: 4 });

    const result = await hydrateMultiReviewWorkflow("wf-held");

    expect(getMultiReviewWorkflowConditionalMock).toHaveBeenCalledWith("wf-held", 4);
    expect(getMultiReviewWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: "wf-held", backendRevision: 4 });
  });

  test("a burst of change events costs one read in flight and one shared follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    getMultiReviewWorkflowMock.mockImplementation(async () => {
      await gate;
      return entry("wf-burst", "reviewing", 2);
    });

    const reads = Array.from({ length: 6 }, () => hydrateMultiReviewWorkflow("wf-burst"));
    release();
    await Promise.all(reads);

    // The first read, then one follow-up (now conditional, the record being held).
    expect(getMultiReviewWorkflowMock).toHaveBeenCalledTimes(1);
    expect(getMultiReviewWorkflowConditionalMock).toHaveBeenCalledTimes(1);
  });

  test("remembers a workflow the backend no longer has until a read finds it", async () => {
    expect(await hydrateMultiReviewWorkflow("wf-gone")).toBeNull();
    expect(isMultiReviewWorkflowKnownUnavailable("wf-gone")).toBe(true);

    getMultiReviewWorkflowMock.mockResolvedValue(entry("wf-gone", "reviewing", 1));
    await hydrateMultiReviewWorkflow("wf-gone");
    expect(isMultiReviewWorkflowKnownUnavailable("wf-gone")).toBe(false);
  });

  test("an environment listing clears the marker of a workflow it returns", async () => {
    await hydrateMultiReviewWorkflow("wf-listed");
    expect(isMultiReviewWorkflowKnownUnavailable("wf-listed")).toBe(true);
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      entry("wf-listed", "reviewing", 1),
    ]);
    await hydrateMultiReviewWorkflowsForEnvironment(ENVIRONMENT_ID);
    expect(isMultiReviewWorkflowKnownUnavailable("wf-listed")).toBe(false);
  });
});

describe("per node scope (plan item 3003)", () => {
  let windowScope: WindowScope;
  let clientA: FakeNodeClient;
  let clientB: FakeNodeClient;
  let scopeA: NodeScope;
  let scopeB: NodeScope;

  beforeEach(() => {
    windowScope = new WindowScope();
    clientA = new FakeNodeClient({ nodeId: "bk_multi-review-a" as BackendId });
    clientB = new FakeNodeClient({ nodeId: "bk_multi-review-b" as BackendId });
    scopeA = windowScope.open({ role: "command", client: clientA });
    scopeB = windowScope.open({ role: "leaf", client: clientB });
  });

  afterEach(() => windowScope.dispose());

  test("a point read goes to the scope's client and fills only that scope's store", async () => {
    clientA.respond("get_multi_review_workflow", entry("wf-a", "reviewing", 3));

    const workflow = await hydrateMultiReviewWorkflow("wf-a", scopeA);

    expect(workflow).toMatchObject({ id: "wf-a", backendRevision: 3 });
    expect(clientA.calls("get_multi_review_workflow")).toHaveLength(1);
    expect(clientB.invocations).toHaveLength(0);
    expect(getMultiReviewWorkflowMock).not.toHaveBeenCalled();
    expect(scopeA.store(multiReviewStore).getState().workflows.has("wf-a")).toBe(true);
    expect(scopeB.store(multiReviewStore).getState().workflows.size).toBe(0);
    expect(appCommandStore(multiReviewStore).getState().workflows.size).toBe(0);
  });

  test("an environment listing reads the scope's node and installs into its store", async () => {
    clientB.respond("list_multi_review_workflows", [entry("wf-b", "reviewing", 1)]);

    await hydrateMultiReviewWorkflowsForEnvironment(ENVIRONMENT_ID, scopeB);

    expect(clientB.calls("list_multi_review_workflows")[0]?.args).toEqual({
      environmentId: ENVIRONMENT_ID,
    });
    expect(listMultiReviewWorkflowsMock).not.toHaveBeenCalled();
    expect(scopeB.store(multiReviewStore).getState().workflows.has("wf-b")).toBe(true);
    expect(scopeA.store(multiReviewStore).getState().workflows.size).toBe(0);
  });

  test("unavailable markers are held per scope", async () => {
    clientA.respond("get_multi_review_workflow", null);

    expect(await hydrateMultiReviewWorkflow("wf-gone", scopeA)).toBeNull();

    expect(isMultiReviewWorkflowKnownUnavailable("wf-gone", scopeA)).toBe(true);
    expect(isMultiReviewWorkflowKnownUnavailable("wf-gone", scopeB)).toBe(false);
    expect(isMultiReviewWorkflowKnownUnavailable("wf-gone")).toBe(false);
  });
});
