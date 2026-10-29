import { describe, expect, test } from "bun:test";
import { compile } from "./compile.js";
import type { GraphPlanHumanNode } from "./plan.js";
import { validateGraphRun } from "./run-guards.js";
import {
  GRAPH_HUMAN_BOUNDS,
  graphHumanAnswerOutlet,
  graphHumanAnswerProblem,
  graphHumanForwardedOutputs,
  graphRunPendingInteractions,
  type GraphHumanWait,
} from "./run-human.js";
import type { NodeActivation } from "./run-model.js";
import { graphRunFixture } from "./run-fixtures.test-support.js";
import { graphActivationKey } from "./run-identity.js";
import type { GraphTemplateV1 } from "./template-model.js";

const WAIT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AT = "2026-10-29T00:00:00.000Z";
const ARTIFACT = "b".repeat(64);

function template(human: Record<string, unknown>, edges: unknown[] = []): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "people",
    revision: 1,
    name: "People",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "brief", type: "text@1" }],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "check",
        kind: "human",
        inputs: [{ name: "brief", type: "text@1" }],
        ...human,
      },
      {
        id: "escalate",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: { template: "Escalate.\n\n{{> input.failure}}\n" },
        inputs: [{ name: "failure", type: "error@1" }],
        outputs: [{ name: "done", type: "text@1" }],
      },
    ],
    edges: [{ id: "in", from: { input: "brief" }, to: { node: "check", port: "brief" } }, ...edges],
    limits: { maxAgentSessions: 2, maxConcurrentAgents: 1 },
  } as unknown as GraphTemplateV1;
}

const ERROR_EDGE = {
  id: "timeout",
  from: { node: "check", port: "error" },
  to: { node: "escalate", port: "failure" },
};

function humanPlanNode(form: GraphPlanHumanNode["form"]): GraphPlanHumanNode {
  return {
    kind: "human",
    id: "check",
    form,
    inputs: [{ name: "brief", type: "text@1" }],
  } as unknown as GraphPlanHumanNode;
}

function waitingActivation(wait: Partial<GraphHumanWait> = {}): NodeActivation {
  const parts = { nodeId: "check", iteration: 1, attempt: 1 };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state: "awaiting-human",
    inputs: { brief: ARTIFACT },
    outputs: {},
    human: { id: WAIT_ID, form: "approve", openedAt: AT, ...wait },
    createdAt: AT,
    startedAt: AT,
  };
}

describe("human node compile", () => {
  test("a timeout routes to an implicit error@1 port by default", () => {
    const result = compile(
      template({ form: { kind: "approve" }, timeoutMs: 60_000 }, [ERROR_EDGE]),
    );
    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const node = result.plan!.nodes.find((entry) => entry.id === "check")!;
    expect(node.onFailure).toBe("route");
    expect(node.outputs).toEqual([
      expect.objectContaining({ name: "error", type: "error@1", required: false }),
    ]);
  });

  test("without a timeout or route the error port does not exist", () => {
    const result = compile(template({ form: { kind: "approve" } }, [ERROR_EDGE]));
    expect(result.plan).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain("outlet-required");
    // An explicit route works without a timeout, and fail-run opts out of it.
    expect(
      compile(template({ form: { kind: "approve" }, onFailure: "route" }, [ERROR_EDGE])).plan,
    ).not.toBeNull();
    expect(
      compile(
        template({ form: { kind: "approve" }, timeoutMs: 60_000, onFailure: "fail-run" }, [
          ERROR_EDGE,
        ]),
      ).plan,
    ).toBeNull();
  });
});

