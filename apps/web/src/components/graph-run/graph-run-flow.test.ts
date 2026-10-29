import { describe, expect, test } from "bun:test";
import { graphActivationSlot } from "@orkestrator/protocol/graphs/run";
import {
  GRAPH_RUN_INPUTS_NODE_ID,
  graphActivationFlowState,
  graphBranchLabel,
  graphRunFlowModel,
  type GraphRunFlowModel,
} from "./graph-run-flow";
import { act, runOf } from "./graph-run.test-fixtures";

function columnIndex(model: GraphRunFlowModel, id: string): number {
  const index = model.columns.findIndex((column) => column.nodeIds.includes(id));
  if (index < 0) throw new Error(`no column holds ${id}`);
  return index;
}

function slot(nodeId: string, iteration = 1, branchKey?: string): string {
  return graphActivationSlot({ nodeId, iteration, ...(branchKey ? { branchKey } : {}) });
}

function node(model: GraphRunFlowModel, id: string) {
  const found = model.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("graphRunFlowModel", () => {
  test("a run that has not started draws every position faded, left to right", () => {
    const run = runOf("multi-review");
    const model = graphRunFlowModel(run.plan, run);
    expect(model.columns[0]!.nodeIds).toEqual([GRAPH_RUN_INPUTS_NODE_ID]);
    const order = ["plan", "package", "review", "consolidate", "has-findings", "fix"];
    const columns = order.map((id) =>
      columnIndex(model, id === "review" ? slot(id, 1, "panel.1") : slot(id)),
    );
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
    expect(new Set(columns).size).toBe(columns.length);
    for (const flow of model.nodes) {
      if (flow.kind === "position") {
        expect(flow.placeholder).toBe(true);
        expect(flow.state).toBe("not-started");
      }
    }
    // Only the run's inputs are there; nothing has flowed between nodes yet.
    for (const edge of model.edges) {
      expect(edge.state).toBe(edge.from === GRAPH_RUN_INPUTS_NODE_ID ? "ready" : "pending");
    }
  });

  test("replicated activations share a column, one node per branch", () => {
    const run = runOf("multi-review", {
      activations: [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review", branchKey: "panel.1" }, { state: "running" }),
        act({ nodeId: "review", branchKey: "panel.2" }),
      ],
    });
    const model = graphRunFlowModel(run.plan, run);
    const first = slot("review", 1, "panel.1");
    const second = slot("review", 1, "panel.2");
    expect(columnIndex(model, first)).toBe(columnIndex(model, second));
    const column = model.columns[columnIndex(model, first)]!;
    expect(column.nodeIds).toEqual([first, second]);
    expect(column.label).toBe("review · 1/2");
    expect(node(model, first)).toMatchObject({ state: "running", title: "review · Panel 1" });
    expect(node(model, second)).toMatchObject({ state: "complete", placeholder: false });
    // Both branches fan into consolidation; the finished one is ready, the running one pending.
    const into = model.edges.filter((edge) => edge.to === slot("consolidate"));
    expect(into.map((edge) => [edge.from, edge.state])).toEqual([
      [first, "pending"],
      [second, "ready"],
    ]);
  });

  test("a gate shows the outlet it took; the other outlet's consumers are skipped", () => {
    const run = runOf("multi-review", {
      status: "complete",
      activations: [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review", branchKey: "panel.1" }),
        act({ nodeId: "review", branchKey: "panel.2" }),
        act({ nodeId: "consolidate" }),
        act({ nodeId: "has-findings" }, { outlet: "clean" }),
        act({ nodeId: "fix" }, { state: "skipped", startedAt: undefined }),
      ],
    });
    const model = graphRunFlowModel(run.plan, run);
    const gate = node(model, slot("has-findings"));
    expect(gate.outlet).toBe("clean");
    const fix = node(model, slot("fix"));
    expect(fix).toMatchObject({ skipped: true, state: "cancelled", placeholder: false });
    const untaken = model.edges.find(
      (edge) => edge.from === slot("has-findings") && edge.to === slot("fix"),
    )!;
    expect(untaken).toMatchObject({ untaken: true, state: "pending" });
    // describe-pr and pr were never reached in a finished run: faded.
    expect(node(model, slot("pr")).placeholder).toBe(true);
  });

  test("loop iterations unroll to the right", () => {
    const run = runOf("build-pipeline-loop", {
      loopIterations: { rounds: 2 },
      activations: [
        act({ nodeId: "build" }),
        act({ nodeId: "fix" }, { state: "skipped", startedAt: undefined }),
        act({ nodeId: "prepare" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review" }),
        act({ nodeId: "has-issues" }, { outlet: "issues" }),
        act({ nodeId: "address" }),
        act({ nodeId: "verify" }),
        act({ nodeId: "fix", iteration: 2 }, { state: "running" }),
      ],
    });
    const model = graphRunFlowModel(run.plan, run);
    const verify1 = columnIndex(model, slot("verify", 1));
    const fix2 = columnIndex(model, slot("fix", 2));
    const verify2 = columnIndex(model, slot("verify", 2));
    expect(fix2).toBeGreaterThan(verify1);
    expect(verify2).toBeGreaterThan(fix2);
    expect(columnIndex(model, slot("review", 2))).toBeGreaterThan(
      columnIndex(model, slot("review", 1)),
    );
    // The labels name the round once a loop is drawn more than once.
    expect(model.columns[columnIndex(model, slot("review", 1))]!.label).toContain("review 1");
    expect(model.columns[columnIndex(model, slot("review", 2))]!.label).toContain("review 2");
    // Round 2 is entered: its positions not reached yet are drawn ahead, faded.
    expect(node(model, slot("verify", 2)).placeholder).toBe(true);
    // The carry feeds round 2 from round 1's verify.
    expect(
      model.edges.some((edge) => edge.from === slot("verify", 1) && edge.to === slot("fix", 2)),
    ).toBe(true);
    // A third round is not drawn before it is entered.
    expect(model.nodes.some((flow) => flow.iteration === 3)).toBe(false);
  });

  test("superseded activations collapse into one previous attempt node, expandable", () => {
    const old = act(
      { nodeId: "consolidate" },
      { state: "superseded", supersededBy: "rewind-1", error: undefined },
    );
    const oldGate = act(
      { nodeId: "has-findings" },
      { state: "superseded", supersededBy: "rewind-1" },
    );
    const run = runOf("multi-review", {
      activations: [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act({ nodeId: "review", branchKey: "panel.1" }),
        act({ nodeId: "review", branchKey: "panel.2" }),
        old,
        oldGate,
        act({ nodeId: "consolidate", attempt: 2 }, { state: "running" }),
      ],
      rewinds: [
        {
          id: "rewind-1",
          kind: "restart",
          nodeId: "consolidate",
          activation: old.key,
          iteration: 1,
          requestedAt: "2026-10-29T10:06:00.000Z",
          requestedBy: "user",
          superseded: { activations: [old.key, oldGate.key], artifacts: [] },
        },
      ],
    });
    const collapsed = graphRunFlowModel(run.plan, run);
    const attempt = node(collapsed, "attempt:rewind-1");
    expect(attempt).toMatchObject({
      kind: "attempt",
      title: "Previous attempt",
      superseded: true,
      attemptExpanded: false,
      attemptActivationKeys: [old.key, oldGate.key],
    });
    // In the column of the node the restart reran, beside the live rerun.
    expect(columnIndex(collapsed, attempt.id)).toBe(columnIndex(collapsed, slot("consolidate")));
    expect(collapsed.nodes.some((flow) => flow.id === old.key)).toBe(false);
    // The live position shows the rerun, and the superseded attempt is not one of its attempts.
    expect(node(collapsed, slot("consolidate"))).toMatchObject({ state: "running" });
    expect(node(collapsed, slot("consolidate")).attempts).toHaveLength(1);

    const expanded = graphRunFlowModel(run.plan, run, { expandedAttempts: new Set(["rewind-1"]) });
    expect(node(expanded, "attempt:rewind-1").attemptExpanded).toBe(true);
    expect(node(expanded, old.key)).toMatchObject({ kind: "superseded", superseded: true });
    expect(columnIndex(expanded, oldGate.key)).toBe(columnIndex(expanded, slot("has-findings")));
  });

  test("retries stay on one position; the face shows the newest attempt", () => {
    const run = runOf("multi-review", {
      activations: [
        act({ nodeId: "plan" }, { state: "failed", error: "Timed out after 600 s" }),
        act({ nodeId: "plan", attempt: 2 }, { state: "running" }),
      ],
    });
    const model = graphRunFlowModel(run.plan, run);
    const plan = node(model, slot("plan"));
    expect(plan.state).toBe("running");
    expect(plan.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(plan.error).toBeUndefined();
  });

  test("a node waiting on the user is highlighted", () => {
    const run = runOf("multi-review", {
      status: "waiting",
      activations: [act({ nodeId: "plan" }, { state: "awaiting-human" })],
    });
    const model = graphRunFlowModel(run.plan, run);
    expect(node(model, slot("plan"))).toMatchObject({ waitingForHuman: true, state: "paused" });
    // While the run stops, nothing is shown as waiting any more.
    const stopping = graphRunFlowModel(run.plan, { ...run, status: "cancelling" });
    expect(node(stopping, slot("plan"))).toMatchObject({
      waitingForHuman: false,
      state: "cancelling",
    });
  });

  test("the inputs node is complete once the run has its inputs", () => {
    const run = runOf("multi-review");
    const model = graphRunFlowModel(run.plan, run);
    expect(node(model, GRAPH_RUN_INPUTS_NODE_ID).state).toBe("complete");
    expect(
      model.edges.some(
        (edge) => edge.from === GRAPH_RUN_INPUTS_NODE_ID && edge.to === slot("plan"),
      ),
    ).toBe(true);
  });
});

describe("graph run flow helpers", () => {
  test("branch labels read as words", () => {
    expect(graphBranchLabel("panel.2")).toBe("Panel 2");
    expect(graphBranchLabel("panel.1+lens.security")).toBe("Panel 1 · security");
    expect(graphBranchLabel("sample.3")).toBe("Sample 3");
  });

  test("activation states map onto the shared vocabulary", () => {
    const running = { status: "running" } as const;
    expect(graphActivationFlowState(undefined, running)).toBe("not-started");
    expect(graphActivationFlowState(act({ nodeId: "x" }, { state: "ready" }), running)).toBe(
      "not-started",
    );
    expect(graphActivationFlowState(act({ nodeId: "x" }, { state: "admitting" }), running)).toBe(
      "running",
    );
    expect(graphActivationFlowState(act({ nodeId: "x" }, { state: "skipped" }), running)).toBe(
      "cancelled",
    );
    expect(
      graphActivationFlowState(act({ nodeId: "x" }, { state: "running" }), {
        status: "cancelling",
      }),
    ).toBe("cancelling");
  });
});
