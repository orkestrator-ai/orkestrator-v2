/**
 * Control flow end to end (item 206): gates and skip propagation, merges,
 * loops and failure handling, through real scheduler passes with the real
 * gate and merge executors and scripted pass-through agent and system
 * executors. Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type {
  GraphAgentNode,
  GraphNodeSpec,
  GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { graphLoopState } from "./graph-run-loops.js";
import type { GraphRunService } from "./graph-run-service.js";
import { GraphRunView } from "./graph-run-view.js";
import { ManualTime } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

/** Real gate and merge executors; pass-through agents, systems and people. */
async function harness(): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.skipKinds.add("gate");
  world.fakes.skipKinds.add("merge");
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  service.executors.register(createGraphGateExecutor());
  service.executors.register(createGraphMergeExecutor());
  await service.init();
  return { world, service, time };
}

async function launch(
  h: Harness,
  plan: CompiledGraphPlan,
  options: { panel?: number; params?: Record<string, string | number | boolean> } = {},
): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, options.panel ?? 2),
    ...(options.params ? { params: options.params } : {}),
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [input.name, graphTypeExample(plan, input.type)]),
    ),
  });
}

/** Passes, one observation period apart, until the run is terminal. */
async function finish(h: Harness, runId: string, passes = 80): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    h.time.jump(3_000);
    const run = await h.service.advanceNow(runId);
    if (!run) throw new Error("the run disappeared");
    if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
  }
  throw new Error("the run did not finish");
}