describe("human answers", () => {
  test("outlets follow the form", () => {
    const approve = humanPlanNode({ kind: "approve" });
    expect(graphHumanAnswerOutlet(approve, { decision: "approve" })).toBe("approved");
    expect(graphHumanAnswerOutlet(approve, { decision: "reject" })).toBe("rejected");
    expect(graphHumanAnswerOutlet(approve, { decision: "choose", outlet: "approved" })).toBeNull();
    const choose = humanPlanNode({
      kind: "choose",
      options: [
        { to: "fast", label: "Fast" },
        { to: "slow", label: "Slow" },
      ],
    });
    expect(graphHumanAnswerOutlet(choose, { decision: "choose", outlet: "slow" })).toBe("slow");
    expect(graphHumanAnswerOutlet(choose, { decision: "choose", outlet: "x" })).toBeNull();
  });

  test("stale, repeated, mismatched and oversized answers are refused", () => {
    const edit = humanPlanNode({ kind: "edit", edit: "brief" });
    const activation = waitingActivation({ form: "edit" });
    expect(
      graphHumanAnswerProblem(edit, activation, { waitId: WAIT_ID, decision: "approve" }),
    ).toBeNull();
    expect(
      graphHumanAnswerProblem(edit, activation, {
        waitId: WAIT_ID,
        decision: "approve",
        value: { text: "x" },
      }),
    ).toBeNull();
    expect(
      graphHumanAnswerProblem(edit, activation, { waitId: "other", decision: "approve" }),
    ).toContain("another attempt");
    expect(
      graphHumanAnswerProblem(
        edit,
        waitingActivation({
          form: "edit",
          answer: { decision: "approve", outlet: "approved", at: AT, by: "user" },
        }),
        { waitId: WAIT_ID, decision: "approve" },
      ),
    ).toContain("already answered");
    expect(
      graphHumanAnswerProblem(
        edit,
        { ...activation, state: "cancelled" },
        {
          waitId: WAIT_ID,
          decision: "approve",
        },
      ),
    ).toContain("cancelled");
    expect(
      graphHumanAnswerProblem(edit, activation, { waitId: WAIT_ID, decision: "reject", value: {} }),
    ).toContain("Only an approval");
    expect(
      graphHumanAnswerProblem(edit, activation, {
        waitId: WAIT_ID,
        decision: "approve",
        value: { text: "x".repeat(GRAPH_HUMAN_BOUNDS.maxEditBytes + 1) },
      }),
    ).toContain("exceeds");
    expect(
      graphHumanAnswerProblem(edit, activation, {
        waitId: WAIT_ID,
        decision: "approve",
        note: "\u0000",
      }),
    ).toContain("control");
    expect(
      graphHumanAnswerProblem(humanPlanNode({ kind: "approve" }), activation, {
        waitId: WAIT_ID,
        decision: "approve",
        value: {},
      }),
    ).toContain("Only an edit step");
  });

  test("a decided node forwards its single inputs, an edit in place of the original", () => {
    const activation = { inputs: { brief: ARTIFACT, list: ["c".repeat(64)] } };
    expect(graphHumanForwardedOutputs(activation, {})).toEqual({ brief: ARTIFACT });
    expect(
      graphHumanForwardedOutputs(activation, {
        edited: { port: "brief", artifactId: "d".repeat(64) },
      }),
    ).toEqual({ brief: "d".repeat(64) });
  });
});

describe("human waits in the run record", () => {
  test("the record validator accepts a wait and refuses a malformed one", () => {
    const parts = { nodeId: "build", iteration: 1, attempt: 1 };
    const activation = (human: unknown) =>
      ({
        key: graphActivationKey(parts),
        ...parts,
        state: "awaiting-human",
        inputs: {},
        outputs: {},
        human,
        createdAt: AT,
      }) as NodeActivation;
    const valid = {
      id: WAIT_ID,
      form: "edit",
      openedAt: AT,
      answer: {
        decision: "approve",
        outlet: "approved",
        edited: { port: "brief", artifactId: ARTIFACT },
        note: "Fine",
        at: AT,
        by: "user",
      },
    };
    expect(validateGraphRun(graphRunFixture({ activations: [activation(valid)] })).ok).toBe(true);
    for (const broken of [
      { ...valid, id: "nope" },
      { ...valid, form: "approve" },
      { ...valid, answer: { ...valid.answer, decision: "reject" } },
      { ...valid, answer: { ...valid.answer, by: "agent" } },
      { ...valid, extra: true },
    ]) {
      expect(validateGraphRun(graphRunFixture({ activations: [activation(broken)] })).ok).toBe(
        false,
      );
    }
  });

  test("pending interactions list open waits and questions, never a stopping run's", () => {
    const plan = compile(
      template(
        {
          label: "Check it",
          form: { kind: "edit", edit: "brief", instructions: "Read it." },
          timeoutMs: 60_000,
        },
        [ERROR_EDGE],
      ),
    ).plan!;
    const run = graphRunFixture({
      plan,
      status: "waiting",
      activations: [waitingActivation({ form: "edit" })],
    });
    expect(graphRunPendingInteractions(run)).toEqual([
      {
        kind: "human",
        runId: run.id,
        activationKey: run.activations[0]!.key,
        nodeId: "check",
        title: "Check it",
        openedAt: AT,
        waitId: WAIT_ID,
        form: "edit",
        instructions: "Read it.",
        edit: { port: "brief", type: "text@1", artifactId: ARTIFACT },
        timeoutAt: "2026-10-29T00:01:00.000Z",
      },
    ]);
    expect(graphRunPendingInteractions({ ...run, status: "cancelling" })).toEqual([]);
    expect(
      graphRunPendingInteractions({
        ...run,
        activations: [
          waitingActivation({
            form: "edit",
            answer: { decision: "reject", outlet: "rejected", at: AT, by: "user" },
          }),
        ],
      }),
    ).toEqual([]);
  });
});
