import { describe, expect, test } from "bun:test";
import {
  compile,
  freezeCompiledGraphPlan,
  GRAPH_DEFAULT_COLLECT_POLICY,
  type GraphPlanAgentNode,
  graphMaxWeightAntichain,
  graphTemplateDigest,
  verifyGraphPlanDigest,
} from "./compile.js";
import { agentOf, baseTemplate, withPanel } from "./compile-fixtures.test-support.js";
import { graphTemplateExample, graphTemplateExamples } from "./examples.js";
import type { GraphTemplateV1 } from "./template-model.js";

/** Reverse every object's key order, recursively. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  ) as T;
}

const errors = (template: unknown) =>
  compile(template).diagnostics.filter((diagnostic) => diagnostic.severity === "error");

describe("the report §9 examples", () => {
  test("§9.1 and §9.2 compile with no errors and may launch", () => {
    for (const key of ["multi-review", "build-pipeline-loop"] as const) {
      const result = compile(graphTemplateExample(key));
      expect({ key, errors: errors(graphTemplateExample(key)) }).toEqual({ key, errors: [] });
      expect(result.ok).toBe(true);
      expect(result.launchable).toBe(true);
      expect(result.plan).not.toBeNull();
    }
  });

  test("§9.3, with its Multi Review sub-graph inlined, compiles and may launch (item 402)", () => {
    const result = compile(graphTemplateExample("design-bake-off"));
    expect(errors(graphTemplateExample("design-bake-off"))).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.launchable).toBe(true);
    expect(result.plan!.subgraphs!.map((instance) => instance.id)).toEqual(["review"]);
  });

  test("§9.4, with its items fan-out, compiles and may launch (item 401)", () => {
    expect(errors(graphTemplateExample("failure-diagnosis"))).toEqual([]);
    const result = compile(graphTemplateExample("failure-diagnosis"));
    expect(result.ok).toBe(true);
    expect(result.launchable).toBe(true);
  });

  test("the design bake-off acknowledges every taint warning it raises", () => {
    const example = graphTemplateExample("design-bake-off");
    const result = compile(example);
    expect(result.pendingAcknowledgements).toEqual([]);
    const taint = result.diagnostics.filter((d) => d.code === "taint-reaches-side-effect");
    const sinks = ["build", "review/plan", "review/package", "review/fix", "review/pr", "pr"];
    expect(taint.map((d) => [d.nodeId, d.severity, d.acknowledgement?.accepted])).toEqual(
      sinks.map((sink) => [sink, "info", true]),
    );
    expect(result.diagnostics.map((d) => d.code)).not.toContain("acknowledgement-stale");

    delete example.acknowledgements;
    const bare = compile(example);
    expect(bare.pendingAcknowledgements.map((ref) => ref.nodeId)).toEqual(sinks);
    expect(
      bare.diagnostics.filter(
        (d) => d.code === "taint-reaches-side-effect" && d.severity === "warning",
      ),
    ).toHaveLength(sinks.length);
  });

  test("costs match the limits the examples declare", () => {
    const cost = (key: Parameters<typeof graphTemplateExample>[0]) =>
      compile(graphTemplateExample(key)).cost!;
    expect(cost("multi-review")).toMatchObject({
      agentSessions: { best: 3, worst: 36 },
      activations: { worst: 39 },
      peakParallelism: 32,
      incomplete: false,
    });
    // build 1 + (fix, prepare, review, address, verify) × 3; fix and address can be skipped.
    expect(cost("build-pipeline-loop")).toMatchObject({
      agentSessions: { best: 4, worst: 16 },
      peakParallelism: 1,
    });
    expect(cost("failure-diagnosis")).toMatchObject({
      agentSessions: { best: 0, worst: 39 },
      peakParallelism: 12,
    });
    // design 3 + judge 1 + build 1 + inlined Multi Review (plan 1 + 8 + 1 + fix 1 +
    // describe-pr 1) + describe-pr 1: the sub-graph's sessions count against the parent.
    expect(cost("design-bake-off")).toMatchObject({
      agentSessions: { worst: 18 },
      peakParallelism: 8,
      incomplete: false,
    });
    for (const example of graphTemplateExamples()) {
      const result = compile(example.template);
      expect(result.cost!.agentSessions.worst).toBeLessThanOrEqual(
        example.template.limits.maxAgentSessions,
      );
    }
  });
});

describe("the plan", () => {
  test("multi review: order, defaults and fan-in", () => {
    const plan = compile(graphTemplateExample("multi-review")).plan!;
    expect(plan.format).toBe("orkestrator.graph-plan");
    expect(plan.order).toEqual([
      "plan",
      "package",
      "review",
      "consolidate",
      "has-findings",
      "fix",
      "describe-pr",
      "pr",
    ]);
    expect(plan.nodes.map((node) => node.id)).toEqual(plan.order);
    const review = plan.nodes[2] as GraphPlanAgentNode;
    expect(review).toMatchObject({
      kind: "agent",
      fanOut: { min: 1, max: 32 },
      onFailure: "skip",
      retry: { attempts: 1, on: [] },
      session: { mode: "fresh" },
      minEnforcement: "provider-configured",
      floorLowered: false,
      askHuman: false,
      replicate: { signature: "panel:reviewer", branches: { min: 1, max: 32 } },
    });
    expect(review.inputs[0]).toMatchObject({ name: "package", render: "file", fanIn: false });
    expect(review.outputs[0]!.valueType).toEqual({
      kind: "list",
      element: { kind: "named", ref: "review-report@1" },
    });
    expect(review.capabilities.readOnly).toBe(true);
    expect(review.capabilities.spec).toEqual({ profile: "reviewer", allow: [], deny: [] });
    expect(review.grantedActions.submit).toEqual(["report"]);

    const consolidate = plan.nodes[3] as GraphPlanAgentNode;
    expect(consolidate.inputs[0]).toMatchObject({
      collect: GRAPH_DEFAULT_COLLECT_POLICY,
      fanIn: true,
      edges: ["review-consolidate"],
      deliveredType: { kind: "list", element: { kind: "named", ref: "review-report@1" } },
    });
    expect(plan.nodes[0]).toMatchObject({ onFailure: "fail-run", workspaceAccess: "write" });
    expect(plan.nodes[1]).toMatchObject({ kind: "system", workspaceAccess: "read", params: {} });
    expect(plan.nodes[4]).toMatchObject({ kind: "gate", outlets: ["findings", "clean"] });
    expect(plan.nodes.find((node) => node.id === "fix")!.skippable).toBe(true);
    const edgeIds = plan.edges.map((edge) => edge.id);
    expect(edgeIds).toEqual(edgeIds.toSorted());
    expect(plan.edges.find((edge) => edge.id === "review-consolidate")).toMatchObject({
      fanIn: true,
      iterations: "all",
      zip: false,
      transform: [],
    });
    expect(plan.typeRefs).toContain("review-package@2");
    expect(plan.types).toEqual([]);
    expect(plan.cost.agentSessions.worst).toBe(36);
    expect(plan.acknowledgements).toEqual({ accepted: [], pending: [] });
    expect(plan.context.ceiling).toEqual({ deny: [] });
  });

  test("build pipeline: loop region, entry and firstIterationFrom", () => {
    const plan = compile(graphTemplateExample("build-pipeline-loop")).plan!;
    expect(plan.loops).toEqual([
      expect.objectContaining({
        id: "rounds",
        members: ["fix", "prepare", "package", "review", "has-issues", "address", "verify"],
        entry: ["fix"],
        laterOnly: ["fix"],
        maxIterations: 3,
        carry: [
          {
            from: { node: "verify", port: "verdict" },
            to: { node: "fix", port: "feedback" },
            type: { kind: "named", ref: "verification-verdict@1" },
          },
          {
            from: { node: "verify", port: "code" },
            to: { node: "fix", port: "code" },
            type: { kind: "named", ref: "workspace@1" },
          },
        ],
      }),
    ]);
    const iterations = Object.fromEntries(plan.edges.map((edge) => [edge.id, edge.iterations]));
    expect(iterations["build-prepare"]).toBe("first");
    expect(iterations["fix-prepare"]).toBe("later");
    expect(iterations["ticket-build"]).toBe("all");
    const fix = plan.nodes.find((node) => node.id === "fix")!;
    expect(fix).toMatchObject({ loop: "rounds", skippable: true });
    expect(fix.inputs.find((port) => port.name === "feedback")!.carries).toEqual(["rounds#0"]);
    // Verify gets its commit from Address or the clean outlet: it always runs.
    expect(plan.nodes.find((node) => node.id === "verify")!.skippable).toBe(false);
    expect(plan.order[0]).toBe("build");
  });

  test("a port only a loop's until reads is used, not output-unused", () => {
    const template = graphTemplateExample("build-pipeline-loop");
    const verify = agentOf(template, "verify");
    verify.outputs!.push({ name: "done", type: "text@1" }, { name: "spare", type: "text@1" });
    template.loops![0]!.until = { path: "verify.done.text", op: "eq", value: "yes" };
    const unused = compile(template)
      .diagnostics.filter((d) => d.code === "output-unused" && d.nodeId === "verify")
      .map((d) => d.port);
    expect(unused).toEqual(["spare"]);
  });

  test("custom types the plan uses are copied into it", () => {
    const template = baseTemplate();
    const note = {
      name: "note",
      version: 1,
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      storage: "value" as const,
      budgets: { maxBytes: 4096 },
    };
    template.types = [note, { ...note, name: "unused" }];
    agentOf(template, "review").outputs!.push({ name: "note", type: "note@1" });
    const plan = compile(template).plan!;
    expect(plan.types).toEqual([note]);
    expect(plan.typeRefs).toContain("note@1");
    expect(plan.typeRefs).not.toContain("unused@1");
  });

  test("the plan is plain JSON and can be frozen", () => {
    const plan = compile(withPanel(baseTemplate())).plan!;
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    const frozen = freezeCompiledGraphPlan(plan);
    expect(Object.isFrozen(frozen.nodes[0]!.inputs)).toBe(true);
    expect(verifyGraphPlanDigest(frozen)).toBe(true);
  });

  test("an invalid template has no plan and no cost", () => {
    for (const value of [null, 42, "x", [], { format: "other" }]) {
      const result = compile(value);
      expect(result).toMatchObject({ ok: false, plan: null, cost: null, launchable: false });
      expect(result.diagnostics[0]!.code).toBe("template-invalid");
    }
  });
});

describe("the digest", () => {
  const digest = (template: GraphTemplateV1) => compile(template).plan!.digest;

  test("does not depend on key order, list order of nodes and edges, or layout", () => {
    for (const key of ["multi-review", "build-pipeline-loop"] as const) {
      const template = graphTemplateExample(key);
      const original = digest(template);
      expect(original).toMatch(/^[a-f0-9]{64}$/);
      expect(digest(reverseKeys(template))).toBe(original);
      const reordered = graphTemplateExample(key);
      reordered.nodes.reverse();
      reordered.edges.reverse();
      expect(digest(reordered)).toBe(original);
      const moved = graphTemplateExample(key);
      moved.layout = { [moved.nodes[0]!.id]: { x: 400, y: -20 } };
      expect(digest(moved)).toBe(original);
      expect(graphTemplateDigest(moved)).toBe(graphTemplateDigest(template));
      expect(graphTemplateDigest(reordered)).toBe(graphTemplateDigest(template));
    }
  });

  test("changes on semantic edits", () => {
    const template = graphTemplateExample("build-pipeline-loop");
    const original = digest(template);
    const edits: Array<(t: GraphTemplateV1) => void> = [
      (t) => (t.loops![0]!.maxIterations = 2),
      (t) =>
        (agentOf(t, "review").prompt = {
          template: "Review the package.\n\n{{> input.package}}\n\n{{> input.ticket}}\n",
        }),
      (t) => (t.limits.maxAgentSessions = 20),
      (t) => (t.name = "Renamed"),
      (t) => (agentOf(t, "build").capabilities.deny = ["network"]),
    ];
    for (const edit of edits) {
      const changed = graphTemplateExample("build-pipeline-loop");
      edit(changed);
      expect(errors(changed)).toEqual([]);
      expect(digest(changed)).not.toBe(original);
      expect(graphTemplateDigest(changed)).not.toBe(graphTemplateDigest(template));
    }
  });

  test("covers the compile context and detects tampering", () => {
    const template = graphTemplateExample("multi-review");
    const plan = compile(template).plan!;
    expect(compile(template, { ceiling: { deny: ["network"] } }).plan!.digest).not.toBe(
      plan.digest,
    );
    // Providers and host only decide diagnostics, never the plan.
    expect(compile(template, { providers: ["codex"] }).plan!.digest).toBe(plan.digest);
    expect(verifyGraphPlanDigest(plan)).toBe(true);
    const tampered = structuredClone(plan);
    tampered.limits.maxAgentSessions = 200;
    expect(verifyGraphPlanDigest(tampered)).toBe(false);
  });
});

describe("cost", () => {
  test("the heaviest antichain", () => {
    // a → b → c, d alone.
    const order = new Set(["0>1", "1>2", "0>2"]);
    const before = (a: number, b: number) => order.has(`${a}>${b}`);
    expect(graphMaxWeightAntichain([], before)).toBe(0);
    expect(graphMaxWeightAntichain([1, 1, 1, 1], before)).toBe(2);
    expect(graphMaxWeightAntichain([1, 5, 1, 2], before)).toBe(7);
    // A chain given only through its links still counts as one chain.
    const links = (a: number, b: number) => b === a + 1;
    expect(graphMaxWeightAntichain([3, 2, 4], links)).toBe(4);
    // Diamond: 0 → 1, 0 → 2, 1 → 3, 2 → 3.
    const diamond = new Set(["0>1", "0>2", "1>3", "2>3"]);
    expect(graphMaxWeightAntichain([1, 4, 6, 1], (a, b) => diamond.has(`${a}>${b}`))).toBe(10);
  });

  test("retries and loops multiply the worst case; skippable nodes leave the best case", () => {
    const template = withPanel(baseTemplate());
    agentOf(template, "build").retry = { attempts: 3, on: ["provider-error"] };
    agentOf(template, "consolidate").when = { path: "params.flag", op: "eq", value: true };
    const cost = compile(template).cost!;
    expect(cost.agentSessions).toEqual({ best: 2, worst: 3 + 4 + 1 });
    expect(cost.nodes.find((node) => node.nodeId === "build")).toMatchObject({
      attempts: 3,
      agentSessions: { best: 1, worst: 3 },
    });
    expect(cost.peakParallelism).toBe(4);
  });
});

describe("robustness", () => {
  test("removing any edge, node or loop member never throws", () => {
    for (const example of graphTemplateExamples()) {
      const template = example.template;
      const variants: GraphTemplateV1[] = [];
      template.edges.forEach((_, index) => {
        const copy = structuredClone(template);
        copy.edges.splice(index, 1);
        variants.push(copy);
      });
      template.nodes.forEach((_, index) => {
        const copy = structuredClone(template);
        copy.nodes.splice(index, 1);
        variants.push(copy);
      });
      for (const [index, loop] of (template.loops ?? []).entries()) {
        loop.nodes.forEach((_, member) => {
          const copy = structuredClone(template);
          copy.loops![index]!.nodes.splice(member, 1);
          variants.push(copy);
        });
      }
      for (const variant of variants) {
        const result = compile(variant);
        expect(result.diagnostics.length + (result.ok ? 1 : 0)).toBeGreaterThan(0);
        if (result.ok) expect(verifyGraphPlanDigest(result.plan!)).toBe(true);
      }
    }
  });

  test("a 100-node template compiles quickly", () => {
    const template = baseTemplate();
    const review = agentOf(template, "review");
    template.nodes = [template.nodes[0]!];
    template.edges = [template.edges[0]!];
    template.outputs = [];
    for (let index = 0; index < 99; index++) {
      const id = `review-${index}`;
      template.nodes.push({ ...structuredClone(review), id });
      template.edges.push({
        id: `edge-${index}`,
        from: { node: "build", port: "code" },
        to: { node: id, port: "code" },
      });
    }
    template.limits = { maxAgentSessions: 200, maxConcurrentAgents: 32 };
    const started = performance.now();
    const result = compile(template);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.ok).toBe(true);
    expect(result.cost!.peakParallelism).toBe(99);
    expect(result.diagnostics.map((d) => d.code)).toContain("concurrency-capped");
  });
});
