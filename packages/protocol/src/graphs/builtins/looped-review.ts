/**
 * Looped Review described as a template (plan P1.8, D5, report §2.4).
 *
 * Looped Review was removed from the product on 2026-10-29 (#1417), after the
 * report was written: `looped-review-service.ts` is gone and storage retires
 * its records (`retire-looped-reviews`). This template keeps the flow as it
 * last ran, so it can be read and duplicated onto the graph runtime; the
 * built-in index marks its engine `retired`. What the flow did:
 *
 * - One model runs everything. A round prepares and seals a review package,
 *   then runs up to `allowance` sequential discovery passes. After each pass
 *   the same session reconciles the pass's report into the round's finding
 *   pool; the round stops early when a pass adds or updates nothing.
 * - A round that leaves findings is fixed; a Fix that is not complete failed
 *   the review. The next round starts with an empty pool and half the
 *   allowance, rounded up. After a Fix at allowance 1, or after a round with
 *   no findings, the model opened the pull request.
 *
 * Loops do not nest in the template model (item 107), so the rounds are
 * unrolled: `loopedReviewBuiltInTemplate()` is the default starting allowance
 * of 6 (rounds of 6, 3, 2 and 1 passes), and `loopedReviewTemplate(n)` builds
 * the graph for another starting allowance. Browser-safe.
 */
import {
  REVIEW_FINDING_POOL_JSON_SCHEMA,
  REVIEW_RECONCILIATION_JSON_SCHEMA,
} from "../../structured-review.js";
import type { ArtifactTypeDef, GraphJsonSchema } from "../artifact-type-def.js";
import type { GraphPredicate } from "../predicate-shape.js";
import type { GraphEdgeSpec, GraphNodeSpec, GraphTemplateV1 } from "../template-model.js";
import { edge, GRAPH_BUILT_IN_TEMPLATE_REVISION, port, target } from "./support.js";

/** The retired engine's bounds (`review-workflow.ts` before #1417). */
export const LOOPED_REVIEW_DEFAULT_ALLOWANCE = 6;
export const LOOPED_REVIEW_MIN_ALLOWANCE = 1;
export const LOOPED_REVIEW_MAX_ALLOWANCE = 10;

/** The retired engine's `nextReviewAllowance`: half, rounded up, at least 1. */
export function nextLoopedReviewAllowance(allowance: number): number {
  return Math.max(1, Math.ceil(allowance / 2));
}

/** The pass allowance of every round a review can run, from the starting allowance. */
export function loopedReviewRoundAllowances(
  startingAllowance = LOOPED_REVIEW_DEFAULT_ALLOWANCE,
): number[] {
  if (
    !Number.isInteger(startingAllowance) ||
    startingAllowance < LOOPED_REVIEW_MIN_ALLOWANCE ||
    startingAllowance > LOOPED_REVIEW_MAX_ALLOWANCE
  ) {
    throw new RangeError(
      `The starting allowance must be a whole number from ${LOOPED_REVIEW_MIN_ALLOWANCE} to ${LOOPED_REVIEW_MAX_ALLOWANCE}`,
    );
  }
  const allowances = [startingAllowance];
  while (allowances.at(-1)! > 1) allowances.push(nextLoopedReviewAllowance(allowances.at(-1)!));
  return allowances;
}

const FINDING_OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reportIndex", "outcome", "poolId"],
  properties: {
    reportIndex: { type: "integer", minimum: 0 },
    outcome: { type: "string", enum: ["new", "updated", "existing"] },
    poolId: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};

/** The round's finding pool after a pass (`REVIEW_FINDING_POOL_JSON_SCHEMA`). */
export function findingPoolType(): ArtifactTypeDef {
  return {
    name: "finding-pool",
    version: 1,
    label: "Finding pool",
    description: "A round's findings with stable pool IDs, merged from every pass so far.",
    schema: structuredClone(REVIEW_FINDING_POOL_JSON_SCHEMA) as unknown as GraphJsonSchema,
    storage: "value",
    budgets: { maxBytes: 131_072, maxStringBytes: 16_384, maxItems: 500 },
    items: { path: "issues", idPrefix: "issue" },
  };
}

/**
 * What a reconciliation turn submitted (the `review-reconciliation` result
 * kind): new findings, updates by pool ID, and an outcome for every finding of
 * the pass's report. The backend pins this schema to its own.
 */
