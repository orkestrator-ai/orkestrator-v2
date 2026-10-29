import { describe, expect, test } from "bun:test";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  GRAPH_INPUTS_NODE_ID,
  GRAPH_OUTPUTS_NODE_ID,
  graphTemplateOrder,
  layoutGraphTemplate,
} from "./graph-designer-layout";
import {
  buildGraphCanvasModel,
  graphCarryEdgeId,
  graphOutputEdgeId,
  indexGraphDiagnostics,
  type GraphCanvasTemplateNode,
} from "./graph-designer-model";

function pipeline(): GraphTemplateV1 {
  return graphBuiltInTemplate("build-pipeline")!.template;
}

function compiledModel(template: GraphTemplateV1) {
  const result = compile(template);
  return {
    result,
    model: buildGraphCanvasModel({ template, plan: result.plan, diagnostics: result.diagnostics }),
  };
}

function templateNode(model: ReturnType<typeof buildGraphCanvasModel>, id: string) {
  return model.nodes.find(
    (node): node is GraphCanvasTemplateNode => node.type === "graph-node" && node.id === id,
  )!;
}

describe("graph designer layout", () => {
  test("orders nodes topologically, ties in template order, and survives cycles", () => {
    const template = pipeline();
    const order = graphTemplateOrder(template);
    expect(new Set(order).size).toBe(template.nodes.length);
    const rank = new Map(order.map((id, index) => [id, index]));
    for (const edge of template.edges) {
      if ("input" in edge.from) continue;
      expect(rank.get(edge.from.node)!).toBeLessThan(rank.get(edge.to.node)!);
    }
    // A cycle (the compiler reports it) still yields every node once.
    const cyclic = structuredClone(template);
    cyclic.edges.push({
      id: "back",
      from: { node: "push", port: "code" },
      to: { node: "setup", port: "ticket" },
    });
    expect(new Set(graphTemplateOrder(cyclic)).size).toBe(template.nodes.length);
  });

  test("lays out in layers with run inputs left and outputs right, and frames each loop", () => {
    const template = pipeline();
    const layout = layoutGraphTemplate(template);
    expect(layout.fromTemplate).toBe(false);
    const inputs = layout.boxes.get(GRAPH_INPUTS_NODE_ID)!;
    const outputs = layout.boxes.get(GRAPH_OUTPUTS_NODE_ID)!;
    for (const node of template.nodes) {
      const box = layout.boxes.get(node.id)!;
      expect(box.x).toBeGreaterThan(inputs.x);
      expect(box.x).toBeLessThan(outputs.x);
    }
    // Producers sit left of consumers.
    for (const edge of template.edges) {
      if ("input" in edge.from) continue;
      expect(layout.boxes.get(edge.from.node)!.x).toBeLessThan(layout.boxes.get(edge.to.node)!.x);
    }
    // The loop frame holds its members and no other node.
    const loop = template.loops![0]!;
    const frame = layout.loops.get(loop.id)!;
    const inside = (id: string) => {
      const box = layout.boxes.get(id)!;
      return (
        box.x >= frame.x &&
        box.y >= frame.y &&
        box.x + box.width <= frame.x + frame.width &&
        box.y + box.height <= frame.y + frame.height
      );
    };
    for (const member of loop.nodes) expect(inside(member)).toBe(true);
    for (const node of template.nodes) {
      if (!loop.nodes.includes(node.id)) expect(inside(node.id)).toBe(false);
    }
  });

  test("uses the template's own layout when it places every node", () => {
    const template = pipeline();
    template.layout = Object.fromEntries(
      template.nodes.map((node, index) => [node.id, { x: index * 300, y: (index % 3) * 200 }]),
    );
    const layout = layoutGraphTemplate(template);
    expect(layout.fromTemplate).toBe(true);
    expect(layout.boxes.get("build")).toMatchObject(template.layout.build!);
    // A partial layout is ignored rather than mixed with automatic positions.
    delete template.layout.build;
    expect(layoutGraphTemplate(template).fromTemplate).toBe(false);
  });
});

