import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  isGraphEngineProjection,
  multiReviewDiscovery,
  multiReviewObligation,
  resultKeysAwaitingTurnEnd,
  stableJitterMs,
  supervisionDemand,
} from "./multi-review-scheduling.js";

function workflow(fields: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return {
    id: "workflow",
    environmentId: "env-1",
    phase: "reviewing",
    reviewers: [],
    ...fields,
  } as unknown as MultiReviewWorkflow;
}

describe("multi review obligations", () => {
  test("name every runnable state, not only running phases", () => {
    expect(multiReviewObligation(workflow({ phase: "reviewing" }), true)).toBe("reviewers");
    expect(multiReviewObligation(workflow({ phase: "consolidating" }), true)).toBe("step");
    expect(multiReviewObligation(workflow({ phase: "cancelling" }), true)).toBe("cancelling");
    expect(
      multiReviewObligation(
        workflow({ phase: "completed", pendingResultConsumptions: ["k"] }),
        true,
      ),
    ).toBe("result-consumption");
    // The durable interactive handoff is owed only when a dispatcher exists.
    const handoff = workflow({ phase: "interactive", addressPromptPending: true });
    expect(multiReviewObligation(handoff, true)).toBe("address-handoff");
    expect(multiReviewObligation(handoff, false)).toBeNull();
    const fix = workflow({
      phase: "interactive",
      fixSession: { status: "running" } as MultiReviewWorkflow["fixSession"],
    });
    expect(multiReviewObligation(fix, true)).toBe("interactive-fix");
    const pausedStop = workflow({
      phase: "paused",
      pausedStep: "fix",
      fixSession: { status: "running" } as MultiReviewWorkflow["fixSession"],
    });
    expect(multiReviewObligation(pausedStop, true)).toBe("paused-stop");
    // A successful Address Findings's PR launch is owed in any phase, until delivered.
    const prLaunch = (state: NonNullable<MultiReviewWorkflow["autoPrLaunch"]>["state"]) =>
      workflow({ phase: "interactive", autoPrLaunch: { state, requestId: "pr" } });
    expect(multiReviewObligation(prLaunch("pending"), true)).toBe("pr-handoff");
    expect(multiReviewObligation(prLaunch("pending"), false)).toBe("pr-handoff");
    for (const settled of ["launched", "skipped", "failed"] as const) {
      expect(multiReviewObligation(prLaunch(settled), true)).toBeNull();
    }
    expect(multiReviewObligation(workflow({ phase: "paused" }), true)).toBeNull();
    expect(multiReviewObligation(workflow({ phase: "ready" }), true)).toBeNull();
    expect(multiReviewObligation(workflow({ phase: "completed" }), true)).toBeNull();
  });

  test("discovery skips unreadable and settled records without hiding others", () => {
    const records = [
      { id: "a", snapshot: workflow({ id: "a", phase: "completed" }) },
      { id: "b", snapshot: { garbage: true } },
      { id: "c", snapshot: workflow({ id: "c", phase: "reviewing", environmentId: "env-9" }) },
    ];
    const isWorkflow = (value: unknown): value is MultiReviewWorkflow =>
      typeof value === "object" && value !== null && "phase" in value;
    expect(multiReviewDiscovery(records, isWorkflow, true)).toEqual({
      entries: [{ key: "c", obligation: "reviewers", target: "env-9" }],
      scanned: 3,
      complete: true,
    });
  });
});

describe("graph-engine reviews (item 301)", () => {
  const graph = (fields: Partial<MultiReviewWorkflow> = {}) =>
    workflow({ engine: "graph", graphRun: { runId: "multi-review-workflow" }, ...fields });

  test("an unsettled graph review only projects its run, in every phase", () => {
    for (const phase of ["preparing", "reviewing", "ready", "fixing", "completed"] as const) {
      const record = graph({
        phase,
        // Bespoke obligations it carries are the run's, not the service's.
        autoPrLaunch: { state: "pending", requestId: "pr" },
        pendingResultConsumptions: ["k"],
      });
      expect(isGraphEngineProjection(record)).toBe(true);
      expect(multiReviewObligation(record, true)).toBe("graph-run");
      expect(supervisionDemand(record, true)).toBe("observe");
    }
    expect(supervisionDemand(graph({ phase: "cancelling" }), true)).toBe("fast");
  });

  test("a settled graph review and every bespoke record follow the bespoke rules", () => {
    const settled = graph({
      phase: "interactive",
      addressPromptPending: true,
      graphRun: { runId: "multi-review-workflow", settled: true },
    });
    expect(isGraphEngineProjection(settled)).toBe(false);
    expect(multiReviewObligation(settled, true)).toBe("address-handoff");
    expect(
      multiReviewObligation(
        graph({ phase: "ready", graphRun: { runId: "r", settled: true } }),
        true,
      ),
    ).toBeNull();
    expect(isGraphEngineProjection(workflow({ phase: "reviewing" }))).toBe(false);
    expect(multiReviewObligation(workflow({ phase: "reviewing" }), true)).toBe("reviewers");
  });
});

describe("stable workflow jitter", () => {
  test("is stable and bounded", () => {
    expect(stableJitterMs("workflow-a", 1_000)).toBe(stableJitterMs("workflow-a", 1_000));
    for (const id of ["a", "b", "c", "workflow-with-a-long-identifier"]) {
      const jitter = stableJitterMs(id, 1_000);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1_000);
    }
    expect(stableJitterMs("a", 0)).toBe(0);
  });
});

describe("result slots awaiting their turn's end (todo 7557)", () => {
  type Reviewer = MultiReviewWorkflow["reviewers"][number];
  const reviewer = (fields: Partial<Reviewer>): Reviewer =>
    ({ id: "r", agent: "codex", model: "default", status: "running", ...fields }) as Reviewer;

  test("name the sent tool-mode step request", () => {
    const step = (request: Partial<NonNullable<MultiReviewWorkflow["activeRequest"]>>) =>
      workflow({
        phase: "consolidating",
        activeRequest: {
          kind: "consolidate",
          requestId: "step",
          state: "sent",
          resultTransport: "tool-v1",
          createdAt: "now",
          ...request,
        },
      });
    expect(resultKeysAwaitingTurnEnd(step({}))).toEqual(["step"]);
    // Not dispatched yet, or a provider structured-output turn: no tool slot to wait on.
    expect(resultKeysAwaitingTurnEnd(step({ state: "prepared" }))).toEqual([]);
    expect(resultKeysAwaitingTurnEnd(step({ state: "dispatching" }))).toEqual([]);
    expect(resultKeysAwaitingTurnEnd(step({ resultTransport: "structured-output-v1" }))).toEqual(
      [],
    );
  });

  test("name each running reviewer's sent tool-mode request while reviewing", () => {
    const reviewing = workflow({
      phase: "reviewing",
      reviewers: [
        reviewer({ requestId: "a", dispatchState: "sent", resultTransport: "tool-v1" }),
        reviewer({ requestId: "b", dispatchState: "prepared", resultTransport: "tool-v1" }),
        reviewer({
          requestId: "c",
          dispatchState: "sent",
          resultTransport: "structured-output-v1",
        }),
        reviewer({
          requestId: "d",
          dispatchState: "sent",
          resultTransport: "tool-v1",
          status: "completed",
        }),
      ],
    });
    expect(resultKeysAwaitingTurnEnd(reviewing)).toEqual(["a"]);
    expect(resultKeysAwaitingTurnEnd({ ...reviewing, phase: "consolidating" })).toEqual([]);
  });
});
