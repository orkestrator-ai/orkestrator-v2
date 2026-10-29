/**
 * `items` fan-out records and branch keys (item 401): key derivation from
 * stable item ids, truncation, branches crossed with other axes, the run
 * record's validation, supersession on rewind, and `sourceItem` in the
 * artifact identity.
 */
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import type { GraphPlanNode } from "./plan.js";
import { graphNodeBranches } from "./run-branches.js";
import {
  graphActivationBranch,
  graphItemBranchSegment,
  graphItemFanOutItems,
  graphListItemCandidates,
  graphLiveItemFanOut,
  graphNodeItemsAxis,
  graphRunNodeBranches,
  graphTypedItemCandidates,
  supersedeGraphItemFanOuts,
} from "./run-fanout.js";
import {
  activationFixture,
  artifactFixture,
  graphRunFixture,
  RUN_FIXTURE_AT,
} from "./run-fixtures.test-support.js";
import {
  validateGraphArtifact,
  validateGraphRun,
  verifyGraphArtifactIdentity,
} from "./run-guards.js";
import { graphArtifactId, isGraphBranchKey } from "./run-identity.js";
import { applyGraphRewind } from "./run-lineage.js";
import { GRAPH_RUN_BOUNDS, type GraphItemFanOut, type GraphRun } from "./run-model.js";
import type { GraphTemplateV1 } from "./template.js";

const ID = (n: number) => n.toString(16).padStart(64, "0");

function failureDiagnosisRun(overrides: Partial<GraphRun> = {}): GraphRun {
  const plan = compile(graphTemplateExample("failure-diagnosis")).plan!;
  return graphRunFixture({
    plan,
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    bindings: {
      roles: { diagnoser: { platform: "claude" }, fixer: { platform: "codex" } },
      params: {},
      inputs: {},
    },
    loopIterations: { repair: 1 },
    ...overrides,
  });
}

function diagnoseNode(run: GraphRun): GraphPlanNode {
  return run.plan.nodes.find((node) => node.id === "diagnose")!;
}

function fanOut(overrides: Partial<GraphItemFanOut> = {}): GraphItemFanOut {
  const { items } = graphItemFanOutItems(
    [
      { id: "validate/failure-1", artifact: ID(1) },
      { id: "validate/failure-2", artifact: ID(2) },
    ],
    12,
  );
  return {
    nodeId: "diagnose",
    iteration: 1,
    sources: [ID(1), ID(2)],
    items,
    total: 2,
    createdAt: RUN_FIXTURE_AT,
    ...overrides,
  };
}

