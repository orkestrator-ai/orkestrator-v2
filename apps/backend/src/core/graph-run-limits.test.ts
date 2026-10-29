/**
 * `limits.maxTokens` (a soft meter over `usage.tokens`) and
 * `limits.maxWallClockMs` (a deadline after `startedAt`), enforced by the
 * pass and admission (`graph-run-pass.ts`, `graph-run-scheduling.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import {
  graphRunMeterError,
  graphRunTokensExhausted,
  graphRunWallClockDeadline,
  graphRunWallClockExceeded,
  selectGraphAdmissions,
} from "./graph-run-scheduling.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime, advanceKeyedWork } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const BASE = Date.parse("2026-10-29T00:00:00.000Z");

function reader(id: string) {
  return {
    id,
    kind: "agent" as const,
    role: "worker",
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read" as const,
    prompt: { template: `Review ${id}.\n\n{{> input.code}}\n` },
    inputs: [{ name: "code", type: "workspace@1" }],
    outputs: [{ name: "report", type: "review-report@1" }],
  };
}

function template(
  nodes: unknown[],
  edges: unknown[],
  outputs: unknown[],
  limits: Partial<GraphTemplateV1["limits"]>,
): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "limited",
    revision: 1,
    name: "Limited",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs,
    workspace: { kind: "environment" },
    nodes,
    edges,
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4, ...limits },
  } as GraphTemplateV1;
}

/** `a` and `b` read the target in parallel; `c` reads `a`'s report. */
function meteredTemplate(limits: Partial<GraphTemplateV1["limits"]>): GraphTemplateV1 {
  const c = {
    ...reader("c"),
    prompt: { template: "Follow up.\n\n{{> input.prior}}\n" },
    inputs: [{ name: "prior", type: "review-report@1" }],
  };
  return template(
    [reader("a"), reader("b"), c],
    [
      { id: "t-a", from: { input: "target" }, to: { node: "a", port: "code" } },
      { id: "t-b", from: { input: "target" }, to: { node: "b", port: "code" } },
      { id: "a-c", from: { node: "a", port: "report" }, to: { node: "c", port: "prior" } },
    ],
    [
      { name: "b", type: "review-report@1", from: { node: "b", port: "report" } },
      { name: "c", type: "review-report@1", from: { node: "c", port: "report" } },
    ],
    limits,
  );
}

function soloTemplate(limits: Partial<GraphTemplateV1["limits"]>): GraphTemplateV1 {
  return template(
    [reader("solo")],
    [{ id: "t-solo", from: { input: "target" }, to: { node: "solo", port: "code" } }],
    [{ name: "out", type: "review-report@1", from: { node: "solo", port: "report" } }],
    limits,
  );
}

/** One human approval of the run's brief. */
function humanTemplate(limits: Partial<GraphTemplateV1["limits"]>): GraphTemplateV1 {
  return {
    ...template(
      [
        {
          id: "approve",
          kind: "human",
          form: { kind: "approve" },
          inputs: [{ name: "brief", type: "text@1" }],
        },
      ],
      [{ id: "brief", from: { input: "brief" }, to: { node: "approve", port: "brief" } }],
      [],
      limits,
    ),
    roles: [],
    inputs: [{ name: "brief", type: "text@1" }],
  } as GraphTemplateV1;
}

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
  /** Wall-clock offset from {@link BASE}, moved by the tests. */
  wall: { ms: number };
}

async function harness(options: { keyed?: boolean; mock?: boolean } = {}): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  const time = new ManualTime(0);
  const wall = { ms: 0 };
  const service = world.service({
    ...(options.keyed
      ? { keyedScheduling: true, discoveryIntervalMs: 30_000 }
      : { autoAdvance: false }),
    schedulerClock: { now: time.now, timers: time.timerFactory },
    // Keyed runs follow the manual scheduler clock; explicit passes the offset.
    clock: () => new Date(BASE + (options.keyed ? time.now() : wall.ms)),
  });
  if (options.mock) world.fakes.register(service.executors, { mock: true });
  await service.init();
  return { world, service, time, wall };
}

async function launch(h: Harness, plan: CompiledGraphPlan, mock = false): Promise<GraphRun> {
  const human = plan.inputs.some((input) => input.name === "brief");
  return h.service.create({
    projectId: "p1",
    ...(mock ? { mock: true } : { environmentId: "e1" }),
    template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
    plan,
    roles: bindAllRoles(plan),
    inputs: human
      ? { brief: graphTypeExample(plan, "text@1") }
      : { target: graphTypeExample(plan, "workspace@1") },
  });
}