export function reviewReconciliationType(): ArtifactTypeDef {
  const base = structuredClone(REVIEW_RECONCILIATION_JSON_SCHEMA) as unknown as {
    required: string[];
    properties: Record<string, unknown>;
  };
  return {
    name: "review-reconciliation",
    version: 1,
    label: "Reconciliation",
    description: "How one discovery pass changed the round's finding pool.",
    schema: {
      ...base,
      required: [...base.required, "issueOutcomes", "coverageGapOutcomes"],
      properties: {
        ...base.properties,
        issueOutcomes: { type: "array", items: structuredClone(FINDING_OUTCOME_SCHEMA) },
        coverageGapOutcomes: { type: "array", items: structuredClone(FINDING_OUTCOME_SCHEMA) },
      },
    } as unknown as GraphJsonSchema,
    storage: "value",
    budgets: { maxBytes: 131_072, maxStringBytes: 16_384, maxItems: 500 },
  };
}

/** The pass added or updated nothing: the round's discovery stops. */
function passAddedNothing(node: string): GraphPredicate {
  return {
    all: ["newIssues", "issueUpdates", "newCoverageGaps", "coverageGapUpdates"].map((field) => ({
      path: `${node}.reconciliation.${field}`,
      op: "empty" as const,
    })),
  };
}

function poolHasFindings(input: string): GraphPredicate {
  return {
    any: [
      { path: `${input}.issues`, op: "nonEmpty" },
      { path: `${input}.coverageGaps`, op: "nonEmpty" },
    ],
  };
}

/** The retired engine's reconciliation contract (`createReconciliationPrompt`). */
export const LOOPED_REVIEW_RECONCILIATION_PROMPT = `Using the review you just made in this session, reconcile the report below semantically against the round's active finding pool.

- Classify differently worded but semantically equivalent findings as updates to an existing stable pool ID, not new entries.
- New findings have no pool ID; the pool assigns IDs after accepting them.
- Updates must name an existing pool ID and include the complete replacement finding.
- Account for every report issue in issueOutcomes and every report coverage gap in coverageGapOutcomes, exactly once, using its zero-based reportIndex.
- outcome=new requires poolId=null and an equivalent entry in the corresponding new-findings array, in report order. outcome=updated requires the referenced existing poolId and an equivalent update. outcome=existing requires the stable poolId of a semantically equivalent finding and no update.
- Do not remove findings. Do not invent IDs. Do not update an entry merely to rephrase it; an update must add or materially improve information.
- If the report adds or materially updates nothing, the operation lists are empty but every repeated finding still has an explicit existing outcome.
- Submit the reconciliation, and the pool as it stands once the reconciliation is applied: every earlier entry, updated entries replaced, new entries added with fresh IDs.

{{> input.report}}

{{> input.pool}}

The sealed package the pass reviewed, for reference:

{{> input.package}}`;

/** Node ids of round `n` (1-based). */
export function loopedReviewRoundNodes(round: number) {
  return {
    prepare: `prepare-r${round}`,
    package: `package-r${round}`,
    discover: `discover-r${round}`,
    reconcile: `reconcile-r${round}`,
    hasFindings: `has-findings-r${round}`,
    fix: `fix-r${round}`,
    fixed: `fixed-r${round}`,
    loop: `passes-r${round}`,
  };
}

/** The engine stage each node describes, for the template built from `startingAllowance`. */
export function loopedReviewTemplateStages(
  startingAllowance = LOOPED_REVIEW_DEFAULT_ALLOWANCE,
): Readonly<Record<string, string>> {
  const stages: Record<string, string> = { "describe-pr": "pr", pr: "pr" };
  loopedReviewRoundAllowances(startingAllowance).forEach((_, index) => {
    const ids = loopedReviewRoundNodes(index + 1);
    stages[ids.prepare] = "preparation";
    stages[ids.package] = "package";
    stages[ids.discover] = "discovery";
    stages[ids.reconcile] = "reconciliation";
    stages[ids.hasFindings] = "after-reconciliation";
    stages[ids.fix] = "fix";
    stages[ids.fixed] = "after-fix";
  });
  return Object.freeze(stages);
}

