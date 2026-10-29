import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  bindAllRoles,
  compiledPlan,
  graphFanOutTemplate,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { GraphNodeExecutorRegistry } from "./graph-run-executors.js";
import {
  GraphWorkspaceLocks,
  graphWorkspaceAllows,
  selectGraphAdmissions,
} from "./graph-run-scheduling.js";
import type { GraphRunService } from "./graph-run-service.js";
import {
  GraphRunTransitionError,
  canTransitionGraphRun,
  transitionGraphRun,
} from "./graph-run-transitions.js";
import { ManualTime, deferred, flushMicrotasks } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

async function world(): Promise<GraphRunWorld> {
  const created = await graphRunWorld();
  worlds.push(created);
  return created;
}

function agentNode(
  id: string,
  access: "read" | "write" | "none",
  output: { name: string; type: string },
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind: "agent" as const,
    role: "worker",
    capabilities: {
      profile: access === "write" ? "builder" : access === "read" ? "reviewer" : "observer",
    },
    workspaceAccess: access,
    prompt: { template: `Do ${id}.\n\n{{> input.code}}\n` },
    inputs: [{ name: "code", type: "workspace@1" }],
    outputs: [output],
    ...extra,
  };
}

function template(
  id: string,
  nodes: unknown[],
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
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4 },
    ...extra,
  } as GraphTemplateV1;
}

/** build (writes) → review (reads) → check (gate) → fix on findings (writes). */
function linearTemplate(): GraphTemplateV1 {
  return template(
    "linear",
    [
      agentNode("build", "write", { name: "code", type: "workspace@1" }),
      agentNode("review", "read", { name: "report", type: "review-report@1" }),
      {
        id: "check",
        kind: "gate",
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
        branches: [{ to: "findings", when: { path: "report.issues", op: "nonEmpty" } }],
        otherwise: "clean",
      },
      {
        ...agentNode("fix", "write", { name: "code", type: "workspace@1" }),
        prompt: { template: "Fix.\n\n{{> input.report}}\n\n{{> input.code}}\n" },
        inputs: [
          { name: "report", type: "review-report@1" },
          { name: "code", type: "workspace@1" },
        ],
      },
    ],
    [
      { id: "target-build", from: { input: "target" }, to: { node: "build", port: "code" } },
      {
        id: "build-review",
        from: { node: "build", port: "code" },
        to: { node: "review", port: "code" },
      },
      {
        id: "review-check",
        from: { node: "review", port: "report" },
        to: { node: "check", port: "report" },
      },
      {
        id: "build-check",
        from: { node: "build", port: "code" },
        to: { node: "check", port: "code" },
      },
      {
        id: "findings-fix-report",
        from: { node: "check", outlet: "findings", port: "report" },
        to: { node: "fix", port: "report" },
      },
      {
        id: "findings-fix-code",
        from: { node: "check", outlet: "findings", port: "code" },
        to: { node: "fix", port: "code" },
      },
    ],
    [
      { name: "report", type: "review-report@1", from: { node: "review", port: "report" } },
      { name: "fixed", type: "workspace@1", required: false, from: { node: "fix", port: "code" } },
    ],
  );
}

function singleNode(id: string, access: "read" | "write"): GraphTemplateV1 {
  const output =
    access === "write"
      ? { name: "code", type: "workspace@1" }
      : { name: "report", type: "review-report@1" };
  return template(
    id,
    [agentNode("work", access, output)],
    [{ id: "target-work", from: { input: "target" }, to: { node: "work", port: "code" } }],
    [{ name: "out", type: output.type, from: { node: "work", port: output.name } }],
  );
}

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

async function harness(): Promise<Harness> {
  const created = await world();
  const time = new ManualTime(0);
  const service = created.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  await service.init();
  return { world: created, service, time };
}

async function launch(
  h: Harness,
  plan: CompiledGraphPlan,
  options: { environmentId?: string; panel?: number; platforms?: ("claude" | "codex")[] } = {},
): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: options.environmentId ?? "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, options.panel ?? 2, options.platforms ?? ["claude"]),
    inputs: { target: graphTypeExample(plan, "workspace@1") },
  });
}

