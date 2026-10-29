/**
 * One test per diagnostic code the compiler reports: every code in
 * `GRAPH_COMPILE_DIAGNOSTIC_CODES`, plus the capability codes it passes
 * through from item 106. `CASES` is typed by the code union, so a new code
 * without a case fails the typecheck, and the last test fails at run time.
 */
import { describe, expect, test } from "bun:test";
import {
  GRAPH_CAPABILITY_ISSUE_CODES,
  type GraphCapabilityIssueCode,
} from "./capability-profiles.js";
import {
  compile,
  type GraphCompileDiagnostic,
  type GraphCompileDiagnosticCode,
  GRAPH_COMPILE_DIAGNOSTIC_CODES,
  type GraphCompileOptions,
} from "./compile.js";
import {
  agentOf,
  baseTemplate,
  edgeOf,
  nodeOf,
  notesNode,
  withGate,
  withPanel,
} from "./compile-fixtures.test-support.js";
import { graphTemplateExample } from "./examples.js";
import type {
  ArtifactTypeDef,
  GraphLoopRegion,
  GraphSystemNode,
  GraphSystemParamValue,
  GraphTemplateV1,
} from "./template.js";

interface Case {
  /** The template to start from; default the clean base. */
  from?: () => GraphTemplateV1;
  mutate: (template: GraphTemplateV1) => void;
  options?: GraphCompileOptions;
  /** Fields the diagnostic must have besides its code. */
  expect?: Partial<GraphCompileDiagnostic>;
}

const pipeline = () => graphTemplateExample("build-pipeline-loop");

const THING: ArtifactTypeDef = {
  name: "thing",
  version: 1,
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  storage: "value",
  budgets: { maxBytes: 4096 },
};

/** Adds a `push-branch` node (index 2) that pushes Build's commit. */
function withPush(
  template: GraphTemplateV1,
  params: Record<string, GraphSystemParamValue> = {},
): GraphSystemNode {
  const node: GraphSystemNode = {
    id: "push",
    kind: "system",
    action: "push-branch",
    params,
    inputs: [{ name: "code", type: "workspace@1" }],
  };
  template.nodes.push(node);
  template.edges.push({
    id: "build-push",
    from: { node: "build", port: "code" },
    to: { node: "push", port: "code" },
  });
  return node;
}