describe("item branch keys", () => {
  test("encode the item's stable id into the branch key grammar", () => {
    expect(graphItemBranchSegment("validate/failure-3")).toBe("item.validate:failure-3");
    expect(graphItemBranchSegment("validate/iter-2/failure-1")).toBe(
      "item.validate:iter-2:failure-1",
    );
    // A run input's `$` is dropped; `+` (the axis separator) becomes `_`.
    expect(graphItemBranchSegment("$input/findings/issue-2")).toBe("item.input:findings:issue-2");
    expect(graphItemBranchSegment("review/panel.1+lens.api/issue-1")).toBe(
      "item.review:panel.1_lens.api:issue-1",
    );
    const long = `${"a".repeat(80)}/issue-1`;
    expect(graphItemBranchSegment(long)).toMatch(/^item\.h-[0-9a-f]{16}$/);
    expect(graphItemBranchSegment(long)).toBe(graphItemBranchSegment(long));
    for (const id of ["validate/failure-3", "$input/x/y-1", "a b/c", long]) {
      expect(isGraphBranchKey(`panel.12+lens.performance+${graphItemBranchSegment(id)}`)).toBe(
        true,
      );
    }
  });

  test("follow the item, not its position: a reordered input keeps each item's key", () => {
    const ids = ["validate/failure-1", "validate/failure-2", "validate/failure-3"];
    const forward = graphItemFanOutItems(
      ids.map((id) => ({ id, artifact: ID(1) })),
      12,
    ).items;
    const reversed = graphItemFanOutItems(
      [...ids].reverse().map((id) => ({ id, artifact: ID(1) })),
      12,
    ).items;
    const keyOf = (items: typeof forward) => new Map(items.map((item) => [item.id, item.key]));
    expect(keyOf(reversed)).toEqual(keyOf(forward));
    // The index is the position in this input (`{{item.index}}`).
    expect(reversed.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(reversed[0]!.id).toBe("validate/failure-3");
  });

  test("a repeated id gets .2, .3 by occurrence", () => {
    const { items } = graphItemFanOutItems(
      [
        { id: "x/item-1", artifact: ID(1) },
        { id: "x/item-1", artifact: ID(2) },
        { id: "x/item-1", artifact: ID(3) },
      ],
      12,
    );
    expect(items.map((item) => item.key)).toEqual([
      "item.x:item-1",
      "item.x:item-1.2",
      "item.x:item-1.3",
    ]);
  });
});

describe("truncation", () => {
  test("keeps the first maxBranches items and names the rest, bounded", () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      id: `validate/failure-${index + 1}`,
      artifact: ID(index + 1),
    }));
    const result = graphItemFanOutItems(candidates, 12);
    expect(result.items).toHaveLength(12);
    expect(result.total).toBe(50);
    expect(result.truncatedIds).toHaveLength(GRAPH_RUN_BOUNDS.maxTruncatedItemIds);
    expect(result.truncatedIds[0]).toBe("validate/failure-13");
    expect(graphItemFanOutItems(candidates.slice(0, 3), 12).truncatedIds).toEqual([]);
  });
});

describe("item candidates", () => {
  test("a list element is its source item, else its producer's label", () => {
    const producer = (activation: string) => ({ nodeId: "review", activation, port: "report" });
    const candidates = graphListItemCandidates([
      {
        id: ID(1),
        producer: producer("review#iter=1#attempt=1"),
        sourceItem: "validate/failure-2",
      },
      { id: ID(2), producer: producer("review#iter=1#branch=panel.2#attempt=1") },
      { id: ID(3), producer: producer("diagnose#iter=1#attempt=1") },
      { id: ID(4), producer: producer("diagnose#iter=1#attempt=1") },
    ]);
    expect(candidates).toEqual([
      { id: "validate/failure-2", artifact: ID(1) },
      { id: "review/panel.2", artifact: ID(2) },
      { id: "diagnose/item-1", artifact: ID(3) },
      { id: "diagnose/item-2", artifact: ID(4) },
    ]);
  });

  test("a type with items gives each entry its stable id", () => {
    const candidates = graphTypedItemCandidates(
      {
        id: ID(9),
        producer: { nodeId: "review", activation: "review#iter=1#attempt=1", port: "r" },
      },
      { path: "issues", idPrefix: "issue" },
      { issues: [{}, {}] },
    );
    expect(candidates).toEqual([
      { id: "review/issue-1", artifact: ID(9) },
      { id: "review/issue-2", artifact: ID(9) },
    ]);
  });
});