/** One observation period later, a pass. */
async function step(h: Harness, runId: string): Promise<GraphRun> {
  h.time.jump(3_000);
  const run = await h.service.advanceNow(runId);
  if (!run) throw new Error("the run disappeared");
  return run;
}

async function until(
  h: Harness,
  runId: string,
  done: (run: GraphRun) => boolean,
  passes = 30,
): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    const run = await step(h, runId);
    if (done(run)) return run;
  }
  throw new Error("the run did not reach the expected state");
}

const state = (run: GraphRun, nodeId: string) =>
  run.activations.filter((activation) => activation.nodeId === nodeId).map((a) => a.state);

describe("graph run passes with pass-through executors", () => {
  test("a run advances end to end: admission, observation, gate routing, completion", async () => {
    const h = await harness();
    const plan = compiledPlan(linearTemplate());
    const created = await launch(h, plan);
    expect(created.status).toBe("running");
    expect(Object.keys(created.bindings.inputs)).toEqual(["target"]);
    let run = await step(h, created.id);
    expect(state(run, "build")).toEqual(["running"]);
    expect(run.usage.agentSessions).toBe(1);
    run = await step(h, created.id);
    // The writer finished; the reader started in the same pass.
    expect(state(run, "build")).toEqual(["complete"]);
    expect(state(run, "review")).toEqual(["running"]);
    run = await until(h, created.id, (current) => current.status === "complete");
    // The example report has issues: the gate took `findings` and fix ran.
    expect(run.activations.find((activation) => activation.nodeId === "check")?.outlet).toBe(
      "findings",
    );
    expect(state(run, "fix")).toEqual(["complete"]);
    expect(run.usage.agentSessions).toBe(3);
    expect(run.finishedAt).toBeDefined();
    // Gates complete inside their admitting pass: one start call, no observation.
    expect(h.world.fakes.callsOf("start", "check")).toHaveLength(1);
    expect(h.world.fakes.callsOf("observe", "check")).toHaveLength(0);
  });

  test("observation follows the 3 s cadence: an early pass does not observe", async () => {
    const h = await harness();
    const plan = compiledPlan(singleNode("solo", "write"));
    const created = await launch(h, plan);
    await step(h, created.id);
    h.world.fakes.held.add("work");
    h.time.jump(1_000);
    await h.service.advanceNow(created.id);
    expect(h.world.fakes.callsOf("observe")).toHaveLength(0);
    h.time.jump(2_000);
    await h.service.advanceNow(created.id);
    expect(h.world.fakes.callsOf("observe")).toHaveLength(1);
  });

  test("cancel stops admitted work through the executors and cancels the rest", async () => {
    const h = await harness();
    const plan = compiledPlan(linearTemplate());
    const created = await launch(h, plan);
    h.world.fakes.held.add("build");
    await step(h, created.id);
    const cancelling = await h.service.cancel(created.id);
    expect(cancelling.status).toBe("cancelling");
    expect(cancelling.cancelRequestedAt).toBeDefined();
    const run = await step(h, created.id);
    expect(run.status).toBe("cancelled");
    expect(state(run, "build")).toEqual(["cancelled"]);
    expect(h.world.fakes.callsOf("cancel").map((call) => call.reason)).toEqual(["run-cancelled"]);
    expect(h.world.fakes.running.size).toBe(0);
    // Cancelling again is a no-op on a terminal run.
    expect((await h.service.cancel(created.id)).status).toBe("cancelled");
  });

  test("pause stops admission; admitted work is still observed; resume continues", async () => {
    const h = await harness();
    const plan = compiledPlan(linearTemplate());
    const created = await launch(h, plan);
    await step(h, created.id);
    await h.service.pause(created.id);
    let run = await step(h, created.id);
    // build completed while paused, but review was not admitted.
    expect(run.status).toBe("paused");
    expect(state(run, "build")).toEqual(["complete"]);
    expect(state(run, "review")).toEqual([]);
    await expect(h.service.pause(created.id)).resolves.toMatchObject({ status: "paused" });
    run = await h.service.resume(created.id);
    expect(run.status).toBe("running");
    run = await step(h, created.id);
    expect(state(run, "review")).toEqual(["running"]);
  });

  test("a `fail-run` failure stops the run's other work and fails it", async () => {
    const h = await harness();
    const plan = compiledPlan(linearTemplate());
    const created = await launch(h, plan);
    h.world.fakes.failStart.set("build", "provider-error");
    const run = await step(h, created.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Node build failed: The fake executor failed");
    expect(run.errorCause).toBe("provider-error");
  });

  test("an activation past its node's timeout is cancelled and fails with `timeout`", async () => {
    const timed = linearTemplate();
    (timed.nodes[0] as { timeoutMs?: number }).timeoutMs = 60_000;
    (timed.nodes[0] as { onFailure?: string }).onFailure = "skip";
    let now = Date.parse("2026-10-29T00:00:00.000Z");
    const created = await world();
    const time = new ManualTime(0);
    const service = created.service({
      autoAdvance: false,
      schedulerClock: { now: time.now, timers: time.timerFactory },
      clock: () => new Date(now),
    });
    await service.init();
    const plan = compiledPlan(timed);
    const run = await service.create({
      projectId: "p1",
      environmentId: "e1",
      template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
      plan,
      roles: bindAllRoles(plan),
      inputs: { target: graphTypeExample(plan, "workspace@1") },
    });
    created.fakes.held.add("build");
    await service.advanceNow(run.id);
    now += 61_000;
    const after = await service.advanceNow(run.id);
    const build = after!.activations.find((activation) => activation.nodeId === "build")!;
    expect(build.state).toBe("failed");
    expect(build.errorCause).toBe("timeout");
    expect(created.fakes.callsOf("cancel").map((call) => call.reason)).toEqual(["timeout"]);
    // `onFailure: skip`: the rest of the run is skipped, and the required output is missing.
    expect(after!.status).toBe("failed");
    expect(after!.error).toContain("Required outputs were not produced: report");
  });

  test("an agent node without a registered executor fails with a clear cause", async () => {
    const h = await harness();
    const plan = compiledPlan(singleNode("solo", "write"));
    const bare = h.world.storage;
    const { GraphRunService } = await import("./graph-run-service.js");
    const service = new GraphRunService(bare, {
      artifacts: h.world.artifacts,
      autoAdvance: false,
      executors: new GraphNodeExecutorRegistry(),
    });
    await service.init();
    const created = await launch({ ...h, service }, plan);
    const run = await service.advanceNow(created.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("No executor is registered for agent nodes");
  });
});

describe("workspace locks (D3)", () => {
  test("the lock rules: one writer alone, readers together", () => {
    expect(graphWorkspaceAllows({ writers: 0, readers: 0 }, "write")).toBe(true);
    expect(graphWorkspaceAllows({ writers: 0, readers: 1 }, "write")).toBe(false);
    expect(graphWorkspaceAllows({ writers: 1, readers: 0 }, "write")).toBe(false);
    expect(graphWorkspaceAllows({ writers: 1, readers: 0 }, "read")).toBe(false);
    expect(graphWorkspaceAllows({ writers: 0, readers: 3 }, "read")).toBe(true);
    expect(graphWorkspaceAllows({ writers: 1, readers: 1 }, "none")).toBe(true);
  });

  test("the lock table sums other runs and reports releases", () => {
    const locks = new GraphWorkspaceLocks();
    expect(locks.set("a", "e1", { writers: 1, readers: 0 })).toBe(false);
    locks.set("b", "e1", { writers: 0, readers: 2 });
    locks.set("c", "e2", { writers: 1, readers: 0 });
    expect(locks.others("e1", "a")).toEqual({ writers: 0, readers: 2 });
    expect(locks.others("e1", "c")).toEqual({ writers: 1, readers: 2 });
    expect(locks.set("a", "e1", { writers: 0, readers: 0 })).toBe(true);
    expect(locks.others("e1", "b")).toEqual({ writers: 0, readers: 0 });
    locks.release("b");
    expect(locks.size()).toBe(1);
  });

  test("a writer and a reader on one workspace never run together, across runs", async () => {
    const h = await harness();
    const writer = await launch(h, compiledPlan(singleNode("writer", "write")));
    const reader = await launch(h, compiledPlan(singleNode("reader", "read")));
    const elsewhere = await launch(h, compiledPlan(singleNode("elsewhere", "read")), {
      environmentId: "e2",
    });
    h.world.fakes.held.add("work");
    expect(state(await step(h, writer.id), "work")).toEqual(["running"]);
    // The reader waits for the writer; a reader on another workspace does not.
    expect(state(await step(h, reader.id), "work")).toEqual(["ready"]);
    expect(state(await step(h, elsewhere.id), "work")).toEqual(["running"]);
    h.world.fakes.held.delete("work");
    expect((await step(h, writer.id)).status).toBe("complete");
    expect(state(await step(h, reader.id), "work")).toEqual(["running"]);
    // Now the reader holds the workspace: a new writer waits for it.
    h.world.fakes.held.add("work");
    const second = await launch(h, compiledPlan(singleNode("writer", "write")));
    expect(state(await step(h, second.id), "work")).toEqual(["ready"]);
    h.world.fakes.held.delete("work");
    expect((await step(h, reader.id)).status).toBe("complete");
    expect(state(await step(h, second.id), "work")).toEqual(["running"]);
    // Never a reader and a writer in flight on e1 at once.
    expect(h.world.fakes.maxRunning).toBeLessThanOrEqual(2);
  });

  test("admission in one pass keeps a ready writer and reader apart", () => {
    const plan = compiledPlan(linearTemplate());
    const at = "2026-10-29T00:00:00.000Z";
    const base = {
      inputs: {},
      outputs: {},
      createdAt: at,
      iteration: 1,
      attempt: 1,
    };
    const run = {
      plan,
      usage: { agentSessions: 0, tokens: 0 },
      activations: [
        { ...base, key: "build#iter=1#attempt=1", nodeId: "build", state: "ready" },
        { ...base, key: "review#iter=1#attempt=1", nodeId: "review", state: "ready" },
      ],
    } as unknown as GraphRun;
    const decision = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 0 },
      workspaceKnown: true,
    });
    expect(decision.admit.map((candidate) => candidate.key)).toEqual(["build#iter=1#attempt=1"]);
    expect(decision.blocked).toEqual([
      { key: "review#iter=1#attempt=1", reason: "workspace-lock" },
    ]);
    // A reader held elsewhere blocks the writer, and the writer is not overtaken.
    const held = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 1 },
      workspaceKnown: true,
    });
    expect(held.admit).toEqual([]);
    expect(held.blocked.map((entry) => entry.reason)).toEqual(["workspace-lock", "workspace-lock"]);
    // Before startup recovery seeded the table, nothing touching a workspace is admitted.
    const recovering = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 0 },
      workspaceKnown: false,
    });
    expect(recovering.blocked.map((entry) => entry.reason)).toEqual(["recovering", "recovering"]);
  });
});

