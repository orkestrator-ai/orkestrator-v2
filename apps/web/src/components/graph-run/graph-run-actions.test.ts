import { describe, expect, test } from "bun:test";
import { graphRunFlowModel } from "./graph-run-flow";
import { graphRunNodeActions, graphRunSessionTabOptions } from "./graph-run-actions";
import { POLICY, act, agentSession, runOf } from "./graph-run.test-fixtures";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";

function actionsFor(run: GraphRun, nodeId: string, branchKey?: string) {
  const model = graphRunFlowModel(run.plan, run);
  const node = model.nodes.find(
    (candidate) => candidate.nodeId === nodeId && candidate.branchKey === branchKey,
  )!;
  return graphRunNodeActions(run, node).map((action) => action.key);
}

describe("graphRunNodeActions", () => {
  test("a failed branch of a live run offers retry, restart and rewind code", () => {
    const run = runOf("multi-review", {
      activations: [
        act({ nodeId: "plan" }),
        act({ nodeId: "package" }),
        act(
          { nodeId: "review", branchKey: "panel.1" },
          { state: "failed", inputs: { package: "artifact-package" } },
        ),
      ],
    });
    expect(actionsFor(run, "review", "panel.1")).toEqual(["retry", "restart", "pause", "cancel"]);
    const plan = runOf("multi-review", {
      activations: [act({ nodeId: "plan" }, { inputs: { code: "artifact-target" } })],
    });
    // The plan node reads a workspace@1 commit: its code can be rewound to.
    expect(actionsFor(plan, "plan")).toEqual(["restart", "rewind-code", "pause", "cancel"]);
  });

  test("a failed run offers restart but no retry; a finished run no run-wide controls", () => {
    const run = runOf("multi-review", {
      status: "failed",
      activations: [act({ nodeId: "plan" }, { state: "failed" })],
    });
    expect(actionsFor(run, "plan")).toEqual(["restart"]);
  });

  test("a queued position offers skip; a position not reached offers nothing of its own", () => {
    const run = runOf("multi-review", {
      status: "paused",
      activations: [act({ nodeId: "plan" }, { state: "ready", startedAt: undefined })],
    });
    expect(actionsFor(run, "plan")).toEqual(["skip", "resume", "cancel"]);
    expect(actionsFor(run, "package")).toEqual(["resume", "cancel"]);
  });

  test("an agent activation with a provider session can be opened in its own tab", () => {
    const activation = act(
      { nodeId: "plan" },
      {
        state: "running",
        policy: POLICY,
        enforcement: "enforced",
        session: agentSession({ turnMode: "read-only", effort: "high" }),
      },
    );
    const run = runOf("multi-review", { activations: [activation] });
    expect(actionsFor(run, "plan")).toEqual(["open-session", "pause", "cancel"]);
    expect(graphRunSessionTabOptions(run, { title: "plan" }, activation)).toMatchObject({
      tabId: `graph-run-session:run-1:${activation.key}`,
      resumeSessionId: "provider-session-1",
      initialReasoningEffort: "high",
      initialConversationMode: "plan",
      requireExistingResumeSession: true,
    });
  });
});
