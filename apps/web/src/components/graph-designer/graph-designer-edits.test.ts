import { describe, expect, test } from "bun:test";
import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { validateGraphTemplate, type GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  acknowledgeGraphWarning,
  addGraphNode,
  addGraphNodeToLoop,
  arrangeGraphLayout,
  blankGraphTemplate,
  createGraphLoop,
  graphIdFrom,
  graphKeyFrom,
  graphLoopOf,
  moveGraphNodes,
  removeGraphAcknowledgements,
  removeGraphInputPort,
  removeGraphNode,
  removeGraphNodeFromLoop,
  removeGraphOutputPort,
  renameGraphInputPort,
  renameGraphNode,
  renameGraphOutputPort,
  renameGraphRunInput,
  uniqueGraphId,
} from "./graph-designer-edits";

function pipeline(): GraphTemplateV1 {
  const template = structuredClone(graphBuiltInTemplate("build-pipeline")!.template);
  delete template.engine;
  return template;
}

describe("graph designer edits", () => {
  test("names: kebab ids and camel keys, made unique", () => {
    expect(graphIdFrom("Open Pull Request")).toBe("open-pull-request");
    expect(graphIdFrom("reviewerLens_2")).toBe("reviewer-lens-2");
    expect(graphIdFrom("123")).toBe("node");
    expect(graphKeyFrom("pr description")).toBe("prDescription");
    expect(uniqueGraphId("agent", ["agent", "agent-2"])).toBe("agent-3");
  });

  test("never mutates the template it is given", () => {
    const template = pipeline();
    const frozen = JSON.stringify(template);
    renameGraphNode(template, "verify", "check");
    removeGraphNode(template, "review");
    moveGraphNodes(template, { build: { x: 5, y: 5 } });
    createGraphLoop(template, ["build"]);
    expect(JSON.stringify(template)).toBe(frozen);
  });

  test("adding a node writes the whole layout and gives an agent its own role", () => {
    const { template, nodeId } = addGraphNode(
      blankGraphTemplate(),
      { kind: "agent" },
      { x: 10.4, y: 20.6 },
    );
    expect(nodeId).toBe("agent");
    expect(template.layout).toEqual({ agent: { x: 10, y: 21 } });
    expect(template.roles).toEqual([{ key: "agent", multiplicity: "one" }]);
    expect(validateGraphTemplate(template).ok).toBe(true);
    const second = addGraphNode(
      template,
      { kind: "system", action: "open-pull-request" },
      { x: 300, y: 0 },
    );
    expect(second.nodeId).toBe("open-pull-request");
    const node = second.template.nodes.at(-1)!;
    expect(node.inputs!.map((port) => port.name)).toEqual(["code", "description"]);
  });

  test("moving one node materialises every position so the saved layout is honoured", () => {
    const template = pipeline();
    delete template.layout;
    const moved = moveGraphNodes(template, { build: { x: 1, y: 2 } });
    expect(Object.keys(moved.layout!).sort()).toEqual(template.nodes.map((node) => node.id).sort());
    expect(moved.layout!.build).toEqual({ x: 1, y: 2 });
  });

  test("renaming a node rewrites edges, loops, carries, conditions, outputs and layout", () => {
    const template = moveGraphNodes(pipeline(), {});
    const renamed = renameGraphNode(template, "verify", "check");
    const json = JSON.stringify({ ...renamed, roles: [] });
    expect(json).not.toContain('"node":"verify"');
    expect(json).not.toContain('"verify."');
    expect(renamed.layout!.check).toEqual(template.layout!.verify);
    const loop = renamed.loops![0]!;
    expect(loop.nodes).toContain("check");
    expect(JSON.stringify(loop.until)).toContain("check.");
    expect(validateGraphTemplate(renamed).ok).toBe(true);
  });

  test("a new agent's own role follows its rename; a shared role does not", () => {
    const added = addGraphNode(blankGraphTemplate(), { kind: "agent" }, { x: 0, y: 0 }).template;
    const renamed = renameGraphNode(added, "agent", "design");
    expect(renamed.roles).toEqual([{ key: "design", multiplicity: "one" }]);
    expect(renamed.nodes[0]).toMatchObject({ id: "design", role: "design" });
    const pipelineTemplate = pipeline();
    // build and fix share the builder role: it stays.
    const kept = renameGraphNode(pipelineTemplate, "build", "builder");
    expect(kept.roles.some((role) => role.key === "builder")).toBe(true);
    expect(kept.nodes.find((node) => node.id === "fix")).toMatchObject({ role: "builder" });
  });

  test("arranging lays every node out automatically and keeps the positions", () => {
    const template = moveGraphNodes(pipeline(), { build: { x: 9999, y: 9999 } });
    const arranged = arrangeGraphLayout(template);
    expect(arranged.layout!.build).not.toEqual({ x: 9999, y: 9999 });
    expect(Object.keys(arranged.layout!).sort()).toEqual(
      template.nodes.map((node) => node.id).sort(),
    );
  });

  test("removing a node drops its edges, loop membership and carries", () => {
    const template = pipeline();
    const removed = removeGraphNode(template, "verify");
    expect(removed.nodes.some((node) => node.id === "verify")).toBe(false);
    expect(JSON.stringify(removed.edges)).not.toContain('"verify"');
    expect(JSON.stringify(removed.loops)).not.toContain('"verify"');
  });

  test("renaming and removing ports follows the edges that name them", () => {
    const template = pipeline();
    const renamed = renameGraphInputPort(template, "prepare", "code", "source");
    expect(
      renamed.edges.filter((edge) => edge.to.node === "prepare" && edge.to.port === "source")
        .length,
    ).toBeGreaterThan(0);
    expect(
      renamed.edges.some((edge) => edge.to.node === "prepare" && edge.to.port === "code"),
    ).toBe(false);
    const output = renameGraphOutputPort(template, "build", "code", "tree");
    expect(
      output.edges.some(
        (edge) => "node" in edge.from && edge.from.node === "build" && edge.from.port === "tree",
      ),
    ).toBe(true);
    const withoutInput = removeGraphInputPort(template, "prepare", "code");
    expect(
      withoutInput.edges.some((edge) => edge.to.node === "prepare" && edge.to.port === "code"),
    ).toBe(false);
    const withoutOutput = removeGraphOutputPort(template, "build", "code");
    expect(
      withoutOutput.edges.some(
        (edge) => "node" in edge.from && edge.from.node === "build" && edge.from.port === "code",
      ),
    ).toBe(false);
  });

  test("renaming a run input rewrites the edges that read it", () => {
    const template = pipeline();
    const name = template.inputs[0]!.name;
    const renamed = renameGraphRunInput(template, name, "work");
    expect(renamed.inputs[0]!.name).toBe("work");
    expect(JSON.stringify(renamed.edges)).toContain('"input":"work"');
    expect(JSON.stringify(renamed.edges)).not.toContain(`"input":"${name}"`);
  });

  test("loops: wrap, join, leave; an emptied loop is removed", () => {
    const base = addGraphNode(
      addGraphNode(blankGraphTemplate(), { kind: "agent" }, { x: 0, y: 0 }).template,
      { kind: "agent" },
      { x: 300, y: 0 },
    ).template;
    const { template, loopId } = createGraphLoop(base, ["agent"]);
    expect(graphLoopOf(template, "agent")?.id).toBe(loopId);
    expect(template.loops![0]).toMatchObject({ maxIterations: 3, carry: [] });
    const joined = addGraphNodeToLoop(template, "agent-2", loopId);
    expect(graphLoopOf(joined, "agent-2")?.id).toBe(loopId);
    const left = removeGraphNodeFromLoop(joined, "agent-2");
    expect(graphLoopOf(left, "agent-2")).toBeUndefined();
    const empty = removeGraphNodeFromLoop(left, "agent");
    expect(empty.loops).toEqual([]);
  });

  test("acknowledgements are recorded once per digest, in RFC 3339 UTC, and removable", () => {
    const template = pipeline();
    const ref = {
      kind: "taint" as const,
      digest: "b".repeat(64),
      code: "taint-reaches-side-effect",
    };
    const at = new Date("2026-10-29T12:34:56.789Z");
    const once = acknowledgeGraphWarning(template, ref, at);
    expect(once.acknowledgements).toEqual([
      { kind: "taint", digest: ref.digest, acknowledgedAt: "2026-10-29T12:34:56Z", code: ref.code },
    ]);
    expect(acknowledgeGraphWarning(once, ref, at)).toBe(once);
    expect(validateGraphTemplate(once).ok).toBe(true);
    expect(removeGraphAcknowledgements(once, [0]).acknowledgements).toBeUndefined();
  });
});
