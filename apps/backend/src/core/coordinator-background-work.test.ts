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

describe("a worker waiting on the user", () => {
  const prompt = {
    kind: "sign-in" as const,
    url: "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967",
    wantsEnter: true,
    text: "Login at: https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967",
    key: "sign-in\u0000npm",
  };

  // Regression (2026-10-26): a worker ended its turn to hand over an npm login
  // link while `npm login` ran in the background; the coordinator heard nothing
  // for three minutes because the turn end was held for that background work.
  test("ends its turn and wakes the coordinator at once, background work or not", async () => {
    let waiting = false;
    const world = await MailWorld.create({
      delegations: {
        workerBackgroundWork: async () => true,
        backgroundWorkHoldMs: 120_000,
        workerNeedsHuman: () => waiting,
      },
    });
    worlds.push(world);
    const worker = await world.addEnvironment("worker", { launched: true });
    const main = await world.main();
    waiting = true;
    await world.coordinator.settleWorkerDelegations({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "completed",
    });
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(0);
    await world.deliver();
    expect(world.received(main)).toHaveLength(1);
    expect(world.received(main)[0]).not.toContain("work it started in the background");
  });

  test("the coordinator is told once per prompt, with the link, and a user's own command is not announced", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker", { launched: true });
    const main = await world.main();
    const entry = {
      id: "task:b22y6b1by",
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      source: "agent-background-task" as const,
      command: "npm login --auth-type=web",
      prompt,
      since: new Date().toISOString(),
    };
    await world.coordinator.noteWorkerHumanPrompt(entry);
    await world.coordinator.noteWorkerHumanPrompt(entry);
    await world.coordinator.noteWorkerHumanPrompt({ ...entry, id: "user-command:1", source: "user-command" });
    const mail = await world.undelivered(main);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      route: "coordinator",
      placement: "pending-inject",
      notice: { state: "waiting", tone: "attention" },
    });
    expect(mail[0]!.subject).toContain("needs you: sign in");
    await world.deliver();
    expect(world.received(main)).toHaveLength(1);
    expect(world.received(main)[0]).toContain(`Open: ${prompt.url}`);
    expect(world.received(main)[0]).toContain("npm login --auth-type=web");
  });
});