describe("buildGraphCanvasModel", () => {
  test("projects nodes, typed handles, loop groups, carries and run outputs", () => {
    const template = pipeline();
    const { model, result } = compiledModel(template);
    expect(result.ok).toBe(true);
    // Groups first: React Flow needs parents before children.
    expect(model.nodes[0]!.type).toBe("graph-loop");
    const loopId = template.loops![0]!.id;
    const review = templateNode(model, "review");
    expect(review.parentId).toBe(`loop:${loopId}`);
    expect(review.extent).toBe("parent");
    expect(review.data.detail).toBe("reviewer · reviewer");
    expect(review.data.inputs.map((port) => port.handleId)).toEqual(["in:package", "in:ticket"]);
    expect(review.data.inputs.map((port) => port.family)).toEqual(["package", "ticket"]);
    expect(review.data.replication).toMatch(/^×/);
    expect(review.data.enforcement).toBe("provider-configured");
    // Gates expose outlets; their edges leave from `outlet:<name>`.
    const gate = templateNode(model, "has-issues");
    expect(gate.data.outlets.length).toBeGreaterThan(0);
    const fromOutlet = template.edges.find(
      (edge) => !("input" in edge.from) && edge.from.node === "has-issues",
    )!;
    const drawn = model.edges.find((edge) => edge.id === fromOutlet.id)!;
    expect(drawn.sourceHandle).toBe(`outlet:${(fromOutlet.from as { outlet: string }).outlet}`);
    // Run inputs leave the `$inputs` node.
    expect(model.edges.find((edge) => edge.id === "ticket-setup")).toMatchObject({
      source: GRAPH_INPUTS_NODE_ID,
      sourceHandle: "out:ticket",
      target: "setup",
      targetHandle: "in:ticket",
    });
    // Carries are dashed back edges; run outputs end at `$outputs`.
    const carries = model.edges.filter((edge) => edge.data?.kind === "carry");
    expect(carries.map((edge) => edge.id)).toContain(graphCarryEdgeId(loopId, 0));
    expect(model.edges.find((edge) => edge.id === graphOutputEdgeId("pr"))?.target).toBe(
      GRAPH_OUTPUTS_NODE_ID,
    );
    // Delivered types colour the edges once compiled.
    const edge = model.edges.find((candidate) => candidate.id === "setup-build")!;
    expect(edge.data).toMatchObject({
      kind: "edge",
      family: "workspace",
      typeLabel: "workspace@1",
    });
    expect(model.undrawnEdges).toEqual([]);
    // Keyboard order is the plan's topological order.
    expect(model.order).toEqual(result.plan!.order);
  });

  test("pins diagnostics to nodes, edges and loops", () => {
    const template = pipeline();
    const prepare = template.nodes.find((node) => node.id === "prepare")!;
    prepare.inputs![0]!.type = "decision@1";
    const { model, result } = compiledModel(template);
    expect(result.ok).toBe(false);
    const mismatched = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "edge-type-mismatch",
    )!;
    expect(mismatched.edgeId).toBe("build-prepare");
    const edge = model.edges.find((candidate) => candidate.id === mismatched.edgeId)!;
    expect(edge.data!.diagnostics.errors).toBe(1);
    // Without a plan, edges fall back to the producer's declared type.
    expect(edge.data!.typeLabel).toBe("workspace@1");
    expect(templateNode(model, "prepare").data.diagnostics.warnings).toBeGreaterThan(0);
    const index = indexGraphDiagnostics(result.diagnostics);
    expect(index.edges.get("build-prepare")).toEqual([mismatched]);
    expect(index.nodes.get("prepare")!.every((diagnostic) => diagnostic.nodeId === "prepare")).toBe(
      true,
    );

    const looped = pipeline();
    looped.loops![0]!.maxIterations = 11;
    const loopModel = compiledModel(looped).model;
    const loop = loopModel.nodes.find((node) => node.type === "graph-loop")!;
    expect((loop.data as { diagnostics: { errors: number } }).diagnostics.errors).toBe(1);
  });

  test("leaves out edges to missing nodes or ports and reports them", () => {
    const template = graphTemplateExample("multi-review");
    template.edges[0]!.to.node = "ghost";
    const { model } = compiledModel(template);
    expect(model.undrawnEdges).toEqual([template.edges[0]!.id]);
    expect(model.edges.some((edge) => edge.id === template.edges[0]!.id)).toBe(false);
  });

  test("marks system nodes whose action has a side effect", () => {
    const template = pipeline();
    const { model } = compiledModel(template);
    const system = template.nodes.filter((node) => node.kind === "system");
    expect(system.length).toBeGreaterThan(0);
    for (const node of template.nodes) {
      const face = templateNode(model, node.id);
      const marked = node.kind === "system" && GRAPH_SYSTEM_ACTION_SPECS[node.action].sideEffect;
      expect(face.data.sideEffect).toBe(marked ? true : undefined);
      expect(face.ariaLabel!.includes("side effect")).toBe(marked);
    }
    const waiting = pipeline();
    waiting.nodes = waiting.nodes.map((node) =>
      node.kind === "system" ? { ...node, action: "wait-for-checks" } : node,
    );
    const faces = compiledModel(waiting).model;
    expect(system.every((node) => templateNode(faces, node.id).data.sideEffect === undefined)).toBe(
      true,
    );
  });

  test("labels node faces by kind and replication", () => {
    const template = graphTemplateExample("multi-review");
    const { model } = compiledModel(template);
    for (const node of template.nodes) {
      const face = templateNode(model, node.id);
      expect(face.data.title).toBe(node.label ?? node.id);
      expect(face.ariaLabel).toContain(face.data.title);
    }
  });
});
