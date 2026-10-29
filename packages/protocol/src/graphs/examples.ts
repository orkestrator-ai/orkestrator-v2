/**
 * The worked examples of the composable-graphs report (§9), encoded as
 * complete `GraphTemplateV1` documents.
 *
 * The report shows them as YAML sketches with parts omitted (names, edges,
 * limits, prompts). Each omission is filled here with the smallest choice
 * that keeps the example's meaning, and noted beside it. Later items reuse
 * these: the compiler must compile them (107), mock runs execute them (213)
 * and the designer renders them (110, 212). Each accessor returns a fresh
 * copy, so a caller may mutate what it gets.
 */
import type { GraphPredicate } from "./predicate-shape.js";
import type {
  GraphEdgeSource,
  GraphEdgeSpec,
  GraphPortTarget,
  GraphTemplateV1,
} from "./template-model.js";

export const GRAPH_TEMPLATE_EXAMPLE_KEYS = [
  "multi-review",
  "build-pipeline-loop",
  "design-bake-off",
  "failure-diagnosis",
] as const;
export type GraphTemplateExampleKey = (typeof GRAPH_TEMPLATE_EXAMPLE_KEYS)[number];

export interface GraphTemplateExample {
  key: GraphTemplateExampleKey;
  /** The report section the example encodes. */
  reportSection: "9.1" | "9.2" | "9.3" | "9.4";
  title: string;
  template: GraphTemplateV1;
}

function edge(
  id: string,
  from: GraphEdgeSource,
  to: GraphPortTarget,
  extra: Partial<Pick<GraphEdgeSpec, "transform" | "zip">> = {},
): GraphEdgeSpec {
  return { id, from, to, ...extra };
}

function hasFindings(): GraphPredicate {
  return {
    any: [
      { path: "report.issues", op: "nonEmpty" },
      { path: "report.testCoverageGaps", op: "nonEmpty" },
    ],
  };
}

/** Report §9.1. Added: a `describe-pr` node, since the PR description needs a producer. */
function multiReview(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "multi-review",
    revision: 1,
    name: "Multi Review",
    description:
      "Prepare and seal a review package, review it with a panel, consolidate, then optionally fix and open a pull request.",
    parameters: [
      { key: "autoFix", type: "boolean", default: true },
      { key: "autoPr", type: "boolean", default: false },
    ],
    roles: [
      { key: "preparer", multiplicity: "one", defaultsFrom: ["reviewPreparation"] },
      {
        key: "reviewer",
        multiplicity: "panel",
        maxPanel: 32,
        defaultsFrom: ["review", "review2", "additionalReviewers"],
      },
      { key: "consolidator", multiplicity: "one", defaultsFrom: ["reviewPreparation"] },
      { key: "fixer", multiplicity: "one", defaultsFrom: ["fixReviewIssues"] },
      { key: "describer", multiplicity: "one", defaultsFrom: ["pr"] },
    ],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "consolidate", port: "report" } },
      { name: "code", type: "workspace@1", required: false, from: { node: "fix", port: "code" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "plan",
        kind: "agent",
        role: "preparer",
        // Commits safe changes first.
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "review-package-preparation" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "package",
        kind: "system",
        action: "run-validation-and-seal",
        inputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "package", type: "review-package@2" }],
      },
      {
        id: "review",
        kind: "agent",
        role: "reviewer",
        replicate: { over: "panel", role: "reviewer" },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        minEnforcement: "provider-configured",
        prompt: { builtIn: "discovery-review" },
        inputs: [{ name: "package", type: "review-package@2", render: "file" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "consolidate",
        kind: "agent",
        role: "consolidator",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: { builtIn: "consolidation" },
        inputs: [
          {
            name: "reports",
            type: "list<review-report@1>",
            render: "json-frame",
            collect: { wait: "all-settled", minSuccessful: 1, includeFailures: true },
          },
        ],
        outputs: [{ name: "report", type: "review-report@1", provenance: "accountForAll" }],
      },
      {
        id: "has-findings",
        kind: "gate",
        inputs: [{ name: "report", type: "review-report@1" }],
        branches: [{ when: hasFindings(), to: "findings" }],
        otherwise: "clean",
      },
      {
        id: "fix",
        kind: "agent",
        role: "fixer",
        when: { path: "params.autoFix", op: "eq", value: true },
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        // Today: an ordinary interactive tab.
        session: { mode: "fresh" },
        prompt: { builtIn: "fix-review-issues" },
        inputs: [
          { name: "report", type: "review-report@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "result", type: "fix-result@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "describe-pr",
        kind: "agent",
        role: "describer",
        when: { path: "params.autoPr", op: "eq", value: true },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "pull-request-description" },
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "result", type: "fix-result@1", render: "json-frame" },
        ],
        outputs: [{ name: "description", type: "pr-description@1" }],
      },
      {
        id: "pr",
        kind: "system",
        action: "open-pull-request",
        when: { path: "params.autoPr", op: "eq", value: true },
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [{ name: "pr", type: "pr-result@1" }],
      },
    ],
    edges: [
      edge("target-plan", { input: "target" }, { node: "plan", port: "code" }),
      edge("plan-package-plan", { node: "plan", port: "plan" }, { node: "package", port: "plan" }),
      edge("plan-package-code", { node: "plan", port: "code" }, { node: "package", port: "code" }),
      edge(
        "package-review",
        { node: "package", port: "package" },
        { node: "review", port: "package" },
      ),
      edge(
        "review-consolidate",
        { node: "review", port: "report" },
        { node: "consolidate", port: "reports" },
      ),
      edge(
        "consolidate-gate",
        { node: "consolidate", port: "report" },
        { node: "has-findings", port: "report" },
      ),
      edge(
        "findings-fix",
        { node: "has-findings", outlet: "findings", port: "report" },
        { node: "fix", port: "report" },
      ),
      edge("plan-fix", { node: "plan", port: "code" }, { node: "fix", port: "code" }),
      edge(
        "fix-describe-code",
        { node: "fix", port: "code" },
        { node: "describe-pr", port: "code" },
      ),
      edge(
        "fix-describe-result",
        { node: "fix", port: "result" },
        { node: "describe-pr", port: "result" },
      ),
      edge("fix-pr", { node: "fix", port: "code" }, { node: "pr", port: "code" }),
      edge(
        "describe-pr-pr",
        { node: "describe-pr", port: "description" },
        { node: "pr", port: "description" },
      ),
    ],
    // plan 1 + reviewers 32 + consolidate 1 + fix 1 + describe-pr 1.
    limits: { maxAgentSessions: 36, maxConcurrentAgents: 32 },
  };
}

