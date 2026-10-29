/**
 * Sub-graph fixtures for the compiler tests (item 402): a small child
 * template, a parent that inlines it after the base fixture's build, and a
 * resolver over a fixed set of templates. Test-only.
 */
import { baseTemplate } from "./compile-fixtures.test-support.js";
import type { GraphTemplateResolver } from "./subgraphs.js";
import type { GraphSubgraphNode, GraphTemplateV1 } from "./template-model.js";
import { graphBuiltInTemplate } from "./builtins/index.js";

/**
 * `child` (user scope): one reviewer that reads the code under a `depth`
 * parameter, a gate on its findings (reading `strict`) and a fixer.
 */
export function childTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "child",
    revision: 3,
    name: "Child",
    parameters: [
      { key: "strict", type: "boolean", default: false },
      { key: "depth", type: "integer", min: 1, max: 5, default: 2 },
    ],
    roles: [
      { key: "checker", multiplicity: "one" },
      { key: "fixer", multiplicity: "one" },
    ],
    inputs: [{ name: "code", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "check", port: "report" } },
      {
        name: "fixed",
        type: "workspace@1",
        required: false,
        from: { node: "fix", port: "code" },
      },
    ],
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
      {
        id: "gate",
        kind: "gate",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [
          {
            to: "fix",
            when: {
              all: [
                { path: "params.strict", op: "eq", value: true },
                { path: "report.issues", op: "nonEmpty" },
              ],
            },
          },
        ],
        otherwise: "done",
      },
      {
        id: "fix",
        kind: "agent",
        role: "fixer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { template: "Fix.\n\n{{> input.report}}\n\n{{> input.code}}\n" },
        inputs: [
          { name: "report", type: "review-report@1", render: "summary" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
    ],
    edges: [
      { id: "code-check", from: { input: "code" }, to: { node: "check", port: "code" } },
      { id: "code-gate", from: { input: "code" }, to: { node: "gate", port: "code" } },
      {
        id: "check-gate",
        from: { node: "check", port: "report" },
        to: { node: "gate", port: "report" },
      },
      {
        id: "gate-fix-report",
        from: { node: "gate", outlet: "fix", port: "report" },
        to: { node: "fix", port: "report" },
      },
      {
        id: "gate-fix-code",
        from: { node: "gate", outlet: "fix", port: "code" },
        to: { node: "fix", port: "code" },
      },
    ],
    limits: { maxAgentSessions: 2, maxConcurrentAgents: 1 },
    layout: { check: { x: 0, y: 0 }, gate: { x: 200, y: 0 }, fix: { x: 400, y: 0 } },
  };
}

/** The sub-graph node `audit` that inlines `child` (user scope). */
export function auditNode(overrides: Partial<GraphSubgraphNode> = {}): GraphSubgraphNode {
  return {
    id: "audit",
    kind: "subgraph",
    template: { scope: "user", id: "child" },
    params: { strict: { param: "flag" } },
    roles: { checker: "worker", fixer: "worker" },
    inputs: [{ name: "code", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1" },
      { name: "fixed", type: "workspace@1", required: false },
    ],
    ...overrides,
  };
}

/**
 * The base fixture with `audit` reading build's commit; its report and its
 * fixed branch (when the node exposes it) are run outputs. Review is dropped so the only writers
 * downstream of build are inside the sub-graph.
 */
export function parentTemplate(node: GraphSubgraphNode = auditNode()): GraphTemplateV1 {
  const template = baseTemplate();
  template.nodes = template.nodes.filter((entry) => entry.id !== "review");
  template.edges = template.edges.filter((edge) => edge.id !== "build-review");
  template.nodes.push(node);
  template.edges.push({
    id: "build-audit",
    from: { node: "build", port: "code" },
    to: { node: node.id, port: "code" },
  });
  template.outputs = [
    { name: "report", type: "review-report@1", from: { node: node.id, port: "report" } },
    { name: "changes", type: "fix-result@1", from: { node: "build", port: "report" } },
    ...((node.outputs ?? []).some((port) => port.name === "fixed")
      ? [
          {
            name: "fixed",
            type: "workspace@1",
            required: false,
            from: { node: node.id, port: "fixed" },
          },
        ]
      : []),
  ];
  return template;
}

/** Resolves user templates from `templates` (by id) and built-ins from code. */
export function resolverOf(...templates: GraphTemplateV1[]): GraphTemplateResolver {
  const byId = new Map(templates.map((template) => [template.id, template]));
  return (ref) => {
    if (ref.scope === "builtin") {
      const builtIn = graphBuiltInTemplate(ref.id);
      return builtIn ? { template: builtIn.template } : undefined;
    }
    const template = byId.get(ref.id);
    return template ? { template: structuredClone(template) } : undefined;
  };
}