describe("branches", () => {
  test("an items axis takes the recorded items; crossed with a panel, keys join in axis order", () => {
    const run = failureDiagnosisRun();
    const node = diagnoseNode(run);
    expect(graphNodeItemsAxis(node)).toEqual({
      input: "failures",
      maxBranches: 12,
      truncate: "first",
    });
    expect(() => graphNodeBranches(node, run.bindings.roles)).toThrow(/known only once/);
    const recorded = fanOut();
    expect(graphNodeBranches(node, run.bindings.roles, recorded.items)!.map((b) => b.key)).toEqual([
      "item.validate:failure-1",
      "item.validate:failure-2",
    ]);
    const crossed = structuredClone(node) as Extract<GraphPlanNode, { kind: "agent" }>;
    crossed.replicate = {
      ...crossed.replicate!,
      axes: [{ over: "panel", role: "panel" }, ...crossed.replicate!.axes],
    };
    const branches = graphNodeBranches(
      crossed,
      { ...run.bindings.roles, panel: [{ platform: "claude" }, { platform: "codex" }] },
      recorded.items,
    )!;
    expect(branches.map((branch) => branch.key)).toEqual([
      "panel.1+item.validate:failure-1",
      "panel.1+item.validate:failure-2",
      "panel.2+item.validate:failure-1",
      "panel.2+item.validate:failure-2",
    ]);
    expect(branches[3]).toMatchObject({ panelIndex: 1, role: "panel", item: recorded.items[1] });
  });

  test("a run reads the live fan-out of a position; before it there are no branches", () => {
    const recorded = fanOut();
    const run = failureDiagnosisRun({
      fanOuts: [{ ...recorded, iteration: 1, supersededBy: "rw-1" }, recorded],
    });
    const node = diagnoseNode(run);
    expect(graphLiveItemFanOut(run, "diagnose", 1)).toBe(recorded);
    expect(graphRunNodeBranches(run, node, 2)).toBeUndefined();
    expect(graphRunNodeBranches(run, node, 1)).toHaveLength(2);
    expect(
      graphActivationBranch(run, node, { iteration: 1, branchKey: "item.validate:failure-2" })?.item
        ?.id,
    ).toBe("validate/failure-2");
    // An unreplicated node keeps its single position.
    const fix = run.plan.nodes.find((entry) => entry.id === "fix")!;
    expect(graphRunNodeBranches(run, fix, 1)).toBeNull();
  });
});

describe("the run record", () => {
  test("validates fan-outs", () => {
    const recorded = fanOut({ truncatedIds: ["validate/failure-3"], total: 3 });
    expect(validateGraphRun(failureDiagnosisRun({ fanOuts: [recorded] })).ok).toBe(true);
    const codes = (fanOuts: unknown) =>
      (
        validateGraphRun({ ...failureDiagnosisRun(), fanOuts }) as { errors?: { code: string }[] }
      ).errors?.map((error) => error.code) ?? [];
    expect(codes([recorded, recorded])).toContain("duplicate");
    expect(codes([{ ...recorded, total: 1 }])).toContain("out_of_range");
    expect(codes([{ ...recorded, nodeId: "nope" }])).toContain("unknown_node");
    expect(codes([{ ...recorded, supersededBy: "rw-missing" }])).toContain("mismatch");
    expect(codes([{ ...recorded, items: [{ ...recorded.items[0]!, key: "panel.1" }] }])).toContain(
      "pattern",
    );
  });

  test("a rewind that supersedes a fan-out's source supersedes the fan-out", () => {
    const recorded = fanOut();
    const other = fanOut({ iteration: 2, sources: [ID(7)] });
    expect(
      supersedeGraphItemFanOuts([recorded, other], "rw-1", new Set([ID(2)]))!.map(
        (entry) => entry.supersededBy,
      ),
    ).toEqual(["rw-1", undefined]);
    const validate = activationFixture({ nodeId: "validate" });
    const run = failureDiagnosisRun({ activations: [validate], fanOuts: [recorded] });
    const change = applyGraphRewind(run, {
      id: "rw-1",
      kind: "restart",
      nodeId: "validate",
      activation: validate.key,
      iteration: 1,
      requestedAt: RUN_FIXTURE_AT,
      requestedBy: "user",
      superseded: { activations: [validate.key], artifacts: [ID(1)] },
    });
    expect(change.ok && change.run.fanOuts?.[0]?.supersededBy).toBe("rw-1");
    expect(change.ok && validateGraphRun(change.run).ok).toBe(true);
  });
});

