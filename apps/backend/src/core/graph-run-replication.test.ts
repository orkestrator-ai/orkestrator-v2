/**
 * Replication and collection end to end (item 205): panels, lenses and their
 * product, every collect policy (with failure markers and the cancellation
 * `first` makes), retries that keep their branch key, and zip edges, through
 * real scheduler passes with the real merge executor and scripted
 * pass-through agents. Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  graphArtifactItemIds,
  type GraphRun,
  type GraphRunBindings,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type {
  GraphAgentNode,
  GraphCollectPolicy,
  GraphNodeSpec,
  GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import { GRAPH_SURPLUS_BRANCH_ERROR } from "./graph-run-executors.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
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

const EPOCH = Date.parse("2026-10-29T09:00:00.000Z");

/** Real merges; pass-through agents. Record timestamps follow the manual clock. */
async function harness(): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.skipKinds.add("merge");
  const time = new ManualTime(EPOCH);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    clock: () => new Date(time.now()),
  });
  service.executors.register(createGraphMergeExecutor());
  await service.init();
  return { world, service, time };
}

async function launch(
  h: Harness,
  plan: CompiledGraphPlan,
  options: { panel?: number; roles?: GraphRunBindings["roles"] } = {},
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
    roles: options.roles ?? bindAllRoles(plan, options.panel ?? 3, ["claude", "codex"]),
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [input.name, graphTypeExample(plan, input.type)]),
    ),
  });
}

/** One pass, one observation period after the last. */
async function pass(h: Harness, runId: string): Promise<GraphRun> {
  h.time.jump(3_000);
  const run = await h.service.advanceNow(runId);
  if (!run) throw new Error("the run disappeared");
  return run;
}

/** Passes until `done` holds (default: the run is terminal). */
async function until(
  h: Harness,
  runId: string,
  done: (run: GraphRun) => boolean = (run) =>
    run.status === "complete" || run.status === "failed" || run.status === "cancelled",
  passes = 60,
): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    const run = await pass(h, runId);
    if (done(run)) return run;
  }
  throw new Error("the condition never held");
}

