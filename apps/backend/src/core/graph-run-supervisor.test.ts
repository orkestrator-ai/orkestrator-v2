import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  bindAllRoles,
  compiledPlan,
  fakeResultKey,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { GraphRunServiceError, type GraphRunService } from "./graph-run-service.js";
import {
  GraphRunResultKeys,
  discoverGraphRuns,
  graphRunObligation,
} from "./graph-run-supervisor.js";
import { ManualTime, advanceKeyedWork, settleKeyedWork } from "./recurring-test-support.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  KEYED_SCHEDULING_DOMAINS,
  KEYED_SCHEDULING_ROLLBACK_ENV,
  keyedSchedulingEnabled,
} from "./workflow-supervisor.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

/** One read-only agent node; `held` keeps it running until released. */
function reviewTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "review-only",
    revision: 1,
    name: "Review only",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "review", port: "report" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "review",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Review.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      { id: "target-review", from: { input: "target" }, to: { node: "review", port: "code" } },
    ],
    limits: { maxAgentSessions: 4, maxConcurrentAgents: 1 },
  };
}

const plan = compiledPlan(reviewTemplate());

interface Keyed {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

async function keyed(world?: GraphRunWorld, time = new ManualTime(0)): Promise<Keyed> {
  const created = world ?? (await graphRunWorld());
  if (!world) worlds.push(created);
  const service = created.service({
    keyedScheduling: true,
    discoveryIntervalMs: 30_000,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  await service.init();
  return { world: created, service, time };
}

function launchInput(planned: CompiledGraphPlan = plan) {
  return {
    projectId: "p1",
    environmentId: "e1",
    template: { id: planned.template.id, revision: 1, digest: planned.templateDigest },
    plan: planned,
    roles: bindAllRoles(planned),
    inputs: { target: graphTypeExample(planned, "workspace@1") },
  };
}

function reviewState(run: GraphRun | null): string | undefined {
  return run?.activations.find((activation) => activation.nodeId === "review")?.state;
}

function runRecord(overrides: Partial<GraphRun> = {}): GraphRun {
  const at = "2026-10-29T00:00:00.000Z";
  return {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
    id: "run-x",
    projectId: "p1",
    environmentId: "e1",
    template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
    plan,
    bindings: { roles: bindAllRoles(plan), params: {}, inputs: {} },
    status: "running",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: {},
    usage: { agentSessions: 0, tokens: 0 },
    revision: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function activation(
  state: NodeActivation["state"],
  extra: Partial<NodeActivation> = {},
): NodeActivation {
  return {
    key: "review#iter=1#attempt=1",
    nodeId: "review",
    iteration: 1,
    attempt: 1,
    state,
    inputs: {},
    outputs: {},
    createdAt: "2026-10-29T00:00:00.000Z",
    ...extra,
  };
}

/**
 * Stores a run whose `review` activation is already admitted, as a process
 * that crashed or stopped would have left it. With `session`, the activation
 * records the fake agent's result keys (and the policy it ran under).
 */
async function seedRun(
  world: GraphRunWorld,
  id: string,
  state: "admitting" | "running",
  options: { session?: boolean } = {},
): Promise<GraphRun> {
  await world.storage.graphRuns.createGraphRun(runRecord({ id }));
  const input = await world.artifacts.putValue({
    runId: id,
    type: "workspace@1",
    producer: { nodeId: "$input", activation: "$input", port: "target" },
    value: graphTypeExample(plan, "workspace@1"),
  });
  const node = plan.nodes[0]!;
  const key = "review#iter=1#attempt=1";
  const admitted = activation(state, {
    inputs: { code: input.id },
    ...(state === "running" ? { startedAt: "2026-10-29T00:00:00.000Z" } : {}),
    ...(options.session && node.kind === "agent"
      ? {
          policy: node.capabilities.policy,
          enforcement: "enforced" as const,
          session: {
            agent: "claude" as const,
            requestId: `request-${id}`,
            dispatchState: "sent" as const,
            resultTransport: "tool-call-v1",
            resultKeys: { report: `${fakeResultKey(id, key)}-report` },
          },
        }
      : {}),
  });
  const stored = (await world.storage.graphRuns.getGraphRun(id))!;
  return world.storage.graphRuns.saveGraphRun(
    {
      ...stored,
      bindings: { ...stored.bindings, inputs: { target: input.id } },
      activations: [admitted],
      usage: { agentSessions: 1, tokens: 0 },
    },
    stored.revision,
  );
}

describe("graph-run obligations", () => {
  test("classify every status and activation mix; terminal runs owe nothing", () => {
    expect(
      graphRunObligation(runRecord({ status: "provisioning", environmentId: undefined })),
    ).toBe("provision");
    expect(graphRunObligation(runRecord({ status: "cancelling" }))).toBe("cancel");
    expect(graphRunObligation(runRecord())).toBe("advance");
    expect(graphRunObligation(runRecord({ activations: [activation("ready")] }))).toBe("advance");
    expect(graphRunObligation(runRecord({ activations: [activation("admitting")] }))).toBe(
      "observe",
    );
    expect(graphRunObligation(runRecord({ activations: [activation("running")] }))).toBe("observe");
    expect(
      graphRunObligation(
        runRecord({ status: "waiting", activations: [activation("awaiting-human")] }),
      ),
    ).toBe("await-human");
    // Paused: nothing owed unless something admitted still runs.
    expect(
      graphRunObligation(runRecord({ status: "paused", activations: [activation("ready")] })),
    ).toBe(null);
    expect(
      graphRunObligation(runRecord({ status: "paused", activations: [activation("running")] })),
    ).toBe("observe");
    for (const status of ["complete", "failed", "cancelled"] as const) {
      expect(graphRunObligation(runRecord({ status, activations: [activation("running")] }))).toBe(
        null,
      );
    }
  });

  test("discovery lists the owed runs with their environment as the target", async () => {
    const runs = [
      runRecord({ id: "a" }),
      runRecord({ id: "b", status: "complete" }),
      runRecord({ id: "c", activations: [activation("running")], environmentId: "e2" }),
    ];
    const seen: string[] = [];
    const result = await discoverGraphRuns({ listAllGraphRuns: async () => runs }, (run) =>
      seen.push(run.id),
    );
    expect(result).toEqual({
      entries: [
        { key: "a", obligation: "advance", target: "e1" },
        { key: "c", obligation: "observe", target: "e2" },
      ],
      scanned: 3,
      complete: true,
    });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("result keys map to their admitted activation only", () => {
    const keys = new GraphRunResultKeys();
    const session = {
      agent: "claude" as const,
      requestId: "r",
      dispatchState: "sent" as const,
      resultTransport: "tool-call-v1",
      resultKeys: { report: "rk-1" },
    };
    const running = runRecord({ id: "a", activations: [activation("running", { session })] });
    keys.note(running);
    expect(keys.owner("rk-1")).toEqual({ runId: "a", activationKey: "review#iter=1#attempt=1" });
    keys.note({ ...running, activations: [activation("complete", { session })] });
    expect(keys.owner("rk-1")).toBeUndefined();
    expect(keys.size()).toBe(0);
  });
});

describe("the graph-run keyed domain", () => {
  test("is a keyed domain the rollback switch can disable", async () => {
    expect(KEYED_SCHEDULING_DOMAINS).toContain("graph-run");
    expect(keyedSchedulingEnabled("graph-run", {})).toBe(true);
    const env = { [KEYED_SCHEDULING_ROLLBACK_ENV]: "build-pipeline, graph-run" };
    expect(keyedSchedulingEnabled("graph-run", env)).toBe(false);
    expect(keyedSchedulingEnabled("graph-run", { [KEYED_SCHEDULING_ROLLBACK_ENV]: "all" })).toBe(
      false,
    );
    // Rolled back: no driver, no launches; a stored run can still be read and cancelled.
    const world = await graphRunWorld();
    worlds.push(world);
    const time = new ManualTime(0);
    const enabled = world.service({
      keyedScheduling: true,
      schedulerClock: { now: time.now, timers: time.timerFactory },
    });
    await enabled.init();
    const run = await enabled.create(launchInput());
    await enabled.shutdown();
    const disabled = world.service({
      keyedScheduling: keyedSchedulingEnabled("graph-run", env),
      schedulerClock: { now: time.now, timers: time.timerFactory },
    });
    await disabled.init();
    expect(disabled.enabled).toBe(false);
    expect(disabled.schedulingStatus()).toBeNull();
    const refused = await disabled.create(launchInput()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GraphRunServiceError);
    expect((refused as GraphRunServiceError).code).toBe("disabled");
    await advanceKeyedWork(time, [disabled], 60_000, 5_000);
    expect(reviewState(await disabled.get(run.id))).toBeUndefined();
    expect((await disabled.cancel(run.id)).status).toBe("cancelling");
    expect((await disabled.get(run.id))?.status).toBe("cancelled");
  });

  test("discovery registers a run whose wakeup was lost", async () => {
    const { world, service, time } = await keyed();
    await settleKeyedWork(time, [service]);
    // Another process (or a crash between its commit and its wake) admitted
    // an activation; nothing woke this one.
    await seedRun(world, "lost-run", "admitting");
    await advanceKeyedWork(time, [service], 29_000, 1_000);
    expect(world.fakes.callsOf("recover")).toHaveLength(0);
    await advanceKeyedWork(time, [service], 1_000, 1_000);
    expect(service.schedulingStatus()?.recoveredByDiscovery).toBe(1);
    expect(world.fakes.callsOf("recover")).toHaveLength(1);
    await advanceKeyedWork(time, [service], 8_000, 1_000);
    expect(reviewState(await world.storage.graphRuns.getGraphRun("lost-run"))).toBe("complete");
  });

  test("an accepted result wakes only the run that owns its slot", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    world.fakes.held.add("review");
    const first = await seedRun(world, "run-a", "running", { session: true });
    const second = await seedRun(world, "run-b", "running", { session: true });
    const { service, time } = await keyed(world);
    await settleKeyedWork(time, [service]);
    const key = first.activations[0]!.key;
    expect(second.activations[0]!.key).toBe(key);
    expect(first.activations[0]!.session?.resultKeys).toEqual({
      report: `${fakeResultKey(first.id, key)}-report`,
    });
    const observed = (runId: string) =>
      world.fakes.calls.filter((call) => call.operation === "observe" && call.runId === runId)
        .length;
    const before = { first: observed(first.id), second: observed(second.id) };
    const wakesBefore = service.schedulingStatus()?.wakes["result-accepted"] ?? 0;
    // No time passes: only a wake can cause a pass.
    service.resultAccepted({
      resultKey: `${fakeResultKey(first.id, key)}-report`,
      environmentId: "e1",
    });
    // An environment-wide result wake is not how graph runs are reached.
    service.wakeEnvironment("e1", "result-accepted");
    await settleKeyedWork(time, [service]);
    expect(observed(first.id)).toBe(before.first + 1);
    expect(observed(second.id)).toBe(before.second);
    expect(service.schedulingStatus()?.wakes["result-accepted"]).toBe(wakesBefore + 1);
    // A slot no graph run owns wakes nothing.
    service.resultAccepted({ resultKey: "rk-unrelated-report", environmentId: "e1" });
    await settleKeyedWork(time, [service]);
    expect(service.schedulingStatus()?.wakes["result-accepted"]).toBe(wakesBefore + 1);
  });

  test("a slot this process has not indexed is found in the environment's runs", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    world.fakes.held.add("review");
    const first = await seedRun(world, "run-a", "running", { session: true });
    const second = await seedRun(world, "run-b", "running", { session: true });
    const { service, time } = await keyed(world);
    await settleKeyedWork(time, [service]);
    const observed = (runId: string) =>
      world.fakes.calls.filter((call) => call.operation === "observe" && call.runId === runId)
        .length;
    const before = { first: observed(first.id), second: observed(second.id) };
    // As if another process recorded the slot after this one's last read.
    (service as unknown as { resultKeys: GraphRunResultKeys }).resultKeys.forget(first.id);
    const wakes = service.schedulingStatus()?.wakes["result-accepted"] ?? 0;
    service.resultAccepted({
      resultKey: `${fakeResultKey(first.id, first.activations[0]!.key)}-report`,
      environmentId: "e1",
    });
    await settleKeyedWork(time, [service]);
    expect(service.schedulingStatus()?.wakes["result-accepted"]).toBe(wakes + 1);
    expect(observed(first.id)).toBe(before.first + 1);
    expect(observed(second.id)).toBe(before.second);
  });

  test("runs advance after a backend restart without a renderer", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    world.fakes.held.add("review");
    const run = await seedRun(world, "run-a", "running", { session: true });
    const time = new ManualTime(0);
    const before = await keyed(world, time);
    await advanceKeyedWork(time, [before.service], 1_000, 250);
    expect(world.fakes.callsOf("recover")).toHaveLength(1);
    // The backend stops with the activation admitted; nothing else touches the run.
    await before.service.shutdown();
    world.fakes.held.delete("review");
    recurringWorkMetrics.reset();
    const after = await keyed(world, time);
    await advanceKeyedWork(time, [after.service], 5_000, 500);
    // The new process recovered the admitted activation once more, through its
    // executor, and never started it again.
    expect(world.fakes.callsOf("recover")).toHaveLength(2);
    expect(world.fakes.callsOf("start")).toHaveLength(0);
    expect(reviewState(await after.service.get(run.id))).toBe("complete");
    expect(recurringWorkMetrics.snapshot().kinds["graph-run-tick"]?.started).toBeGreaterThan(0);
  });

  test("a deleted run's key is forgotten", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    world.fakes.held.add("review");
    const run = await seedRun(world, "run-a", "running");
    const { service, time } = await keyed(world);
    await advanceKeyedWork(time, [service], 1_000, 250);
    expect(service.schedulingStatus()?.keys).toBe(1);
    await world.storage.graphRuns.deleteGraphRunsByEnvironment("e1");
    await settleKeyedWork(time, [service]);
    expect(service.schedulingStatus()?.keys).toBe(0);
    expect(await service.get(run.id)).toBeNull();
  });
});
