import { describe, expect, test } from "bun:test";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  applyGraphConnection,
  defaultGraphDedupeKey,
  graphConnectionVerdict,
  GRAPH_NEW_PORT_HANDLE,
  type GraphConnectEnd,
} from "./graph-designer-connect";
import {
  addGraphNodeToLoop,
  createGraphLoop,
  removeGraphEdge,
  updateGraphLoop,
} from "./graph-designer-edits";
import { graphTemplateTypeLibrary } from "./graph-designer-model";

function verdict(template: GraphTemplateV1, from: GraphConnectEnd, to: GraphConnectEnd) {
  return graphConnectionVerdict(template, graphTemplateTypeLibrary(template), from, to);
}

function connect(template: GraphTemplateV1, from: GraphConnectEnd, to: GraphConnectEnd) {
  const result = verdict(template, from, to);
  if (!result.ok) throw new Error(result.reason);
  return applyGraphConnection(template, graphTemplateTypeLibrary(template), result);
}

/** The bake-off without its sub-graph: Build feeds the PR directly. */
function bakeOff(): GraphTemplateV1 {
  const template = graphTemplateExample("design-bake-off");
  template.nodes = template.nodes.filter((node) => node.id !== "review");
  template.edges = template.edges.filter(
    (edge) => edge.id !== "build-review" && !edge.id.startsWith("review-"),
  );
  template.roles = template.roles.filter((role) =>
    ["designer", "judge", "builder", "describer"].includes(role.key),
  );
  template.limits.maxAgentSessions = 6;
  template.acknowledgements = [];
  return template;
}

describe("graphConnectionVerdict", () => {
  test("accepts assignable ports, in either drag direction", () => {
    const template = removeGraphEdge(bakeOff(), "describe-pr-pr");
    const from = { node: "describe-pr", handle: "out:description" };
    const to = { node: "pr", handle: "in:description" };
    const forward = verdict(template, from, to);
    expect(forward).toMatchObject({ ok: true, plan: { kind: "edge" } });
    expect(verdict(template, to, from)).toEqual(forward);
  });

  test("refuses incompatible types with the assignability reason", () => {
    const template = bakeOff();
    const result = verdict(
      template,
      { node: "describe-pr", handle: "out:description" },
      { node: "pr", handle: "in:code" },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/pr-description@1|workspace@1/);
  });

  test("one value into a list port is not an edge", () => {
    const template = bakeOff();
    const result = verdict(
      template,
      { node: "judge", handle: "out:brief" },
      { node: "judge", handle: "in:briefs" },
    );
    expect(result.ok).toBe(false);
    const fresh = verdict(
      { ...template, edges: template.edges.filter((edge) => edge.id !== "design-judge") },
      { node: "approve", handle: "outlet:approved" },
      { node: "judge", handle: "in:briefs" },
    );
    expect(fresh.ok).toBe(false);
  });

  test("a replicated producer fans in to a list port", () => {
    const template = removeGraphEdge(bakeOff(), "design-judge");
    const result = verdict(
      template,
      { node: "design", handle: "out:brief" },
      { node: "judge", handle: "in:briefs" },
    );
    expect(result).toMatchObject({ ok: true, plan: { kind: "edge", fanIn: true } });
  });

  test("a fan-in into a single value of a type without items makes the port a list", () => {
    const template = bakeOff();
    const result = connect(
      template,
      { node: "design", handle: "out:brief" },
      { node: "build", handle: "in:brief" },
    );
    const build = result.template.nodes.find((node) => node.id === "build")!;
    expect(build.inputs!.find((port) => port.name === "brief")!.type).toBe("list<design-brief@1>");
  });

  test("a fan-in into a single value of a type with items inserts a dedupe merge (D11)", () => {
    const template = structuredClone(graphBuiltInTemplate("multi-review")!.template);
    delete template.engine;
    // Cut the consolidator out: reviewers now feed the gate's single report directly.
    template.edges = template.edges.filter(
      (edge) => !(edge.to.node === "has-findings" && edge.to.port === "report"),
    );
    const before = verdict(
      template,
      { node: "review", handle: "out:report" },
      { node: "has-findings", handle: "in:report" },
    );
    expect(before).toMatchObject({ ok: true, plan: { kind: "fan-in-merge" } });
    const result = connect(
      template,
      { node: "review", handle: "out:report" },
      { node: "has-findings", handle: "in:report" },
    );
    const merge = result.template.nodes.find((node) => node.id === result.createdNodeId)!;
    expect(merge).toMatchObject({
      kind: "merge",
      strategy: { kind: "dedupe", key: ["file", "line", "title"] },
      inputs: [{ name: "sources", type: "list<review-report@1>" }],
      outputs: [{ name: "report", type: "review-report@1" }],
    });
    const edges = result.template.edges.filter(
      (edge) => edge.to.node === merge.id || ("node" in edge.from && edge.from.node === merge.id),
    );
    expect(edges).toHaveLength(2);
    const compiled = compile(result.template);
    expect(
      compiled.diagnostics.filter(
        (diagnostic) => diagnostic.nodeId === merge.id && diagnostic.severity === "error",
      ),
    ).toEqual([]);
  });

  test("replicated into replicated over the same branches zips", () => {
    const template = bakeOff();
    const judge = template.nodes.find((node) => node.id === "judge")!;
    if (judge.kind !== "agent") throw new Error("judge is an agent");
    const design = template.nodes.find((node) => node.id === "design")!;
    if (design.kind !== "agent") throw new Error("design is an agent");
    judge.replicate = structuredClone(design.replicate);
    judge.inputs!.push({ name: "single", type: "design-brief@1" });
    const result = verdict(
      template,
      { node: "design", handle: "out:brief" },
      { node: "judge", handle: "in:single" },
    );
    expect(result).toMatchObject({ ok: true, plan: { kind: "edge", zip: true } });
  });

  test("an edge back inside a loop is a carry; outside a loop it is refused", () => {
    const template = structuredClone(graphBuiltInTemplate("build-pipeline")!.template);
    delete template.engine;
    const loop = template.loops![0]!;
    const result = verdict(
      { ...template, loops: [{ ...loop, carry: [] }] },
      { node: "verify", handle: "out:code" },
      { node: "fix", handle: "in:code" },
    );
    expect(result).toMatchObject({ ok: true, plan: { kind: "carry", loopId: loop.id } });
    const outside = verdict(
      { ...template, loops: [] },
      { node: "verify", handle: "out:code" },
      { node: "fix", handle: "in:code" },
    );
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.reason).toContain("cycle");
  });

  test("the + handle adds an input of the delivered type (a list from a replicated node)", () => {
    const template = bakeOff();
    const result = connect(
      template,
      { node: "design", handle: "out:brief" },
      { node: "describe-pr", handle: GRAPH_NEW_PORT_HANDLE },
    );
    const node = result.template.nodes.find((entry) => entry.id === "describe-pr")!;
    expect(node.inputs!.at(-1)).toEqual({ name: "brief2", type: "list<design-brief@1>" });
    expect(result.template.edges.at(-1)).toMatchObject({
      from: { node: "design", port: "brief" },
      to: { node: "describe-pr", port: "brief2" },
    });
  });

  test("an outlet forwards the input that fits the target port", () => {
    const template = removeGraphEdge(bakeOff(), "approved-build");
    const result = connect(
      template,
      { node: "approve", handle: "outlet:approved" },
      { node: "build", handle: "in:brief" },
    );
    expect(result.template.edges.at(-1)).toMatchObject({
      from: { node: "approve", outlet: "approved", port: "brief" },
      to: { node: "build", port: "brief" },
    });
  });

  test("run outputs: rebind an existing one, or add one from + output", () => {
    const template = bakeOff();
    const added = connect(
      template,
      { node: "build", handle: "out:code" },
      { node: "$outputs", handle: GRAPH_NEW_PORT_HANDLE },
    );
    expect(added.template.outputs!.at(-1)).toEqual({
      name: "code",
      type: "workspace@1",
      from: { node: "build", port: "code" },
    });
    const refused = verdict(
      template,
      { node: "$inputs", handle: "out:ticket" },
      { node: "$outputs", handle: GRAPH_NEW_PORT_HANDLE },
    );
    expect(refused.ok).toBe(false);
  });

  test("inside a loop, a second producer from outside becomes firstIterationFrom", () => {
    const template = structuredClone(graphBuiltInTemplate("build-pipeline")!.template);
    delete template.engine;
    const prepare = template.nodes.find((node) => node.id === "prepare")!;
    const port = prepare.inputs!.find((entry) => entry.name === "code")!;
    delete port.firstIterationFrom;
    const into = template.edges.filter(
      (edge) => edge.to.node === "prepare" && edge.to.port === "code",
    );
    const outside = into.find((edge) => "node" in edge.from && edge.from.node === "build")!;
    const withoutOutside = removeGraphEdge(template, outside.id);
    const result = connect(
      withoutOutside,
      { node: "build", handle: "out:code" },
      { node: "prepare", handle: "in:code" },
    );
    const after = result.template.nodes.find((node) => node.id === "prepare")!;
    expect(after.inputs!.find((entry) => entry.name === "code")!.firstIterationFrom).toEqual({
      node: "build",
      port: "code",
    });
  });

  test("defaultGraphDedupeKey falls back to id without items", () => {
    expect(defaultGraphDedupeKey(null)).toEqual(["id"]);
  });
});

