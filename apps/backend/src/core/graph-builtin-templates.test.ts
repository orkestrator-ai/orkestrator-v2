/**
 * Pins the built-in templates (plan P1.8) to the engines they describe.
 *
 * Each test reads one fact from the engine (an exported table, constant or
 * decision function the engine itself uses) and the same fact from the
 * compiled template, and requires them to agree. A change to either side
 * alone fails here until the other says the same. The protocol-side pins
 * (bounds and defaults the protocol owns) are in
 * `packages/protocol/src/graphs/builtins/*.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import { buildPipelineConfiguredDefaults } from "@orkestrator/protocol/build-pipeline-defaults";
import {
  executionModeForSessionPhase,
  MAX_BUILD_PIPELINE_ITERATIONS,
  MAX_BUILD_PIPELINE_REVIEWERS,
  stepKeyForSessionPhase,
  BUILD_PIPELINE_AGENTS,
  type BuildPipeline,
  type BuildStepConfig,
  type VerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  graphBuiltInTemplate,
  graphBuiltInTemplates,
  type GraphBuiltInTemplateId,
} from "@orkestrator/protocol/graphs/builtins";
import {
  compile,
  type CompiledGraphPlan,
  type GraphPlanAgentNode,
  type GraphPlanEdge,
  type GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import {
  evaluateGraphPredicate,
  filterGraphPredicateList,
} from "@orkestrator/protocol/graphs/predicates";
import type { GraphRole } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import type { StructuredReviewFindings } from "@orkestrator/protocol/structured-review";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";
import {
  BUILD_PIPELINE_STAGES,
  buildPipelineStage,
  buildPipelineStageTurn,
  DEFAULT_BUILD_PIPELINE_ITERATIONS,
  usesPackagePreparationSession,
  type BuildPipelineStage,
  type BuildPipelineStageKey,
} from "./build-pipeline-stages.js";
import { readsReviewPackage } from "./build-pipeline-prompt-dispatch.js";
import {
  executionModeOverrideForPhase,
  pullRequestNeedsConflictResolution,
  PULL_REQUEST_DETECTION_STATES,
  stageAfterReview,
  verificationPassed,
} from "./build-pipeline-service-helpers.js";
import { multiReviewDefaultRows } from "./coordinator-launch-defaults.js";
import {
  fixResultCompletes,
  multiReviewAutoFixDue,
  queueAutoPr,
  queueCleanReviewAutoPr,
} from "./multi-review-auto-pr.js";
import {
  MULTI_REVIEW_INTERACTIVE_FIX,
  MULTI_REVIEW_REVIEWER_RESULT_KIND,
  MULTI_REVIEW_STAGE_KEYS,
  MULTI_REVIEW_STEP_TURNS,
} from "./multi-review-steps.js";
import { REVIEW_RECONCILIATION_RESULT_JSON_SCHEMA } from "./review-prompts.js";
import { REVIEW_FANOUT_FAN_IN, reviewFanoutReviewerMode } from "./review-fanout.js";
import { RETIRED_LEGACY_STORES, retireLoopedReviewsMigration } from "./storage-retired-features.js";
import { STORAGE_MIGRATIONS } from "./storage-stores.js";
import {
  REVIEW_CONSOLIDATION_PROVENANCE,
  workflowResultJsonSchema,
} from "./workflow-result-contracts.js";

// ------------------------------------------------------------------ support

function builtIn(id: GraphBuiltInTemplateId) {
  const entry = graphBuiltInTemplate(id)!;
  const result = compile(entry.template);
  if (!result.plan) throw new Error(`The ${id} built-in does not compile`);
  return { ...entry, plan: result.plan };
}

function node(plan: CompiledGraphPlan, id: string): GraphPlanNode {
  const found = plan.nodes.find((entry) => entry.id === id);
  if (!found) throw new Error(`No node ${id}`);
  return found;
}

function agent(plan: CompiledGraphPlan, id: string): GraphPlanAgentNode {
  const found = node(plan, id);
  if (found.kind !== "agent") throw new Error(`${id} is not an agent node`);
  return found;
}

/** Nodes describing one engine stage, in plan order. */
function nodesFor(
  plan: CompiledGraphPlan,
  stages: Readonly<Record<string, string>>,
  stage: string,
) {
  return plan.order.filter((id) => stages[id] === stage);
}

