/**
 * Multi Review described as a template (plan P1.8, D5, report §2.2, §9.1).
 *
 * The template describes what `multi-review-service.ts` runs after Phase 0;
 * the flow keeps running there (`engine: "multi-review"`). Duplicating it gives
 * a user template for the graph runtime. Where the graph model cannot say what
 * the engine does, the template says the nearest thing and the difference is
 * recorded beside it and in plans/graphs/108-builtin-templates.md. The
 * backend's `graph-builtin-templates.test.ts` pins this file to the engine.
 * Browser-safe.
 */
import { MULTI_REVIEW_MAX_REVIEWERS } from "../../multi-review.js";
import type { GraphTemplateV1 } from "../template-model.js";
import {
  edge,
  GRAPH_BUILT_IN_TEMPLATE_REVISION,
  paramIsTrue,
  port,
  reviewReportHasFindings,
  target,
} from "./support.js";

/** The engine stage each node describes (`multi-review-steps.ts` in the backend). */
export const MULTI_REVIEW_TEMPLATE_STAGES = Object.freeze({
  plan: "prepare",
  package: "validation",
  review: "reviewer",
  consolidate: "consolidate",
  "has-findings": "after-consolidation",
  fix: "fix",
  "fix-complete": "after-fix",
  "describe-pr": "pr",
  pr: "pr",
} as const);