describe("admission caps", () => {
  test("caps hold under a wide fan-out: 4 starting, 4 per provider, maxConcurrentAgents running", async () => {
    const h = await harness();
    const plan = compiledPlan(graphFanOutTemplate(8));
    const created = await launch(h, plan, { panel: 32, platforms: ["claude", "codex"] });
    const fakes = h.world.fakes;
    fakes.held.add("review");
    // Hold every start until the pool is saturated, to see its width.
    const gate = deferred();
    fakes.gate = gate.promise;
    h.time.jump(3_000);
    const pass = h.service.advanceNow(created.id);
    for (let index = 0; index < 20 && fakes.callsOf("start").length < 4; index++) {
      await flushMicrotasks();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(fakes.callsOf("start")).toHaveLength(4);
    fakes.gate = null;
    gate.resolve();
    let run = (await pass)!;
    expect(state(run, "review").filter((value) => value === "running")).toHaveLength(8);
    expect(state(run, "review").filter((value) => value === "ready")).toHaveLength(24);
    // Held reviewers keep their slots: nothing more is admitted.
    run = await step(h, created.id);
    expect(state(run, "review").filter((value) => value === "running")).toHaveLength(8);
    fakes.held.delete("review");
    run = await until(h, created.id, (current) => current.status === "complete", 40);
    expect(run.usage.agentSessions).toBe(33);
    expect(fakes.maxRunning).toBe(8);
    const starts = fakes.callsOf("start");
    expect(Math.max(...starts.map((call) => call.concurrent))).toBeLessThanOrEqual(4);
    expect(Math.max(...starts.map((call) => call.concurrentInGroup))).toBeLessThanOrEqual(4);
    const observes = fakes.callsOf("observe");
    expect(Math.max(...observes.map((call) => call.concurrent))).toBeLessThanOrEqual(8);
    // The consolidator received every branch's report.
    const consolidate = run.activations.find((activation) => activation.nodeId === "consolidate")!;
    expect(consolidate.inputs.reports).toHaveLength(32);
  });

  test("an agent activation beyond `maxAgentSessions` fails with `budget-exceeded`", () => {
    const plan = compiledPlan(graphFanOutTemplate(8));
    const run = {
      plan,
      usage: { agentSessions: 40, tokens: 0 },
      activations: [
        {
          key: "consolidate#iter=1#attempt=1",
          nodeId: "consolidate",
          iteration: 1,
          attempt: 1,
          state: "ready",
          inputs: {},
          outputs: {},
          createdAt: "2026-10-29T00:00:00.000Z",
        },
      ],
    } as unknown as GraphRun;
    const decision = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 0 },
      workspaceKnown: true,
    });
    expect(decision.exhausted).toEqual([
      { key: "consolidate#iter=1#attempt=1", meter: "agent-sessions" },
    ]);
    expect(decision.admit).toEqual([]);
  });
});