/**
 * The engine result kind an output port stands for: a built-in type's own
 * kind, or `consolidated-review` for a report that cites its sources (the
 * consolidation contract: a review report plus provenance).
 */
function outputResultKind(port: { type: string; provenance?: string }): WorkflowResultKind | null {
  const kind = graphBuiltInType(port.type)?.resultKind ?? null;
  if (kind === "review-report" && port.provenance !== undefined) return "consolidated-review";
  return kind;
}

/** Every result kind an agent node submits. */
function nodeResultKinds(plan: CompiledGraphPlan, id: string): WorkflowResultKind[] {
  return node(plan, id)
    .outputs.map(outputResultKind)
    .filter((kind): kind is WorkflowResultKind => kind !== null);
}

/** How the compiled node may touch the workspace, in the engine's terms. */
function nodeTurn(plan: CompiledGraphPlan, id: string): BuildPipelineStage["turn"] {
  const entry = node(plan, id);
  if (entry.kind === "system") return "system";
  if (entry.kind !== "agent") throw new Error(`${id} has no turn`);
  if (entry.workspaceAccess === "write") return entry.capabilities.readOnly ? "read-only" : "write";
  return entry.capabilities.readOnly ? "read-only" : "guarded";
}

interface Route {
  params?: Record<string, unknown>;
  iteration?: number;
  /** Produced values by `node.port`; carried values by `carry.node.port`. */
  values?: Record<string, unknown>;
}

/** Applies an edge's transforms to a value (only the ones the built-ins use). */
function transformed(edge: GraphPlanEdge, value: unknown): unknown {
  let current = value;
  for (const step of edge.transform) {
    if (step.op === "flatten") {
      current = (current as Record<string, unknown>)[step.path] ?? [];
    } else if (step.op === "filter") {
      const filtered = filterGraphPredicateList(current, step.where);
      if (!filtered.ok) throw new Error(filtered.message);
      current = filtered.items;
    } else {
      throw new Error(`Transform ${step.op} is not simulated`);
    }
  }
  return current;
}

/**
 * Which nodes one pass over the plan runs: nodes in plan order, each when its
 * required inputs arrive (a gate's untaken outlet delivers nothing) and its
 * `when` holds; a gate takes its first true branch, else `otherwise`. Inside a
 * loop it simulates one iteration.
 */
function route(plan: CompiledGraphPlan, input: Route): Set<string> {
  const iteration = input.iteration ?? 1;
  const ran = new Set<string>();
  const taken = new Map<string, string | null>();
  const gateValues = new Map<string, Record<string, unknown>>();
  const edges = new Map(plan.edges.map((entry) => [entry.id, entry]));
  const live = (edge: GraphPlanEdge) => {
    if (edge.iterations === "first" && iteration !== 1) return false;
    if (edge.iterations === "later" && iteration === 1) return false;
    if ("input" in edge.from) return true;
    if (!ran.has(edge.from.node)) return false;
    return edge.from.outlet === undefined || taken.get(edge.from.node) === edge.from.outlet;
  };
  const valueOf = (edge: GraphPlanEdge) => {
    const from = edge.from;
    const raw =
      "input" in from
        ? (input.values?.[`input.${from.input}`] ?? {})
        : from.outlet !== undefined
          ? gateValues.get(from.node)?.[from.port]
          : (input.values?.[`${from.node}.${from.port}`] ?? {});
    return transformed(edge, raw);
  };
  for (const id of plan.order) {
    const entry = node(plan, id);
    const values: Record<string, unknown> = {};
    let ready = true;
    for (const port of entry.inputs) {
      const delivered = port.edges.map((edgeId) => edges.get(edgeId)!).filter(live);
      if (delivered.length > 0) values[port.name] = valueOf(delivered[0]!);
      else if (iteration > 1 && port.carries.length > 0) {
        values[port.name] = input.values?.[`carry.${id}.${port.name}`] ?? {};
      } else if (port.required) ready = false;
    }
    if (!ready) continue;
    const environment = { params: input.params ?? {}, run: { iteration }, values };
    if (entry.when && evaluateGraphPredicate(entry.when, environment).truth !== "true") continue;
    ran.add(id);
    if (entry.kind === "gate") {
      gateValues.set(id, values);
      const branch = entry.branches.find(
        (candidate) => evaluateGraphPredicate(candidate.when, environment).truth === "true",
      );
      taken.set(id, branch?.to ?? entry.otherwise ?? null);
    }
  }
  return ran;
}

