/**
 * The coordinator's `deliverNow`: mail a busy worker must see mid-turn is
 * steered into that turn, through the same pending-entry flag as Deliver now.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

    expect(sent.deliverNow).toBe("steered");
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
});
