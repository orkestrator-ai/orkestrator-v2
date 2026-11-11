/**
 * Todo 7564: a graph agent node finished up to one observation pass (3 s
 * plus a per-run spread) after its model submitted the node's last output.
 *
 * The model submits through a tool call inside its turn, so the acceptance
 * and its `result-accepted` wake land before the turn can end. The pass that
 * wake starts can find the turn still running, and the turn's end raises no
 * wake: workflow sessions are not native agent sessions, so the activity
 * sweep's `provider-transition` never reaches them. The fake executor's
 * `held` node is that turn: it reports running until released, and releasing
 * it wakes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { GRAPH_RUN_OBSERVATION_MS, GRAPH_RUN_RESULT_SETTLE_MS } from "./graph-run-pass.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime, advanceKeyedWork, settleKeyedWork } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

function reviewTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "review-settle",
    revision: 1,
    name: "Review settle",
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

interface Started {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
  run: GraphRun;
  resultKey: string;
  observes: () => number;
}

/** A run whose review turn has started and is held running. */
async function started(): Promise<Started> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.withSessions = true;
  world.fakes.held.add("review");
  const time = new ManualTime(0);
  const service = world.service({
    keyedScheduling: true,
    discoveryIntervalMs: 30_000,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  await service.init();
  const created = await service.create({
    projectId: "p1",
    environmentId: "e1",
    template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
    plan,
    roles: bindAllRoles(plan),
    inputs: { target: graphTypeExample(plan, "workspace@1") },
  });
  await advanceKeyedWork(time, [service], 2_000, 250);
  const run = (await service.get(created.id))!;
  const review = run.activations.find((activation) => activation.nodeId === "review");
  expect(review?.state).toBe("running");
  const resultKey = review!.session!.resultKeys!.report!;
  return {
    world,
    service,
    time,
    run,
    resultKey,
    observes: () => world.fakes.callsOf("observe", "review").length,
  };
}

async function reviewState(s: Started): Promise<string | undefined> {
  const run = await s.service.get(s.run.id);
  return run?.activations.find((activation) => activation.nodeId === "review")?.state;
}

/** The model submitted its output: the slot is accepted inside the running turn. */
async function accept(s: Started): Promise<void> {
  s.service.resultAccepted({ resultKey: s.resultKey, environmentId: "e1", kind: "graph-output" });
  await settleKeyedWork(s.time, [s.service]);
}

describe("graph run result settle cadence (todo 7564)", () => {
  test("without a result, a turn that ends silently waits for the observation cadence", async () => {
    const s = await started();
    // The order 7564 describes: the last observation saw the turn running and
    // its end raises no wake. Nothing reaches it before the next observation.
    s.world.fakes.held.delete("review");
    await advanceKeyedWork(s.time, [s.service], 1_000, 50);
    expect(await reviewState(s)).toBe("running");
    await advanceKeyedWork(s.time, [s.service], GRAPH_RUN_OBSERVATION_MS * 2, 250);
    expect(await reviewState(s)).toBe("complete");
  });

  test("an accepted result whose turn is still running finishes within the settle cadence", async () => {
    const s = await started();
    const before = s.observes();
    await accept(s);
    // The acceptance's wake observed the activation; the turn was still running.
    expect(s.observes()).toBe(before + 1);
    expect(await reviewState(s)).toBe("running");
    // The turn ends with no wake of its own.
    s.world.fakes.held.delete("review");
    await advanceKeyedWork(s.time, [s.service], GRAPH_RUN_RESULT_SETTLE_MS, 50);
    expect(await reviewState(s)).toBe("complete");
  });

  test("a model that keeps working after it submitted cannot hold the settle cadence", async () => {
    const s = await started();
    await accept(s);
    const afterWake = s.observes();
    // One observation interval of follow-ups at the settle cadence, then the
    // ordinary cadence again.
    await advanceKeyedWork(s.time, [s.service], GRAPH_RUN_OBSERVATION_MS, 50);
    const inWindow = s.observes() - afterWake;
    expect(inWindow).toBeGreaterThanOrEqual(
      GRAPH_RUN_OBSERVATION_MS / GRAPH_RUN_RESULT_SETTLE_MS - 2,
    );
    expect(inWindow).toBeLessThanOrEqual(GRAPH_RUN_OBSERVATION_MS / GRAPH_RUN_RESULT_SETTLE_MS + 1);
    const windowEnd = s.observes();
    await advanceKeyedWork(s.time, [s.service], GRAPH_RUN_OBSERVATION_MS * 2, 250);
    // Two intervals at 3 s plus a spread of at most a third: at most two passes
    // (the first may be the window's last 250 ms follow-up).
    expect(s.observes() - windowEnd).toBeLessThanOrEqual(3);
    expect(await reviewState(s)).toBe("running");
    s.world.fakes.held.delete("review");
    await advanceKeyedWork(s.time, [s.service], GRAPH_RUN_OBSERVATION_MS * 2, 250);
    expect(await reviewState(s)).toBe("complete");
  });
});
