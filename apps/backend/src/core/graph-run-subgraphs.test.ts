/**
 * Sub-graphs end to end (item 402): the report §9.3 design bake-off, whose
 * review is the built-in Multi Review inlined as a sub-graph, through real
 * scheduler passes with the real gate and merge executors and pass-through
 * agent, system and human executors. Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { ManualTime } from "./recurring-test-support.js";
import { runCommand } from "./shell.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
  plan: CompiledGraphPlan;
}

/**
 * A run world whose environment `e3` has a Git worktree, so the inlined
 * review package (a reference artifact) can be sealed as a file.
 */
async function harness(): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  const worktree = path.join(world.dataDir, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  await world.storage.addEnvironment(
    graphEnvironmentFixture({ id: "e3", order: 2, worktreePath: worktree }),
  );
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
  return { world, service, time, plan: compiledPlan(graphTemplateExample("design-bake-off")) };
}

async function launch(h: Harness, params: Record<string, boolean> = {}): Promise<GraphRun> {
  const { plan } = h;
  return h.service.create({
    projectId: "p1",
    environmentId: "e3",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, 2),
    params,
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [input.name, graphTypeExample(plan, input.type)]),
    ),
  });
}

const terminal = (run: GraphRun) =>
  run.status === "complete" || run.status === "failed" || run.status === "cancelled";

/** Passes until the run waits for a person or ends; approves the brief on the way. */
async function finish(h: Harness, runId: string, passes = 80): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    h.time.jump(3_000);
    const run = await h.service.advanceNow(runId);
    if (!run) throw new Error("the run disappeared");
    if (terminal(run)) return run;
    const approval = run.activations.find(
      (activation) => activation.nodeId === "approve" && activation.state === "awaiting-human",
    );
    if (approval && !h.world.fakes.answers.has(approval.key)) {
      h.world.fakes.answers.set(approval.key, "approved");
      h.service.requestObservation(runId, approval.key);
    }
  }
  throw new Error("the run did not finish");
}

const states = (run: GraphRun, nodeId: string) =>
  run.activations
    .filter((activation) => activation.nodeId === nodeId)
    .map((activation) => activation.state);

function only(run: GraphRun, nodeId: string): NodeActivation {
  const found = run.activations.filter((activation) => activation.nodeId === nodeId);
  if (found.length !== 1) throw new Error(`${nodeId} has ${found.length} activations`);
  return found[0]!;
}

/** The consolidated report: with the example's issues, or with none. */
function scriptReport(h: Harness, findings: boolean): void {
  const example = graphTypeExample(h.plan, "review-report@1") as Record<string, unknown>;
  h.world.fakes.scripts.set("review/consolidate", ({ port }) =>
    port === "report"
      ? findings
        ? example
        : { ...example, issues: [], testCoverageGaps: [] }
      : undefined,
  );
}

describe("the §9.3 design bake-off with Multi Review inlined (item 402)", () => {
  test("findings are fixed inside the sub-graph and the parent opens the pull request", async () => {
    const h = await harness();
    scriptReport(h, true);
    const run = await finish(h, (await launch(h)).id);
    expect(run.status).toBe("complete");

    // The parent's own nodes ran, the design panel once per lens.
    expect(states(run, "design")).toEqual(["complete", "complete", "complete"]);
    for (const id of ["judge", "approve", "build", "describe-pr", "pr"]) {
      expect({ id, states: states(run, id) }).toEqual({ id, states: ["complete"] });
    }
    // The inlined Multi Review ran on the graph runtime, under namespaced ids.
    for (const id of ["review/plan", "review/package", "review/consolidate", "review/fix"]) {
      expect({ id, states: states(run, id) }).toEqual({ id, states: ["complete"] });
    }
    expect(states(run, "review/review")).toEqual(["complete", "complete"]);
    expect(only(run, "review/has-findings").outlet).toBe("findings");
    expect(only(run, "review/fix-complete").outlet).toBe("complete");
    // autoPr is bound off: the child's own pull request nodes were skipped.
    expect(states(run, "review/describe-pr")).toEqual(["skipped"]);
    expect(states(run, "review/pr")).toEqual(["skipped"]);
    expect(only(run, "review/plan").key).toBe("review/plan#iter=1#attempt=1");

    // Wiring through the sub-graph's ports: build's commit in, the Fix's commit out.
    const build = only(run, "build");
    expect(only(run, "review/plan").inputs.code).toBe(build.outputs.code);
    const fixed = only(run, "review/fix").outputs.code;
    expect(only(run, "describe-pr").inputs.code).toBe(fixed);
    expect(only(run, "pr").inputs.code).toBe(fixed);
    expect(run.status === "complete" && only(run, "pr").outputs.pr).toBeDefined();

    // Child roles ran on the parent's bindings: reviewers on the reviewer
    // panel, the Fix on the builder.
    const agentStarts = h.world.fakes.callsOf("start").filter((call) => call.kind === "agent");
    const reviewers = agentStarts.filter((call) => call.nodeId === "review/review");
    expect(reviewers.map((call) => call.binding?.model).sort()).toEqual(["model-1", "model-2"]);
    expect(run.bindings.roles.builder).toBeDefined();
    expect(agentStarts.find((call) => call.nodeId === "review/fix")?.binding).toEqual({
      platform: "claude",
      model: "model",
    });
    // The frozen plan keeps where the inlined nodes came from.
    expect(run.plan.subgraphs![0]!).toMatchObject({
      id: "review",
      template: { scope: "builtin", id: "multi-review", engine: "multi-review" },
      params: { autoFix: { param: "autoFix" }, autoPr: { value: false } },
    });
  });

  test("a clean review ships the reviewed branch through the sub-graph's clean output", async () => {
    const h = await harness();
    scriptReport(h, false);
    const run = await finish(h, (await launch(h)).id);
    expect(run.status).toBe("complete");
    expect(only(run, "review/has-findings").outlet).toBe("clean");
    expect(states(run, "review/fix")).toEqual(["skipped"]);
    const reviewed = only(run, "review/plan").outputs.code;
    expect(only(run, "pr").inputs.code).toBe(reviewed);
    expect(states(run, "pr")).toEqual(["complete"]);
  });

  test("the parent's autoFix parameter passes through to the inlined Fix", async () => {
    const h = await harness();
    scriptReport(h, true);
    const run = await finish(h, (await launch(h, { autoFix: false })).id);
    expect(run.bindings.params.autoFix).toBe(false);
    // The review ends with findings and no Fix, so there is no pull request (an optional output).
    expect(run.status).toBe("complete");
    expect(only(run, "review/has-findings").outlet).toBe("findings");
    // The Fix's `when: params.autoFix` read the parent's value through the sub-graph scope.
    expect(states(run, "review/fix")).toEqual(["skipped"]);
    expect(states(run, "pr")).toEqual(["skipped"]);
    expect(h.world.fakes.callsOf("start").some((call) => call.nodeId === "review/fix")).toBe(false);
  });
});