function latest(run: GraphRun, nodeId: string, branchKey?: string): NodeActivation {
  const found = run.activations
    .filter((activation) => activation.nodeId === nodeId && activation.branchKey === branchKey)
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no activation of ${nodeId} ${branchKey ?? ""}`);
  return found;
}

/** The report a branch delivered. */
function reportOf(run: GraphRun, nodeId: string, branchKey: string): string {
  const id = latest(run, nodeId, branchKey).outputs.report;
  if (id === undefined) throw new Error(`${nodeId} ${branchKey} delivered no report`);
  return id;
}

const hasNode = (nodeId: string) => (run: GraphRun) =>
  run.activations.some((activation) => activation.nodeId === nodeId);

async function artifact(h: Harness, run: GraphRun, id: string) {
  const stored = await h.world.storage.graphRuns.getGraphArtifact(run.id, id);
  if (!stored) throw new Error(`no artifact ${id}`);
  return stored;
}

// ---------------------------------------------------------------- templates

type PortSpec = { name: string; type: string } & Record<string, unknown>;

const CODE = { name: "code", type: "workspace@1" };
const REPORT = { name: "report", type: "review-report@1" };
const REPORTS = { name: "reports", type: "list<review-report@1>" };

function agent(
  id: string,
  role: string,
  access: "read" | "none",
  inputs: PortSpec[],
  outputs: PortSpec[],
  extra: Partial<GraphAgentNode> = {},
): GraphNodeSpec {
  return {
    id,
    kind: "agent",
    role,
    capabilities: { profile: access === "read" ? "reviewer" : "observer" },
    workspaceAccess: access,
    prompt: {
      template: `Do ${id}.\n\n${inputs.map((input) => `{{> input.${input.name}}}`).join("\n\n")}\n`,
    },
    inputs: inputs as GraphAgentNode["inputs"],
    outputs: outputs as GraphAgentNode["outputs"],
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
    roles: [
      { key: "worker", multiplicity: "one" },
      { key: "panel", multiplicity: "panel", maxPanel: 4 },
    ],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs,
    workspace: { kind: "environment" },
    nodes,
    edges,
    limits: { maxAgentSessions: 60, maxConcurrentAgents: 8 },
    ...extra,
  } as GraphTemplateV1;
}

/** A panel review collected by `consolidate` under `collect`. */
function panelTemplate(
  options: {
    collect?: GraphCollectPolicy;
    review?: Partial<GraphAgentNode>;
    /** A second reader of the panel that waits for every branch. */
    tally?: boolean;
    maxConcurrentAgents?: number;
  } = {},
): GraphTemplateV1 {
  const nodes = [
    agent("review", "panel", "read", [CODE], [REPORT], {
      replicate: { over: "panel", role: "panel" },
      ...options.review,
    }),
    agent(
      "consolidate",
      "worker",
      "none",
      [{ ...REPORTS, ...(options.collect ? { collect: options.collect } : {}) }],
      [REPORT],
    ),
    ...(options.tally ? [agent("tally", "worker", "none", [REPORTS], [REPORT])] : []),
  ];
  const edges = [
    edge("target-review", { input: "target" }, ["review", "code"]),
    edge("review-consolidate", { node: "review", port: "report" }, ["consolidate", "reports"]),
    ...(options.tally
      ? [edge("review-tally", { node: "review", port: "report" }, ["tally", "reports"])]
      : []),
  ];
  return template(
    "panel",
    nodes,
    edges,
    [{ name: "report", type: "review-report@1", from: { node: "consolidate", port: "report" } }],
    { limits: { maxAgentSessions: 60, maxConcurrentAgents: options.maxConcurrentAgents ?? 8 } },
  );
}

const ISSUE_ITEMS = graphBuiltInType("review-report@1")!.items;

// ---------------------------------------------------------------- tests

describe("collect policies (report §4.4)", () => {
  test("all-settled collects every branch in branch order, failed ones as error@1 markers", async () => {
    const h = await harness();
    h.world.fakes.failBranches.set("review/panel.2", ["provider-error"]);
    const run = await launch(h, compiledPlan(panelTemplate()));
    const done = await until(h, run.id);
    expect(done.status).toBe("complete");
    const failed = latest(done, "review", "panel.2");
    expect(failed.state).toBe("failed");
    const marker = failed.outputs.error!;
    expect(marker).toBeDefined();
    expect(latest(done, "consolidate").inputs.reports).toEqual([
      reportOf(done, "review", "panel.1"),
      marker,
      reportOf(done, "review", "panel.3"),
    ]);
    const stored = await artifact(h, done, marker);
    expect(stored.type).toBe("error@1");
    expect(stored.producer).toEqual({ nodeId: "review", activation: failed.key, port: "error" });
    expect("value" in stored.body && stored.body.value).toMatchObject({
      node: "review",
      cause: "provider-error",
      code: "provider_error",
      retryable: true,
    });
  });

  test("without includeFailures a failed branch is left out and no marker is stored", async () => {
    const h = await harness();
    h.world.fakes.failBranches.set("review/panel.2", ["provider-error"]);
    const plan = compiledPlan(
      panelTemplate({
        collect: { wait: "all-settled", minSuccessful: 1, includeFailures: false },
      }),
    );
    const done = await until(h, (await launch(h, plan)).id);
    expect(done.status).toBe("complete");
    expect(latest(done, "review", "panel.2").outputs).toEqual({});
    expect(latest(done, "consolidate").inputs.reports).toEqual([
      reportOf(done, "review", "panel.1"),
      reportOf(done, "review", "panel.3"),
    ]);
  });

  test("quorum delivers at `count` successes while the other branches keep running", async () => {
    const h = await harness();
    h.world.fakes.heldBranches.add("review/panel.3");
    const plan = compiledPlan(
      panelTemplate({
        collect: { wait: "quorum", count: 2, minSuccessful: 2, includeFailures: false },
      }),
    );
    const run = await launch(h, plan);
    const started = await until(h, run.id, hasNode("consolidate"));
    expect(latest(started, "consolidate").inputs.reports).toEqual([
      reportOf(started, "review", "panel.1"),
      reportOf(started, "review", "panel.2"),
    ]);
    expect(latest(started, "review", "panel.3").state).toBe("running");
    h.world.fakes.heldBranches.clear();
    const done = await until(h, run.id);
    expect(done.status).toBe("complete");
    // Quorum never cancels: the slow branch finished on its own.
    expect(latest(done, "review", "panel.3").state).toBe("complete");
    expect(h.world.fakes.callsOf("cancel")).toEqual([]);
  });

  test("first takes the earliest finisher and cancels the remaining branches", async () => {
    const h = await harness();
    // panel.1 is held, so panel.2 finishes first; panel.3 never gets admitted.
    h.world.fakes.heldBranches.add("review/panel.1");
    const plan = compiledPlan(
      panelTemplate({
        collect: { wait: "first", count: 1, minSuccessful: 1, includeFailures: true },
        maxConcurrentAgents: 2,
      }),
    );
    const run = await launch(h, plan);
    const done = await until(h, run.id);
    expect(done.status).toBe("complete");
    expect(latest(done, "consolidate").inputs.reports).toEqual([
      reportOf(done, "review", "panel.2"),
    ]);
    // The admitted, still running branch is stopped through its executor.
    const one = latest(done, "review", "panel.1");
    expect(one.state).toBe("cancelled");
    expect(
      h.world.fakes.callsOf("cancel", "review").map((call) => [call.key, call.reason]),
    ).toEqual([[one.key, "surplus"]]);
    // The one never admitted is settled without a start.
    const three = latest(done, "review", "panel.3");
    expect(three.state).toBe("cancelled");
    expect(three.error).toBe(GRAPH_SURPLUS_BRANCH_ERROR);
    expect(h.world.fakes.callsOf("start", "review").map((call) => call.key)).not.toContain(
      three.key,
    );
  });

  test("first keeps branches that another reader still waits for", async () => {
    const h = await harness();
    h.world.fakes.heldBranches.add("review/panel.2");
    h.world.fakes.heldBranches.add("review/panel.3");
    const plan = compiledPlan(
      panelTemplate({
        collect: { wait: "first", count: 1, minSuccessful: 1, includeFailures: true },
        tally: true,
      }),
    );
    const run = await launch(h, plan);
    const started = await until(h, run.id, hasNode("consolidate"));
    expect(latest(started, "consolidate").inputs.reports).toEqual([
      reportOf(started, "review", "panel.1"),
    ]);
    // `tally` collects every branch, so nothing is surplus.
    await pass(h, run.id);
    expect(h.world.fakes.callsOf("cancel")).toEqual([]);
    h.world.fakes.heldBranches.clear();
    const done = await until(h, run.id);
    expect(done.status).toBe("complete");
    expect(latest(done, "tally").inputs.reports).toHaveLength(3);
  });

  test("fewer successes than minSuccessful fail the port as soon as the bound is out of reach", async () => {
    const h = await harness();
    h.world.fakes.failBranches.set("review/panel.1", ["provider-error"]);
    h.world.fakes.failBranches.set("review/panel.2", ["invalid-result"]);
    h.world.fakes.heldBranches.add("review/panel.3");
    const plan = compiledPlan(
      panelTemplate({
        collect: { wait: "quorum", count: 2, minSuccessful: 2, includeFailures: true },
      }),
    );
    const done = await until(h, (await launch(h, plan)).id);
    expect(done.status).toBe("failed");
    const consolidate = latest(done, "consolidate");
    expect(consolidate.state).toBe("failed");
    expect(consolidate.error).toContain("0 of 3 branches succeeded; at least 2 are required");
    expect(done.error).toContain("Node consolidate failed");
  });
});

describe("branch keys", () => {
  test("retrying one branch keeps its key, and the other branches keep their results", async () => {
    const h = await harness();
    h.world.fakes.failBranches.set("review/panel.2", ["provider-error"]);
    const plan = compiledPlan(
      panelTemplate({ review: { retry: { attempts: 2, on: ["provider-error"] } } }),
    );
    const done = await until(h, (await launch(h, plan)).id);
    expect(done.status).toBe("complete");
    const review = done.activations.filter((activation) => activation.nodeId === "review");
    expect(review.map((activation) => [activation.key, activation.state])).toEqual([
      ["review#iter=1#branch=panel.1#attempt=1", "complete"],
      ["review#iter=1#branch=panel.2#attempt=1", "failed"],
      ["review#iter=1#branch=panel.3#attempt=1", "complete"],
      ["review#iter=1#branch=panel.2#attempt=2", "complete"],
    ]);
    // Each other branch started once; its result is the one consolidate got.
    const starts = h.world.fakes.callsOf("start", "review").map((call) => call.key);
    expect(starts.filter((key) => key.includes("panel.1"))).toHaveLength(1);
    expect(starts.filter((key) => key.includes("panel.3"))).toHaveLength(1);
    const retried = latest(done, "review", "panel.2");
    expect(latest(done, "consolidate").inputs.reports).toEqual([
      reportOf(done, "review", "panel.1"),
      reportOf(done, "review", "panel.2"),
      reportOf(done, "review", "panel.3"),
    ]);
    // The retry's items keep the branch's ids.
    const report = await artifact(h, done, retried.outputs.report!);
    expect(report.producer.activation).toBe("review#iter=1#branch=panel.2#attempt=2");
    expect(
      graphArtifactItemIds(report, ISSUE_ITEMS, {
        value: "value" in report.body ? report.body.value : undefined,
      }),
    ).toEqual(["review/panel.2/issue-1"]);
  });

  test("panel × lenses runs the cross product, each branch on its panel model", async () => {
    const h = await harness();
    const lenses = ["security", "performance", "api"].map((key) => ({
      key,
      label: key,
      instruction: `Look at ${key}.`,
    }));
    const base = panelTemplate({
      review: {
        replicate: {
          over: "cross",
          axes: [
            { over: "panel", role: "panel" },
            { over: "lenses", lenses },
          ],
        },
      },
    });
    base.roles = [
      { key: "worker", multiplicity: "one" },
      { key: "panel", multiplicity: "panel", maxPanel: 2 },
    ];
    const plan = compiledPlan(base);
    expect(plan.nodes.find((node) => node.id === "review")?.fanOut).toEqual({ min: 3, max: 6 });
    const done = await until(h, (await launch(h, plan, { panel: 2 })).id);
    expect(done.status).toBe("complete");
    const keys = [1, 2].flatMap((panel) => lenses.map((lens) => `panel.${panel}+lens.${lens.key}`));
    expect(
      done.activations
        .filter((activation) => activation.nodeId === "review")
        .map((activation) => activation.branchKey),
    ).toEqual(keys);
    const models = Object.fromEntries(
      h.world.fakes
        .callsOf("start", "review")
        .map((call) => [call.key.split("#")[2]!.slice("branch=".length), call.binding]),
    );
    for (const key of keys) {
      expect(models[key]).toEqual(
        key.startsWith("panel.1")
          ? { platform: "claude", model: "model-1" }
          : { platform: "codex", model: "model-2" },
      );
    }
    expect(latest(done, "consolidate").inputs.reports).toHaveLength(6);
  });

  test("samples run the same prompt N times on the node's model", async () => {
    const h = await harness();
    const plan = compiledPlan(
      panelTemplate({ review: { role: "worker", replicate: { over: "samples", count: 3 } } }),
    );
    const done = await until(h, (await launch(h, plan)).id);
    expect(done.status).toBe("complete");
    const starts = h.world.fakes.callsOf("start", "review");
    expect(starts.map((call) => call.key)).toEqual(
      [1, 2, 3].map((sample) => `review#iter=1#branch=sample.${sample}#attempt=1`),
    );
    expect(new Set(starts.map((call) => JSON.stringify(call.binding)))).toEqual(
      new Set([JSON.stringify({ platform: "claude", model: "model" })]),
    );
    expect(latest(done, "consolidate").inputs.reports).toHaveLength(3);
  });

  test("a lens with its own role runs on that role's model", async () => {
    const h = await harness();
    const base = panelTemplate({
      review: {
        role: "worker",
        replicate: {
          over: "lenses",
          lenses: [
            { key: "a", label: "A", instruction: "Look at A.", role: "critic" },
            { key: "b", label: "B", instruction: "Look at B." },
          ],
        },
      },
    });
    base.roles = [
      { key: "worker", multiplicity: "one" },
      { key: "critic", multiplicity: "one" },
    ];
    const plan = compiledPlan(base);
    const done = await until(
      h,
      (
        await launch(h, plan, {
          roles: {
            worker: { platform: "claude", model: "worker-model" },
            critic: { platform: "codex", model: "critic-model" },
          },
        })
      ).id,
    );
    expect(done.status).toBe("complete");
    const bindings = Object.fromEntries(
      h.world.fakes.callsOf("start", "review").map((call) => [call.key, call.binding]),
    );
    expect(bindings).toEqual({
      "review#iter=1#branch=lens.a#attempt=1": { platform: "codex", model: "critic-model" },
      "review#iter=1#branch=lens.b#attempt=1": { platform: "claude", model: "worker-model" },
    });
  });
});