export function multiReviewBuiltInTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "multi-review",
    revision: GRAPH_BUILT_IN_TEMPLATE_REVISION,
    name: "Multi Review",
    description:
      "Prepare and seal one review package, review it with a panel of read-only reviewers, consolidate their reports citing every source finding, then optionally fix and open a pull request. Runs on the Multi Review engine.",
    engine: "multi-review",
    parameters: [
      {
        key: "autoFix",
        label: "Fix automatically",
        description:
          "Open the Fix once consolidation reports issues or test coverage gaps. Saved default: off.",
        type: "boolean",
        default: false,
      },
      {
        key: "autoPr",
        label: "Open a pull request automatically",
        description:
          "Open the pull request after a Fix that completes, or straight after a consolidated report with nothing to fix. Saved default: off.",
        type: "boolean",
        default: false,
      },
    ],
    roles: [
      {
        key: "preparer",
        label: "Package preparation",
        multiplicity: "one",
        defaultsFrom: ["reviewPreparation", "review"],
      },
      {
        key: "reviewer",
        label: "Reviewer",
        description:
          "One position per reviewer, 1 to 32. Each position may carry a focus (lens) chosen with its model at launch; the prompt renders it after the reviewer's panel position.",
        multiplicity: "panel",
        maxPanel: MULTI_REVIEW_MAX_REVIEWERS,
        defaultsFrom: ["review", "review2", "additionalReviewers"],
      },
      {
        key: "consolidator",
        label: "Consolidation",
        description: "The preparation model unless the launch picks another.",
        multiplicity: "one",
        defaultsFrom: ["reviewPreparation", "review"],
      },
      {
        key: "fixer",
        label: "Fix",
        multiplicity: "one",
        defaultsFrom: ["fixReviewIssues", "review"],
      },
      { key: "describer", label: "Pull request", multiplicity: "one", defaultsFrom: ["pr"] },
    ],
    inputs: [
      {
        name: "target",
        type: "workspace@1",
        label: "Branch to review",
        description: "The environment's branch, reviewed against its target branch.",
      },
    ],
    outputs: [
      {
        name: "report",
        type: "review-report@1",
        label: "Consolidated report",
        from: port("consolidate", "report"),
      },
      {
        name: "pr",
        type: "pr-result@1",
        label: "Pull request",
        required: false,
        from: port("pr", "pr"),
      },
      // The branch the review ends on, for a parent that inlines Multi Review
      // and ships it itself (item 402): exactly one of the two arrives, on
      // exclusive outlets, like the two producers into `describe-pr.code`.
      {
        name: "clean",
        type: "workspace@1",
        label: "Reviewed branch (clean)",
        description: "The reviewed branch, when the consolidated report has no findings.",
        required: false,
        from: port("has-findings", "code", "clean"),
      },
      {
        name: "fixed",
        type: "workspace@1",
        label: "Fixed branch",
        description: "The Fix's commit, when a Fix ran and completed.",
        required: false,
        from: port("fix-complete", "code", "complete"),
      },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "plan",
        kind: "agent",
        label: "Prepare review package",
        description:
          "Commits relevant safe changes, then submits the validation plan for the committed HEAD. A writable build-mode turn.",
        role: "preparer",
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
        label: "Validate and seal",
        description:
          "The environment runs the plan's commands once, then seals one immutable, hash-verified review package every reviewer shares.",
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
          "Each reviewer reads the sealed package in a read-only plan-mode turn and submits a structured report. A failed reviewer is carried to consolidation as a summary, not a blocker.",
        role: "reviewer",
        replicate: { over: "panel", role: "reviewer" },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { builtIn: "discovery-review" },
        inputs: [{ name: "package", type: "review-package@2", render: "file" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "consolidate",
        kind: "agent",
        label: "Consolidate",
        description:
          "Starts once every reviewer has settled and at least one report is usable. A read-only report turn that may make targeted reads; every consolidated finding cites the source finding IDs it merges, and the backend rejects IDs that do not exist.",
        role: "consolidator",
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
        // `cite`, not `accountForAll`: today's contract checks that cited IDs
        // exist and lets the consolidator leave a source finding out.
        outputs: [{ name: "report", type: "review-report@1", provenance: "cite" }],
      },
      {
        id: "has-findings",
        kind: "gate",
        label: "Findings?",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [
          { to: "findings", when: reviewReportHasFindings("report"), label: "Issues or gaps" },
        ],
        otherwise: "clean",
      },
      {
        id: "fix",
        kind: "agent",
        label: "Fix",
        description:
          "Today an ordinary interactive Fix tab that the user can talk to; it ends when its handoff turn finishes on its own. Here it submits a fix result.",
        role: "fixer",
        when: paramIsTrue("autoFix"),
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        askHuman: true,
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
        id: "fix-complete",
        kind: "gate",
        label: "Fix complete?",
        description: "Only proof that the Fix completed queues the pull request.",
        inputs: [
          { name: "result", type: "fix-result@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [
          {
            to: "complete",
            when: { path: "result.complete", op: "eq", value: true },
            label: "Complete",
          },
        ],
      },
      {
        id: "describe-pr",
        kind: "agent",
        label: "Describe pull request",
        description:
          "Writes the title and body. Today's PR agent also pushes and opens the pull request; agent nodes may not (D12), so the next node does.",
        role: "describer",
        when: paramIsTrue("autoPr"),
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
          "Pushes, then opens the pull request against the reviewed target branch. Skipped today when the environment already has one.",
        action: "open-pull-request",
        when: paramIsTrue("autoPr"),
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [{ name: "pr", type: "pr-result@1" }],
      },
    ],
    edges: [
      edge("target-plan", { input: "target" }, target("plan", "code")),
      edge("plan-package-plan", port("plan", "plan"), target("package", "plan")),
      edge("plan-package-code", port("plan", "code"), target("package", "code")),
      edge("package-review", port("package", "package"), target("review", "package")),
      edge("package-consolidate", port("package", "package"), target("consolidate", "package")),
      edge("review-consolidate", port("review", "report"), target("consolidate", "reports")),
      edge("consolidate-gate", port("consolidate", "report"), target("has-findings", "report")),
      edge("plan-gate", port("plan", "code"), target("has-findings", "code")),
      edge(
        "findings-fix-report",
        port("has-findings", "report", "findings"),
        target("fix", "report"),
      ),
      edge("findings-fix-code", port("has-findings", "code", "findings"), target("fix", "code")),
      edge("fix-complete-result", port("fix", "result"), target("fix-complete", "result")),
      edge("fix-complete-code", port("fix", "code"), target("fix-complete", "code")),
      // Two producers into each `code` port below, on exclusive outlets of
      // has-findings: a clean report ships the reviewed branch, a complete Fix
      // ships its own commit.
      edge("clean-describe", port("has-findings", "code", "clean"), target("describe-pr", "code")),
      edge(
        "fixed-describe",
        port("fix-complete", "code", "complete"),
        target("describe-pr", "code"),
      ),
      edge("clean-pr", port("has-findings", "code", "clean"), target("pr", "code")),
      edge("fixed-pr", port("fix-complete", "code", "complete"), target("pr", "code")),
      edge("describe-pr-pr", port("describe-pr", "description"), target("pr", "description")),
    ],
    // plan 1 + reviewers 32 + consolidate 1 + fix 1 + describe-pr 1.
    limits: { maxAgentSessions: 36, maxConcurrentAgents: MULTI_REVIEW_MAX_REVIEWERS },
  };
}