function findings(issues: number, gaps: number): StructuredReviewFindings {
  return {
    issues: Array.from({ length: issues }, () => ({})),
    testCoverageGaps: Array.from({ length: gaps }, () => ({})),
  } as unknown as StructuredReviewFindings;
}

const FINDINGS = [findings(0, 0), findings(2, 0), findings(0, 1), findings(1, 1)];

/**
 * The template's reading of `defaultsFrom` (plan P1.1). A one-model role takes
 * the first action key with a usable saved platform; with none it runs on the
 * app's default agent (`unset`). A panel takes one position per action key, an
 * unset key falling back to the first position's source, then the
 * `additionalReviewers` entries, an unset entry falling back the same way.
 */
function roleSource(
  role: GraphRole,
  position: number,
  configured: ReadonlySet<string>,
  additional: ReadonlyArray<string | null>,
): string {
  const sources = role.defaultsFrom ?? [];
  const keys = sources.filter((source) => source !== "additionalReviewers");
  const resolved = (key: string | undefined) =>
    key !== undefined && configured.has(key) ? key : "unset";
  if (role.multiplicity === "one") return resolved(keys.find((key) => configured.has(key)));
  const first = resolved(keys[0]);
  if (position < keys.length) {
    return configured.has(keys[position]!) ? keys[position]! : first;
  }
  const extra = sources.includes("additionalReviewers")
    ? additional[position - keys.length]
    : undefined;
  return extra ?? first;
}

const ROLE_KEYS = [
  "review",
  "review2",
  "reviewPreparation",
  "fixReviewIssues",
  "verify",
  "pr",
  "resolve",
] as const;

/** Saved settings where every configured source names its own model, `m-<source>`. */
function savedSettings(configured: readonly string[], additional: ReadonlyArray<string | null>) {
  const global: AgentSettingsTier = {
    actionDefaults: Object.fromEntries(
      configured.map((key) => [key, { platform: "codex", model: `m-${key}` }]),
    ),
    multiReview: {
      reviewerCount: 2 + additional.length,
      additionalReviewers: additional.map((entry) =>
        entry === null ? null : { platform: "codex" as const, model: `m-${entry}` },
      ),
    },
  };
  return global;
}

/** Which saved source a selection came from, by its model name. */
function sourceOf(selection: { model?: string } | undefined): string {
  return selection?.model?.replace(/^m-/, "") ?? "unset";
}

const SCENARIOS: Array<{ configured: string[]; additional: Array<string | null> }> = [
  { configured: [...ROLE_KEYS], additional: ["additional-1", "additional-2"] },
  { configured: ["review"], additional: [null, "additional-2"] },
  { configured: ["review", "verify", "reviewPreparation"], additional: [] },
];

// ---------------------------------------------------------------- the list

describe("built-in templates", () => {
  test("each compiles cleanly, may launch, and names its engine", () => {
    for (const entry of graphBuiltInTemplates()) {
      const result = compile(entry.template);
      expect({
        id: entry.id,
        diagnostics: result.diagnostics.filter((d) => d.severity !== "info"),
      }).toEqual({ id: entry.id, diagnostics: [] });
      expect(result.launchable).toBe(true);
      expect(entry.template.engine).toBe(entry.engine);
      expect(result.plan!.template.engine).toBe(entry.engine);
      // Every node describes an engine stage or decision.
      expect(Object.keys(entry.stages).sort()).toEqual(result.plan!.order.toSorted());
    }
  });

  test("Looped Review is the one retired engine", () => {
    // Its engine was removed: storage retires its records. Reviving the engine
    // means changing the built-in's status (and pinning it) as well.
    expect(RETIRED_LEGACY_STORES).toContain("looped-reviews");
    expect(STORAGE_MIGRATIONS).toContain(retireLoopedReviewsMigration);
    expect(graphBuiltInTemplates().map((entry) => [entry.id, entry.engineStatus])).toEqual([
      ["multi-review", "active"],
      ["build-pipeline", "active"],
      ["looped-review", "retired"],
    ]);
  });
});

// ------------------------------------------------------------ Multi Review