describe("run status transitions", () => {
  test("follow the table; terminal statuses never move", () => {
    expect(canTransitionGraphRun("provisioning", "running")).toBe(true);
    expect(canTransitionGraphRun("running", "waiting")).toBe(true);
    expect(canTransitionGraphRun("waiting", "running")).toBe(true);
    expect(canTransitionGraphRun("paused", "running")).toBe(true);
    expect(canTransitionGraphRun("cancelling", "cancelled")).toBe(true);
    expect(canTransitionGraphRun("cancelling", "running")).toBe(false);
    expect(canTransitionGraphRun("complete", "running")).toBe(false);
    expect(canTransitionGraphRun("provisioning", "paused")).toBe(false);
    const run = { status: "complete" } as GraphRun;
    expect(() => transitionGraphRun(run, "running", "2026-10-29T00:00:00.000Z")).toThrow(
      GraphRunTransitionError,
    );
    const failing = transitionGraphRun(
      { status: "running" } as GraphRun,
      "cancelling",
      "2026-10-29T00:00:00.000Z",
      { error: "x".repeat(3_000), cause: "budget-exceeded" },
    );
    expect(failing.cancelRequestedAt).toBe("2026-10-29T00:00:00.000Z");
    expect(failing.error!.length).toBe(2_000);
  });

  test("a run waiting only on a person is `waiting`, and running again once answered", async () => {
    const h = await harness();
    const human = template(
      "approval",
      [
        agentNode("build", "write", { name: "code", type: "workspace@1" }),
        {
          id: "approve",
          kind: "human",
          form: { kind: "approve" },
          inputs: [{ name: "code", type: "workspace@1" }],
        },
        {
          ...agentNode("ship", "read", { name: "report", type: "review-report@1" }),
        },
      ],
      [
        { id: "target-build", from: { input: "target" }, to: { node: "build", port: "code" } },
        {
          id: "build-approve",
          from: { node: "build", port: "code" },
          to: { node: "approve", port: "code" },
        },
        {
          id: "approved-ship",
          from: { node: "approve", outlet: "approved", port: "code" },
          to: { node: "ship", port: "code" },
        },
      ],
      [
        {
          name: "report",
          type: "review-report@1",
          required: false,
          from: { node: "ship", port: "report" },
        },
      ],
    );
    const created = await launch(h, compiledPlan(human));
    let run = await until(h, created.id, (current) => current.status === "waiting");
    const approval = run.activations.find((activation) => activation.nodeId === "approve")!;
    expect(approval.state).toBe("awaiting-human");
    h.world.fakes.answers.set(approval.key, "approved");
    // An unflagged pass does not ask the person's executor again.
    expect((await step(h, created.id)).status).toBe("waiting");
    h.service.requestObservation(created.id, approval.key);
    run = await until(h, created.id, (current) => current.status === "complete");
    expect(state(run, "ship")).toEqual(["complete"]);
  });
});
