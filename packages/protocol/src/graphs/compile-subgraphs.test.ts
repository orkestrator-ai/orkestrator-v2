/**
 * Sub-graph inlining (item 402): ids, rewiring, roles, parameter scopes,
 * nesting, pinning and digest stability. One case per diagnostic code lives
 * in `compile-diagnostics.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  compile,
  graphTemplateDigest,
  type CompiledGraphPlan,
  type GraphPlanAgentNode,
} from "./compile.js";
import { graphBuiltInTemplate } from "./builtins/index.js";
import { graphTemplateExample } from "./examples.js";
import { isGraphProjectTemplatePath } from "./library.js";
import { graphActivationKey, parseGraphActivationKey } from "./run-identity.js";
import {
  auditNode,
  childTemplate,
  parentTemplate,
  resolverOf,
} from "./subgraph-fixtures.test-support.js";
import {
  graphPlanLoopParams,
  graphPlanNodeParameters,
  graphPlanNodeParams,
  graphSubgraphPorts,
  type GraphTemplateResolver,
} from "./subgraphs.js";
import { GRAPH_PROJECT_TEMPLATE_PATH } from "./template-nodes.js";
import type { GraphTemplateV1 } from "./template-model.js";
import { validateGraphTemplate } from "./template.js";

const compileWith = (template: GraphTemplateV1, ...children: GraphTemplateV1[]) =>
  compile(template, { resolveTemplate: resolverOf(...children) });

const planOf = (template: GraphTemplateV1, ...children: GraphTemplateV1[]): CompiledGraphPlan => {
  const result = compileWith(template, ...children);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors).toEqual([]);
  return result.plan!;
};

const node = (plan: CompiledGraphPlan, id: string) => {
  const found = plan.nodes.find((entry) => entry.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};

describe("inlining", () => {
  test("child nodes, edges and outputs take namespaced ids and parent roles", () => {
    const parent = parentTemplate();
    const plan = planOf(parent, childTemplate());
    expect(plan.order).toEqual(["build", "audit/check", "audit/gate", "audit/fix"]);
    expect(plan.templateDigest).toBe(graphTemplateDigest(parent));
    expect(plan.template.id).toBe("base");
    expect((node(plan, "audit/check") as GraphPlanAgentNode).role).toBe("worker");
    expect(node(plan, "audit/check").subgraph).toBe("audit");
    expect(node(plan, "build").subgraph).toBeUndefined();
    expect(plan.edges.map((edge) => [edge.id, edge.from, edge.to])).toContainEqual([
      "audit/code-check",
      { node: "build", port: "code" },
      { node: "audit/check", port: "code" },
    ]);
    expect(plan.outputs.find((output) => output.name === "report")!.from).toEqual({
      node: "audit/check",
      port: "report",
    });
    expect(plan.subgraphs).toEqual([
      {
        id: "audit",
        template: {
          scope: "user",
          id: "child",
          revision: 3,
          digest: graphTemplateDigest(childTemplate()),
          name: "Child",
        },
        parameters: childTemplate().parameters,
        params: { strict: { param: "flag" }, depth: { value: 2 } },
        roles: { checker: "worker", fixer: "worker" },
        nodes: ["audit/check", "audit/gate", "audit/fix"],
        inputs: {
          code: [
            { node: "audit/check", port: "code" },
            { node: "audit/gate", port: "code" },
          ],
        },
        outputs: {
          report: { node: "audit/check", port: "report" },
          fixed: { node: "audit/fix", port: "code" },
        },
      },
    ]);
  });

  test("a plan without sub-graphs has no subgraphs field (digests of older plans hold)", () => {
    const plan = compile(graphTemplateExample("multi-review")).plan!;
    expect("subgraphs" in plan).toBe(false);
    expect(plan.nodes.some((entry) => "subgraph" in entry)).toBe(false);
  });

  test("an unbound child role maps to the parent role with the same key", () => {
    const parent = parentTemplate(auditNode({ roles: { checker: "worker" } }));
    parent.roles.push({ key: "fixer", multiplicity: "one" });
    const plan = planOf(parent, childTemplate());
    expect((node(plan, "audit/fix") as GraphPlanAgentNode).role).toBe("fixer");
    expect(plan.subgraphs![0]!.roles).toEqual({ checker: "worker", fixer: "fixer" });
  });

  test("inlined nodes read the child's parameters; the plan resolves them per node", () => {
    const plan = planOf(
      parentTemplate(auditNode({ params: { strict: { param: "flag" }, depth: 4 } })),
      childTemplate(),
    );
    expect(graphPlanNodeParams(plan, "audit/gate", { flag: true })).toEqual({
      strict: true,
      depth: 4,
    });
    expect(graphPlanNodeParams(plan, "audit/gate", { flag: false }).strict).toBe(false);
    expect(graphPlanNodeParams(plan, "build", { flag: true })).toEqual({ flag: true });
    expect(graphPlanNodeParameters(plan, "audit/check").map((p) => p.key)).toEqual([
      "strict",
      "depth",
    ]);
    expect(graphPlanNodeParameters(plan, "build").map((p) => p.key)).toEqual(["flag"]);
    // A launch parameter is the parent's alone.
    expect(plan.parameters.map((p) => p.key)).toEqual(["flag"]);
  });

  test("a child's prompt and conditions are checked against its own parameters", () => {
    const child = childTemplate();
    const check = child.nodes[0]!;
    if (check.kind !== "agent") throw new Error("check is an agent");
    check.prompt = { template: "Check {{params.flag}}.\n\n{{> input.code}}\n" };
    const result = compileWith(parentTemplate(), child);
    // `flag` is the parent's parameter, not the child's.
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "prompt-unbound-variable",
        nodeId: "audit/check",
        path: "nodes[1]>nodes[0].prompt.template",
      }),
    );
  });

  test("diagnostics on inlined entries point into the sub-graph node", () => {
    const child = childTemplate();
    child.edges[2]!.to.port = "nope";
    const result = compileWith(parentTemplate(), child);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unknown-port",
        edgeId: "audit/check-gate",
        path: "nodes[1]>edges[2].to",
      }),
    );
    // An edge rewired through the sub-graph's input is the parent's edge.
    const rewired = childTemplate();
    rewired.edges[0]!.to.port = "nope";
    expect(compileWith(parentTemplate(), rewired).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unknown-port",
        edgeId: "audit/code-check",
        path: "edges[1].to",
      }),
    );
  });

  test("nested sub-graphs compose ids, roles and parameter scopes", () => {
    const middle: GraphTemplateV1 = {
      ...childTemplate(),
      id: "middle",
      name: "Middle",
      parameters: [{ key: "level", type: "boolean" }],
      roles: [{ key: "agent", multiplicity: "one" }],
      nodes: [
        {
          id: "inner",
          kind: "subgraph",
          template: { scope: "user", id: "child" },
          params: { strict: { param: "level" }, depth: 5 },
          roles: { checker: "agent", fixer: "agent" },
          inputs: [{ name: "code", type: "workspace@1" }],
          outputs: [{ name: "report", type: "review-report@1" }],
        },
      ],
      edges: [{ id: "code-inner", from: { input: "code" }, to: { node: "inner", port: "code" } }],
      outputs: [
        { name: "report", type: "review-report@1", from: { node: "inner", port: "report" } },
      ],
    };
    delete middle.layout;
    const parent = parentTemplate(
      auditNode({
        template: { scope: "user", id: "middle" },
        params: { level: { param: "flag" } },
        roles: { agent: "worker" },
        outputs: [{ name: "report", type: "review-report@1" }],
      }),
    );
    const plan = planOf(parent, middle, childTemplate());
    expect(plan.order).toEqual([
      "build",
      "audit/inner/check",
      "audit/inner/gate",
      "audit/inner/fix",
    ]);
    expect(plan.subgraphs!.map((instance) => [instance.id, instance.parent])).toEqual([
      ["audit", undefined],
      ["audit/inner", "audit"],
    ]);
    const inner = plan.subgraphs![1]!;
    expect(inner.params).toEqual({ strict: { param: "flag" }, depth: { value: 5 } });
    expect(inner.roles).toEqual({ checker: "worker", fixer: "worker" });
    expect(node(plan, "audit/inner/gate").subgraph).toBe("audit/inner");
    expect(plan.subgraphs![0]!.nodes).toEqual([
      "audit/inner/check",
      "audit/inner/gate",
      "audit/inner/fix",
    ]);
    expect(graphPlanNodeParams(plan, "audit/inner/gate", { flag: true })).toEqual({
      strict: true,
      depth: 5,
    });
    expect((node(plan, "audit/inner/fix") as GraphPlanAgentNode).role).toBe("worker");
  });

  test("a sub-graph inside a parent loop joins it; carries and until are rewired", () => {
    const child = childTemplate();
    const parent = parentTemplate();
    const build = parent.nodes[0]!;
    if (build.kind !== "agent") throw new Error("build is an agent");
    build.inputs!.push({ name: "feedback", type: "review-report@1", required: false });
    build.prompt = { template: "Build.\n\n{{> input.code}}\n\n{{> input.feedback}}\n" };
    parent.loops = [
      {
        id: "rounds",
        nodes: ["build", "audit"],
        until: { path: "audit.report.issues", op: "empty" },
        maxIterations: 3,
        carry: [
          { from: { node: "audit", port: "report" }, to: { node: "build", port: "feedback" } },
        ],
      },
    ];
    const plan = planOf(parent, child);
    expect(plan.loops[0]).toMatchObject({
      id: "rounds",
      members: ["build", "audit/check", "audit/gate", "audit/fix"],
      until: { path: "audit/check.report.issues", op: "empty" },
      carry: [
        { from: { node: "audit/check", port: "report" }, to: { node: "build", port: "feedback" } },
      ],
    });
    expect(plan.loops[0]!.subgraph).toBeUndefined();
    expect(graphPlanLoopParams(plan, "rounds", { flag: true })).toEqual({ flag: true });
  });

  test("a child's own loop is namespaced and reads the child's parameters", () => {
    const child = childTemplate();
    child.parameters.push({ key: "rounds", type: "integer", min: 1, max: 3, default: 2 });
    child.loops = [
      {
        id: "again",
        nodes: ["check"],
        until: { path: "params.strict", op: "eq", value: true },
        maxIterations: 2,
        carry: [],
      },
    ];
    const plan = planOf(parentTemplate(), child);
    expect(plan.loops[0]).toMatchObject({
      id: "audit/again",
      subgraph: "audit",
      members: ["audit/check"],
      until: { path: "params.strict", op: "eq", value: true },
    });
    expect(graphPlanLoopParams(plan, "audit/again", { flag: true })).toMatchObject({
      strict: true,
    });
  });

  test("a sub-graph that cannot be inlined stays opaque, so its ports are still checked", () => {
    const parent = parentTemplate(auditNode({ template: { scope: "user", id: "gone" } }));
    parent.edges.push({
      id: "build-audit-bad",
      from: { node: "build", port: "report" },
      to: { node: "audit", port: "code" },
    });
    const result = compileWith(parent, childTemplate());
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("subgraph-unresolved");
    expect(codes).toContain("edge-type-mismatch");
    expect(result.plan).toBeNull();
    expect(result.cost!.incomplete).toBe(true);
  });

  test("the resolver is called once per reference", () => {
    let calls = 0;
    const counting: GraphTemplateResolver = (ref) => {
      calls += 1;
      return resolverOf(childTemplate())(ref);
    };
    const parent = parentTemplate();
    parent.nodes.push({ ...auditNode({ id: "audit-two" }) });
    parent.edges.push({
      id: "build-audit-two",
      from: { node: "build", port: "code" },
      to: { node: "audit-two", port: "code" },
    });
    compile(parent, { resolveTemplate: counting });
    expect(calls).toBe(1);
  });

  test("without a resolver, built-ins resolve from code and others do not", () => {
    expect(compile(graphTemplateExample("design-bake-off")).ok).toBe(true);
    const result = compile(parentTemplate());
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-unresolved", detail: "no-resolver" }),
    );
  });

  test("an untrusted project child names the reason", () => {
    const parent = parentTemplate(
      auditNode({
        template: { scope: "project", id: "child", path: ".orkestrator/graphs/child.graph.json" },
      }),
    );
    const result = compile(parent, { resolveTemplate: () => ({ missing: "untrusted" }) });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "subgraph-unresolved",
        detail: "untrusted",
        nodeId: "audit",
      }),
    );
  });

  test("mutual recursion is caught", () => {
    const a = childTemplate();
    a.id = "a";
    const b = childTemplate();
    b.id = "b";
    for (const [template, next] of [
      [a, "b"],
      [b, "a"],
    ] as const) {
      template.nodes.push({
        id: "next",
        kind: "subgraph",
        template: { scope: "user", id: next },
        roles: { checker: "checker", fixer: "fixer" },
        inputs: [{ name: "code", type: "workspace@1" }],
      });
      template.edges.push({
        id: "code-next",
        from: { input: "code" },
        to: { node: "next", port: "code" },
      });
    }
    const result = compileWith(
      parentTemplate(auditNode({ template: { scope: "user", id: "a" } })),
      a,
      b,
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-recursive", nodeId: "audit/next/next" }),
    );
  });

  test("port, parameter and role mismatches each name what to change", () => {
    const missing = compileWith(parentTemplate(auditNode({ inputs: [] })), childTemplate());
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "subgraph-port-mismatch",
        port: "code",
        path: "nodes[1].inputs",
      }),
    );
    const rendered = compileWith(
      parentTemplate(
        auditNode({ inputs: [{ name: "code", type: "workspace@1", render: "file" }] }),
      ),
      childTemplate(),
    );
    expect(rendered.diagnostics.map((d) => d.code)).toContain("subgraph-port-mismatch");
    const required = compileWith(
      parentTemplate(auditNode({ outputs: [{ name: "fixed", type: "workspace@1" }] })),
      childTemplate(),
    );
    expect(required.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-port-mismatch", path: "nodes[1].outputs[0]" }),
    );

    const parent = parentTemplate(auditNode({ params: { strict: { param: "mode" } } }));
    parent.parameters.push({ key: "mode", type: "enum", options: ["a", "b"], default: "a" });
    const typed = compileWith(parent, childTemplate());
    expect(typed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-param-binding", path: "nodes[1].params.strict" }),
    );
    const enumChild = childTemplate();
    enumChild.parameters.push({ key: "mode", type: "enum", options: ["a"], default: "a" });
    const enumParent = parentTemplate(auditNode({ params: { mode: { param: "mode" } } }));
    enumParent.parameters.push({ key: "mode", type: "enum", options: ["a", "b"], default: "a" });
    expect(compileWith(enumParent, enumChild).diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-param-binding", path: "nodes[1].params.mode" }),
    );
    const noDefault = childTemplate();
    noDefault.parameters.push({ key: "must", type: "string" });
    expect(compileWith(parentTemplate(), noDefault).diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-param-binding", path: "nodes[1].params" }),
    );

    const unbound = compileWith(
      parentTemplate(auditNode({ roles: { checker: "worker" } })),
      childTemplate(),
    );
    expect(unbound.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-role-binding", path: "nodes[1].roles" }),
    );
    const panelChild = childTemplate();
    panelChild.roles[0] = { key: "checker", multiplicity: "panel", maxPanel: 2 };
    const check = panelChild.nodes[0]!;
    if (check.kind === "agent") check.replicate = { over: "panel", role: "checker" };
    panelChild.outputs = [];
    const wide = compileWith(
      parentTemplate(auditNode({ roles: { checker: "panel", fixer: "worker" }, outputs: [] })),
      panelChild,
    );
    expect(wide.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "subgraph-role-binding",
        message: expect.stringContaining("at most 2 models"),
      }),
    );
  });

  test("graphSubgraphPorts mirrors a child's run inputs and outputs", () => {
    expect(graphSubgraphPorts(graphBuiltInTemplate("multi-review")!.template)).toMatchObject({
      inputs: [{ name: "target", type: "workspace@1" }],
      outputs: [
        { name: "report", type: "review-report@1" },
        { name: "pr", type: "pr-result@1", required: false },
        { name: "clean", type: "workspace@1", required: false },
        { name: "fixed", type: "workspace@1", required: false },
      ],
    });
  });
});

describe("pinning and digests", () => {
  test("a matching pin compiles silently; an unpinned child says so", () => {
    const digest = graphTemplateDigest(childTemplate());
    const pinned = compileWith(
      parentTemplate(auditNode({ template: { scope: "user", id: "child", digest, revision: 3 } })),
      childTemplate(),
    );
    expect(pinned.ok).toBe(true);
    expect(pinned.diagnostics.map((d) => d.code)).not.toContain("subgraph-unpinned");
    const stale = compileWith(
      parentTemplate(auditNode({ template: { scope: "user", id: "child", revision: 2 } })),
      childTemplate(),
    );
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "subgraph-digest-mismatch",
        path: "nodes[1].template.revision",
      }),
    );
  });

  test("the plan digest is stable, ignores the child's layout and follows its content", () => {
    const parent = parentTemplate();
    const first = planOf(parent, childTemplate());
    expect(planOf(parentTemplate(), childTemplate()).digest).toBe(first.digest);

    const moved = childTemplate();
    moved.layout = { check: { x: 900, y: 900 } };
    expect(planOf(parent, moved).digest).toBe(first.digest);

    const edited = childTemplate();
    const check = edited.nodes[0]!;
    if (check.kind === "agent") check.prompt = { template: "Check harder.\n\n{{> input.code}}\n" };
    const changed = planOf(parent, edited);
    expect(changed.digest).not.toBe(first.digest);
    // The parent's own digest (trust records, run identity) does not move.
    expect(changed.templateDigest).toBe(first.templateDigest);
    expect(changed.subgraphs![0]!.template.digest).toBe(graphTemplateDigest(edited));
  });

  test("the bake-off plan digest is stable across compiles", () => {
    const one = compile(graphTemplateExample("design-bake-off")).plan!;
    const two = compile(graphTemplateExample("design-bake-off")).plan!;
    expect(two.digest).toBe(one.digest);
  });
});

describe("plan ids", () => {
  test("activation keys carry namespaced node ids and parse back", () => {
    const key = graphActivationKey({
      nodeId: "review/review",
      iteration: 1,
      branchKey: "panel.2",
      attempt: 1,
    });
    expect(key).toBe("review/review#iter=1#branch=panel.2#attempt=1");
    expect(parseGraphActivationKey(key)).toEqual({
      nodeId: "review/review",
      iteration: 1,
      branchKey: "panel.2",
      attempt: 1,
    });
    expect(() => graphActivationKey({ nodeId: "review//x", iteration: 1, attempt: 1 })).toThrow();
    expect(parseGraphActivationKey("/review#iter=1#attempt=1")).toBeNull();
  });

  test("the template guard checks a reference's digest and path", () => {
    const errorsOf = (template: GraphTemplateV1) => {
      const guard = validateGraphTemplate(template);
      return guard.ok ? [] : guard.errors.map((error) => [error.path, error.code]);
    };
    expect(
      errorsOf(
        parentTemplate(auditNode({ template: { scope: "user", id: "child", digest: "ABC" } })),
      ),
    ).toEqual([["nodes[1].template.digest", "pattern"]]);
    expect(
      errorsOf(
        parentTemplate(
          auditNode({
            template: { scope: "user", id: "child", path: ".orkestrator/graphs/child.graph.json" },
          }),
        ),
      ),
    ).toEqual([["nodes[1].template.path", "not_applicable"]]);
    expect(
      errorsOf(
        parentTemplate(
          auditNode({ template: { scope: "project", id: "child", path: "../child.json" } }),
        ),
      ),
    ).toEqual([["nodes[1].template.path", "pattern"]]);
  });

  test("the project path pattern agrees with the library's", () => {
    for (const path of [
      ".orkestrator/graphs/review.graph.json",
      ".orkestrator/graphs/a.b-c_d.graph.json",
      ".orkestrator/graphs/../x.graph.json",
      ".orkestrator/graphs/sub/x.graph.json",
      ".orkestrator/graphs/x.json",
      `.orkestrator/graphs/${"a".repeat(117)}.graph.json`,
      `.orkestrator/graphs/${"a".repeat(118)}.graph.json`,
    ]) {
      expect({ path, ok: GRAPH_PROJECT_TEMPLATE_PATH.test(path) }).toEqual({
        path,
        ok: isGraphProjectTemplatePath(path),
      });
    }
  });
});