describe("Multi Review template ↔ multi-review-service", () => {
  const { plan, stages, template } = builtIn("multi-review");

  test("node set and stage order", () => {
    const described = plan.order
      .map((id) => stages[id]!)
      .filter((stage) => (MULTI_REVIEW_STAGE_KEYS as readonly string[]).includes(stage))
      .filter((stage, index, list) => list[index - 1] !== stage);
    expect(described).toEqual([...MULTI_REVIEW_STAGE_KEYS]);
  });

  test("result kinds per step", () => {
    expect(nodeResultKinds(plan, "plan")).toEqual([MULTI_REVIEW_STEP_TURNS.prepare.result]);
    expect(nodeResultKinds(plan, "review")).toEqual([MULTI_REVIEW_REVIEWER_RESULT_KIND]);
    expect(nodeResultKinds(plan, "consolidate")).toEqual([
      MULTI_REVIEW_STEP_TURNS.consolidate.result,
    ]);
    expect(nodeResultKinds(plan, "fix")).toEqual([MULTI_REVIEW_STEP_TURNS.fix.result]);
    expect(nodeResultKinds(plan, "describe-pr")).toEqual([]);
    // A consolidated report is a review report that cites its sources, under
    // today's provenance contract.
    expect(workflowResultJsonSchema("consolidated-review")).toEqual(
      graphBuiltInType("review-report@1")!.schema as never,
    );
    expect(node(plan, "consolidate").outputs[0]!.provenance).toBe(
      REVIEW_CONSOLIDATION_PROVENANCE.mode,
    );
  });

  test("profiles and read-only modes per step", () => {
    const sealed = { kind: "file" };
    expect(nodeTurn(plan, "plan")).toBe(
      MULTI_REVIEW_STEP_TURNS.prepare.readOnly ? "read-only" : "write",
    );
    expect(reviewFanoutReviewerMode(sealed)).toBe("plan");
    expect(nodeTurn(plan, "review")).toBe("read-only");
    expect(nodeTurn(plan, "consolidate")).toBe(
      MULTI_REVIEW_STEP_TURNS.consolidate.readOnly ? "read-only" : "write",
    );
    // The Fix is an interactive build-mode tab the user can talk to.
    expect(MULTI_REVIEW_INTERACTIVE_FIX.mode).toBe("build");
    expect(nodeTurn(plan, "fix")).toBe("write");
    expect(agent(plan, "fix").askHuman).toBe(
      MULTI_REVIEW_INTERACTIVE_FIX.interactionPolicy === INTERACTIVE_AGENT_INTERACTION_POLICY,
    );
    // Today's PR agent pushes; here a system node does (D12).
    expect(node(plan, "pr")).toMatchObject({ kind: "system", action: "open-pull-request" });
  });

  test("fan-out bounds and fan-in policy", () => {
    expect(agent(plan, "review").fanOut).toEqual({ min: 1, max: MAX_BUILD_PIPELINE_REVIEWERS });
    const reports = node(plan, "consolidate").inputs.find((port) => port.name === "reports")!;
    expect(reports.collect).toEqual({ ...REVIEW_FANOUT_FAN_IN });
  });

  test("auto-fix and auto-PR routing", () => {
    for (const autoFix of [false, true]) {
      for (const autoPr of [false, true]) {
        for (const report of FINDINGS) {
          for (const complete of [false, true]) {
            const workflow = { autoFix, autoPr, consolidatedReport: report } as MultiReviewWorkflow;
            const fixes = multiReviewAutoFixDue(workflow);
            if (!fixes) queueCleanReviewAutoPr(workflow);
            else if (fixResultCompletes({ complete })) queueAutoPr(workflow);
            const engine = { fix: fixes, pr: workflow.autoPrLaunch?.state === "pending" };
            const ran = route(plan, {
              params: { autoFix, autoPr },
              values: { "consolidate.report": report, "fix.result": { complete } },
            });
            expect({
              autoFix,
              autoPr,
              report,
              complete,
              fix: ran.has("fix"),
              pr: ran.has("pr"),
            }).toEqual({
              autoFix,
              autoPr,
              report,
              complete,
              ...engine,
            });
            expect(ran.has("describe-pr")).toBe(engine.pr);
          }
        }
      }
    }
  });

  test("role defaults follow the Multi Review button's saved rows", () => {
    const roles = new Map(template.roles.map((role) => [role.key, role]));
    for (const { configured, additional } of SCENARIOS) {
      const global = savedSettings(configured, additional);
      const rows = multiReviewDefaultRows(
        { tiers: { global }, global, enabledAgentPlatforms: ["codex"] },
        [],
      );
      const set = new Set(configured);
      expect({
        reviewers: rows.reviewers.map(sourceOf),
        preparer: sourceOf(rows.reviewModel),
        fixer: sourceOf(rows.fixModel),
      }).toEqual({
        reviewers: rows.reviewers.map((_, index) =>
          roleSource(roles.get("reviewer")!, index, set, additional),
        ),
        preparer: roleSource(roles.get("preparer")!, 0, set, additional),
        fixer: roleSource(roles.get("fixer")!, 0, set, additional),
      });
      // Consolidation uses the preparation model unless the launch picks one.
      expect(roles.get("consolidator")!.defaultsFrom).toEqual(roles.get("preparer")!.defaultsFrom);
    }
  });
});

