import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { blankGraphTemplate } from "./graph-designer-edits";

/** Templates for the predicate, scope and node-kind editor tests (item 212). */

/** review → gate (findings / clean) → fix; judge's decision with choices → approve. */
export function gatedTemplate(): GraphTemplateV1 {
  return {
    ...blankGraphTemplate({ id: "gated", name: "Gated" }),
    roles: [{ key: "reviewer", multiplicity: "one" }],
    parameters: [{ key: "autoFix", type: "boolean", default: true }],
    nodes: [
      {
        id: "review",
        kind: "agent",
        role: "reviewer",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Review.\n" },
        outputs: [
          { name: "report", type: "review-report@1" },
          { name: "decision", type: "decision@1", choices: ["ship", "hold"] },
        ],
      },
      {
        id: "check",
        kind: "gate",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "decision", type: "decision@1" },
        ],
        branches: [{ to: "findings", when: { path: "report.issues", op: "nonEmpty" } }],
        otherwise: "clean",
      },
      {
        id: "approve",
        kind: "human",
        form: { kind: "approve" },
        inputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      {
        id: "review-check",
        from: { node: "review", port: "report" },
        to: { node: "check", port: "report" },
      },
      {
        id: "review-check-decision",
        from: { node: "review", port: "decision" },
        to: { node: "check", port: "decision" },
      },
      {
        id: "check-approve",
        from: { node: "check", outlet: "findings", port: "report" },
        to: { node: "approve", port: "report" },
      },
    ],
    outputs: [
      {
        name: "clean",
        type: "review-report@1",
        from: { node: "check", outlet: "clean", port: "report" },
      },
    ],
    loops: [
      {
        id: "rounds",
        nodes: ["review", "check"],
        until: { path: "review.report.issues", op: "empty" },
        maxIterations: 3,
        carry: [],
      },
    ],
  };
}

/** A system node, a merge over reports, and an approval whose outlets feed a fixer. */
export function kindsTemplate(): GraphTemplateV1 {
  return {
    ...blankGraphTemplate({ id: "kinds", name: "Kinds" }),
    roles: [{ key: "fixer", multiplicity: "one" }],
    nodes: [
      {
        id: "pr",
        kind: "system",
        action: "open-pull-request",
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [{ name: "pr", type: "pr-result@1" }],
      },
      {
        id: "merge",
        kind: "merge",
        inputs: [{ name: "sources", type: "list<review-report@1>" }],
        outputs: [{ name: "report", type: "review-report@1" }],
        strategy: { kind: "concat" },
      },
      {
        id: "approve",
        kind: "human",
        form: { kind: "approve" },
        inputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "fix",
        kind: "agent",
        role: "fixer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { template: "Fix.\n" },
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "rejected", type: "review-report@1", required: false },
        ],
      },
    ],
    edges: [
      {
        id: "merge-approve",
        from: { node: "merge", port: "report" },
        to: { node: "approve", port: "report" },
      },
      {
        id: "approved-fix",
        from: { node: "approve", outlet: "approved", port: "report" },
        to: { node: "fix", port: "report" },
      },
      {
        id: "rejected-fix",
        from: { node: "approve", outlet: "rejected", port: "report" },
        to: { node: "fix", port: "rejected" },
      },
    ],
  };
}
