/**
 * `graph_run_answer`'s human-node form and `graph_run_pending` (item 208),
 * over a real store, the real human executor and hand-driven passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type {
  GraphRunPendingInteraction,
  GraphHumanWait,
  GraphRun,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createGraphHumanExecutor, GraphHumanAnswers } from "./graph-node-human.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";

const commands = createCommandRegistry();
const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const PLAN = compiledPlan({
  format: "orkestrator.graph",
  formatVersion: 1,
  id: "edit-brief",
  revision: 1,
  name: "Edit brief",
  parameters: [],
  roles: [],
  inputs: [{ name: "brief", type: "text@1" }],
  outputs: [],
  workspace: { kind: "environment" },
  nodes: [
    {
      id: "check",
      kind: "human",
      form: { kind: "edit", edit: "brief", instructions: "Tighten the brief." },
      inputs: [{ name: "brief", type: "text@1" }],
    },
  ],
  edges: [{ id: "in", from: { input: "brief" }, to: { node: "check", port: "brief" } }],
  limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
} as unknown as GraphTemplateV1);

async function setup(): Promise<{
  world: GraphRunWorld;
  service: GraphRunService;
  context: CommandContext;
  time: ManualTime;
}> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.skipKinds.add("human");
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  service.executors.register(createGraphHumanExecutor());
  await service.init();
  const context = {
    storage: world.storage,
    graphRuns: service,
    graphHumanAnswers: new GraphHumanAnswers({ runs: service, artifacts: world.artifacts }),
  } as unknown as CommandContext;
  return { world, service, context, time };
}

async function call<T>(context: CommandContext, name: string, args: Record<string, unknown>) {
  const handler = commands.get(name);
  if (!handler) throw new Error(`Not registered: ${name}`);
  return (await handler(args, context)) as T;
}

async function refused(context: CommandContext, args: Record<string, unknown>) {
  try {
    await call(context, "graph_run_answer", args);
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error("the answer was accepted");
}

async function waitingRun(h: Awaited<ReturnType<typeof setup>>): Promise<GraphRun> {
  const launched = await h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: PLAN.template.id,
      revision: PLAN.template.revision,
      digest: PLAN.templateDigest,
    },
    plan: PLAN,
    roles: bindAllRoles(PLAN),
    inputs: { brief: { text: "Export reports as CSV." } },
  });
  let run = launched;
  for (let index = 0; index < 3; index++) {
    h.time.jump(3_000);
    run = (await h.service.advanceNow(launched.id))!;
  }
  expect(run.status).toBe("waiting");
  return run;
}

describe("human node commands", () => {
  test("graph_run_pending lists the waits by run and by environment, rehydratable", async () => {
    const h = await setup();
    expect(commands.has("graph_run_pending")).toBe(true);
    const run = await waitingRun(h);
    const byRun = await call<GraphRunPendingInteraction[]>(h.context, "graph_run_pending", {
      runId: run.id,
    });
    const check = run.activations[0]!;
    expect(byRun).toEqual([
      expect.objectContaining({
        kind: "human",
        runId: run.id,
        activationKey: check.key,
        waitId: check.human!.id,
        form: "edit",
        instructions: "Tighten the brief.",
        edit: { port: "brief", type: "text@1", artifactId: run.bindings.inputs.brief },
      }),
    ]);
    expect(await call(h.context, "graph_run_pending", { environmentId: "e1" })).toEqual(byRun);
    expect(await call(h.context, "graph_run_pending", { environmentId: "e2" })).toEqual([]);
    await expect(call(h.context, "graph_run_pending", {})).rejects.toThrow(/exactly one/);
  });

  test("graph_run_answer validates, stores the edit and returns the wait", async () => {
    const h = await setup();
    const run = await waitingRun(h);
    const check = run.activations[0]!;
    const base = { runId: run.id, activationKey: check.key, waitId: check.human!.id };
    expect(await refused(h.context, { ...base, decision: "maybe" })).toMatchObject({
      code: "invalid-answer",
    });
    expect(await refused(h.context, { ...base, decision: "approve", extra: 1 })).toMatchObject({
      message: expect.stringContaining("Unknown arguments"),
    });
    expect(
      await refused(h.context, { ...base, decision: "approve", value: { text: "x", more: 1 } }),
    ).toMatchObject({ code: "invalid-answer", message: expect.stringContaining("text@1") });
    expect(
      await refused(h.context, { ...base, waitId: crypto.randomUUID(), decision: "approve" }),
    ).toMatchObject({ code: "invalid-answer" });

    const answered = await call<{ activationKey: string; human: GraphHumanWait }>(
      h.context,
      "graph_run_answer",
      {
        ...base,
        decision: "approve",
        value: { text: "Export reports as CSV, with a header." },
        note: "ok",
      },
    );
    expect(answered.activationKey).toBe(check.key);
    expect(answered.human.answer).toMatchObject({
      decision: "approve",
      outlet: "approved",
      note: "ok",
      by: "user",
      edited: { port: "brief" },
    });
    // The wait is answered: the run has nothing pending any more.
    expect(await call(h.context, "graph_run_pending", { runId: run.id })).toEqual([]);
    expect(await refused(h.context, { ...base, decision: "reject" })).toMatchObject({
      code: "invalid-answer",
    });
  });
});
