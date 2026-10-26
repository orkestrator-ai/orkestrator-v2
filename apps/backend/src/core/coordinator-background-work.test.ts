import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MailWorld } from "./agent-mail-world-test-support.js";

const worlds: MailWorld[] = [];
let now: number;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  clock.mockRestore();
  for (const world of worlds.splice(0)) await world.close();
});

async function fixture(holdMs = 120_000) {
  let activity: "idle" | "working" = "idle";
  const world = await MailWorld.create({
    statusWakes: { workerActivity: async () => activity },
    delegations: { workerBackgroundWork: async () => true, backgroundWorkHoldMs: holdMs },
  });
  worlds.push(world);
  const worker = await world.addEnvironment("worker", { launched: true });
  const main = await world.main();
  const pause = () =>
    world.coordinator.settleWorkerDelegations({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "completed",
    });
  return {
    world,
    worker,
    main,
    pause,
    setActivity: (value: typeof activity) => {
      activity = value;
    },
  };
}

function advance(ms: number) {
  now += ms;
}

describe("background-work delegation holds", () => {
  test("a nonzero hold survives sweeps and expires at its bound", async () => {
    const { world, main, pause } = await fixture();
    await pause();
    advance(119_999);
    await world.coordinator.reconcileWorkerDelegations();
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
    expect(await world.storage.listPendingAgentMailInjects()).toHaveLength(0);
    advance(1);
    await world.coordinator.reconcileWorkerDelegations();
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(0);
    await world.deliver();
    expect(world.received(main)[0]).toContain("none of it reported for 2 minutes");
  });

  for (const observation of ["sweep", "event"] as const) {
    test(`resuming observed by ${observation} starts a fresh pause budget`, async () => {
      const { world, worker, pause, setActivity } = await fixture();
      await pause();
      advance(60_000);
      setActivity("working");
      if (observation === "sweep") await world.coordinator.reconcileWorkerDelegations();
      else
        await world.coordinator.noteWorkerActivity({
          environmentId: worker.environmentId,
          tabId: worker.tabId,
          state: "working",
        });
      advance(40 * 60_000);
      setActivity("idle");
      await pause();
      await world.coordinator.reconcileWorkerDelegations();
      expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
      advance(119_999);
      await world.coordinator.reconcileWorkerDelegations();
      expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
      advance(1);
      await world.coordinator.reconcileWorkerDelegations();
      expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(0);
    });
  }

  for (const restart of [false, true]) {
    test(`timeout qualification survives ${restart ? "restart before delivery" : "a failed notice write"}`, async () => {
      const { world, main, pause } = await fixture(60_000);
      await pause();
      advance(60_000);
      if (restart) {
        const deliver = spyOn(world.coordinator, "deliverDelegationWakes").mockResolvedValue(
          undefined,
        );
        try {
          await pause();
        } finally {
          deliver.mockRestore();
        }
      } else {
        const send = spyOn(world.storage, "sendAgentMail").mockRejectedValueOnce(
          new Error("disk unavailable"),
        );
        try {
          await expect(pause()).rejects.toThrow("disk unavailable");
        } finally {
          send.mockRestore();
        }
      }
      expect(await world.storage.coordinators.listUnwokenCoordinatorDelegations()).toMatchObject([
        { delegation: { state: "completed", backgroundWorkTimeoutMs: 60_000 } },
      ]);
      if (restart) await world.restart();
      await world.coordinator.deliverDelegationWakes();
      await world.coordinator.deliverDelegationWakes();
      await world.deliver();
      expect(world.received(main)).toHaveLength(1);
      expect(world.received(main)[0]).toContain(
        "work it started in the background was still running",
      );
      expect(world.received(main)[0]).toContain("none of it reported for 1 minute");
      expect(await world.storage.coordinators.listUnwokenCoordinatorDelegations()).toHaveLength(0);
    });
  }
});