function roundNodes(round: number, allowance: number): GraphNodeSpec[] {
  const ids = loopedReviewRoundNodes(round);
  return [
    {
      id: ids.prepare,
      kind: "agent",
      label: `Round ${round} · Package preparation`,
      description: "Commits relevant safe changes and prepares the round's review package.",
      role: "model",
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
      id: ids.package,
      kind: "system",
      label: `Round ${round} · Seal package`,
      action: "run-validation-and-seal",
      inputs: [
        { name: "plan", type: "validation-plan@1" },
        { name: "code", type: "workspace@1" },
      ],
      outputs: [{ name: "package", type: "review-package@2" }],
    },
    {
      id: ids.discover,
      kind: "agent",
      label: `Round ${round} · Review pass`,
      description: `One discovery pass over the sealed package, in plan mode; at most ${allowance} this round.`,
      role: "model",
      capabilities: { profile: "reviewer" },
      workspaceAccess: "read",
      prompt: { builtIn: "discovery-review" },
      inputs: [{ name: "package", type: "review-package@2", render: "file" }],
      outputs: [{ name: "report", type: "review-report@1" }],
    },
    {
      id: ids.reconcile,
      kind: "agent",
      label: `Round ${round} · Reconcile`,
      description:
        "A second turn in the pass's own session merges its report into the round's pool. The engine applied the reconciliation itself; here the turn also submits the resulting pool.",
      role: "model",
      session: { mode: "continue", from: ids.discover },
      capabilities: { profile: "reviewer" },
      workspaceAccess: "read",
      prompt: { template: LOOPED_REVIEW_RECONCILIATION_PROMPT },
      inputs: [
        // The session already holds the report; it stays one read away.
        { name: "report", type: "review-report@1", render: "on-demand" },
        { name: "pool", type: "finding-pool@1", required: false, render: "json-frame" },
        { name: "package", type: "review-package@2", render: "file" },
      ],
      outputs: [
        { name: "reconciliation", type: "review-reconciliation@1" },
        { name: "pool", type: "finding-pool@1" },
      ],
    },
    {
      id: ids.hasFindings,
      kind: "gate",
      label: `Round ${round} · Findings?`,
      inputs: [
        { name: "pool", type: "finding-pool@1" },
        { name: "code", type: "workspace@1" },
      ],
      branches: [{ to: "findings", when: poolHasFindings("pool"), label: "Findings remain" }],
      otherwise: "clean",
    },
    {
      id: ids.fix,
      kind: "agent",
      label: `Round ${round} · Fix`,
      description: "Fixes the whole pool in a fresh session and commits.",
      role: "model",
      capabilities: { profile: "builder" },
      workspaceAccess: "write",
      prompt: { builtIn: "fix-review-issues" },
      inputs: [
        { name: "pool", type: "finding-pool@1", render: "json-frame" },
        { name: "code", type: "workspace@1" },
      ],
      outputs: [
        { name: "result", type: "fix-result@1" },
        { name: "code", type: "workspace@1" },
      ],
    },
    {
      id: ids.fixed,
      kind: "gate",
      label: `Round ${round} · Fix complete?`,
      description: "An incomplete Fix failed the review; nothing runs after it.",
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
  ];
}

function roundEdges(round: number): GraphEdgeSpec[] {
  const ids = loopedReviewRoundNodes(round);
  const previous = loopedReviewRoundNodes(round - 1);
  return [
    round === 1
      ? edge(`target-${ids.prepare}`, { input: "target" }, target(ids.prepare, "code"))
      : edge(
          `${previous.fixed}-${ids.prepare}`,
          port(previous.fixed, "code", "complete"),
          target(ids.prepare, "code"),
        ),
    edge(`${ids.prepare}-plan`, port(ids.prepare, "plan"), target(ids.package, "plan")),
    edge(`${ids.prepare}-code`, port(ids.prepare, "code"), target(ids.package, "code")),
    edge(`${ids.package}-package`, port(ids.package, "package"), target(ids.discover, "package")),
    edge(`${ids.discover}-report`, port(ids.discover, "report"), target(ids.reconcile, "report")),
    edge(
      `${ids.package}-reconcile`,
      port(ids.package, "package"),
      target(ids.reconcile, "package"),
    ),
    edge(`${ids.reconcile}-pool`, port(ids.reconcile, "pool"), target(ids.hasFindings, "pool")),
    edge(`${ids.prepare}-gate-code`, port(ids.prepare, "code"), target(ids.hasFindings, "code")),
    edge(
      `${ids.hasFindings}-fix-pool`,
      port(ids.hasFindings, "pool", "findings"),
      target(ids.fix, "pool"),
    ),
    edge(
      `${ids.hasFindings}-fix-code`,
      port(ids.hasFindings, "code", "findings"),
      target(ids.fix, "code"),
    ),
    edge(`${ids.fix}-result`, port(ids.fix, "result"), target(ids.fixed, "result")),
    edge(`${ids.fix}-code`, port(ids.fix, "code"), target(ids.fixed, "code")),
  ];
}

/** Looped Review for one starting allowance (1 to 10), its rounds unrolled. */
export function loopedReviewTemplate(startingAllowance: number): GraphTemplateV1 {
  const allowances = loopedReviewRoundAllowances(startingAllowance);
  const rounds = allowances.length;
  const last = loopedReviewRoundNodes(rounds);
  // The pull request ships a clean round's branch, or the last round's fix.
  const shipped = [
    ...allowances.map((_, index) => {
      const gate = loopedReviewRoundNodes(index + 1).hasFindings;
      return { id: gate, source: port(gate, "code", "clean") };
    }),
    { id: last.fixed, source: port(last.fixed, "code", "complete") },
  ];
  const passes = allowances.reduce((total, allowance) => total + allowance, 0);
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "looped-review",
    revision: GRAPH_BUILT_IN_TEMPLATE_REVISION,
    name: "Looped Review",
    description: `One model reviews in rounds of sequential passes, reconciling each pass into a finding pool until a pass adds nothing, fixes the pool, and repeats with half the passes; then it opens a pull request. Rounds of ${allowances.join(", ")} passes. The Looped Review engine was retired on 2026-10-29; this describes how it ran.`,
    engine: "looped-review",
    parameters: [],
    roles: [
      {
        key: "model",
        label: "Review model",
        description: "One model prepares, reviews, reconciles, fixes and ships.",
        multiplicity: "one",
        defaultsFrom: ["review"],
      },
    ],
    types: [findingPoolType(), reviewReconciliationType()],
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
        name: "pr",
        type: "pr-result@1",
        label: "Pull request",
        required: false,
        from: port("pr", "pr"),
      },
    ],
    workspace: { kind: "environment" },
    nodes: [
      ...allowances.flatMap((allowance, index) => roundNodes(index + 1, allowance)),
      {
        id: "describe-pr",
        kind: "agent",
        label: "Describe pull request",
        description:
          "Writes the title and body. The engine's PR session also pushed and opened the pull request; agent nodes may not (D12).",
        role: "model",
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
        action: "open-pull-request",
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [{ name: "pr", type: "pr-result@1" }],
      },
    ],
    edges: [
      ...allowances.flatMap((_, index) => roundEdges(index + 1)),
      ...shipped.flatMap(({ id, source }) => [
        edge(`${id}-describe-pr`, source, target("describe-pr", "code")),
        edge(`${id}-pr`, source, target("pr", "code")),
      ]),
      edge("describe-pr-pr", port("describe-pr", "description"), target("pr", "description")),
    ],
    loops: allowances.map((allowance, index) => {
      const ids = loopedReviewRoundNodes(index + 1);
      return {
        id: ids.loop,
        label: `Round ${index + 1} passes`,
        nodes: [ids.discover, ids.reconcile],
        until: passAddedNothing(ids.reconcile),
        maxIterations: allowance,
        carry: [{ from: port(ids.reconcile, "pool"), to: target(ids.reconcile, "pool") }],
      };
    }),
    // Per round: preparation and fix, plus a discovery and a reconciliation
    // turn per pass; then the pull request description.
    limits: {
      maxAgentSessions: rounds * 2 + passes * 2 + 1,
      maxConcurrentAgents: 1,
    },
  };
}

/** Looped Review at the default starting allowance (6: rounds of 6, 3, 2 and 1 passes). */
export function loopedReviewBuiltInTemplate(): GraphTemplateV1 {
  return loopedReviewTemplate(LOOPED_REVIEW_DEFAULT_ALLOWANCE);
}