// ---------------------------------------------------------- Build Pipeline

describe("Build Pipeline template ↔ build-pipeline supervisor", () => {
  const { plan, stages, template } = builtIn("build-pipeline");
  const loop = plan.loops[0]!;
  const panel: Pick<BuildPipeline, "reviewers" | "steps" | "agentType" | "reviewPreparation"> = {
    agentType: "claude",
    reviewers: [{ agent: "claude" }, { agent: "codex" }],
  };

  function stageOf(id: string): BuildPipelineStage | undefined {
    const key = stages[id];
    return BUILD_PIPELINE_STAGES.find((stage) => stage.key === key);
  }

  test("node set: every stage of a panel run is described", () => {
    const described = new Set(Object.values(stages));
    for (const stage of BUILD_PIPELINE_STAGES) expect(described).toContain(stage.key);
  });

  test("stage order and loop membership", () => {
    const next = new Map<string, string[]>();
    for (const entry of plan.edges) {
      if ("input" in entry.from) continue;
      next.set(entry.from.node, [...(next.get(entry.from.node) ?? []), entry.to.node]);
    }
    const reachesLoop = (id: string): boolean => {
      const seen = new Set<string>();
      const queue = [...(next.get(id) ?? [])];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (loop.members.includes(current)) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        queue.push(...(next.get(current) ?? []));
      }
      return false;
    };
    const round = (id: string): BuildPipelineStage["round"] =>
      loop.laterOnly.includes(id)
        ? "later"
        : loop.members.includes(id)
          ? "every"
          : reachesLoop(id)
            ? "before"
            : "after";
    for (const id of plan.order) {
      const stage = stageOf(id);
      if (stage) expect({ id, round: round(id) }).toEqual({ id, round: stage.round });
    }
    // Within each part of a run, nodes meet the stages in table order.
    const order = (ids: readonly string[]) =>
      ids
        .map((id) => stageOf(id)?.key)
        .filter((key): key is BuildPipelineStageKey => key !== undefined)
        .filter((key, index, list) => list[index - 1] !== key);
    for (const part of ["before", "every", "later", "after"] as const) {
      expect(order(plan.order.filter((id) => stageOf(id)?.round === part))).toEqual(
        BUILD_PIPELINE_STAGES.filter((stage) => stage.round === part).map((stage) => stage.key),
      );
    }
  });

  test("result kinds per stage, for a panel run", () => {
    // The default launch has two reviewers, so Build and Fix leave the package
    // to the preparation session and submit nothing themselves.
    expect(usesPackagePreparationSession(panel)).toBe(true);
    for (const id of plan.order) {
      const stage = stageOf(id);
      if (!stage || node(plan, id).kind !== "agent") continue;
      const expected =
        (stage.key === "build" || stage.key === "fix") && usesPackagePreparationSession(panel)
          ? []
          : stage.result === null
            ? []
            : [stage.result];
      expect({ id, kinds: nodeResultKinds(plan, id) }).toEqual({ id, kinds: expected });
    }
    expect(node(plan, "consolidate").outputs[0]!.provenance).toBe(
      REVIEW_CONSOLIDATION_PROVENANCE.mode,
    );
  });

  test("profiles and read-only modes per stage", () => {
    for (const id of plan.order) {
      const stage = stageOf(id);
      const entry = node(plan, id);
      if (!stage || (entry.kind !== "agent" && entry.kind !== "system")) continue;
      if (stage.key === "pr" || (stage.key === "resolve-conflicts" && entry.kind === "system")) {
        // Today's Ship session pushes and opens the pull request, and conflict
        // resolution pushes. Agent nodes never push (D12): the agent only
        // describes or commits, and a system node does the side effect.
        expect(stage.turn).toBe("write");
        if (entry.kind === "agent") expect(nodeTurn(plan, id)).toBe("read-only");
        else expect(["open-pull-request", "push-branch"]).toContain(entry.action);
        continue;
      }
      // Recording criteria is part of the engine's Verify bookkeeping.
      if (entry.kind === "system" && stage.turn !== "system") continue;
      expect({ id, turn: nodeTurn(plan, id) }).toEqual({ id, turn: stage.turn });
    }
    // The engine side of those turns.
    for (const phase of [
      "build",
      "review",
      "address",
      "verify",
      "fix",
      "pr",
      "resolve-conflicts",
    ] as const) {
      for (const agentName of BUILD_PIPELINE_AGENTS) {
        expect(executionModeForSessionPhase(phase, agentName)).toBe("build");
      }
    }
    expect(executionModeOverrideForPhase("addressing")).toBe("build");
    const withPackage = { reviewPackage: { kind: "file" } } as unknown as BuildPipeline;
    expect(readsReviewPackage(withPackage, "review")).toBe(true);
    expect(readsReviewPackage(withPackage, "verify")).toBe(false);
    expect(reviewFanoutReviewerMode(withPackage.reviewPackage)).toBe("plan");
    expect(buildPipelineStageTurn(buildPipelineStage("consolidation"))).toEqual({
      mode: "plan",
      readOnly: true,
    });
  });

  test("routing after review", () => {
    for (const report of FINDINGS) {
      const ran = route(plan, { values: { "consolidate.report": report } });
      expect({ report, address: ran.has("address"), verify: ran.has("verify") }).toEqual({
        report,
        address: stageAfterReview(report).sessionPhase === "address",
        verify: true,
      });
    }
  });

  test("routing after Verify: the ship gate is the engine's rule; the loop stops on complete", () => {
    const criterion = (status: "passed" | "failed" | "not-checked") => ({
      id: "ac-1",
      status,
      evidence: "checked",
    });
    const verdicts: VerificationVerdict[] = [
      { complete: true, rationale: "ok", acceptanceCriteria: [] },
      { complete: true, rationale: "ok", acceptanceCriteria: [criterion("passed")] },
      { complete: true, rationale: "ok", acceptanceCriteria: [criterion("not-checked")] },
      { complete: true, rationale: "no", acceptanceCriteria: [criterion("failed")] },
      { complete: false, rationale: "no", acceptanceCriteria: [criterion("passed")] },
      { complete: false, rationale: "no", acceptanceCriteria: [] },
      { complete: true, rationale: "legacy" },
    ];
    const loopStops: VerificationVerdict[] = [];
    for (const verdict of verdicts) {
      const ships = route(plan, {
        values: { "consolidate.report": findings(0, 0), "verify.verdict": verdict },
      }).has("pr");
      expect({ verdict, ships }).toEqual({ verdict, ships: verificationPassed(verdict) });
      const stops =
        evaluateGraphPredicate(loop.until, { values: { "verify.verdict": verdict } }).truth ===
        "true";
      if (stops !== verificationPassed(verdict)) loopStops.push(verdict);
    }
    // Known gap: predicates cannot look inside a list (item 104), so a
    // complete verdict with a failed criterion ends the loop here, where the
    // engine runs another round; the ship gate still refuses it.
    expect(loopStops).toEqual([verdicts[3]!]);
  });

  test("Fix runs from the second round", () => {
    expect(buildPipelineStage("fix").round).toBe("later");
    expect(loop.laterOnly).toEqual(nodesFor(plan, stages, "fix"));
    const values = { "consolidate.report": findings(0, 0) };
    expect(route(plan, { iteration: 1, values }).has("fix")).toBe(false);
    expect(route(plan, { iteration: 2, values }).has("fix")).toBe(true);
  });

  test("routing after Ship: conflicts open conflict resolution", () => {
    expect(
      (template.types ?? []).find((type) => type.name === "pull-request-state")!.schema,
    ).toMatchObject({ properties: { state: { enum: [...PULL_REQUEST_DETECTION_STATES] } } });
    const passed = { complete: true, rationale: "ok", acceptanceCriteria: [] };
    for (const hasMergeConflicts of [true, false, null]) {
      const ran = route(plan, {
        values: {
          "consolidate.report": findings(0, 0),
          "verify.verdict": passed,
          "pr.state": { url: "u", state: "open", hasMergeConflicts },
        },
      });
      const engine = pullRequestNeedsConflictResolution({ hasMergeConflicts });
      expect({ hasMergeConflicts, resolve: ran.has("resolve"), push: ran.has("push") }).toEqual({
        hasMergeConflicts,
        resolve: engine,
        push: engine,
      });
    }
  });

  test("iteration bounds and reviewer caps", () => {
    expect(loop.maxIterations).toBe(DEFAULT_BUILD_PIPELINE_ITERATIONS);
    expect(loop.maxIterations).toBeLessThanOrEqual(MAX_BUILD_PIPELINE_ITERATIONS);
    expect(agent(plan, "review").fanOut).toEqual({ min: 1, max: MAX_BUILD_PIPELINE_REVIEWERS });
    const reports = node(plan, "consolidate").inputs.find((port) => port.name === "reports")!;
    expect(reports.collect).toEqual({ ...REVIEW_FANOUT_FAN_IN });
  });

  test("nodes share a role exactly when their stages share a step's settings and instructions", () => {
    // Fix runs under Build's step; preparation and consolidation share the
    // preparation step; each reviewer reads its own `reviewers` entry.
    const settingsOf = (stage: BuildPipelineStage) =>
      stage.key === "preparation" || stage.key === "consolidation"
        ? "reviewPreparation"
        : stage.key === "review"
          ? "reviewers"
          : stepKeyForSessionPhase(stage.session!.phase);
    const agents = plan.order.filter((id) => node(plan, id).kind === "agent");
    for (const a of agents) {
      for (const b of agents) {
        expect({
          a,
          b,
          sameRole: agent(plan, a).role === agent(plan, b).role,
        }).toEqual({ a, b, sameRole: settingsOf(stageOf(a)!) === settingsOf(stageOf(b)!) });
      }
    }
  });

  test("role defaults follow the saved build defaults", () => {
    const roles = new Map(template.roles.map((role) => [role.key, role]));
    for (const { configured, additional } of SCENARIOS) {
      const defaults = buildPipelineConfiguredDefaults(
        { global: savedSettings(configured, additional) },
        ["codex"],
      );
      const set = new Set(configured);
      const source = (step: BuildStepConfig | undefined) => sourceOf(step);
      expect({
        reviewers: defaults.reviewers.map(source),
        preparer: source(defaults.reviewPreparation),
        fixer: source(defaults.steps.address),
        verifier: source(defaults.steps.verify),
        describer: source(defaults.steps.pr),
        resolver: source(defaults.steps["resolve-conflicts"]),
      }).toEqual({
        reviewers: defaults.reviewers.map((_, index) =>
          roleSource(roles.get("reviewer")!, index, set, additional),
        ),
        preparer: roleSource(roles.get("preparer")!, 0, set, additional),
        fixer: roleSource(roles.get("fixer")!, 0, set, additional),
        verifier: roleSource(roles.get("verifier")!, 0, set, additional),
        describer: roleSource(roles.get("describer")!, 0, set, additional),
        resolver: roleSource(roles.get("resolver")!, 0, set, additional),
      });
    }
    // Build has no action default: it is the pipeline's own agent.
    expect(roles.get("builder")!.defaultsFrom).toBeUndefined();
  });
});

// ----------------------------------------------------------- Looped Review

describe("Looped Review template ↔ what remains of its engine", () => {
  const { template } = builtIn("looped-review");

  test("the reconciliation type is the review-reconciliation result kind's schema", () => {
    const reconciliation = template.types!.find((type) => type.name === "review-reconciliation")!;
    expect(reconciliation.schema).toEqual(REVIEW_RECONCILIATION_RESULT_JSON_SCHEMA as never);
    expect(workflowResultJsonSchema("review-reconciliation")).toBeDefined();
  });
});
