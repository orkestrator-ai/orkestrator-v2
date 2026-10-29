/**
 * The Build Pipeline described as a template (plan P1.8, D5, report §2.3,
 * §9.2).
 *
 * The template describes what the backend's build-pipeline supervisor runs
 * after Phase 0, for the default launch: a reviewer panel (the saved reviewer
 * count is 2), so package preparation and consolidation are sessions of their
 * own. The flow keeps running there (`engine: "build-pipeline"`). Where the
 * graph model cannot say what the engine does, the template says the nearest
 * thing and the difference is recorded beside it and in
 * plans/graphs/108-builtin-templates.md. The backend's
 * `graph-builtin-templates.test.ts` pins this file to the engine.
 * Browser-safe.
 */
import { MAX_BUILD_PIPELINE_REVIEWERS } from "../../build-pipeline.js";
import { ACCEPTANCE_CRITERION_STATUSES } from "../../ticket-sections.js";
import type { ArtifactTypeDef } from "../artifact-type-def.js";
import type { GraphTemplateV1 } from "../template-model.js";
import {
  edge,
  GRAPH_BUILT_IN_TEMPLATE_REVISION,
  port,
  reviewReportHasFindings,
  target,
} from "./support.js";

/** Today's default `maxIterations`; the engine accepts 1 to 10 per launch. */
export const BUILD_PIPELINE_TEMPLATE_ROUNDS = 3;

/**
 * The engine stage each node describes (`BUILD_PIPELINE_STAGES` in the
 * backend's `build-pipeline-stages.ts`). Gates name the engine decision they
 * stand for.
 */
export const BUILD_PIPELINE_TEMPLATE_STAGES = Object.freeze({
  setup: "setup",
  build: "build",
  fix: "fix",
  prepare: "preparation",
  package: "validation",
  review: "review",
  consolidate: "consolidation",
  "has-issues": "after-review",
  address: "address",
  verify: "verify",
  criteria: "verify",
  verified: "after-verify",
  "describe-pr": "pr",
  pr: "pr",
  "has-conflicts": "after-pr",
  resolve: "resolve-conflicts",
  push: "resolve-conflicts",
} as const);

/**
 * What the pipeline learns about its pull request after Ship
 * (`PullRequestDetection` in `build-pipeline-service-recovery.ts`). The
 * `open-pull-request` node reports it so a gate can route merge conflicts.
 */
export function pullRequestStateType(): ArtifactTypeDef {
  return {
    name: "pull-request-state",
    version: 1,
    label: "Pull request state",
    description: "The pull request's URL, state and whether GitHub reports merge conflicts.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        state: { type: "string", enum: ["open", "merged", "closed"] },
        hasMergeConflicts: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
          description: "Null while GitHub is still computing mergeability.",
        },
      },
      required: ["url", "state", "hasMergeConflicts"],
      additionalProperties: false,
    },
    storage: "value",
    budgets: { maxBytes: 4096, maxStringBytes: 2048 },
    render: { summary: ["url", "state", "hasMergeConflicts"] },
    example: {
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      hasMergeConflicts: false,
    },
  };
}

/** One acceptance criterion's result in a verdict (`VerificationCriterionVerdict`). */
export function criterionResultType(): ArtifactTypeDef {
  return {
    name: "criterion-result",
    version: 1,
    label: "Criterion result",
    description: "One acceptance criterion's verdict: its ticket ID, status and evidence.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: [...ACCEPTANCE_CRITERION_STATUSES] },
        evidence: { type: "string" },
      },
      required: ["id", "status", "evidence"],
      additionalProperties: false,
    },
    storage: "value",
    budgets: { maxBytes: 65_536, maxStringBytes: 16_384 },
    render: { summary: ["id", "status"] },
    example: { id: "ac-1", status: "passed", evidence: "The export endpoint streams CSV rows." },
  };
}