/**
 * Report §9.2. The report shows only the loop; the nodes around it follow the
 * Build Pipeline after Phase 0: a single reviewer, a typed Address report
 * (P0.4), and Verify reading the commit it approves.
 */
function buildPipelineLoop(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "build-pipeline-loop",
    revision: 1,
    name: "Build Pipeline loop",
    description:
      "Build once, then prepare, package, review, address and verify in rounds until Verify passes.",
    parameters: [],
    roles: [
      { key: "builder", multiplicity: "one" },
      { key: "preparer", multiplicity: "one", defaultsFrom: ["reviewPreparation"] },
      { key: "reviewer", multiplicity: "one", defaultsFrom: ["review"] },
      { key: "fixer", multiplicity: "one", defaultsFrom: ["fixReviewIssues"] },
      { key: "verifier", multiplicity: "one", defaultsFrom: ["verify"] },
    ],
    inputs: [
      { name: "ticket", type: "ticket@1" },
      { name: "target", type: "workspace@1" },
    ],
    outputs: [
      {
        name: "verdict",
        type: "verification-verdict@1",
        from: { node: "verify", port: "verdict" },
      },
      { name: "code", type: "workspace@1", from: { node: "verify", port: "code" } },
    ],
    workspace: { kind: "environment", create: { kind: "worktree" } },
    nodes: [
      {
        id: "build",
        kind: "agent",
        role: "builder",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "build" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "fix",
        kind: "agent",
        role: "builder",
        when: { path: "run.iteration", op: "gt", value: 1 },
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "pipeline-fix" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "feedback", type: "verification-verdict@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "prepare",
        kind: "agent",
        role: "preparer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "review-package-preparation" },
        inputs: [
          {
            name: "code",
            type: "workspace@1",
            // Build's commit on iteration 1, Fix's afterwards.
            firstIterationFrom: { node: "build", port: "code" },
          },
        ],
        outputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "package",
        kind: "system",
        action: "run-validation-and-seal",
        inputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "package", type: "review-package@2" }],
      },
      {
        id: "review",
        kind: "agent",
        role: "reviewer",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        minEnforcement: "provider-configured",
        prompt: { builtIn: "discovery-review" },
        inputs: [
          { name: "package", type: "review-package@2", render: "file" },
          { name: "ticket", type: "ticket@1", render: "markdown" },
        ],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "has-issues",
        kind: "gate",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [{ when: hasFindings(), to: "issues" }],
        otherwise: "clean",
      },
      {
        id: "address",
        kind: "agent",
        role: "fixer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "address-review" },
        inputs: [
          { name: "report", type: "review-report@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "verify",
        kind: "agent",
        role: "verifier",
        capabilities: { profile: "verifier" },
        workspaceAccess: "read",
        minEnforcement: "provider-configured",
        prompt: { builtIn: "verify" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "code", type: "workspace@1" },
          { name: "address", type: "fix-result@1", required: false, render: "json-frame" },
        ],
        outputs: [
          { name: "verdict", type: "verification-verdict@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
    ],
    edges: [
      edge("target-build", { input: "target" }, { node: "build", port: "code" }),
      edge("ticket-build", { input: "ticket" }, { node: "build", port: "ticket" }),
      edge("build-prepare", { node: "build", port: "code" }, { node: "prepare", port: "code" }),
      edge("fix-prepare", { node: "fix", port: "code" }, { node: "prepare", port: "code" }),
      edge("ticket-fix", { input: "ticket" }, { node: "fix", port: "ticket" }),
      edge(
        "prepare-package-plan",
        { node: "prepare", port: "plan" },
        { node: "package", port: "plan" },
      ),
      edge(
        "prepare-package-code",
        { node: "prepare", port: "code" },
        { node: "package", port: "code" },
      ),
      edge(
        "package-review",
        { node: "package", port: "package" },
        { node: "review", port: "package" },
      ),
      edge("ticket-review", { input: "ticket" }, { node: "review", port: "ticket" }),
      edge(
        "review-gate",
        { node: "review", port: "report" },
        { node: "has-issues", port: "report" },
      ),
      edge("prepare-gate", { node: "prepare", port: "code" }, { node: "has-issues", port: "code" }),
      edge(
        "issues-address-report",
        { node: "has-issues", outlet: "issues", port: "report" },
        { node: "address", port: "report" },
      ),
      edge(
        "issues-address-code",
        { node: "has-issues", outlet: "issues", port: "code" },
        { node: "address", port: "code" },
      ),
      // Two producers into verify.code, on mutually exclusive gate outlets.
      edge(
        "address-verify-code",
        { node: "address", port: "code" },
        { node: "verify", port: "code" },
      ),
      edge(
        "clean-verify-code",
        { node: "has-issues", outlet: "clean", port: "code" },
        { node: "verify", port: "code" },
      ),
      edge(
        "address-verify-report",
        { node: "address", port: "report" },
        { node: "verify", port: "address" },
      ),
      edge("ticket-verify", { input: "ticket" }, { node: "verify", port: "ticket" }),
    ],
    loops: [
      {
        id: "rounds",
        nodes: ["fix", "prepare", "package", "review", "has-issues", "address", "verify"],
        until: { path: "verify.verdict.complete", op: "eq", value: true },
        // Today's default; the protocol maximum is 10.
        maxIterations: 3,
        carry: [
          { from: { node: "verify", port: "verdict" }, to: { node: "fix", port: "feedback" } },
          { from: { node: "verify", port: "code" }, to: { node: "fix", port: "code" } },
        ],
      },
    ],
    // build 1 + (fix, prepare, review, address, verify) × 3.
    limits: { maxAgentSessions: 16, maxConcurrentAgents: 1 },
  };
}

function designBriefExample() {
  return {
    summary: "Cache resolved settings per project.",
    approach: "Add a bounded LRU keyed by project id, invalidated on settings writes.",
    risks: ["Stale reads if an invalidation path is missed."],
    filesTouched: ["apps/backend/src/core/settings-service.ts"],
  };
}

/**
 * Report §9.3. Added: the judge also emits the chosen brief (citing its
 * source) so the human node has one artifact to edit, and a `describe-pr`
 * node produces the PR description. The taint acknowledgement the report
 * mentions needs the compiler's warning digest (107), so it is not encoded.
 */
function designBakeOff(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "design-bake-off",
    revision: 1,
    name: "Design bake-off",
    description:
      "Three designers propose briefs through different lenses, a judge picks one, a person approves it, then Build, Multi Review and a pull request.",
    parameters: [],
    roles: [
      { key: "designer", multiplicity: "one" },
      { key: "judge", multiplicity: "one" },
      { key: "builder", multiplicity: "one" },
      { key: "preparer", multiplicity: "one", defaultsFrom: ["reviewPreparation"] },
      {
        key: "reviewer",
        multiplicity: "panel",
        maxPanel: 8,
        defaultsFrom: ["review", "review2", "additionalReviewers"],
      },
      { key: "consolidator", multiplicity: "one", defaultsFrom: ["reviewPreparation"] },
      { key: "describer", multiplicity: "one", defaultsFrom: ["pr"] },
    ],
    types: [
      {
        name: "design-brief",
        version: 1,
        label: "Design brief",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            approach: { type: "string" },
            risks: { type: "array", items: { type: "string" } },
            filesTouched: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "approach", "risks", "filesTouched"],
          additionalProperties: false,
        },
        storage: "value",
        budgets: { maxBytes: 65_536, maxStringBytes: 16_384, maxItems: 100 },
        render: { summary: ["summary"] },
        example: designBriefExample(),
      },
    ],
    inputs: [
      { name: "ticket", type: "ticket@1" },
      { name: "target", type: "workspace@1" },
    ],
    outputs: [{ name: "pr", type: "pr-result@1", from: { node: "pr", port: "pr" } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "design",
        kind: "agent",
        role: "designer",
        replicate: {
          over: "lenses",
          lenses: [
            {
              key: "simplicity",
              label: "Simplicity",
              instruction: "Prefer the smallest change that fully solves the ticket.",
            },
            {
              key: "performance",
              label: "Performance",
              instruction: "Prefer the design with the best latency and memory profile.",
            },
            {
              key: "security",
              label: "Security",
              instruction: "Prefer the design with the smallest attack surface.",
            },
          ],
        },
        // Reads the code and searches the web, so its briefs are tainted (§5.13).
        capabilities: { profile: "researcher" },
        workspaceAccess: "read",
        minEnforcement: "provider-configured",
        prompt: {
          template:
            "Propose a design for the ticket below.\n\n{{> input.ticket}}\n\nFocus: {{lens.label}}. {{lens.instruction}}\n",
        },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "brief", type: "design-brief@1" }],
      },
      {
        id: "judge",
        kind: "agent",
        role: "judge",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: {
          template:
            "Choose the best design brief for the ticket. Your choice must be one of the lens keys.\n\n{{> input.ticket}}\n\n{{> input.briefs}}\n",
        },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          {
            name: "briefs",
            type: "list<design-brief@1>",
            render: "json-frame",
            collect: { wait: "all-settled", minSuccessful: 1, includeFailures: false },
          },
        ],
        outputs: [
          {
            name: "decision",
            type: "decision@1",
            choices: ["simplicity", "performance", "security"],
          },
          { name: "brief", type: "design-brief@1", provenance: "cite" },
        ],
      },
      {
        id: "approve",
        kind: "human",
        form: {
          kind: "edit",
          edit: "brief",
          instructions: "Check the chosen brief, edit it if needed, then approve it for Build.",
        },
        inputs: [
          { name: "brief", type: "design-brief@1" },
          { name: "decision", type: "decision@1" },
        ],
      },
      {
        id: "build",
        kind: "agent",
        role: "builder",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "build" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "brief", type: "design-brief@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "review",
        kind: "subgraph",
        template: { scope: "builtin", id: "multi-review" },
        params: { autoFix: true, autoPr: false },
        roles: {
          preparer: "preparer",
          reviewer: "reviewer",
          consolidator: "consolidator",
          fixer: "builder",
          describer: "describer",
        },
        inputs: [{ name: "target", type: "workspace@1" }],
        outputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1", required: false },
        ],
      },
      {
        id: "describe-pr",
        kind: "agent",
        role: "describer",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "pull-request-description" },
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "brief", type: "design-brief@1", render: "markdown" },
        ],
        outputs: [{ name: "description", type: "pr-description@1" }],
      },
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
    ],
    edges: [
      edge("ticket-design", { input: "ticket" }, { node: "design", port: "ticket" }),
      edge("target-design", { input: "target" }, { node: "design", port: "code" }),
      edge("design-judge", { node: "design", port: "brief" }, { node: "judge", port: "briefs" }),
      edge("ticket-judge", { input: "ticket" }, { node: "judge", port: "ticket" }),
      edge(
        "judge-approve-brief",
        { node: "judge", port: "brief" },
        { node: "approve", port: "brief" },
      ),
      edge(
        "judge-approve-decision",
        { node: "judge", port: "decision" },
        { node: "approve", port: "decision" },
      ),
      edge(
        "approved-build",
        { node: "approve", outlet: "approved", port: "brief" },
        { node: "build", port: "brief" },
      ),
      edge("ticket-build", { input: "ticket" }, { node: "build", port: "ticket" }),
      edge("target-build", { input: "target" }, { node: "build", port: "code" }),
      edge("build-review", { node: "build", port: "code" }, { node: "review", port: "target" }),
      edge(
        "review-describe",
        { node: "review", port: "code" },
        { node: "describe-pr", port: "code" },
      ),
      edge(
        "approved-describe",
        { node: "approve", outlet: "approved", port: "brief" },
        { node: "describe-pr", port: "brief" },
      ),
      edge("review-pr", { node: "review", port: "code" }, { node: "pr", port: "code" }),
      edge(
        "describe-pr-pr",
        { node: "describe-pr", port: "description" },
        { node: "pr", port: "description" },
      ),
    ],
    // design 3 + judge 1 + build 1 + Multi Review (1 + 8 + 1 + 1 + 1) + describe-pr 1.
    limits: { maxAgentSessions: 18, maxConcurrentAgents: 8 },
    layout: {
      design: { x: 0, y: 0 },
      judge: { x: 240, y: 0 },
      approve: { x: 480, y: 0 },
      build: { x: 720, y: 0 },
      review: { x: 960, y: 0 },
      "describe-pr": { x: 1200, y: 0 },
      pr: { x: 1440, y: 0 },
    },
  };
}

