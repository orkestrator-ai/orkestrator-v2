import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { compile, graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphSubgraphNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { graphDiagnosticTarget } from "./GraphCompilePanel";
import { addGraphNode, blankGraphTemplate } from "./graph-designer-edits";
import { indexGraphDiagnostics } from "./graph-designer-model";
import {
  graphDesignerNodeOf,
  graphDesignerSubgraphKey,
  graphSubgraphBindParam,
  graphSubgraphBindRole,
  graphSubgraphChoices,
  graphSubgraphLibraryRef,
  graphSubgraphRefFor,
  graphSubgraphRefsToFetch,
} from "./graph-designer-subgraphs";
import { fixtureSummary, listResult, userDetail } from "./graph-designer.test-fixtures";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

/** A user template with one reviewer: run input `code`, run output `report`, a `depth` parameter. */
function childTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "child",
    revision: 1,
    name: "Child",
    parameters: [{ key: "depth", type: "integer", min: 1, max: 5, default: 2 }],
    roles: [{ key: "checker", multiplicity: "one" }],
    inputs: [{ name: "code", type: "workspace@1" }],
    outputs: [{ name: "report", type: "review-report@1", from: { node: "check", port: "report" } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "check",
        kind: "agent",
        role: "checker",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Check to depth {{params.depth}}.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [{ id: "code-check", from: { input: "code" }, to: { node: "check", port: "code" } }],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

/** The child as the backend serves it: summary digest is the real template digest. */
function childDetail(template = childTemplate(), trust: "trusted" | "untrusted" = "trusted") {
  const detail = userDetail(template, template.revision);
  return {
    ...detail,
    summary: { ...detail.summary, digest: graphTemplateDigest(detail.template), trust },
  };
}

/** A parent with a run input `target` wired into the sub-graph node for `child`. */
function parentWith(child: GraphTemplateV1, ref = graphSubgraphRefFor(childDetail(child).summary)) {
  const added = addGraphNode(
    blankGraphTemplate(),
    { kind: "subgraph", ref, child },
    { x: 0, y: 0 },
  );
  const template = added.template;
  template.inputs = [{ name: "target", type: "workspace@1" }];
  template.edges = [
    { id: "target-child", from: { input: "target" }, to: { node: added.nodeId, port: "code" } },
  ];
  template.outputs = [
    { name: "report", type: "review-report@1", from: { node: added.nodeId, port: "report" } },
  ];
  return { template, nodeId: added.nodeId };
}

describe("sub-graph nodes in the designer (item 402)", () => {
  test("a picked template becomes one node with its ports, its roles and a pinned reference", () => {
    const child = childTemplate();
    const summary = childDetail(child).summary;
    const { template, nodeId } = parentWith(child);
    const node = template.nodes.find((entry) => entry.id === nodeId) as GraphSubgraphNode;
    expect(nodeId).toBe("child");
    expect(node).toMatchObject({
      kind: "subgraph",
      label: "Child",
      template: { scope: "user", id: "child", revision: 1, digest: summary.digest },
      inputs: [{ name: "code", type: "workspace@1" }],
      outputs: [{ name: "report", type: "review-report@1" }],
    });
    expect(template.roles.map((role) => role.key)).toContain("checker");
    // Pinned to what it was picked at, and it compiles once the child resolves.
    const result = compile(template, { resolveTemplate: () => ({ template: child }) });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("subgraph-unpinned");
  });

  test("the palette offers every saved template but the one edited; untrusted ones disabled", () => {
    const child = childDetail().summary;
    const self = fixtureSummary(blankGraphTemplate(), { scope: "user", id: "untitled-graph" });
    const project = fixtureSummary(
      childTemplate(),
      { scope: "project", projectId: "p1", path: ".orkestrator/graphs/child.graph.json" },
      { trust: "changed" },
    );
    const choices = graphSubgraphChoices([child, self, project], {
      scope: "user",
      id: self.id,
    });
    expect(choices.map((choice) => [choice.summary.scope, choice.disabled !== undefined])).toEqual([
      ["user", false],
      ["project", true],
    ]);
    expect(graphSubgraphRefFor(project)).toMatchObject({
      scope: "project",
      path: ".orkestrator/graphs/child.graph.json",
    });
  });

  test("project references resolve by path, or by a unique id within the project", () => {
    const one = fixtureSummary(childTemplate(), {
      scope: "project",
      projectId: "p1",
      path: ".orkestrator/graphs/a.graph.json",
    });
    const ref = { scope: "project" as const, id: "child" };
    expect(graphSubgraphLibraryRef(ref, "p1", [one])).toEqual(one.ref);
    expect(graphSubgraphLibraryRef(ref, null, [one])).toEqual({ missing: "no-project" });
    expect(
      graphSubgraphLibraryRef(ref, "p1", [
        one,
        {
          ...one,
          ref: { scope: "project", projectId: "p1", path: ".orkestrator/graphs/b.graph.json" },
        },
      ]),
    ).toEqual({
      missing: "ambiguous",
    });
    expect(graphSubgraphLibraryRef({ scope: "builtin", id: "multi-review" }, null, [])).toEqual({
      scope: "builtin",
      id: "multi-review",
    });
  });

  test("references to read: unread ones, then those inside children already read", () => {
    const child = childTemplate();
    const { template } = parentWith(child);
    expect(graphSubgraphRefsToFetch(template, new Map(), null).map((ref) => ref.id)).toEqual([
      "child",
    ]);
    const nested = parentWith({ ...childTemplate(), id: "grandchild" }).template;
    const outer = { ...nested, id: "outer" };
    const entries = new Map([
      [
        graphDesignerSubgraphKey(null, { scope: "user", id: "child" }),
        {
          status: "ready" as const,
          resolution: { template: outer },
        },
      ],
    ]);
    expect(graphSubgraphRefsToFetch(template, entries, null).map((ref) => ref.id)).toEqual([
      "grandchild",
    ]);
    // Built-ins resolve from code and are never fetched.
    expect(
      graphSubgraphRefsToFetch(graphTemplateExample("design-bake-off"), new Map(), null),
    ).toEqual([]);
  });

  test("parameter and role bindings set and clear", () => {
    const { template, nodeId } = parentWith(childTemplate());
    const node = template.nodes.find((entry) => entry.id === nodeId) as GraphSubgraphNode;
    const bound = graphSubgraphBindRole(
      graphSubgraphBindParam(node, "depth", 4),
      "checker",
      "lead",
    );
    expect(bound.params).toEqual({ depth: 4 });
    expect(bound.roles).toEqual({ checker: "lead" });
    const cleared = graphSubgraphBindRole(
      graphSubgraphBindParam(bound, "depth", undefined),
      "checker",
      undefined,
    );
    expect("params" in cleared).toBe(false);
    expect("roles" in cleared).toBe(false);
  });

  test("diagnostics on inlined nodes and edges land on the sub-graph node", () => {
    expect(graphDesignerNodeOf("review/plan")).toBe("review");
    expect(graphDesignerNodeOf("build")).toBe("build");
    const diagnostics = [
      {
        code: "input-unbound" as const,
        severity: "error" as const,
        message: "m",
        nodeId: "review/fix",
      },
      {
        code: "edge-type-mismatch" as const,
        severity: "error" as const,
        message: "m",
        edgeId: "review/x",
      },
    ];
    const index = indexGraphDiagnostics(diagnostics);
    expect(index.nodes.get("review")).toHaveLength(2);
    expect(index.edges.size).toBe(0);
    expect(graphDiagnosticTarget(diagnostics[1]!)).toEqual({ kind: "node", id: "review" });
  });
});

describe("browser compile of a draft with sub-graphs", () => {
  beforeEach(() => {
    useGraphDesignerStore.setState({
      libraries: new Map(),
      tabs: new Map(),
      subgraphTemplates: new Map(),
    });
  });

  afterEach(() => {
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function install(detail: ReturnType<typeof childDetail>) {
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "graph_template_get") return detail;
      if (command === "graph_templates_list") return listResult([detail.summary]);
      throw new Error(`unexpected command ${command}`);
    });
    window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
  }

  async function settle() {
    for (let index = 0; index < 5; index++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("reads a user child once, then compiles the draft with it inlined", async () => {
    const child = childTemplate();
    install(childDetail(child));
    const store = useGraphDesignerStore.getState();
    store.openDraft("tab-1", parentWith(child).template, null);
    store.compileDraft("tab-1", {});
    // The first compile has not read the child yet.
    expect(useGraphDesignerStore.getState().tabs.get("tab-1")!.compile!.ok).toBe(false);
    await settle();
    const compiled = useGraphDesignerStore.getState().tabs.get("tab-1")!.compile!;
    expect(compiled.ok).toBe(true);
    expect(compiled.plan!.subgraphs![0]!.nodes).toEqual(["child/check"]);
    expect(invokeMock.mock.calls.filter(([name]) => name === "graph_template_get")).toHaveLength(1);
    store.compileDraft("tab-1", {});
    await settle();
    expect(invokeMock.mock.calls.filter(([name]) => name === "graph_template_get")).toHaveLength(1);
  });

  test("an untrusted child is never inlined", async () => {
    const child = childTemplate();
    install(childDetail(child, "untrusted"));
    const store = useGraphDesignerStore.getState();
    store.openDraft("tab-1", parentWith(child).template, null);
    store.compileDraft("tab-1", {});
    await settle();
    const compiled = useGraphDesignerStore.getState().tabs.get("tab-1")!.compile!;
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-unresolved", detail: "untrusted" }),
    );
  });

  test("a library reload drops what was read, so an edited child is read again", async () => {
    const child = childTemplate();
    install(childDetail(child));
    const store = useGraphDesignerStore.getState();
    store.openDraft("tab-1", parentWith(child).template, null);
    store.compileDraft("tab-1", {});
    await settle();
    const edited = { ...childTemplate(), revision: 2, description: "Edited" };
    install(childDetail(edited));
    await store.loadLibrary(null);
    await settle();
    const compiled = useGraphDesignerStore.getState().tabs.get("tab-1")!.compile!;
    // The node pinned revision 1; the child is now at 2.
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-digest-mismatch" }),
    );
  });
});