function latest(run: GraphRun, nodeId: string, iteration = 1, branchKey?: string): NodeActivation {
  const found = run.activations
    .filter(
      (activation) =>
        activation.nodeId === nodeId &&
        activation.iteration === iteration &&
        activation.branchKey === branchKey,
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no activation of ${nodeId} at ${iteration} ${branchKey ?? ""}`);
  return found;
}

const states = (run: GraphRun, nodeId: string) =>
  run.activations
    .filter((activation) => activation.nodeId === nodeId)
    .map((activation) => `${activation.iteration}:${activation.state}`);

async function artifact(h: Harness, run: GraphRun, id: string) {
  const stored = await h.world.storage.graphRuns.getGraphArtifact(run.id, id);
  if (!stored) throw new Error(`no artifact ${id}`);
  return stored;
}

// ---------------------------------------------------------------- templates

function agent(
  id: string,
  access: "read" | "write" | "none",
  inputs: { name: string; type: string; required?: boolean; firstIterationFrom?: unknown }[],
  outputs: { name: string; type: string }[],
  extra: Partial<GraphAgentNode> = {},
): GraphNodeSpec {
  return {
    id,
    kind: "agent",
    role: "worker",
    capabilities: {
      profile: access === "write" ? "builder" : access === "read" ? "reviewer" : "observer",
    },
    workspaceAccess: access,
    prompt: {
      template: `Do ${id}.\n\n${inputs.map((input) => `{{> input.${input.name}}}`).join("\n\n")}\n`,
    },
    inputs: inputs as GraphAgentNode["inputs"],
    outputs,
    ...extra,
  } as GraphNodeSpec;
}

function edge(
  id: string,
  from: unknown,
  to: [string, string],
  extra: Record<string, unknown> = {},
) {
  return { id, from, to: { node: to[0], port: to[1] }, ...extra };
}

function template(
  id: string,
  nodes: GraphNodeSpec[],
  edges: unknown[],
  outputs: unknown[],
  extra: Partial<GraphTemplateV1> = {},
): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id,
    revision: 1,
    name: id,
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs,
    workspace: { kind: "environment" },
    nodes,
    edges,
    limits: { maxAgentSessions: 40, maxConcurrentAgents: 4 },
    ...extra,
  } as GraphTemplateV1;
}

const CODE = { name: "code", type: "workspace@1" };
const REPORT = { name: "report", type: "review-report@1" };
const EXAMPLE_REPORT = graphTypeExample({ types: [] } as never, "review-report@1") as Record<
  string,
  unknown
>;
const CLEAN_REPORT = { ...EXAMPLE_REPORT, issues: [], testCoverageGaps: [] };

/**
 * build → review → check (gate: findings | clean). `findings` feeds fix →
 * polish; publish takes fix's code or the clean outlet's (exclusive
 * producers); audit needs both outlets, so it never runs.
 */
function routingTemplate(): GraphTemplateV1 {
  return template(
    "routing",
    [
      agent("build", "write", [CODE], [CODE]),
      agent("review", "read", [CODE], [REPORT]),
      {
        id: "check",
        kind: "gate",
        inputs: [REPORT, CODE],
        branches: [{ to: "findings", when: { path: "report.issues", op: "nonEmpty" } }],
        otherwise: "clean",
      },
      agent("fix", "write", [REPORT, CODE], [CODE]),
      agent("polish", "write", [CODE], [CODE]),
      agent("publish", "none", [CODE], [{ name: "notes", type: "text@1" }]),
      agent("audit", "none", [REPORT, CODE], [{ name: "notes", type: "text@1" }]),
    ],
    [
      edge("target-build", { input: "target" }, ["build", "code"]),
      edge("build-review", { node: "build", port: "code" }, ["review", "code"]),
      edge("review-check", { node: "review", port: "report" }, ["check", "report"]),
      edge("build-check", { node: "build", port: "code" }, ["check", "code"]),
      edge("findings-fix-report", { node: "check", outlet: "findings", port: "report" }, [
        "fix",
        "report",
      ]),
      edge("findings-fix-code", { node: "check", outlet: "findings", port: "code" }, [
        "fix",
        "code",
      ]),
      edge("fix-polish", { node: "fix", port: "code" }, ["polish", "code"]),
      edge("fix-publish", { node: "fix", port: "code" }, ["publish", "code"]),
      edge("clean-publish", { node: "check", outlet: "clean", port: "code" }, ["publish", "code"]),
      edge("findings-audit", { node: "check", outlet: "findings", port: "report" }, [
        "audit",
        "report",
      ]),
      edge("clean-audit", { node: "check", outlet: "clean", port: "code" }, ["audit", "code"]),
    ],
    [
      { name: "notes", type: "text@1", from: { node: "publish", port: "notes" } },
      { name: "audit", type: "text@1", required: false, from: { node: "audit", port: "notes" } },
    ],
  );
}

describe("gates route and skip their untaken subtrees", () => {
  test("findings: fix and polish run, publish takes fix's code, audit is skipped", async () => {
    const h = await harness();
    const created = await launch(h, compiledPlan(routingTemplate()));
    const run = await finish(h, created.id);
    expect(run.status).toBe("complete");
    const check = latest(run, "check");
    expect(check.outlet).toBe("findings");
    expect(states(run, "fix")).toEqual(["1:complete"]);
    expect(states(run, "polish")).toEqual(["1:complete"]);
    expect(latest(run, "publish").inputs.code).toBe(latest(run, "fix").outputs.code);
    expect(states(run, "audit")).toEqual(["1:skipped"]);
    // The outlet forwards the gate's inputs as they are.
    expect(latest(run, "fix").inputs).toEqual({
      report: latest(run, "review").outputs.report!,
      code: latest(run, "build").outputs.code!,
    });
  });

  test("clean: the whole findings subtree is skipped; publish takes the clean outlet", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("review", () => CLEAN_REPORT);
    const created = await launch(h, compiledPlan(routingTemplate()));
    const run = await finish(h, created.id);
    expect(run.status).toBe("complete");
    expect(latest(run, "check").outlet).toBe("clean");
    expect(states(run, "fix")).toEqual(["1:skipped"]);
    expect(states(run, "polish")).toEqual(["1:skipped"]);
    expect(states(run, "audit")).toEqual(["1:skipped"]);
    expect(latest(run, "publish").inputs.code).toBe(latest(run, "build").outputs.code);
    // Skipped nodes never reached an executor.
    expect(h.world.fakes.callsOf("start", "fix")).toHaveLength(0);
  });

  test("a gate without `otherwise` whose branches are false takes no outlet", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        "no-outlet",
        [
          agent("build", "write", [CODE], [CODE]),
          {
            id: "go",
            kind: "gate",
            inputs: [CODE],
            branches: [{ to: "yes", when: { path: "params.mode", op: "eq", value: "go" } }],
          },
          agent("after", "read", [CODE], [{ name: "notes", type: "text@1" }]),
        ],
        [
          edge("target-build", { input: "target" }, ["build", "code"]),
          edge("build-go", { node: "build", port: "code" }, ["go", "code"]),
          edge("yes-after", { node: "go", outlet: "yes", port: "code" }, ["after", "code"]),
        ],
        [
          {
            name: "notes",
            type: "text@1",
            required: false,
            from: { node: "after", port: "notes" },
          },
        ],
        {
          parameters: [{ key: "mode", type: "enum", options: ["go", "stop"], default: "stop" }],
        } as Partial<GraphTemplateV1>,
      ),
    );
    const stopped = await finish(h, (await launch(h, plan)).id);
    expect(stopped.status).toBe("complete");
    expect(latest(stopped, "go").state).toBe("complete");
    expect(latest(stopped, "go").outlet).toBeUndefined();
    expect(states(stopped, "after")).toEqual(["1:skipped"]);
    const going = await finish(h, (await launch(h, plan, { params: { mode: "go" } })).id);
    expect(latest(going, "go").outlet).toBe("yes");
    expect(states(going, "after")).toEqual(["1:complete"]);
  });

  test("a list input passes through a taken outlet as a list", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        "list-outlet",
        [
          agent("review", "read", [CODE], [REPORT], {
            role: "panel",
            replicate: { over: "panel", role: "panel" },
          }),
          {
            id: "any",
            kind: "gate",
            inputs: [{ name: "reports", type: "list<review-report@1>" }],
            branches: [{ to: "some", when: { path: "reports", op: "nonEmpty" } }],
            otherwise: "none",
          },
          agent(
            "consolidate",
            "none",
            [{ name: "reports", type: "list<review-report@1>" }],
            [REPORT],
          ),
        ],
        [
          edge("target-review", { input: "target" }, ["review", "code"]),
          edge("review-any", { node: "review", port: "report" }, ["any", "reports"]),
          edge("some-consolidate", { node: "any", outlet: "some", port: "reports" }, [
            "consolidate",
            "reports",
          ]),
        ],
        [
          {
            name: "report",
            type: "review-report@1",
            from: { node: "consolidate", port: "report" },
          },
        ],
        {
          roles: [
            { key: "worker", multiplicity: "one" },
            { key: "panel", multiplicity: "panel", maxPanel: 4 },
          ],
        },
      ),
    );
    const run = await finish(h, (await launch(h, plan, { panel: 3 })).id);
    expect(run.status).toBe("complete");
    expect(latest(run, "any").outlet).toBe("some");
    const reviews = ["panel.1", "panel.2", "panel.3"].map(
      (branch) => latest(run, "review", 1, branch).outputs.report!,
    );
    expect(latest(run, "consolidate").inputs.reports).toEqual(reviews);
  });
});

// ---------------------------------------------------------------- merges

describe("merge nodes at run time", () => {
  function mergeTemplate(strategy: unknown, outputType = "review-report@1"): GraphTemplateV1 {
    return template(
      "merging",
      [
        agent("review", "read", [CODE], [REPORT], {
          role: "panel",
          replicate: { over: "panel", role: "panel" },
        }),
        {
          id: "merge",
          kind: "merge",
          strategy,
          inputs: [{ name: "reports", type: "list<review-report@1>" }],
          outputs: [{ name: "report", type: outputType }],
        } as GraphNodeSpec,
        agent(
          "after",
          "none",
          [{ name: "report", type: outputType }],
          [{ name: "notes", type: "text@1" }],
        ),
      ],
      [
        edge("target-review", { input: "target" }, ["review", "code"]),
        edge("review-merge", { node: "review", port: "report" }, ["merge", "reports"]),
        edge("merge-after", { node: "merge", port: "report" }, ["after", "report"]),
      ],
      [{ name: "notes", type: "text@1", required: false, from: { node: "after", port: "notes" } }],
      {
        roles: [
          { key: "worker", multiplicity: "one" },
          { key: "panel", multiplicity: "panel", maxPanel: 4 },
        ],
      },
    );
  }

  test("a dedupe over a panel folds shared findings and keeps every source id", async () => {
    const h = await harness();
    const issue = (EXAMPLE_REPORT.issues as Record<string, unknown>[])[0]!;
    h.world.fakes.scripts.set("review", ({ branchKey }) => ({
      ...EXAMPLE_REPORT,
      issues:
        branchKey === "panel.1"
          ? [issue, { ...issue, title: "Only one reviewer saw this" }]
          : [issue],
    }));
    const plan = compiledPlan(mergeTemplate({ kind: "dedupe", key: ["file", "title"] }));
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    const merged = await artifact(h, run, latest(run, "merge").outputs.report!);
    expect(merged.producer).toEqual({
      nodeId: "merge",
      activation: latest(run, "merge").key,
      port: "report",
    });
    expect(merged.inputs).toEqual(latest(run, "merge").inputs.reports as string[]);
    expect(merged.itemIds).toEqual(["review/panel.1/issue-1", "review/panel.1/issue-2"]);
    expect(merged.itemSources).toEqual([
      ["review/panel.1/issue-1", "review/panel.2/issue-1"],
      ["review/panel.1/issue-2"],
    ]);
    const value = merged.body.value as { issues: { reviewSourceIds: string[] }[] };
    expect(value.issues.map((entry) => entry.reviewSourceIds)).toEqual(merged.itemSources!);
    expect(latest(run, "after").inputs.report).toBe(merged.id);
  });

  test("a collect merge delivers its input list unchanged", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        "collecting",
        [
          agent("review", "read", [CODE], [REPORT], {
            role: "panel",
            replicate: { over: "panel", role: "panel" },
          }),
          {
            id: "merge",
            kind: "merge",
            strategy: { kind: "collect" },
            inputs: [{ name: "reports", type: "list<review-report@1>" }],
            outputs: [{ name: "reports", type: "list<review-report@1>" }],
          } as GraphNodeSpec,
          agent("after", "none", [{ name: "reports", type: "list<review-report@1>" }], [REPORT]),
        ],
        [
          edge("target-review", { input: "target" }, ["review", "code"]),
          edge("review-merge", { node: "review", port: "report" }, ["merge", "reports"]),
          edge("merge-after", { node: "merge", port: "reports" }, ["after", "reports"]),
        ],
        [{ name: "report", type: "review-report@1", from: { node: "after", port: "report" } }],
        {
          roles: [
            { key: "worker", multiplicity: "one" },
            { key: "panel", multiplicity: "panel", maxPanel: 4 },
          ],
        },
      ),
    );
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    expect(latest(run, "after").inputs.reports).toEqual(latest(run, "merge").inputs.reports);
    expect((latest(run, "after").inputs.reports as string[]).length).toBe(2);
  });

  test("a vote tie under `tie: fail` fails the merge with invalid-result", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        "voting",
        [
          agent("judge", "none", [CODE], [{ name: "decision", type: "decision@1" }], {
            replicate: { over: "samples", count: 2 },
          }),
          {
            id: "vote",
            kind: "merge",
            strategy: { kind: "vote", tie: "fail" },
            inputs: [{ name: "decisions", type: "list<decision@1>" }],
            outputs: [{ name: "decision", type: "decision@1" }],
          } as GraphNodeSpec,
        ],
        [
          edge("target-judge", { input: "target" }, ["judge", "code"]),
          edge("judge-vote", { node: "judge", port: "decision" }, ["vote", "decisions"]),
        ],
        [{ name: "decision", type: "decision@1", from: { node: "vote", port: "decision" } }],
      ),
    );
    h.world.fakes.scripts.set("judge", ({ branchKey }) => ({
      choice: branchKey === "sample.1" ? "ship" : "rework",
      rationale: "r",
    }));
    const tied = await finish(h, (await launch(h, plan)).id);
    expect(tied.status).toBe("failed");
    expect(latest(tied, "vote")).toMatchObject({ state: "failed", errorCause: "invalid-result" });
    h.world.fakes.scripts.set("judge", () => ({ choice: "ship", rationale: "r" }));
    const agreed = await finish(h, (await launch(h, plan)).id);
    expect(agreed.status).toBe("complete");
    const decision = await artifact(h, agreed, latest(agreed, "vote").outputs.decision!);
    expect(decision.body.value).toEqual({ choice: "ship", rationale: "Vote: ship 2 (2 votes). r" });
  });
});

// ---------------------------------------------------------------- loops

/** The §9.2 loop shape: build once, then rounds of fix?, prepare, review, gate, address?, verify. */
function pipelineLoopTemplate(): GraphTemplateV1 {
  const VERDICT = { name: "verdict", type: "verification-verdict@1" };
  return template(
    "pipeline-loop",
    [
      agent("build", "write", [CODE], [CODE]),
      agent("fix", "write", [{ name: "feedback", type: VERDICT.type }, CODE], [CODE], {
        when: { path: "run.iteration", op: "gt", value: 1 },
      }),
      agent(
        "prepare",
        "write",
        [{ ...CODE, firstIterationFrom: { node: "build", port: "code" } }],
        [CODE],
      ),
      agent("review", "read", [CODE], [REPORT]),
      {
        id: "has-issues",
        kind: "gate",
        inputs: [REPORT, CODE],
        branches: [{ to: "issues", when: { path: "report.issues", op: "nonEmpty" } }],
        otherwise: "clean",
      },
      agent("address", "write", [REPORT, CODE], [CODE, { name: "report", type: "fix-result@1" }]),
      agent(
        "verify",
        "read",
        [CODE, { name: "address", type: "fix-result@1", required: false }],
        [VERDICT, CODE],
      ),
    ],
    [
      edge("target-build", { input: "target" }, ["build", "code"]),
      edge("build-prepare", { node: "build", port: "code" }, ["prepare", "code"]),
      edge("fix-prepare", { node: "fix", port: "code" }, ["prepare", "code"]),
      edge("prepare-review", { node: "prepare", port: "code" }, ["review", "code"]),
      edge("review-gate", { node: "review", port: "report" }, ["has-issues", "report"]),
      edge("prepare-gate", { node: "prepare", port: "code" }, ["has-issues", "code"]),
      edge("issues-address-report", { node: "has-issues", outlet: "issues", port: "report" }, [
        "address",
        "report",
      ]),
      edge("issues-address-code", { node: "has-issues", outlet: "issues", port: "code" }, [
        "address",
        "code",
      ]),
      edge("address-verify-code", { node: "address", port: "code" }, ["verify", "code"]),
      edge("clean-verify-code", { node: "has-issues", outlet: "clean", port: "code" }, [
        "verify",
        "code",
      ]),
      edge("address-verify-report", { node: "address", port: "report" }, ["verify", "address"]),
    ],
    [
      { name: "verdict", type: VERDICT.type, from: { node: "verify", port: "verdict" } },
      { name: "code", type: "workspace@1", from: { node: "verify", port: "code" } },
    ],
    {
      loops: [
        {
          id: "rounds",
          nodes: ["fix", "prepare", "review", "has-issues", "address", "verify"],
          until: { path: "verify.verdict.complete", op: "eq", value: true },
          maxIterations: 3,
          carry: [
            { from: { node: "verify", port: "verdict" }, to: { node: "fix", port: "feedback" } },
            { from: { node: "verify", port: "code" }, to: { node: "fix", port: "code" } },
          ],
        },
      ],
    } as Partial<GraphTemplateV1>,
  );
}

const VERDICT_EXAMPLE = graphTypeExample({ types: [] } as never, "verification-verdict@1") as {
  acceptanceCriteria: { id: string; status: string; evidence: string }[];
};

function verdict(complete: boolean) {
  return {
    ...VERDICT_EXAMPLE,
    complete,
    acceptanceCriteria: VERDICT_EXAMPLE.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      status: complete ? "passed" : criterion.status,
    })),
  };
}

async function loopState(h: Harness, run: GraphRun, loopId: string) {
  const values = new Map<string, { value: unknown }>();
  for (const activation of run.activations) {
    for (const id of Object.values(activation.outputs)) {
      values.set(id, { value: (await artifact(h, run, id)).body.value });
    }
  }
  const view = new GraphRunView(run, values);
  return graphLoopState(view, view.loop(loopId));
}

describe("loops (§9.2, §9.4)", () => {
  test("the pipeline loop converges, carrying the previous iteration's artifacts", async () => {
    const h = await harness();
    // Iteration 1 has findings and fails verification; iteration 2 is clean and passes.
    h.world.fakes.scripts.set("review", ({ iteration }) =>
      iteration === 1 ? undefined : CLEAN_REPORT,
    );
    h.world.fakes.scripts.set("verify", ({ port, iteration }) =>
      port === "verdict" ? verdict(iteration >= 2) : undefined,
    );
    const run = await finish(h, (await launch(h, compiledPlan(pipelineLoopTemplate()))).id);
    expect(run.status).toBe("complete");
    expect(run.loopIterations.rounds).toBe(2);
    expect(run.activations.some((activation) => activation.iteration > 2)).toBe(false);
    expect(await loopState(h, run, "rounds")).toEqual({
      state: "done",
      reason: "converged",
      iteration: 2,
    });
    // The iteration is part of every member's key.
    expect(latest(run, "prepare", 2).key).toBe("prepare#iter=2#attempt=1");
    // Iteration 1: fix is a later-only entry; prepare takes build's code.
    expect(states(run, "fix")).toEqual(["1:skipped", "2:complete"]);
    expect(latest(run, "prepare", 1).inputs.code).toBe(latest(run, "build").outputs.code);
    expect(latest(run, "has-issues", 1).outlet).toBe("issues");
    expect(latest(run, "verify", 1).inputs.code).toBe(latest(run, "address", 1).outputs.code);
    // Iteration 2: fix gets verify's verdict and code from iteration 1, prepare takes fix's.
    expect(latest(run, "fix", 2).inputs).toEqual({
      feedback: latest(run, "verify", 1).outputs.verdict!,
      code: latest(run, "verify", 1).outputs.code!,
    });
    expect(latest(run, "prepare", 2).inputs.code).toBe(latest(run, "fix", 2).outputs.code);
    expect(latest(run, "has-issues", 2).outlet).toBe("clean");
    expect(states(run, "address")).toEqual(["1:complete", "2:skipped"]);
    expect(latest(run, "verify", 2).inputs).toEqual({
      code: latest(run, "prepare", 2).outputs.code!,
    });
  });

  test("a loop that never converges stops at maxIterations; downstream reads the last iteration", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("verify", ({ port }) =>
      port === "verdict" ? verdict(false) : undefined,
    );
    const run = await finish(h, (await launch(h, compiledPlan(pipelineLoopTemplate()))).id);
    // Stopping at the bound is an outcome, not a failure.
    expect(run.status).toBe("complete");
    expect(run.loopIterations.rounds).toBe(3);
    expect(states(run, "verify")).toEqual(["1:complete", "2:complete", "3:complete"]);
    expect(run.activations.some((activation) => activation.iteration > 3)).toBe(false);
    expect(await loopState(h, run, "rounds")).toEqual({
      state: "done",
      reason: "bound",
      iteration: 3,
    });
    expect(latest(run, "fix", 3).inputs.feedback).toBe(latest(run, "verify", 2).outputs.verdict);
  });

  test("§9.4 with a static panel: flatten at delivery, dedupe, fix, revalidate until clean", async () => {
    const h = await harness();
    const diagnosis = (rootCause: string, explanation: string) => ({
      rootCause,
      explanation,
      files: ["src/a.ts"],
    });
    const failure = (command: string) => ({ command, summary: "fails", output: "1 failed" });
    h.world.fakes.scripts.set("validate", ({ port, iteration }) =>
      port === "results"
        ? { failures: iteration === 1 ? [failure("bun test a"), failure("bun test b")] : [] }
        : undefined,
    );
    h.world.fakes.scripts.set("diagnose", ({ branchKey }) => ({
      diagnoses:
        branchKey === "panel.1"
          ? [diagnosis("race", "seen by one"), diagnosis("typo", "only one")]
          : [diagnosis("race", "seen by two")],
    }));
    const example = graphTemplateExample("failure-diagnosis");
    example.roles = example.roles.map((role) =>
      role.key === "diagnoser" ? { key: "diagnoser", multiplicity: "panel", maxPanel: 4 } : role,
    );
    const diagnose = example.nodes.find((node) => node.id === "diagnose") as GraphAgentNode;
    diagnose.replicate = { over: "panel", role: "diagnoser" };
    diagnose.prompt = {
      template:
        "Find the root cause of these validation failures. Do not change any files.\n\n{{> input.code}}\n\n{{> input.failures}}\n",
    };
    const run = await finish(h, (await launch(h, compiledPlan(example))).id);
    expect(run.status).toBe("complete");
    expect(run.loopIterations.repair).toBe(2);
    expect(await loopState(h, run, "repair")).toMatchObject({ state: "done", reason: "converged" });

    // The flatten transform delivered one validation-failure@1 per failure, made at delivery.
    const results = latest(run, "validate", 1).outputs.results!;
    for (const branch of ["panel.1", "panel.2"]) {
      const activation = latest(run, "diagnose", 1, branch);
      const failures = activation.inputs.failures as string[];
      expect(failures).toHaveLength(2);
      for (const id of failures) {
        const delivered = await artifact(h, run, id);
        expect(delivered.type).toBe("validation-failure@1");
        expect(delivered.inputs).toEqual([results]);
        expect(delivered.producer).toEqual({
          nodeId: "diagnose",
          activation: activation.key,
          port: "failures",
        });
      }
    }
    // The dedupe folded the shared root cause and kept both sources.
    const merged = await artifact(h, run, latest(run, "dedupe", 1).outputs.diagnosis!);
    expect(
      (merged.body.value as { diagnoses: { rootCause: string }[] }).diagnoses.map(
        (d) => d.rootCause,
      ),
    ).toEqual(["race", "typo"]);
    expect(merged.itemSources).toEqual([
      ["diagnose/panel.1/diagnosis-1", "diagnose/panel.2/diagnosis-1"],
      ["diagnose/panel.1/diagnosis-2"],
    ]);
    expect(latest(run, "fix", 1).inputs.diagnosis).toBe(merged.id);
    // Iteration 2 validates fix's code; with no failures the rest of the round is skipped.
    expect(latest(run, "validate", 2).inputs.code).toBe(latest(run, "fix", 1).outputs.code);
    expect(states(run, "diagnose")).toEqual(["1:complete", "1:complete", "2:skipped", "2:skipped"]);
    expect(states(run, "dedupe")).toEqual(["1:complete", "2:skipped"]);
    expect(states(run, "fix")).toEqual(["1:complete", "2:skipped"]);
  });
});

// ---------------------------------------------------------------- failure

describe("failure handling (§8.4)", () => {
  function failingTemplate(build: Partial<GraphAgentNode>): GraphTemplateV1 {
    return template(
      "failing",
      [
        agent("build", "write", [CODE], [CODE, { name: "error", type: "error@1" }], build),
        agent("after", "read", [CODE], [{ name: "notes", type: "text@1" }]),
        agent(
          "recover",
          "none",
          [{ name: "error", type: "error@1" }],
          [{ name: "notes", type: "text@1" }],
        ),
      ],
      [
        edge("target-build", { input: "target" }, ["build", "code"]),
        edge("build-after", { node: "build", port: "code" }, ["after", "code"]),
        edge("build-recover", { node: "build", port: "error" }, ["recover", "error"]),
      ],
      [
        { name: "notes", type: "text@1", required: false, from: { node: "after", port: "notes" } },
        {
          name: "recovered",
          type: "text@1",
          required: false,
          from: { node: "recover", port: "notes" },
        },
      ],
    );
  }

  test("retry: counted failures rerun the node with the same inputs until it succeeds", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["provider-error", "provider-error"]);
    const plan = compiledPlan(
      failingTemplate({ retry: { attempts: 3, on: ["provider-error"] }, onFailure: "route" }),
    );
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    expect(
      run.activations.filter((a) => a.nodeId === "build").map((a) => `${a.attempt}:${a.state}`),
    ).toEqual(["1:failed", "2:failed", "3:complete"]);
    const attempts = run.activations.filter((a) => a.nodeId === "build");
    expect(new Set(attempts.map((a) => JSON.stringify(a.inputs))).size).toBe(1);
    expect(states(run, "after")).toEqual(["1:complete"]);
    // A success emits nothing on `error`: the recovery branch is skipped.
    expect(states(run, "recover")).toEqual(["1:skipped"]);
  });

  test("fail-run: a failure retry does not count fails the run", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["invalid-result"]);
    const plan = compiledPlan(failingTemplate({ retry: { attempts: 3, on: ["provider-error"] } }));
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("failed");
    expect(run.errorCause).toBe("invalid-result");
    expect(run.error).toContain("Node build failed");
    expect(states(run, "build")).toEqual(["1:failed"]);
  });

  test("skip: the failed node's consumers are skipped and the run goes on", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["timeout"]);
    const plan = compiledPlan(failingTemplate({ onFailure: "skip" }));
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    expect(states(run, "build")).toEqual(["1:failed"]);
    expect(states(run, "after")).toEqual(["1:skipped"]);
    expect(states(run, "recover")).toEqual(["1:skipped"]);
  });

  test("route: after its retries the failure becomes an error@1 artifact a recovery branch reads", async () => {
    const h = await harness();
    h.world.fakes.failQueue.set("build", ["timeout", "timeout"]);
    const plan = compiledPlan(
      failingTemplate({ retry: { attempts: 2, on: ["timeout"] }, onFailure: "route" }),
    );
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    const failed = latest(run, "build");
    expect(failed).toMatchObject({ state: "failed", attempt: 2, errorCause: "timeout" });
    const error = await artifact(h, run, failed.outputs.error!);
    expect(error.type).toBe("error@1");
    expect(error.producer).toEqual({ nodeId: "build", activation: failed.key, port: "error" });
    expect(error.inputs).toEqual([failed.inputs.code as string]);
    expect(error.body.value).toEqual({
      node: "build",
      cause: "timeout",
      code: "timeout",
      message: "The fake executor failed",
      attempts: 2,
      retryable: true,
    });
    expect(latest(run, "recover").inputs.error).toBe(error.id);
    expect(states(run, "recover")).toEqual(["1:complete"]);
    expect(states(run, "after")).toEqual(["1:skipped"]);
  });

  test("a value over the target's budgets fails the consumer at delivery with budget-exceeded", async () => {
    const h = await harness();
    const note = (name: string, maxStringBytes: number) => ({
      name,
      version: 1,
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      storage: "value",
      budgets: { maxBytes: 65_536, maxStringBytes },
    });
    const plan = compiledPlan(
      template(
        "budgets",
        [
          agent("write", "none", [CODE], [{ name: "note", type: "long-note@1" }]),
          agent(
            "read",
            "none",
            [{ name: "note", type: "short-note@1" }],
            [{ name: "notes", type: "text@1" }],
            {
              onFailure: "skip",
            },
          ),
        ],
        [
          edge("target-write", { input: "target" }, ["write", "code"]),
          edge("write-read", { node: "write", port: "note" }, ["read", "note"]),
        ],
        [{ name: "notes", type: "text@1", required: false, from: { node: "read", port: "notes" } }],
        { types: [note("long-note", 4_096), note("short-note", 16)] } as Partial<GraphTemplateV1>,
      ),
    );
    expect(plan.edges.find((candidate) => candidate.id === "write-read")?.budgetCheck).toBe(true);
    h.world.fakes.scripts.set("write", () => ({ text: "x".repeat(64) }));
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    const read = latest(run, "read");
    expect(read).toMatchObject({ state: "failed", errorCause: "budget-exceeded" });
    expect(read.error).toContain("edge write-read");
    expect(read.error).not.toContain("xxxx");
    // Within budget the same edge forwards the producer's artifact itself.
    h.world.fakes.scripts.set("write", () => ({ text: "short" }));
    const fits = await finish(h, (await launch(h, plan)).id);
    expect(latest(fits, "read").inputs.note).toBe(latest(fits, "write").outputs.note);
  });
});