describe("building report §9 shapes with canvas operations", () => {
  test("§9.2: the Build Pipeline's loop, from its nodes and plain edges, compiles", () => {
    const example = graphTemplateExample("build-pipeline-loop");
    // Start from the nodes and the edges that are not the loop's: no region,
    // no carries, no firstIterationFrom, no fix → prepare edge.
    let template: GraphTemplateV1 = structuredClone(example);
    delete template.loops;
    template.edges = template.edges.filter((edge) => edge.id !== "fix-prepare");
    for (const node of template.nodes) {
      for (const port of node.inputs ?? []) delete port.firstIterationFrom;
    }
    const members = example.loops![0]!.nodes;
    const created = createGraphLoop(template, [members[0]!]);
    template = created.template;
    for (const member of members.slice(1))
      template = addGraphNodeToLoop(template, member, created.loopId);
    template = updateGraphLoop(template, created.loopId, (loop) => ({
      ...loop,
      id: loop.id,
      until: example.loops![0]!.until,
      maxIterations: 3,
    }));
    // A second producer into prepare.code from inside the loop: iteration 1 reads Build.
    template = connect(
      template,
      { node: "fix", handle: "out:code" },
      { node: "prepare", handle: "in:code" },
    ).template;
    const prepare = template.nodes.find((node) => node.id === "prepare")!;
    expect(prepare.inputs!.find((port) => port.name === "code")!.firstIterationFrom).toEqual({
      node: "build",
      port: "code",
    });
    // Back edges inside the region become carries.
    template = connect(
      template,
      { node: "verify", handle: "out:verdict" },
      { node: "fix", handle: "in:feedback" },
    ).template;
    template = connect(
      template,
      { node: "verify", handle: "out:code" },
      { node: "fix", handle: "in:code" },
    ).template;
    expect(template.loops![0]!.carry).toHaveLength(2);
    const result = compile(template);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });
});