describe("zip edges (report §5.8)", () => {
  /** review (panel) → zip → recheck (panel) → consolidate (fan-in). */
  function zipTemplate(): GraphTemplateV1 {
    return template(
      "zip",
      [
        agent("review", "panel", "read", [CODE], [REPORT], {
          replicate: { over: "panel", role: "panel" },
        }),
        agent("recheck", "panel", "none", [{ name: "report", type: "review-report@1" }], [REPORT], {
          replicate: { over: "panel", role: "panel" },
        }),
        agent("consolidate", "worker", "none", [REPORTS], [REPORT]),
      ],
      [
        edge("target-review", { input: "target" }, ["review", "code"]),
        edge("review-recheck", { node: "review", port: "report" }, ["recheck", "report"], {
          zip: true,
        }),
        edge("recheck-consolidate", { node: "recheck", port: "report" }, [
          "consolidate",
          "reports",
        ]),
      ],
      [{ name: "report", type: "review-report@1", from: { node: "consolidate", port: "report" } }],
    );
  }

  test("branch k feeds branch k, on the same model, and a failed branch skips its partner", async () => {
    const h = await harness();
    h.world.fakes.failBranches.set("review/panel.2", ["provider-error"]);
    const plan = compiledPlan(zipTemplate());
    expect(plan.edges.find((entry) => entry.id === "review-recheck")).toMatchObject({
      zip: true,
      fanIn: false,
    });
    const done = await until(h, (await launch(h, plan)).id);
    expect(done.status).toBe("complete");
    for (const branch of ["panel.1", "panel.3"]) {
      expect(latest(done, "recheck", branch).inputs).toEqual({
        report: reportOf(done, "review", branch),
      });
    }
    // No fan-in between: recheck panel.2 has nothing to read and skips.
    expect(latest(done, "recheck", "panel.2").state).toBe("skipped");
    const binding = (nodeId: string, branch: string) =>
      h.world.fakes.callsOf("start", nodeId).find((call) => call.key.includes(`branch=${branch}#`))
        ?.binding;
    expect(binding("recheck", "panel.3")).toEqual(binding("review", "panel.3"));
    expect(binding("recheck", "panel.3")).toEqual({ platform: "claude", model: "model-3" });
    // The skipped partner is no failure: only the two rechecks are collected.
    expect(latest(done, "consolidate").inputs.reports).toEqual([
      reportOf(done, "recheck", "panel.1"),
      reportOf(done, "recheck", "panel.3"),
    ]);
  });
});
