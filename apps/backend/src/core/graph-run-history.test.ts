/**
 * Run history per environment (invariant 6): the run service keeps the
 * newest finished runs of an environment and deletes older finished ones,
 * after a run finishes and when discovery (at startup) finds an environment
 * over the bound. Unfinished runs are never deleted.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GRAPH_LAUNCH_BOUNDS } from "@orkestrator/protocol/graphs/launch";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { graphRunWorld, type GraphRunWorld } from "./graph-run-executor-test-support.js";
import { graphArtifactFixture, graphRunFixture } from "./graph-run-test-support.js";
import { ManualTime, advanceKeyedWork } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const at = (second: number) => `2026-10-29T00:00:${String(second).padStart(2, "0")}.000Z`;

async function finishedRun(world: GraphRunWorld, id: string, second: number): Promise<void> {
  await world.storage.graphRuns.createGraphRun(
    graphRunFixture({
      id,
      status: "complete",
      startedAt: at(0),
      finishedAt: at(second),
      updatedAt: at(second),
    }),
  );
  await world.storage.graphRuns.putGraphArtifact(graphArtifactFixture(id));
}

async function ids(world: GraphRunWorld, environmentId = "e1"): Promise<string[]> {
  return (await world.storage.graphRuns.listGraphRuns(environmentId))
    .map((run: GraphRun) => run.id)
    .sort();
}

describe("graph run history", () => {
  test("the bound is 100 finished runs per environment", () => {
    expect(GRAPH_LAUNCH_BOUNDS.maxFinishedRunsPerEnvironment).toBe(100);
  });

  test("a run that finishes prunes its environment's oldest finished runs", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    const service = world.service({ autoAdvance: false, runHistoryPerEnvironment: 2 });
    const files = spyOn(world.artifacts, "removeRunFiles");
    await service.init();
    await finishedRun(world, "old", 1);
    await finishedRun(world, "mid", 2);
    await world.storage.graphRuns.createGraphRun(graphRunFixture({ id: "live", createdAt: at(0) }));
    await world.storage.graphRuns.createGraphRun(
      graphRunFixture({ id: "other-env", environmentId: "e2", createdAt: at(0) }),
    );
    // Two finished runs: within the bound, nothing goes.
    expect(await service.pruneRunHistory("e1")).toEqual([]);

    // Cancelling the live run (nothing admitted) finishes it at its next
    // pass: three finished runs, so the oldest goes with its artifacts.
    await service.cancel("live");
    const cancelled = await service.advanceNow("live");
    expect(cancelled?.status).toBe("cancelled");
    // The prune runs in the background; shutdown waits for it.
    await service.shutdown();
    expect(await ids(world)).toEqual(["live", "mid"]);
    expect(await world.storage.graphRuns.listGraphArtifacts("old")).toEqual([]);
    // Its sealed reference files in the workspace go too.
    expect(files).toHaveBeenCalledWith("e1", ["old"]);
    expect(await ids(world, "e2")).toEqual(["other-env"]);
  });

  test("an unfinished run is never deleted, whatever its age", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    const service = world.service({ autoAdvance: false, runHistoryPerEnvironment: 0 });
    await service.init();
    for (const [id, status] of [
      ["paused", "paused"],
      ["running", "running"],
      ["provisioning", "provisioning"],
    ] as const) {
      const created = await world.storage.graphRuns.createGraphRun(
        graphRunFixture({ id, createdAt: at(0) }),
      );
      if (status !== "running") {
        await world.storage.graphRuns.saveGraphRun({ ...created, status }, created.revision);
      }
    }
    await finishedRun(world, "done", 5);
    expect(await service.pruneRunHistory("e1")).toEqual(["done"]);
    expect(await ids(world)).toEqual(["paused", "provisioning", "running"]);
  });

  test("discovery at startup prunes an environment over the bound", async () => {
    const world = await graphRunWorld();
    worlds.push(world);
    for (let second = 1; second <= 5; second++) await finishedRun(world, `run-${second}`, second);
    const paused = await world.storage.graphRuns.createGraphRun(
      graphRunFixture({ id: "held", createdAt: at(0) }),
    );
    await world.storage.graphRuns.saveGraphRun({ ...paused, status: "paused" }, paused.revision);
    const time = new ManualTime(0);
    const service = world.service({
      keyedScheduling: true,
      discoveryIntervalMs: 30_000,
      schedulerClock: { now: time.now, timers: time.timerFactory },
      runHistoryPerEnvironment: 3,
    });
    await service.init();
    await advanceKeyedWork(time, [service], 1_000, 250);
    // Shutdown waits for prunes in flight.
    await service.shutdown();
    expect(await ids(world)).toEqual(["held", "run-3", "run-4", "run-5"]);
  });
});
