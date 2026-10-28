/**
 * The coordinator's `deliverNow`: mail a busy worker must see mid-turn is
 * steered into that turn, through the same pending-entry flag as Deliver now.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { coordinatorDeliverNowResult } from "./coordinator-deliver-now.js";
import { MailWorld } from "./agent-mail-world-test-support.js";

describe("coordinator deliverNow", () => {
  let world: MailWorld;

  beforeEach(async () => {
    world = await MailWorld.create();
  });

  afterEach(async () => {
    await world.close();
  });

  async function pendingEntry(messageId: string) {
    const pending = await world.storage.listPendingAgentMailInjects(100, {
      includeDeferred: true,
      includeCoalescing: true,
    });
    return pending.find((entry) => entry.message.id === messageId);
  }

  test("a busy native worker gets the message steered into its running turn", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("busy", { launched: true });

    const sent = await world.delegate(coordinator, worker, "Stop: the requirement changed.", {
      deliverNow: true,
    });

    expect(sent).toMatchObject({
      deliverNow: "steered",
      placement: "injected",
      injectedVia: "steer",
    });
    expect(sent.injectedAt).toBeString();
    expect(sent.placementReason).toBeUndefined();
    expect(world.steered(worker)).toEqual(["Stop: the requirement changed."]);
    // It joined the running turn rather than starting another one.
    expect(world.wakes(worker)).toBe(0);
    expect(
      await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, sent.id),
    ).toMatchObject({ placement: "injected", injectedVia: "steer" });

    // The turn that read it settles the delegation: one coordinator wake.
    await world.finishTurn(worker);
    expect(world.wakes(coordinator)).toBe(1);
    expect(world.received(worker)).toEqual([]);
  });

  test("an idle worker gets an ordinary delivery", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("idle");

    const sent = await world.delegate(coordinator, worker, "Add the docs too.", {
      deliverNow: true,
    });

    expect(sent.deliverNow).toBe("delivered");
    expect(world.steered(worker)).toEqual([]);
    expect(world.received(worker)).toEqual(["Add the docs too."]);
    const delivered = await world.storage.getAgentMailMessage(
      worker.environmentId,
      worker.tabId,
      sent.id,
    );
    expect(delivered.placement).toBe("injected");
    expect(delivered.injectedVia).toBeUndefined();
  });

  test("a terminal worker is told it cannot take mail now and gets it at turn end", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("terminal", { launched: true, terminal: true });

    const sent = await world.delegate(coordinator, worker, "Also fix the lint.", {
      deliverNow: true,
    });

    expect(sent.deliverNow).toBe("unsupported, queued");
    expect(
      await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, sent.id),
    ).toMatchObject({ placement: "pending-inject", placementReason: "steer-unsupported" });
    expect(world.received(worker)).toEqual([]);

    await world.finishTurn(worker);
    expect(world.received(worker)).toEqual(["Also fix the lint."]);
    expect(world.wakes(coordinator)).toBe(0);
  });

  test("an unconfirmed steer is verified against the journal, never re-sent", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("unanswered", { launched: true });
    world.steerNext.set(world.key(worker), { outcome: "unknown" });

    const sent = await world.delegate(coordinator, worker, "Did this land?", {
      deliverNow: true,
    });

    expect(sent.deliverNow).toBe("verifying");
    expect(
      await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, sent.id),
    ).toMatchObject({ placement: "pending-inject", placementReason: "verifying" });

    // Skip the verification wait: the drain asks the journal, it does not resend.
    await world.storage.retryAgentMailInject(worker.environmentId, worker.tabId, sent.id);
    await world.deliver();
    expect(world.reconciledSteers).toHaveLength(1);
    expect(world.steered(worker)).toEqual([]);
    expect(world.wakes(worker)).toBe(0);

    world.steerJournal = "dispatched";
    await world.storage.retryAgentMailInject(worker.environmentId, worker.tabId, sent.id);
    await world.deliver();
    expect(
      await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, sent.id),
    ).toMatchObject({ placement: "injected", injectedVia: "steer" });

    await world.finishTurn(worker);
    expect(world.received(worker)).toEqual([]);
    expect(world.steered(worker)).toEqual([]);
  });

  test("without deliverNow a busy worker still gets mail when its turn ends", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("default", { launched: true });

    const sent = await world.delegate(coordinator, worker, "Routine follow-up.");

    expect(sent).not.toHaveProperty("deliverNow");
    expect(sent.placement).toBe("pending-inject");
    expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
    await world.deliver();
    expect(world.steered(worker)).toEqual([]);
    expect(world.received(worker)).toEqual([]);

    await world.finishTurn(worker);
    expect(world.received(worker)).toEqual(["Routine follow-up."]);
  });

  test("deliverNow does not bypass a muted recipient", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("muted", { launched: true });
    await world.storage.updateAgentMailboxPolicy(worker.environmentId, worker.tabId, {
      mutedInbound: true,
    });

    const sent = await world.delegate(coordinator, worker, "Urgent.", { deliverNow: true });

    expect(sent.placement).toBe("bounced");
    expect(sent.deliverNow).toBe("not queued");
    expect(world.steered(worker)).toEqual([]);
  });

  test("coordinator conversations are never steered", async () => {
    const coordinator = await world.main();
    const side = await world.addSide();
    world.startTurn(side);

    const sent = await world.delegate(coordinator, side, "Side note.", { deliverNow: true });

    expect(sent.deliverNow).toBe("queued until idle");
    expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
    await world.deliver();
    expect(world.steered(side)).toEqual([]);
  });

  test("a worker's own mail cannot request a steer", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("reporter", { launched: true });
    world.startTurn(coordinator);
    await world.finishTurn(worker);
    await world.finishTurn(coordinator);

    const sent = await world.storage.sendAgentMail(
      {
        kind: "tab",
        projectId: world.projectId,
        environmentId: worker.environmentId,
        tabId: worker.tabId,
      },
      { requestId: "worker-steer", toEnvironmentId: "coordinator", toTabId: "", body: "Hi." },
      { steer: true },
    );

    expect(sent.placement).toBe("pending-inject");
    expect(await pendingEntry(sent.id)).toBeDefined();
    expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
  });
  for (const busy of [true, false]) {
    test(`same-requestId replay preserves ${busy ? "steer" : "idle delivery"} success`, async () => {
      const coordinator = await world.main();
      const worker = await world.addEnvironment("replay", busy ? { launched: true } : {});
      const options = { deliverNow: true, requestId: "replayed-correction" };
      const first = await world.delegate(coordinator, worker, "Correction.", options);
      await world.mail.shutdown();
      const drain = spyOn(world.mail, "drainInjects");
      const replay = await world.delegate(coordinator, worker, "Correction.", options);
      expect(replay).toMatchObject({
        id: first.id,
        placement: "injected",
        injectedAt: first.injectedAt,
        deliverNow: busy ? "steered" : "delivered",
      });
      expect(drain).not.toHaveBeenCalled();
      expect(world.steered(worker)).toEqual(busy ? ["Correction."] : []);
      expect(world.received(worker)).toEqual(busy ? [] : ["Correction."]);
      drain.mockRestore();
      await world.finishTurn(worker);
      expect(world.wakes(coordinator)).toBe(1);
    });
  }

  test("deliverNow supports replying to a worker message", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("reply", { launched: true });
    const parent = await world.send(worker, coordinator, "Which requirement?");
    const sent = await world.delegate(coordinator, worker, "The updated one.", {
      deliverNow: true,
      replyToMessageId: parent.id,
    });
    expect(sent).toMatchObject({
      deliverNow: "steered",
      replyToMessageId: parent.id,
      threadId: parent.threadId,
    });
    expect(world.steered(worker)).toEqual(["The updated one."]);
  });

  for (const reason of ["steer-refused", "steer-too-large"] as const) {
    test(`${reason} queues once for idle delivery`, async () => {
      const coordinator = await world.main();
      const worker = await world.addEnvironment(reason, { launched: true });
      const body = reason === "steer-too-large" ? "\0".repeat(11_000) : "Correction.";
      if (reason === "steer-refused")
        world.steerNext.set(world.key(worker), { outcome: "refused", reason });
      const sent = await world.delegate(coordinator, worker, body, { deliverNow: true });
      expect(sent).toMatchObject({
        deliverNow: "queued until idle",
        placement: "pending-inject",
        placementReason: reason,
      });
      expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
      await world.deliver();
      expect(world.steered(worker)).toEqual([]);
      await world.finishTurn(worker);
      expect(world.received(worker)).toEqual([body]);
      await world.finishTurn(worker);
      expect(world.wakes(coordinator)).toBe(1);
    });
  }

  for (const blocker of ["paused", "stopped", "unready"] as const) {
    test(`${blocker} mail reports the blocker and cannot steer a later turn`, async () => {
      const coordinator = await world.main();
      const worker = await world.addEnvironment(blocker);
      const config = await world.storage.loadConfig();
      if (blocker === "paused") {
        await world.storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, paused: true },
        });
      } else if (blocker === "stopped") {
        await world.setEnvironmentStatus(worker, "stopped");
      } else {
        await world.storage.updateEnvironment(worker.environmentId, {
          setupPhase: "pending",
          setupScriptsComplete: false,
        });
      }
      const sent = await world.delegate(coordinator, worker, "Wait for readiness.", {
        deliverNow: true,
      });
      expect(sent.deliverNow).toBe("not queued");
      expect(sent.deliverNowNote).toContain(blocker);
      expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
      await world.storage.updateGlobalConfig(config.global);
      await world.storage.updateEnvironment(worker.environmentId, {
        status: "running",
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
      world.startTurn(worker);
      await world.deliver();
      expect(world.steered(worker)).toEqual([]);
      expect(world.received(worker)).toEqual([]);
      await world.finishTurn(worker);
      expect(world.received(worker)).toEqual(["Wait for readiness."]);
    });
  }

  test("a recipient made ineligible before the drain cannot retain an armed steer", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("ineligible", { launched: true });
    // Hold event-driven passes so the policy change sits exactly between
    // admission and the command's requested pass.
    await world.mail.shutdown();
    const original = world.mail.drainInjects.bind(world.mail);
    const drain = spyOn(world.mail, "drainInjects").mockImplementation(async () => {
      await world.storage.updateAgentMailboxPolicy(worker.environmentId, worker.tabId, {
        inject: "off",
      });
      await original();
    });
    const sent = await world.delegate(coordinator, worker, "Correction.", { deliverNow: true });
    drain.mockRestore();
    expect(sent.deliverNow).toBe("not queued");
    expect(sent.deliverNowNote).toContain("inject-policy-off");
    expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
    await world.storage.updateAgentMailboxPolicy(worker.environmentId, worker.tabId, {
      inject: "inherit",
    });
    await world.deliver();
    expect(world.steered(worker)).toEqual([]);
    await world.finishTurn(worker);
    expect(world.received(worker)).toEqual(["Correction."]);
  });

  for (const conversation of [false, true]) {
    for (const budget of ["autonomousWakeBudget", "hourlyWakeLimit"] as const) {
      test(`${conversation ? "coordinator conversation" : "worker"} ${budget} hold is not queued`, async () => {
        const coordinator = await world.main();
        const recipient = conversation
          ? await world.addSide()
          : await world.addEnvironment("budget", { launched: true });
        const config = await world.storage.loadConfig();
        await world.storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, [budget]: 1 },
        });
        await world.delegate(coordinator, recipient, "First.");
        const held = await world.delegate(coordinator, recipient, "Over budget.", {
          deliverNow: true,
        });
        expect(held).toMatchObject({
          placement: "inject-held",
          deliverNow: "not queued",
          placementReason:
            budget === "autonomousWakeBudget" ? "loop-budget-exhausted" : "hourly-limit",
        });
        expect(held.deliverNowNote).toContain(held.placementReason!);
        expect(world.steered(recipient)).toEqual([]);
      });
    }
  }

  for (const direction of ["main-to-side", "side-to-main"] as const) {
    for (const policy of ["muted", "off"] as const) {
      test(`${direction} ${policy} mail is not queued`, async () => {
        const main = await world.main();
        const side = await world.addSide();
        const [sender, recipient] = direction === "main-to-side" ? [main, side] : [side, main];
        await world.storage.updateAgentMailboxPolicy(
          recipient.environmentId,
          recipient.tabId,
          policy === "muted" ? { mutedInbound: true } : { inject: "off" },
        );
        const sent = await world.delegate(sender, recipient, "Note.", { deliverNow: true });
        expect(sent).toMatchObject({
          deliverNow: "not queued",
          placement: policy === "muted" ? "bounced" : "stored",
        });
        expect((await pendingEntry(sent.id))?.steerRequested).toBeUndefined();
      });
    }
  }

  test("unknown remote placement cannot promise queued delivery", () => {
    expect(coordinatorDeliverNowResult({}, { unsupported: true }).deliverNow).toBe("not queued");
  });

  test("completion during admission waits for the correction's delivered turn", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("admission-race", { launched: true });
    await world.mail.shutdown();
    const original = world.storage.sendAgentMail.bind(world.storage);
    let completion: Promise<void> | undefined;
    const sending = spyOn(world.storage, "sendAgentMail").mockImplementation(async (...args) => {
      const message = await original(...args);
      // Completion queues behind the admission lock before the drain begins.
      completion = world.finishTurn(worker, { deliver: false });
      return message;
    });
    const sent = await world.delegate(coordinator, worker, "Correction.", { deliverNow: true });
    sending.mockRestore();
    await completion;
    expect(sent.deliverNow).toBe("delivered");
    expect(world.wakes(coordinator)).toBe(0);
    expect(world.received(worker)).toEqual(["Correction."]);
    await world.finishTurn(worker);
    expect(world.wakes(coordinator)).toBe(1);
  });

  for (const phase of ["handoff", "journal"] as const) {
    test(`completion during steer ${phase} eventually wakes the coordinator once`, async () => {
      await world.close();
      world = await MailWorld.create({ statusWakes: { workerActivity: async () => "idle" } });
      const coordinator = await world.main();
      const worker = await world.addEnvironment(phase, { launched: true });
      const finish = async () => {
        await world.finishTurn(worker, { deliver: false });
        expect(world.wakes(coordinator)).toBe(0);
        expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
      };
      if (phase === "handoff") world.afterSteer = finish;
      else world.steerNext.set(world.key(worker), { outcome: "unknown" });
      const sent = await world.delegate(coordinator, worker, "Correction.", { deliverNow: true });
      if (phase === "journal") {
        expect(sent.deliverNow).toBe("verifying");
        world.beforeSteerJournal = finish;
        world.steerJournal = "dispatched";
        await world.storage.retryAgentMailInject(worker.environmentId, worker.tabId, sent.id);
        await world.deliver();
      } else expect(sent.deliverNow).toBe("steered");
      expect(
        await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, sent.id),
      ).toMatchObject({ placement: "injected", injectedVia: "steer" });
      // The normal reconciliation sweep recovers the missed completion edge
      // after its grace period, with no additional worker turn or dispatch.
      const time = spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
      try {
        await world.coordinator.reconcileWorkerDelegations();
        await world.deliver();
        await world.coordinator.reconcileWorkerDelegations();
        await world.deliver();
      } finally {
        time.mockRestore();
      }
      expect(world.wakes(coordinator)).toBe(1);
      expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(0);
      expect(world.received(worker)).toEqual([]);
      expect(world.steered(worker)).toEqual(phase === "handoff" ? ["Correction."] : []);
    });
  }
});