export function buildPipelineBuiltInTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "build-pipeline",
    revision: GRAPH_BUILT_IN_TEMPLATE_REVISION,
    name: "Build Pipeline",
    description:
      "Build a ticket, then prepare, seal, review with a read-only panel, address and verify in rounds until Verify passes; then open the pull request and resolve merge conflicts. Runs on the Build Pipeline engine.",
    engine: "build-pipeline",
    parameters: [],
    roles: [
      {
        key: "builder",
        label: "Build",
        description: "The pipeline's build agent. Fix runs under Build's step and instructions.",
        multiplicity: "one",
      },
      {
        key: "preparer",
        label: "Preparation and consolidation",
        description: "One model prepares each round's package and consolidates the panel.",
        multiplicity: "one",
        defaultsFrom: ["reviewPreparation", "review"],
      },
      {
        key: "reviewer",
        label: "Reviewer",
        description:
          "One position per reviewer, 1 to 32. Each position may carry a focus (lens) and its own instructions, chosen with its model at launch; the prompt renders the panel position, then the focus, then the instructions.",
        multiplicity: "panel",
        maxPanel: MAX_BUILD_PIPELINE_REVIEWERS,
        defaultsFrom: ["review", "review2", "additionalReviewers"],
      },
      { key: "fixer", label: "Address", multiplicity: "one", defaultsFrom: ["fixReviewIssues"] },
      {
        key: "verifier",
        label: "Verify",
        multiplicity: "one",
        defaultsFrom: ["verify", "fixReviewIssues"],
      },
      { key: "describer", label: "Ship", multiplicity: "one", defaultsFrom: ["pr"] },
      {
        key: "resolver",
        label: "Resolve conflicts",
        multiplicity: "one",
        defaultsFrom: ["resolve"],
      },
    ],
    types: [pullRequestStateType(), criterionResultType()],
    inputs: [
      {
        name: "ticket",
        type: "ticket@1",
        label: "Ticket",
        description: "Title, description and acceptance criteria. Images are not carried.",
      },
    ],
    outputs: [
      {
        name: "verdict",
        type: "verification-verdict@1",
        label: "Verification",
        from: port("verify", "verdict"),
      },
      {
        name: "pr",
        type: "pr-result@1",
        label: "Pull request",
        required: false,
        from: port("pr", "pr"),
      },
    ],
    workspace: { kind: "environment", create: { kind: "worktree" } },
    nodes: [
      {
        id: "setup",
        kind: "system",
        label: "Set up environment",
        description: "Creates and starts the environment and waits for its setup script.",
        action: "prepare-environment",
        inputs: [{ name: "ticket", type: "ticket@1" }],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "build",
        kind: "agent",
        label: "Build",
        description: "Implements the ticket and commits. A writable build-mode turn.",
        role: "builder",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "build" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "code", type: "workspace@1" },
        ],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "fix",
        kind: "agent",
        label: "Fix",
        description:
          "From round 2: fixes what Verify found unmet. Today a Fix that leaves the worktree unchanged pauses the pipeline for a person.",
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
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "prepare",
        kind: "agent",
        label: "Prepare review package",
        description:
          "Discovers the validation plan for the committed HEAD in a session of its own (the Package Preparation Session).",
        role: "preparer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "review-package-preparation" },
        inputs: [
          {
            name: "code",
            type: "workspace@1",
            // Build's commit in round 1, Fix's afterwards (report §9.2).
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
        label: "Validate and seal",
        description:
          "The environment runs the plan's commands once and seals one immutable review package; Review, Address and Verify re-verify its hash.",
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
        label: "Review",
        description:
          "Each reviewer reads the sealed package in a read-only plan-mode turn; a git guard refuses a report from a reviewer that committed or changed the worktree.",
        role: "reviewer",
        replicate: { over: "panel", role: "reviewer" },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "discovery-review" },
        inputs: [
          { name: "package", type: "review-package@2", render: "file" },
          { name: "ticket", type: "ticket@1", render: "markdown" },
        ],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "consolidate",
        kind: "agent",
        label: "Consolidate",
        description:
          "Starts once every reviewer has settled and at least one report is usable. A guarded read-only turn; every finding cites the source finding IDs it merges.",
        role: "preparer",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "consolidation" },
        inputs: [
          {
            name: "reports",
            type: "list<review-report@1>",
            render: "json-frame",
            collect: { wait: "all-settled", minSuccessful: 1, includeFailures: true },
          },
          { name: "package", type: "review-package@2", render: "file" },
        ],
        // `cite`: today's contract checks that cited IDs exist and lets the
        // consolidator leave a source finding out.
        outputs: [{ name: "report", type: "review-report@1", provenance: "cite" }],
      },
      {
        id: "has-issues",
        kind: "gate",
        label: "Issues?",
        description: "Address only when the report has issues or test coverage gaps (D21).",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [
          { to: "issues", when: reviewReportHasFindings("report"), label: "Issues or gaps" },
        ],
        otherwise: "clean",
      },
      {
        id: "address",
        kind: "agent",
        label: "Address",
        description:
          "Fixes the review's findings, validates the fix and submits a typed fix result for Verify. Today it also receives the end of the review session's transcript.",
        role: "fixer",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "address-review" },
        inputs: [
          { name: "report", type: "review-report@1", render: "json-frame" },
          { name: "code", type: "workspace@1" },
          { name: "package", type: "review-package@2", render: "file" },
        ],
        outputs: [
          { name: "code", type: "workspace@1" },
          { name: "report", type: "fix-result@1" },
        ],
      },
      {
        id: "verify",
        kind: "agent",
        label: "Verify",
        description:
          "Judges the committed change against every acceptance criterion. Its shell may write build outputs; a git guard refuses a verdict when the HEAD moved or new paths appeared. No enforcement floor: the guard protects the sources.",
        role: "verifier",
        capabilities: { profile: "verifier" },
        workspaceAccess: "read",
        prompt: { builtIn: "verify" },
        inputs: [
          { name: "ticket", type: "ticket@1", render: "markdown" },
          { name: "code", type: "workspace@1" },
          { name: "address", type: "fix-result@1", required: false, render: "json-frame" },
          { name: "package", type: "review-package@2", render: "file" },
        ],
        outputs: [
          { name: "verdict", type: "verification-verdict@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
      {
        id: "criteria",
        kind: "system",
        label: "Record criteria",
        description: "Writes each acceptance criterion's result to the Kanban ticket.",
        action: "update-ticket",
        params: { record: "criteria" },
        inputs: [{ name: "verdict", type: "verification-verdict@1" }],
      },
      {
        id: "verified",
        kind: "gate",
        label: "Verified?",
        description:
          "Ship only after a passing verdict: complete, with no failed criterion. A run whose rounds end without one fails today.",
        inputs: [
          { name: "verdict", type: "verification-verdict@1" },
          { name: "code", type: "workspace@1" },
          {
            name: "failed",
            type: "list<criterion-result@1>",
            description: "The verdict's failed acceptance criteria.",
          },
        ],
        branches: [
          {
            to: "passed",
            when: {
              all: [
                { path: "verdict.complete", op: "eq", value: true },
                { path: "failed", op: "empty" },
              ],
            },
            label: "Passed",
          },
        ],
      },
      {
        id: "describe-pr",
        kind: "agent",
        label: "Describe pull request",
        description:
          "Writes the title and body. Today's Ship session also pushes and opens or updates the pull request; agent nodes may not (D12), so the next node does.",
        role: "describer",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "pull-request-description" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "description", type: "pr-description@1" }],
      },
      {
        id: "pr",
        kind: "system",
        label: "Open pull request",
        description:
          "Pushes, then opens the pull request, or updates the one an earlier Ship opened, and reports its merge state.",
        action: "open-pull-request",
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [
          { name: "pr", type: "pr-result@1" },
          { name: "state", type: "pull-request-state@1" },
        ],
      },
      {
        id: "has-conflicts",
        kind: "gate",
        label: "Conflicts?",
        inputs: [
          { name: "state", type: "pull-request-state@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [
          {
            to: "conflicts",
            when: { path: "state.hasMergeConflicts", op: "eq", value: true },
            label: "Merge conflicts",
          },
        ],
      },
      {
        id: "resolve",
        kind: "agent",
        label: "Resolve conflicts",
        description:
          "Merges the target branch and resolves every conflict, then commits locally (D12). Today the pipeline fails when GitHub still reports conflicts afterwards.",
        role: "resolver",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { builtIn: "resolve-conflicts" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "push",
        kind: "system",
        label: "Push resolution",
        action: "push-branch",
        inputs: [{ name: "code", type: "workspace@1" }],
      },
    ],
    edges: [
      edge("ticket-setup", { input: "ticket" }, target("setup", "ticket")),
      edge("ticket-build", { input: "ticket" }, target("build", "ticket")),
      edge("setup-build", port("setup", "code"), target("build", "code")),
      edge("ticket-fix", { input: "ticket" }, target("fix", "ticket")),
      edge("build-prepare", port("build", "code"), target("prepare", "code")),
      edge("fix-prepare", port("fix", "code"), target("prepare", "code")),
      edge("prepare-package-plan", port("prepare", "plan"), target("package", "plan")),
      edge("prepare-package-code", port("prepare", "code"), target("package", "code")),
      edge("package-review", port("package", "package"), target("review", "package")),
      edge("ticket-review", { input: "ticket" }, target("review", "ticket")),
      edge("review-consolidate", port("review", "report"), target("consolidate", "reports")),
      edge("package-consolidate", port("package", "package"), target("consolidate", "package")),
      edge("consolidate-gate", port("consolidate", "report"), target("has-issues", "report")),
      edge("prepare-gate", port("prepare", "code"), target("has-issues", "code")),
      edge(
        "issues-address-report",
        port("has-issues", "report", "issues"),
        target("address", "report"),
      ),
      edge("issues-address-code", port("has-issues", "code", "issues"), target("address", "code")),
      edge("package-address", port("package", "package"), target("address", "package")),
      // Two producers into verify.code, on exclusive outlets of has-issues.
      edge("address-verify-code", port("address", "code"), target("verify", "code")),
      edge("clean-verify-code", port("has-issues", "code", "clean"), target("verify", "code")),
      edge("address-verify-report", port("address", "report"), target("verify", "address")),
      edge("package-verify", port("package", "package"), target("verify", "package")),
      edge("ticket-verify", { input: "ticket" }, target("verify", "ticket")),
      edge("verify-criteria", port("verify", "verdict"), target("criteria", "verdict")),
      edge("verify-verified-verdict", port("verify", "verdict"), target("verified", "verdict")),
      edge("verify-verified-code", port("verify", "code"), target("verified", "code")),
      {
        id: "verify-verified-failed",
        from: port("verify", "verdict"),
        to: target("verified", "failed"),
        transform: [
          { op: "flatten", path: "acceptanceCriteria" },
          { op: "filter", where: { path: "status", op: "eq", value: "failed" } },
        ],
      },
      edge("passed-describe", port("verified", "code", "passed"), target("describe-pr", "code")),
      edge("passed-pr", port("verified", "code", "passed"), target("pr", "code")),
      edge("describe-pr-pr", port("describe-pr", "description"), target("pr", "description")),
      edge("pr-conflicts-state", port("pr", "state"), target("has-conflicts", "state")),
      edge(
        "passed-conflicts-code",
        port("verified", "code", "passed"),
        target("has-conflicts", "code"),
      ),
      edge(
        "conflicts-resolve",
        port("has-conflicts", "code", "conflicts"),
        target("resolve", "code"),
      ),
      edge("resolve-push", port("resolve", "code"), target("push", "code")),
    ],
    loops: [
      {
        id: "rounds",
        label: "Rounds",
        nodes: [
          "fix",
          "prepare",
          "package",
          "review",
          "consolidate",
          "has-issues",
          "address",
          "verify",
          "criteria",
        ],
        until: { path: "verify.verdict.complete", op: "eq", value: true },
        maxIterations: BUILD_PIPELINE_TEMPLATE_ROUNDS,
        carry: [
          { from: port("verify", "verdict"), to: target("fix", "feedback") },
          { from: port("verify", "code"), to: target("fix", "code") },
        ],
      },
    ],
    // build 1 + (fix, prepare, 32 reviewers, consolidate, address, verify) × 3
    // + describe-pr 1 + resolve 1.
    limits: { maxAgentSessions: 114, maxConcurrentAgents: MAX_BUILD_PIPELINE_REVIEWERS },
  };
}