/**
 * Report §9.4: diagnose each failure in parallel (read-only), dedupe on root
 * cause, fix serially, validate again. `items` fan-out is Phase 4 (401).
 */
function failureDiagnosis(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "failure-diagnosis",
    revision: 1,
    name: "Map over failures",
    description:
      "Run validation, diagnose each failure in parallel, dedupe on root cause, fix, and repeat until validation passes.",
    parameters: [],
    roles: [
      { key: "diagnoser", multiplicity: "one" },
      { key: "fixer", multiplicity: "one", defaultsFrom: ["fixReviewIssues"] },
    ],
    types: [
      {
        name: "validation-failure",
        version: 1,
        schema: {
          type: "object",
          properties: {
            command: { type: "string" },
            summary: { type: "string" },
            output: { type: "string" },
          },
          required: ["command", "summary", "output"],
          additionalProperties: false,
        },
        storage: "value",
        budgets: { maxBytes: 65_536, maxStringBytes: 32_768 },
      },
      {
        name: "validation-results",
        version: 1,
        schema: {
          type: "object",
          properties: {
            failures: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  summary: { type: "string" },
                  output: { type: "string" },
                },
                required: ["command", "summary", "output"],
                additionalProperties: false,
              },
            },
          },
          required: ["failures"],
          additionalProperties: false,
        },
        storage: "value",
        budgets: { maxBytes: 393_216, maxStringBytes: 32_768, maxItems: 64 },
        items: { path: "failures", idPrefix: "failure" },
        render: { summary: ["failures"] },
      },
      {
        name: "diagnosis",
        version: 1,
        schema: {
          type: "object",
          properties: {
            diagnoses: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rootCause: { type: "string" },
                  explanation: { type: "string" },
                  files: { type: "array", items: { type: "string" } },
                },
                required: ["rootCause", "explanation", "files"],
                additionalProperties: false,
              },
            },
          },
          required: ["diagnoses"],
          additionalProperties: false,
        },
        storage: "value",
        budgets: { maxBytes: 65_536, maxStringBytes: 16_384, maxItems: 32 },
        items: { path: "diagnoses", idPrefix: "diagnosis" },
      },
    ],
    inputs: [
      { name: "plan", type: "validation-plan@1" },
      { name: "target", type: "workspace@1" },
    ],
    outputs: [
      {
        name: "results",
        type: "validation-results@1",
        from: { node: "validate", port: "results" },
      },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "validate",
        kind: "system",
        action: "run-validation",
        inputs: [
          { name: "plan", type: "validation-plan@1" },
          { name: "code", type: "workspace@1", firstIterationFrom: { input: "target" } },
        ],
        outputs: [
          { name: "results", type: "validation-results@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "diagnose",
        kind: "agent",
        role: "diagnoser",
        when: { path: "failures", op: "nonEmpty" },
        replicate: { over: "items", input: "failures", maxBranches: 12 },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        minEnforcement: "provider-configured",
        prompt: {
          template:
            "Find the root cause of this validation failure. Do not change any files.\n\n{{> input.code}}\n\nFailure {{item.index}}:\n{{> input.failures}}\n",
        },
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "failures", type: "list<validation-failure@1>", render: "json-frame" },
        ],
        outputs: [{ name: "diagnosis", type: "diagnosis@1" }],
      },
      {
        id: "dedupe",
        kind: "merge",
        strategy: { kind: "dedupe", key: ["rootCause"] },
        inputs: [
          {
            name: "diagnoses",
            type: "list<diagnosis@1>",
            collect: { wait: "all-settled", minSuccessful: 1, includeFailures: false },
          },
        ],
        outputs: [{ name: "diagnosis", type: "diagnosis@1" }],
      },
      {
        id: "fix",
        kind: "agent",
        role: "fixer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "fix-review-issues" },
        inputs: [
          { name: "diagnosis", type: "diagnosis@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
    ],
    edges: [
      edge("plan-validate", { input: "plan" }, { node: "validate", port: "plan" }),
      edge("target-validate", { input: "target" }, { node: "validate", port: "code" }),
      edge(
        "validate-diagnose-failures",
        { node: "validate", port: "results" },
        { node: "diagnose", port: "failures" },
        { transform: [{ op: "flatten", path: "failures" }] },
      ),
      edge(
        "validate-diagnose-code",
        { node: "validate", port: "code" },
        { node: "diagnose", port: "code" },
      ),
      edge(
        "diagnose-dedupe",
        { node: "diagnose", port: "diagnosis" },
        { node: "dedupe", port: "diagnoses" },
      ),
      edge("dedupe-fix", { node: "dedupe", port: "diagnosis" }, { node: "fix", port: "diagnosis" }),
      edge("validate-fix", { node: "validate", port: "code" }, { node: "fix", port: "code" }),
    ],
    loops: [
      {
        id: "repair",
        nodes: ["validate", "diagnose", "dedupe", "fix"],
        until: { path: "validate.results.failures", op: "empty" },
        maxIterations: 3,
        carry: [{ from: { node: "fix", port: "code" }, to: { node: "validate", port: "code" } }],
      },
    ],
    // (diagnose 12 + fix 1) × 3.
    limits: { maxAgentSessions: 39, maxConcurrentAgents: 12 },
  };
}