describe("sourceItem on artifacts", () => {
  test("is part of the id when present, so equal elements of different items differ", () => {
    const base = artifactFixture("run-1", { type: "validation-failure@1", value: { id: "a" } });
    const identity = {
      digest: base.digest,
      runId: base.runId,
      producer: base.producer,
      inputs: base.inputs,
    };
    expect(graphArtifactId(identity)).toBe(base.id);
    const first = graphArtifactId({ ...identity, sourceItem: "validate/failure-1" });
    const second = graphArtifactId({ ...identity, sourceItem: "validate/failure-2" });
    expect(new Set([base.id, first, second]).size).toBe(3);
    const withItem = { ...base, id: first, sourceItem: "validate/failure-1" };
    expect(validateGraphArtifact(withItem).ok).toBe(true);
    expect(verifyGraphArtifactIdentity(withItem)).toEqual({ ok: true });
    expect(verifyGraphArtifactIdentity({ ...withItem, sourceItem: "validate/failure-2" })).toEqual({
      ok: false,
      field: "id",
    });
  });
});

describe("compiling items fan-out", () => {
  test("§9.4: the plan fills truncate and prices the worst case at maxBranches", () => {
    const result = compile(graphTemplateExample("failure-diagnosis"));
    const diagnose = result.plan!.nodes.find((node) => node.id === "diagnose")!;
    expect(diagnose.fanOut).toEqual({ min: 0, max: 12 });
    expect(diagnose.kind === "agent" && diagnose.replicate?.axes).toEqual([
      { over: "items", input: "failures", maxBranches: 12, truncate: "first" },
    ]);
    expect(diagnose.inputs.find((port) => port.name === "failures")?.perBranch).toBe(true);
    const cost = result.cost!.nodes.find((node) => node.nodeId === "diagnose")!;
    expect(cost.agentSessions).toEqual({ best: 0, worst: 36 });
  });

  test("crossed with a panel the bounds multiply; past 32 branches or the limits it refuses", () => {
    const crossed = (maxBranches: number, limits?: GraphTemplateV1["limits"]) => {
      const template = graphTemplateExample("failure-diagnosis");
      template.roles.push({ key: "panel", multiplicity: "panel", maxPanel: 3 });
      const diagnose = template.nodes.find((node) => node.id === "diagnose")!;
      if (diagnose.kind !== "agent") throw new Error("diagnose is an agent");
      diagnose.replicate = {
        over: "cross",
        axes: [
          { over: "panel", role: "panel" },
          { over: "items", input: "failures", maxBranches },
        ],
      };
      if (limits) template.limits = limits;
      return compile(template);
    };
    const ok = crossed(4, { maxAgentSessions: 39, maxConcurrentAgents: 12 });
    expect(ok.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(ok.plan!.nodes.find((node) => node.id === "diagnose")!.fanOut).toEqual({
      min: 0,
      max: 12,
    });
    const wide = crossed(11);
    expect(wide.diagnostics.map((d) => d.code)).toContain("fanout-too-wide");
    const over = crossed(4, { maxAgentSessions: 20, maxConcurrentAgents: 12 });
    expect(over.diagnostics.map((d) => d.code)).toContain("limit-agent-sessions");
  });

  test("an input of a type that declares items replicates per entry", () => {
    const template = graphTemplateExample("failure-diagnosis");
    const diagnose = template.nodes.find((node) => node.id === "diagnose")!;
    if (diagnose.kind !== "agent") throw new Error("diagnose is an agent");
    diagnose.inputs![1]!.type = "validation-results@1";
    diagnose.replicate = { over: "items", input: "failures", maxBranches: 12, truncate: "fail" };
    diagnose.when = { path: "failures.failures", op: "nonEmpty" };
    diagnose.prompt = {
      template:
        "Find the root cause. Do not change any files.\n\n{{> input.code}}\n\nFailure {{item.index}} ({{item.id}}): `{{item.command}}` {{item.summary}}\n",
    };
    const edge = template.edges.find((entry) => entry.id === "validate-diagnose-failures")!;
    delete edge.transform;
    const result = compile(template);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(
      result.plan!.nodes.find((node) => node.id === "diagnose")!.kind === "agent" &&
        (result.plan!.nodes.find((node) => node.id === "diagnose") as { replicate: unknown })
          .replicate,
    ).toMatchObject({ axes: [{ truncate: "fail" }] });
  });
});