async function pass(h: Harness, runId: string, advanceMs = 3_000): Promise<GraphRun> {
  h.time.jump(advanceMs);
  h.wall.ms += advanceMs;
  const run = await h.service.advanceNow(runId);
  if (!run) throw new Error("the run disappeared");
  return run;
}

const states = (run: GraphRun, nodeId: string) =>
  run.activations.filter((activation) => activation.nodeId === nodeId).map((a) => a.state);

describe("limits.maxTokens (soft meter)", () => {
  test("the meter reads usage.tokens and ignores mock runs", () => {
    const plan = compiledPlan(soloTemplate({ maxTokens: 1_000 }));
    expect(plan.limits.maxTokens).toBe(1_000);
    const usage = { agentSessions: 1, tokens: 1_000 };
    expect(graphRunTokensExhausted({ plan, usage, mock: false })).toBe(true);
    expect(graphRunTokensExhausted({ plan, usage: { ...usage, tokens: 999 }, mock: false })).toBe(
      false,
    );
    expect(graphRunTokensExhausted({ plan, usage, mock: true })).toBe(false);
    const unlimited = compiledPlan(soloTemplate({}));
    expect(graphRunTokensExhausted({ plan: unlimited, usage, mock: false })).toBe(false);
    expect(graphRunMeterError({ plan, usage }, "tokens")).toContain("limits.maxTokens 1000");
  });

  test("a ready agent waits while agents run, then fails once none does", () => {
    const plan = compiledPlan(meteredTemplate({ maxTokens: 1_000 }));
    const ready = {
      key: "c#iter=1#attempt=1",
      nodeId: "c",
      iteration: 1,
      attempt: 1,
      state: "ready",
      inputs: {},
      outputs: {},
      createdAt: "2026-10-29T00:00:00.000Z",
    };
    const running = { ...ready, key: "b#iter=1#attempt=1", nodeId: "b", state: "running" };
    const run = (activations: unknown[]) =>
      ({
        plan,
        mock: false,
        usage: { agentSessions: 2, tokens: 1_200 },
        activations,
      }) as unknown as GraphRun;
    const options = { others: { writers: 0, readers: 0 }, workspaceKnown: true };
    const busy = selectGraphAdmissions(run([running, ready]), options);
    expect(busy.admit).toEqual([]);
    expect(busy.blocked).toEqual([{ key: ready.key, reason: "token-budget" }]);
    expect(busy.exhausted).toEqual([]);
    const idle = selectGraphAdmissions(run([ready]), options);
    expect(idle.exhausted).toEqual([{ key: ready.key, meter: "tokens" }]);
  });

  test("running agents finish; the next agent fails the run naming the meter", async () => {
    const h = await harness();
    h.world.fakes.tokens.set("a", 1_500);
    h.world.fakes.held.add("b");
    const created = await launch(h, compiledPlan(meteredTemplate({ maxTokens: 1_000 })));
    let run = await pass(h, created.id);
    expect(states(run, "a")).toEqual(["running"]);
    expect(states(run, "b")).toEqual(["running"]);
    run = await pass(h, created.id);
    // `a` reported 1 500 tokens: `c` is not admitted, `b` keeps running.
    expect(run.usage.tokens).toBe(1_500);
    expect(states(run, "a")).toEqual(["complete"]);
    expect(states(run, "b")).toEqual(["running"]);
    expect(states(run, "c")).toEqual(["ready"]);
    expect(run.status).toBe("running");
    run = await pass(h, created.id);
    expect(states(run, "c")).toEqual(["ready"]);
    h.world.fakes.held.delete("b");
    run = await pass(h, created.id);
    expect(states(run, "b")).toEqual(["complete"]);
    expect(states(run, "c")).toEqual(["failed"]);
    const c = run.activations.find((activation) => activation.nodeId === "c")!;
    expect(c.errorCause).toBe("budget-exceeded");
    expect(run.status).toBe("failed");
    expect(run.errorCause).toBe("budget-exceeded");
    expect(run.error).toContain("limits.maxTokens 1000; 1500 used");
    // Nothing was stopped: the meter never cancels running work.
    expect(h.world.fakes.callsOf("cancel")).toEqual([]);
    expect(h.world.fakes.callsOf("start", "c")).toEqual([]);
    expect(run.usage.agentSessions).toBe(2);
  });

  test("below the meter the run completes", async () => {
    const h = await harness();
    h.world.fakes.tokens.set("a", 400);
    h.world.fakes.tokens.set("b", 400);
    const created = await launch(h, compiledPlan(meteredTemplate({ maxTokens: 1_000 })));
    let run = created;
    for (let index = 0; index < 6 && run.status !== "complete"; index++) {
      run = await pass(h, created.id);
    }
    expect(run.status).toBe("complete");
    expect(run.usage.tokens).toBe(800);
  });

  test("a mock run is never metered", async () => {
    const h = await harness({ mock: true });
    h.world.fakes.tokens.set("a", 5_000);
    const created = await launch(h, compiledPlan(meteredTemplate({ maxTokens: 1_000 })), true);
    expect(created.mock).toBe(true);
    let run = created;
    for (let index = 0; index < 6 && run.status !== "complete"; index++) {
      run = await pass(h, created.id);
    }
    expect(run.status).toBe("complete");
    expect(states(run, "c")).toEqual(["complete"]);
  });
});