const BUILDERS: Record<
  GraphTemplateExampleKey,
  {
    reportSection: GraphTemplateExample["reportSection"];
    title: string;
    build: () => GraphTemplateV1;
  }
> = {
  "multi-review": {
    reportSection: "9.1",
    title: "Multi Review expressed as a template",
    build: multiReview,
  },
  "build-pipeline-loop": {
    reportSection: "9.2",
    title: "The Build Pipeline's loop",
    build: buildPipelineLoop,
  },
  "design-bake-off": {
    reportSection: "9.3",
    title: "A user graph: design bake-off",
    build: designBakeOff,
  },
  "failure-diagnosis": {
    reportSection: "9.4",
    title: "A user graph: map over failures",
    build: failureDiagnosis,
  },
};

/** A fresh copy of one example template. */
export function graphTemplateExample(key: GraphTemplateExampleKey): GraphTemplateV1 {
  return BUILDERS[key].build();
}

/** Fresh copies of every example, in report order. */
export function graphTemplateExamples(): GraphTemplateExample[] {
  return GRAPH_TEMPLATE_EXAMPLE_KEYS.map((key) => ({
    key,
    reportSection: BUILDERS[key].reportSection,
    title: BUILDERS[key].title,
    template: BUILDERS[key].build(),
  }));
}
