/**
 * D3 across engines, the graph side: an activation that uses the workspace
 * waits while a Build Pipeline or bespoke Multi Review holds it in a way the
 * access cannot share, the run records why (`blocked`), and the block goes
 * when the activation is admitted.
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
import { selectGraphAdmissions, type GraphExternalWorkspaceHold } from "./graph-run-scheduling.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

function singleNode(access: "read" | "write"): GraphTemplateV1 {
  const output =
    access === "write"
      ? { name: "code", type: "workspace@1" }
      : { name: "report", type: "review-report@1" };
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: `single-${access}`,
    revision: 1,
    name: `single-${access}`,
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [{ name: "out", type: output.type, from: { node: "work", port: output.name } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "work",
        kind: "agent",
        role: "worker",
        capabilities: { profile: access === "write" ? "builder" : "reviewer" },
        workspaceAccess: access,
        prompt: { template: "Do it.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [output],
      },
    ],
    edges: [{ id: "target-work", from: { input: "target" }, to: { node: "work", port: "code" } }],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4 },
  } as GraphTemplateV1;
}

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
  external: { hold: GraphExternalWorkspaceHold | null; readyCalls: number };
}

async function harness(): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  const time = new ManualTime(0);
  const external: Harness["external"] = { hold: { writers: 0, readers: 0 }, readyCalls: 0 };
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    externalWorkspace: {
      ready: async () => {
        external.readyCalls += 1;
        return true;
      },
      hold: () => external.hold,
    },
  });
  await service.init();
  return { world, service, time, external };
}

async function launch(h: Harness, plan: CompiledGraphPlan): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, 1, ["claude"]),
    inputs: { target: graphTypeExample(plan, "workspace@1") },
  });
}

async function step(h: Harness, runId: string): Promise<GraphRun> {
  h.time.jump(3_000);
  const run = await h.service.advanceNow(runId);
  if (!run) throw new Error("the run disappeared");
  return run;
}

const work = (run: GraphRun) => run.activations.find((activation) => activation.nodeId === "work")!;

describe("graph admission and other engines (D3 across engines)", () => {
  test("a writer waits for a pipeline writer, with the reason on the record, then runs", async () => {
    const h = await harness();
    h.external.hold = {
      writers: 1,
      readers: 0,
      holder: "build-pipeline",
      holderAccess: "write",
    };
    const run = await launch(h, compiledPlan(singleNode("write")));
    const blocked = await step(h, run.id);
    expect(work(blocked).state).toBe("ready");
    expect(work(blocked).blocked).toEqual({
      reason: "external-workflow",
      holder: "build-pipeline",
      holderAccess: "write",
    });
    expect(h.external.readyCalls).toBeGreaterThan(0);
    // The block is on the stored record, so a reloaded run view shows it.
    expect(work((await h.service.get(run.id))!).blocked?.holder).toBe("build-pipeline");

    // The same block on the next pass writes nothing.
    const saves = h.service.passStats(run.id)?.saves ?? 0;
    const again = await step(h, run.id);
    expect(again.revision).toBe(blocked.revision);
    expect(h.service.passStats(run.id)?.saves ?? 0).toBeLessThanOrEqual(saves);

    // The pipeline moves on to reviewing: still no graph writer beside its reader.
    h.external.hold = { writers: 0, readers: 1, holder: "build-pipeline", holderAccess: "read" };
    expect(work(await step(h, run.id)).blocked).toEqual({
      reason: "external-workflow",
      holder: "build-pipeline",
      holderAccess: "read",
    });

    h.external.hold = { writers: 0, readers: 0 };
    h.world.fakes.held.add("work");
    const admitted = await step(h, run.id);
    expect(work(admitted).state).toBe("running");
    expect(work(admitted).blocked).toBeUndefined();
    h.world.fakes.held.delete("work");
  });

  test("a reader runs beside another engine's reader but not its writer", async () => {
    const h = await harness();
    h.external.hold = { writers: 0, readers: 1, holder: "multi-review", holderAccess: "read" };
    h.world.fakes.held.add("work");
    const beside = await launch(h, compiledPlan(singleNode("read")));
    expect(work(await step(h, beside.id)).state).toBe("running");
    h.world.fakes.held.delete("work");

    h.external.hold = { writers: 1, readers: 0, holder: "multi-review", holderAccess: "write" };
    const waits = await launch(h, compiledPlan(singleNode("read")));
    const blocked = work(await step(h, waits.id));
    expect(blocked.state).toBe("ready");
    expect(blocked.blocked).toEqual({
      reason: "external-workflow",
      holder: "multi-review",
      holderAccess: "write",
    });

    // Not yet known (the projection is unseeded): wait as recovering.
    h.external.hold = null;
    expect(work(await step(h, waits.id)).blocked).toEqual({ reason: "recovering" });
  });

  test("selection: another engine's writer blocks every access, and a blocked writer is not overtaken", () => {
    const plan = compiledPlan(singleNode("write"));
    const at = "2026-10-29T00:00:00.000Z";
    const run = {
      plan,
      usage: { agentSessions: 0, tokens: 0 },
      activations: [
        {
          key: "work#iter=1#attempt=1",
          nodeId: "work",
          state: "ready",
          inputs: {},
          outputs: {},
          createdAt: at,
          iteration: 1,
          attempt: 1,
        },
      ],
    } as unknown as GraphRun;
    const free = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 0 },
      workspaceKnown: true,
      external: { writers: 0, readers: 0 },
    });
    expect(free.admit).toHaveLength(1);
    const held = selectGraphAdmissions(run, {
      others: { writers: 0, readers: 0 },
      workspaceKnown: true,
      external: { writers: 0, readers: 2, holder: "build-pipeline", holderAccess: "read" },
    });
    expect(held.blocked).toEqual([
      {
        key: "work#iter=1#attempt=1",
        reason: "external-workflow",
        holder: "build-pipeline",
        holderAccess: "read",
      },
    ]);
    // A graph lock is reported before another engine's.
    const both = selectGraphAdmissions(run, {
      others: { writers: 1, readers: 0 },
      workspaceKnown: true,
      external: { writers: 1, readers: 0, holder: "build-pipeline", holderAccess: "write" },
    });
    expect(both.blocked.map((entry) => entry.reason)).toEqual(["workspace-lock"]);
  });
});