describe("limits.maxWallClockMs", () => {
  test("the deadline counts from startedAt", () => {
    const plan = compiledPlan(soloTemplate({ maxWallClockMs: 60_000 }));
    const startedAt = "2026-10-29T00:00:00.000Z";
    expect(graphRunWallClockDeadline({ plan, startedAt })).toBe(BASE + 60_000);
    expect(graphRunWallClockDeadline({ plan })).toBeUndefined();
    expect(graphRunWallClockExceeded({ plan, startedAt }, BASE + 60_000)).toBe(false);
    expect(graphRunWallClockExceeded({ plan, startedAt }, BASE + 60_001)).toBe(true);
    expect(graphRunWallClockDeadline({ plan: compiledPlan(soloTemplate({})), startedAt })).toBe(
      undefined,
    );
  });

  test("a run past its wall clock fails; running agents are cancelled with run-failed", async () => {
    const h = await harness();
    h.world.fakes.held.add("solo");
    const created = await launch(h, compiledPlan(soloTemplate({ maxWallClockMs: 60_000 })));
    let run = await pass(h, created.id);
    expect(states(run, "solo")).toEqual(["running"]);
    run = await pass(h, created.id, 50_000);
    expect(run.status).toBe("running");
    run = await pass(h, created.id, 10_000);
    expect(run.status).toBe("failed");
    expect(run.errorCause).toBe("budget-exceeded");
    expect(run.error).toBe(
      "The run exceeded its wall-clock limit of 1 min (limits.maxWallClockMs)",
    );
    expect(states(run, "solo")).toEqual(["cancelled"]);
    expect(h.world.fakes.callsOf("cancel").map((call) => call.reason)).toEqual(["run-failed"]);
    expect(h.world.fakes.running.size).toBe(0);
  });

  test("a paused run is woken at its deadline and fails", async () => {
    const h = await harness({ keyed: true });
    h.world.fakes.held.add("solo");
    const created = await launch(h, compiledPlan(soloTemplate({ maxWallClockMs: 20_000 })));
    await advanceKeyedWork(h.time, [h.service], 4_000, 1_000);
    await h.service.pause(created.id);
    await advanceKeyedWork(h.time, [h.service], 4_000, 1_000);
    expect((await h.service.get(created.id))?.status).toBe("paused");
    await advanceKeyedWork(h.time, [h.service], 14_000, 1_000);
    const run = await h.service.get(created.id);
    expect(run?.status).toBe("failed");
    expect(run?.errorCause).toBe("budget-exceeded");
    expect(h.world.fakes.callsOf("cancel").map((call) => call.reason)).toEqual(["run-failed"]);
  });

  test("a run waiting on a person is woken at its deadline, before the 30 s human cadence", async () => {
    const h = await harness({ keyed: true });
    const created = await launch(h, compiledPlan(humanTemplate({ maxWallClockMs: 10_000 })));
    await advanceKeyedWork(h.time, [h.service], 3_000, 500);
    expect((await h.service.get(created.id))?.status).toBe("waiting");
    await advanceKeyedWork(h.time, [h.service], 9_000, 500);
    const run = await h.service.get(created.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("wall-clock limit of 10 s");
    expect(states(run!, "approve")).toEqual(["cancelled"]);
    expect(h.world.fakes.callsOf("cancel", "approve").map((call) => call.reason)).toEqual([
      "run-failed",
    ]);
  });
});