const CASES: Record<GraphCompileDiagnosticCode | GraphCapabilityIssueCode, Case> = {
  // ------------------------------------------------------------ template, refs
  "template-invalid": {
    mutate: (t) => {
      t.id = "Not A Slug";
    },
    expect: { path: "id", detail: "pattern", severity: "error" },
  },
  "type-invalid": {
    mutate: (t) => {
      t.types = [
        {
          ...THING,
          schema: {
            type: "object",
            properties: { text: { type: "string", pattern: "^x" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ];
    },
    expect: { detail: "unsupported_keyword" },
  },
  "type-conflict": {
    mutate: (t) => {
      t.types = [THING];
    },
    options: { types: [{ ...THING, budgets: { maxBytes: 8192 } }] },
    expect: { path: "$types[0]" },
  },
  "type-unresolved": {
    mutate: (t) => {
      agentOf(t, "review").outputs![0]!.type = "missing@1";
    },
    expect: { nodeId: "review", detail: "unknown_type", path: "nodes[1].outputs[0].type" },
  },
  "unknown-node": {
    mutate: (t) => {
      edgeOf(t, "build-review").to = { node: "ghost", port: "code" };
    },
    expect: { edgeId: "build-review", path: "edges[1].to" },
  },
  "unknown-port": {
    mutate: (t) => {
      edgeOf(t, "build-review").to = { node: "review", port: "missing" };
    },
    expect: { edgeId: "build-review", port: "missing" },
  },
  "unknown-input": {
    mutate: (t) => {
      edgeOf(t, "target-build").from = { input: "missing" };
    },
    expect: { edgeId: "target-build" },
  },
  "unknown-outlet": {
    from: () => withGate(baseTemplate()),
    mutate: (t) => {
      edgeOf(t, "findings-fix").from = { node: "check", outlet: "missing", port: "report" };
    },
    expect: { edgeId: "findings-fix" },
  },
  "outlet-required": {
    from: () => withGate(baseTemplate()),
    mutate: (t) => {
      edgeOf(t, "findings-fix").from = { node: "check", port: "report" };
    },
    expect: { edgeId: "findings-fix" },
  },
  "outlet-not-applicable": {
    mutate: (t) => {
      edgeOf(t, "build-review").from = { node: "build", outlet: "done", port: "code" };
    },
    expect: { edgeId: "build-review" },
  },
  "unknown-role": {
    mutate: (t) => {
      agentOf(t, "review").role = "ghost";
    },
    expect: { nodeId: "review", path: "nodes[1].role" },
  },
  "role-multiplicity": {
    mutate: (t) => {
      agentOf(t, "review").role = "panel";
    },
    expect: { nodeId: "review" },
  },
  "subgraph-unsupported": {
    mutate: (t) => {
      t.nodes.push({
        id: "inner",
        kind: "subgraph",
        template: { scope: "builtin", id: "multi-review" },
        inputs: [{ name: "target", type: "workspace@1" }],
      });
      t.edges.push({
        id: "build-inner",
        from: { node: "build", port: "code" },
        to: { node: "inner", port: "target" },
      });
    },
    expect: { nodeId: "inner", path: "nodes[2].kind" },
  },
  "replicate-items-unsupported": {
    from: () => graphTemplateExample("failure-diagnosis"),
    mutate: () => {},
    expect: { nodeId: "diagnose", path: "nodes[1].replicate" },
  },
  "output-port-list": {
    mutate: (t) => {
      agentOf(t, "review").outputs![0]!.type = "list<review-report@1>";
    },
    expect: { nodeId: "review", port: "report", path: "nodes[1].outputs[0].type" },
  },
  "output-port-reserved": {
    mutate: (t) => {
      agentOf(t, "review").outputs!.push({ name: "review_report", type: "review-report@1" });
    },
    expect: { nodeId: "review", port: "review_report" },
  },
  "error-port-type": {
    mutate: (t) => {
      agentOf(t, "build").outputs!.push({ name: "error", type: "text@1" });
    },
    expect: { nodeId: "build", port: "error" },
  },
  "route-without-error-port": {
    mutate: (t) => {
      agentOf(t, "build").onFailure = "route";
    },
    expect: { nodeId: "build", path: "nodes[0].onFailure" },
  },
  "system-param-invalid": {
    mutate: (t) => {
      withPush(t, { force: true });
    },
    expect: { nodeId: "push", path: "nodes[2].params.force", detail: "unknown" },
  },
  "system-port-unsupported": {
    mutate: (t) => {
      withPush(t).outputs = [{ name: "report", type: "fix-result@1" }];
    },
    expect: { nodeId: "push", port: "report", detail: "output-type" },
  },
  "system-input-missing": {
    mutate: (t) => {
      const node = withPush(t);
      node.action = "open-pull-request";
    },
    expect: { nodeId: "push", path: "nodes[2].inputs" },
  },

  // ------------------------------------------------------------ topology
  "graph-cycle": {
    mutate: (t) => {
      agentOf(t, "build").inputs!.push({
        name: "feedback",
        type: "review-report@1",
        required: false,
      });
      t.edges.push({
        id: "review-build",
        from: { node: "review", port: "report" },
        to: { node: "build", port: "feedback" },
      });
    },
    expect: { nodeId: "build" },
  },
  "loop-unbounded": {
    from: pipeline,
    mutate: (t) => {
      delete (t.loops![0] as Partial<GraphLoopRegion>).maxIterations;
    },
    expect: { loopId: "rounds", path: "loops[0].maxIterations", detail: "required" },
  },
  "loop-bound-exceeded": {
    from: pipeline,
    mutate: (t) => {
      t.loops![0]!.maxIterations = 11;
    },
    expect: { loopId: "rounds", detail: "out_of_range" },
  },
  "loop-overlap": {
    from: pipeline,
    mutate: (t) => {
      t.loops!.push({
        id: "second",
        nodes: ["verify"],
        until: { path: "verify.verdict.complete", op: "eq", value: true },
        maxIterations: 2,
        carry: [],
      });
    },
    expect: { loopId: "second", nodeId: "verify" },
  },
  "loop-not-contiguous": {
    from: pipeline,
    mutate: (t) => {
      t.loops![0]!.nodes = t.loops![0]!.nodes.filter((node) => node !== "review");
    },
    expect: { loopId: "rounds" },
  },
  "loop-carry-outside": {
    from: pipeline,
    mutate: (t) => {
      t.loops![0]!.carry.push({
        from: { node: "build", port: "code" },
        to: { node: "fix", port: "code" },
      });
    },
    expect: { loopId: "rounds", path: "loops[0].carry[2]" },
  },
  "first-iteration-invalid": {
    mutate: (t) => {
      agentOf(t, "review").inputs![0]!.firstIterationFrom = { node: "build", port: "code" };
    },
    expect: { nodeId: "review", detail: "not_in_loop" },
  },

  // ------------------------------------------------------------ ports
  "edge-type-mismatch": {
    mutate: (t) => {
      agentOf(t, "review").inputs![0]!.type = "ticket@1";
    },
    expect: { edgeId: "build-review", detail: "nominal_target" },
  },
  "edge-cardinality": {
    mutate: (t) => {
      agentOf(t, "review").inputs![0]!.type = "list<workspace@1>";
    },
    expect: { edgeId: "build-review", detail: "cardinality" },
  },
  "edge-transform-invalid": {
    mutate: (t) => {
      edgeOf(t, "build-review").transform = [{ op: "limit", count: 3 }];
    },
    expect: { edgeId: "build-review", path: "edges[1].transform[0]", detail: "requires_list" },
  },
  "edge-zip-invalid": {
    mutate: (t) => {
      edgeOf(t, "build-review").zip = true;
    },
    expect: { edgeId: "build-review", path: "edges[1].zip" },
  },
  "input-unbound": {
    mutate: (t) => {
      t.edges = t.edges.filter((edge) => edge.id !== "build-review");
    },
    expect: { nodeId: "review", port: "code" },
  },
  "input-multiple-producers": {
    mutate: (t) => {
      t.edges.push({
        id: "target-review",
        from: { input: "target" },
        to: { node: "review", port: "code" },
      });
    },
    expect: { nodeId: "review", port: "code" },
  },
  "collect-unsatisfiable": {
    from: () => withPanel(baseTemplate()),
    mutate: (t) => {
      agentOf(t, "consolidate").inputs![0]!.collect = {
        wait: "all-settled",
        minSuccessful: 5,
        includeFailures: true,
      };
    },
    expect: { nodeId: "consolidate", port: "reports" },
  },
  "collect-without-fan-in": {
    from: () => withPanel(baseTemplate()),
    mutate: (t) => {
      t.inputs.push({ name: "earlier", type: "list<review-report@1>" });
      agentOf(t, "consolidate").inputs!.push({
        name: "earlier",
        type: "list<review-report@1>",
        collect: { wait: "all-settled", minSuccessful: 1, includeFailures: false },
      });
      t.edges.push({
        id: "earlier-consolidate",
        from: { input: "earlier" },
        to: { node: "consolidate", port: "earlier" },
      });
    },
    expect: { nodeId: "consolidate", port: "earlier", severity: "warning" },
  },
  "merge-invalid": {
    from: () => withPanel(baseTemplate()),
    mutate: (t) => {
      t.nodes.push({
        id: "pick",
        kind: "merge",
        strategy: { kind: "best", score: "summary" },
        inputs: [{ name: "reports", type: "list<review-report@1>" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      });
      t.edges.push({
        id: "review-pick",
        from: { node: "review", port: "report" },
        to: { node: "pick", port: "reports" },
      });
    },
    expect: { nodeId: "pick", detail: "score_path" },
  },
  "output-type-mismatch": {
    mutate: (t) => {
      t.outputs![0]!.type = "fix-result@1";
    },
    expect: { path: "outputs[0]" },
  },
  "condition-invalid": {
    mutate: (t) => {
      agentOf(t, "review").when = { path: "code.missing", op: "exists" };
    },
    expect: { nodeId: "review", detail: "unknown_path" },
  },

  // ------------------------------------------------------------ workspace
  "workspace-unavailable": {
    mutate: (t) => {
      t.workspace = { kind: "none" };
    },
    expect: { nodeId: "build" },
  },
  "workspace-concurrent-writers": {
    mutate: (t) => {
      t.nodes.push({ ...structuredClone(agentOf(t, "build")), id: "build-two" });
      t.edges.push({
        id: "target-build-two",
        from: { input: "target" },
        to: { node: "build-two", port: "code" },
      });
    },
    expect: { nodeId: "build-two" },
  },
  "workspace-read-write-race": {
    mutate: (t) => {
      edgeOf(t, "build-review").from = { input: "target" };
    },
    expect: { nodeId: "review" },
  },
  "replicated-writer": {
    mutate: (t) => {
      agentOf(t, "build").replicate = { over: "samples", count: 2 };
    },
    expect: { nodeId: "build", path: "nodes[0].workspaceAccess" },
  },

  // ------------------------------------------------------------ enforcement, taint
  "enforcement-unmet": {
    mutate: () => {},
    options: { providers: ["grok"] },
    expect: { nodeId: "review", detail: "provider-configured" },
  },
  "enforcement-floor-lowered": {
    mutate: (t) => {
      agentOf(t, "review").minEnforcement = "advisory";
    },
    expect: { nodeId: "review", severity: "warning" },
  },
  "taint-reaches-side-effect": {
    mutate: (t) => {
      agentOf(t, "build").capabilities.allow = ["network"];
    },
    expect: { nodeId: "build", severity: "warning" },
  },
  "acknowledgement-stale": {
    mutate: (t) => {
      t.acknowledgements = [
        { kind: "taint", digest: "0".repeat(64), acknowledgedAt: "2026-10-29T00:00:00Z" },
      ];
    },
    expect: { path: "acknowledgements[0]", severity: "info" },
  },

  // ------------------------------------------------------------ sessions
  "session-source-invalid": {
    mutate: (t) => {
      agentOf(t, "review").session = { mode: "continue", from: "ghost" };
    },
    expect: { nodeId: "review", path: "nodes[1].session.from" },
  },
  "session-role-mismatch": {
    mutate: (t) => {
      t.roles.push({ key: "critic", multiplicity: "one" });
      agentOf(t, "review").role = "critic";
      agentOf(t, "review").session = { mode: "continue", from: "build" };
    },
    expect: { nodeId: "review" },
  },
  "session-not-predecessor": {
    mutate: (t) => {
      t.nodes.push(notesNode());
      agentOf(t, "review").session = { mode: "continue", from: "notes" };
    },
    expect: { nodeId: "review" },
  },
  "session-replicated": {
    mutate: (t) => {
      agentOf(t, "review").replicate = { over: "samples", count: 2 };
      agentOf(t, "review").session = { mode: "continue", from: "build" };
    },
    expect: { nodeId: "review" },
  },

  // ------------------------------------------------------------ limits
  "limit-agent-sessions": {
    mutate: (t) => {
      t.limits.maxAgentSessions = 1;
    },
    expect: { path: "limits.maxAgentSessions" },
  },
  "limit-activations": {
    from: pipeline,
    mutate: (t) => {
      t.loops![0]!.maxIterations = 10;
      agentOf(t, "review").replicate = { over: "samples", count: 32 };
    },
    expect: { path: "limits" },
  },
  "fanout-too-wide": {
    mutate: (t) => {
      agentOf(t, "review").replicate = {
        over: "cross",
        axes: [
          { over: "samples", count: 8 },
          {
            over: "lenses",
            lenses: ["a", "b", "c", "d", "e"].map((key) => ({
              key,
              label: key,
              instruction: `Focus on ${key}.`,
            })),
          },
        ],
      };
    },
    expect: { nodeId: "review", path: "nodes[1].replicate" },
  },
  "concurrency-capped": {
    mutate: (t) => {
      agentOf(t, "review").replicate = { over: "samples", count: 2 };
      t.limits.maxConcurrentAgents = 1;
    },
    expect: { path: "limits.maxConcurrentAgents", severity: "info" },
  },

  // ------------------------------------------------------------ lints
  "output-unused": {
    mutate: (t) => {
      t.outputs = t.outputs!.filter((output) => output.name !== "changes");
    },
    expect: { nodeId: "build", port: "report", severity: "warning" },
  },
  "run-input-unused": {
    mutate: (t) => {
      t.inputs.push({ name: "extra", type: "text@1" });
    },
    expect: { path: "inputs[1]", severity: "warning" },
  },
  "outlet-unused": {
    from: () => withGate(baseTemplate()),
    mutate: () => {},
    expect: { nodeId: "check", severity: "info" },
  },
  "iteration-outside-loop": {
    mutate: (t) => {
      agentOf(t, "review").when = { path: "run.iteration", op: "gt", value: 1 };
    },
    expect: { nodeId: "review", path: "nodes[1].when", severity: "warning" },
  },
  "workspace-unpinned": {
    mutate: (t) => {
      t.nodes.push(notesNode({ capabilities: { profile: "reviewer" }, workspaceAccess: "read" }));
    },
    expect: { nodeId: "notes", severity: "warning" },
  },

  // ------------------------------------------------------------ capabilities (106)
  "capability-remote-write": {
    mutate: (t) => {
      agentOf(t, "build").capabilities.allow = ["git.push"];
    },
    expect: { nodeId: "build", path: "nodes[0].capabilities", detail: "git.push" },
  },
  "capability-mcp-grant": {
    // Grok cannot select user MCP servers, so a grant warns once for it.
    mutate: (t) => {
      agentOf(t, "build").capabilities.allow = ["mcp:docs"];
    },
    expect: { nodeId: "build", detail: "mcp:docs", severity: "warning" },
  },
  "capability-mcp-grant-read-only": {
    mutate: (t) => {
      agentOf(t, "review").capabilities.allow = ["mcp:docs"];
    },
    expect: { nodeId: "review", detail: "mcp:docs", severity: "warning" },
  },
  "capability-allow-unused": {
    mutate: (t) => {
      agentOf(t, "build").capabilities.allow = ["shell"];
    },
    expect: { nodeId: "build", severity: "warning" },
  },
  "capability-workspace-write-denied": {
    mutate: (t) => {
      agentOf(t, "review").workspaceAccess = "write";
    },
    expect: { nodeId: "review", path: "nodes[1].workspaceAccess" },
  },
  "capability-workspace-read-writable": {
    mutate: (t) => {
      agentOf(t, "build").workspaceAccess = "read";
    },
    expect: { nodeId: "build", path: "nodes[0].workspaceAccess" },
  },
};

describe("compile diagnostics, one per code", () => {
  test("the base fixture compiles without diagnostics", () => {
    const result = compile(baseTemplate());
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.launchable).toBe(true);
  });

  for (const [code, entry] of Object.entries(CASES)) {
    test(code, () => {
      const template = (entry.from ?? baseTemplate)();
      entry.mutate(template);
      const result = compile(template, entry.options);
      const found = result.diagnostics.filter((diagnostic) => diagnostic.code === code);
      expect({ code, found: found.length > 0 }).toEqual({ code, found: true });
      expect(found).toContainEqual(expect.objectContaining(entry.expect ?? {}));
      for (const diagnostic of found) {
        expect(diagnostic.message.length).toBeGreaterThan(0);
        if (diagnostic.severity === "error") expect(result.plan).toBeNull();
      }
    });
  }

  test("every compiler and capability code has a case", () => {
    expect(Object.keys(CASES).sort()).toEqual(
      [...GRAPH_COMPILE_DIAGNOSTIC_CODES, ...GRAPH_CAPABILITY_ISSUE_CODES].sort(),
    );
  });
});

describe("pass-through prompt lints (item 105)", () => {
  test("the prompt size ceiling", () => {
    const result = compile(baseTemplate(), { promptCeilingBytes: 16 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "prompt-size-over-ceiling",
        severity: "warning",
        nodeId: "build",
        path: "nodes[0].prompt.template",
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("an unbound variable is an error pinned to the prompt", () => {
    const template = baseTemplate();
    agentOf(template, "review").prompt = { template: "Focus on {{lens.label}}.\n{{> input.code}}" };
    const result = compile(template);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "prompt-unbound-variable",
        severity: "error",
        nodeId: "review",
        detail: "lens.label",
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("rule details", () => {
  test("firstIterationFrom needs an edge from outside the loop and a later source", () => {
    const codes = (mutate: (t: GraphTemplateV1) => void) => {
      const template = pipeline();
      mutate(template);
      return compile(template)
        .diagnostics.filter((d) => d.code === "first-iteration-invalid")
        .map((d) => d.detail);
    };
    const prepare = (t: GraphTemplateV1) => agentOf(t, "prepare").inputs![0]!;
    expect(codes(() => {})).toEqual([]);
    expect(codes((t) => (prepare(t).firstIterationFrom = { input: "target" }))).toEqual([
      "no_edge",
    ]);
    expect(codes((t) => (prepare(t).firstIterationFrom = { node: "fix", port: "code" }))).toEqual([
      "inside_loop",
    ]);
    expect(
      codes((t) => {
        t.edges = t.edges.filter((edge) => edge.id !== "fix-prepare");
      }),
    ).toEqual(["no_later_source"]);
  });

  test("two producers on different outlets of one gate may feed one port", () => {
    const template = withGate(baseTemplate());
    // The clean outlet forwards the review's report to the same consumer.
    nodeOf(template, "check").inputs!.push({ name: "code", type: "workspace@1" });
    template.edges.push(
      {
        id: "build-check",
        from: { node: "build", port: "code" },
        to: { node: "check", port: "code" },
      },
      {
        id: "clean-fix",
        from: { node: "check", outlet: "clean", port: "report" },
        to: { node: "fix", port: "report" },
      },
    );
    const result = compile(template);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("input-multiple-producers");
    // And not from one outlet twice.
    edgeOf(template, "clean-fix").from = { node: "check", outlet: "findings", port: "report" };
    expect(compile(template).diagnostics.map((d) => d.code)).toContain("input-multiple-producers");
  });

  test("writers on mutually exclusive outlets do not race", () => {
    const template = withGate(baseTemplate());
    template.nodes.push({
      ...structuredClone(agentOf(template, "fix")),
      id: "polish",
      prompt: { template: "Polish.\n\n{{> input.report}}\n\n{{> input.code}}\n" },
    });
    template.edges.push(
      {
        id: "clean-polish",
        from: { node: "check", outlet: "clean", port: "report" },
        to: { node: "polish", port: "report" },
      },
      {
        id: "build-polish",
        from: { node: "build", port: "code" },
        to: { node: "polish", port: "code" },
      },
    );
    template.outputs!.push({
      name: "polished",
      type: "workspace@1",
      required: false,
      from: { node: "polish", port: "code" },
    });
    const codes = compile(template).diagnostics.map((d) => d.code);
    expect(codes).not.toContain("workspace-concurrent-writers");
    expect(codes).not.toContain("workspace-read-write-race");
  });

  test("library types and template types that agree are accepted", () => {
    const template = baseTemplate();
    template.types = [THING];
    const result = compile(template, { types: [THING] });
    expect(result.diagnostics.map((d) => d.code)).not.toContain("type-conflict");
  });

  test("a library type with an unknown schema keyword is type-invalid", () => {
    const bad = { ...THING, name: "other", schema: { ...THING.schema, $ref: "#/x" } };
    const result = compile(baseTemplate(), { types: [bad] });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type-invalid", path: "$types[0].schema.$ref" }),
    );
  });

  test("every reserved output name is refused", () => {
    for (const name of ["workflow_result", "consolidated_review", "verification_result"]) {
      const template = baseTemplate();
      agentOf(template, "review").outputs!.push({ name, type: "text@1" });
      expect(compile(template).diagnostics.map((d) => d.code)).toContain("output-port-reserved");
    }
  });

  test("an acknowledged warning is info and the plan launches", () => {
    const template = baseTemplate();
    agentOf(template, "build").capabilities.allow = ["network"];
    const first = compile(template);
    expect(first.launchable).toBe(false);
    expect(first.ok).toBe(true);
    const pending = first.pendingAcknowledgements;
    expect(pending).toEqual([
      expect.objectContaining({
        kind: "taint",
        code: "taint-reaches-side-effect",
        nodeId: "build",
      }),
    ]);
    template.acknowledgements = pending.map((ref) => ({
      kind: ref.kind,
      digest: ref.digest,
      acknowledgedAt: "2026-10-29T00:00:00Z",
    }));
    const second = compile(template);
    expect(second.launchable).toBe(true);
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "taint-reaches-side-effect",
        severity: "info",
        acknowledgement: { kind: "taint", digest: pending[0]!.digest, accepted: true },
      }),
    );
    expect(second.plan!.acknowledgements.accepted).toEqual(pending);
  });
});
