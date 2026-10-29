/**
 * Small templates for the compiler tests: a clean base (build, then review)
 * and helpers that add a gate, a panel and other pieces. Test-only.
 */
import type {
  GraphAgentNode,
  GraphEdgeSpec,
  GraphNodeSpec,
  GraphTemplateV1,
} from "./template-model.js";

export function baseTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "base",
    revision: 1,
    name: "Base",
    parameters: [{ key: "flag", type: "boolean", default: true }],
    roles: [
      { key: "worker", multiplicity: "one" },
      { key: "panel", multiplicity: "panel", maxPanel: 4 },
    ],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "review", port: "report" } },
      { name: "changes", type: "fix-result@1", from: { node: "build", port: "report" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "build",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { template: "Implement the change.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "review",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Review the change.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      { id: "target-build", from: { input: "target" }, to: { node: "build", port: "code" } },
      {
        id: "build-review",
        from: { node: "build", port: "code" },
        to: { node: "review", port: "code" },
      },
    ],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4 },
  };
}

export function nodeOf(template: GraphTemplateV1, id: string): GraphNodeSpec {
  const node = template.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

export function agentOf(template: GraphTemplateV1, id: string): GraphAgentNode {
  const node = nodeOf(template, id);
  if (node.kind !== "agent") throw new Error(`${id} is not an agent node`);
  return node;
}

export function edgeOf(template: GraphTemplateV1, id: string): GraphEdgeSpec {
  const edge = template.edges.find((entry) => entry.id === id);
  if (!edge) throw new Error(`no edge ${id}`);
  return edge;
}

/** A gate on the review's findings; `fix` (a builder) takes the findings outlet. */
export function withGate(template: GraphTemplateV1): GraphTemplateV1 {
  template.nodes.push(
    {
      id: "check",
      kind: "gate",
      inputs: [{ name: "report", type: "review-report@1" }],
      branches: [{ to: "findings", when: { path: "report.issues", op: "nonEmpty" } }],
      otherwise: "clean",
    },
    {
      id: "fix",
      kind: "agent",
      role: "worker",
      capabilities: { profile: "builder" },
      workspaceAccess: "write",
      prompt: { template: "Fix the findings.\n\n{{> input.report}}\n\n{{> input.code}}\n" },
      inputs: [
        { name: "report", type: "review-report@1" },
        { name: "code", type: "workspace@1" },
      ],
      outputs: [{ name: "code", type: "workspace@1" }],
    },
  );
  template.edges.push(
    {
      id: "review-check",
      from: { node: "review", port: "report" },
      to: { node: "check", port: "report" },
    },
    {
      id: "findings-fix",
      from: { node: "check", outlet: "findings", port: "report" },
      to: { node: "fix", port: "report" },
    },
    { id: "build-fix", from: { node: "build", port: "code" }, to: { node: "fix", port: "code" } },
  );
  template.outputs!.push({
    name: "fixed",
    type: "workspace@1",
    required: false,
    from: { node: "fix", port: "code" },
  });
  return template;
}

/** The review runs as a panel and a consolidator collects the reports. */
export function withPanel(template: GraphTemplateV1): GraphTemplateV1 {
  const review = agentOf(template, "review");
  review.role = "panel";
  review.replicate = { over: "panel", role: "panel" };
  template.nodes.push({
    id: "consolidate",
    kind: "agent",
    role: "worker",
    capabilities: { profile: "observer" },
    workspaceAccess: "none",
    prompt: { template: "Consolidate the reports.\n\n{{> input.reports}}\n" },
    inputs: [{ name: "reports", type: "list<review-report@1>" }],
    outputs: [{ name: "report", type: "review-report@1", provenance: "accountForAll" }],
  });
  template.edges.push({
    id: "review-consolidate",
    from: { node: "review", port: "report" },
    to: { node: "consolidate", port: "reports" },
  });
  template.outputs![0] = {
    name: "report",
    type: "review-report@1",
    from: { node: "consolidate", port: "report" },
  };
  return template;
}

/** An agent with no inputs, for session and workspace cases. */
export function notesNode(overrides: Partial<GraphAgentNode> = {}): GraphAgentNode {
  return {
    id: "notes",
    kind: "agent",
    role: "worker",
    capabilities: { profile: "observer" },
    workspaceAccess: "none",
    prompt: { template: "Write release notes." },
    outputs: [{ name: "notes", type: "text@1" }],
    ...overrides,
  };
}
