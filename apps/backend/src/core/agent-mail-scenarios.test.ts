/**
 * Multi-actor mail scenarios, with peer wake explicitly enabled where needed.
 * Each asserts what reached which agent and that no message
 * needed a person to deliver it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import { MailWorld } from "./agent-mail-world-test-support.js";

describe("agent mail between many actors", () => {
  let world: MailWorld;

  beforeEach(async () => {
    world = await MailWorld.create();
  });

  afterEach(async () => {
    await world.close();
  });

  test("two launched workers report to the coordinator once each, with no user action", async () => {
    const coordinator = await world.main();
    const alpha = await world.addEnvironment("alpha", { launched: true });
    const beta = await world.addEnvironment("beta", { launched: true });

    // Mid-turn reports are held, not delivered.
    await world.send(alpha, "coordinator", "alpha: done, PR opened");
    await world.send(beta, "coordinator", "beta: blocked on a failing test");
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(0);

    await world.finishTurn(alpha);
    expect(world.received(coordinator)).toEqual(["alpha: done, PR opened"]);
    await world.finishTurn(coordinator);
    await world.finishTurn(beta);
    expect(world.received(coordinator)).toEqual([
      "alpha: done, PR opened",
      "beta: blocked on a failing test",
    ]);
    expect(world.wakes(coordinator)).toBe(2);
    expect(await world.undelivered(coordinator)).toEqual([]);
  });

  test("a worker that finishes silently still wakes its coordinator once", async () => {
    const coordinator = await world.main();
    const quiet = await world.addEnvironment("quiet", { launched: true });
    await world.finishTurn(quiet);
    expect(world.wakes(coordinator)).toBe(1);
    expect(world.received(coordinator)[0]).toContain("without sending a report");
    // The notice carries its facts as data, so a transcript can show it as a
    // finished-worker tile without reading the prose.
    expect(world.carriers(coordinator)[0]![0]).toMatchObject({
      kind: "notice",
      from: { kind: "system" },
      notice: {
        resource: {
          kind: "agent-tab",
          environmentId: quiet.environmentId,
          tabId: "startup-agent",
          label: "quiet",
        },
        state: "completed",
        tone: "success",
      },
    });
  });

  test("a worker report reaches its coordinator as a plain message, not a notice", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("reporter", { launched: true });
    await world.send(worker, "coordinator", "done");
    await world.finishTurn(worker);
    const [carrier] = world.carriers(coordinator)[0]!;
    expect(carrier!.kind).toBe("message");
    expect(carrier!.notice).toBeUndefined();
  });

  test("the coordinator follows up by environment id and the worker answers", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, "coordinator", "first pass done");
    await world.finishTurn(worker);
    await world.finishTurn(coordinator);

    // No tab id: the environment resolves to its agent tab.
    const followUp = await world.delegate(
      coordinator,
      { environmentId: worker.environmentId, tabId: "" } as never,
      "also update the changelog",
    );
    expect(followUp.toTabId).toBe("startup-agent");
    await world.deliver();
    expect(world.received(worker)).toEqual(["also update the changelog"]);

    await world.send(worker, "coordinator", "changelog updated");
    await world.finishTurn(worker);
    expect(world.received(coordinator)).toEqual(["first pass done", "changelog updated"]);
  });

  test("peers hold a ten-message conversation unattended", async () => {
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, wakePeers: true },
    });
    const left = await world.addEnvironment("left");
    const right = await world.addEnvironment("right");
    for (let turn = 0; turn < 10; turn += 1) {
      const [from, to] = turn % 2 === 0 ? [left, right] : [right, left];
      await world.send(from, to, `message ${turn}`);
      await world.deliver();
      await world.finishTurn(to);
    }
    expect(world.received(right)).toEqual([0, 2, 4, 6, 8].map((turn) => `message ${turn}`));
    expect(world.received(left)).toEqual([1, 3, 5, 7, 9].map((turn) => `message ${turn}`));
  });

  test("a launched worker's sideways mail is stored, not woken", async () => {
    const alpha = await world.addEnvironment("alpha", { launched: true });
    const beta = await world.addEnvironment("beta", { launched: true });
    const peer = await world.addEnvironment("peer");
    const toSibling = await world.send(alpha, beta, "psst");
    const toPeer = await world.send(alpha, peer, "hello");
    const fromPeer = await world.send(peer, alpha, "hello back");
    for (const message of [toSibling, toPeer, fromPeer]) {
      expect(message).toMatchObject({ placement: "stored", placementReason: "isolated-route" });
    }
    await world.deliver();
    expect(world.wakes(peer)).toBe(0);
  });

  test("side agents talk to the main coordinator and nobody else", async () => {
    const coordinator = await world.main();
    const side = await world.addSide();
    const worker = await world.addEnvironment("worker", { launched: true });

    await world.send(side, "coordinator", "I think the parser is the culprit");
    await world.deliver();
    expect(world.received(coordinator)).toEqual(["I think the parser is the culprit"]);
    await world.finishTurn(coordinator);

    await world.send(coordinator, side, "check the lexer too");
    await world.deliver();
    expect(world.received(side)).toEqual(["check the lexer too"]);

    await expect(world.send(worker, side, "hi")).rejects.toMatchObject({ code: "policy-denied" });
    await expect(world.send(side, worker, "hi")).rejects.toMatchObject({
      code: "policy-denied",
    });
  });

  test("closing the main coordinator: the next report starts a new one that receives it", async () => {
    const original = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.closeMain();

    // The worker still knows only the old conversation's address.
    await world.send(worker, original, "done");
    await world.finishTurn(worker);

    const replacement = await world.main();
    expect(replacement.conversationId).not.toBe(original.conversationId);
    expect(world.received(replacement)).toEqual(["done"]);
  });

  test("an unsolicited stream from a worker pauses at the budget and tells the coordinator", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.finishTurn(worker);
    await world.finishTurn(coordinator);

    const budget = DEFAULT_AGENT_MESSAGING_SETTINGS.autonomousWakeBudget;
    const sent = [];
    for (let index = 0; index <= budget; index += 1) {
      sent.push(await world.send(worker, "coordinator", `note ${index}`));
    }
    expect(sent.at(-1)).toMatchObject({ placementReason: "loop-budget-exhausted" });
    // The coordinator works through what was delivered, a batch per turn.
    await world.deliver();
    for (let turn = 0; turn < 4; turn += 1) await world.finishTurn(coordinator);
    const notices = world
      .received(coordinator)
      .filter((body) => body.includes("unattended message budget"));
    expect(notices).toHaveLength(1);
    expect(world.received(coordinator)).not.toContain(`note ${budget}`);

    // A new request from the coordinator is a new budget.
    await world.delegate(coordinator, worker, "keep going");
    const next = await world.send(worker, "coordinator", "continuing");
    expect(next.placement).not.toBe("stored");
    expect(next.placementReason).not.toBe("loop-budget-exhausted");
  });

  test("a refused delivery is retried without anyone pressing Retry", async () => {
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, wakePeers: true },
    });
    const left = await world.addEnvironment("left");
    const right = await world.addEnvironment("right");
    world.refuseNext.add(`${right.environmentId}\0${right.logicalSessionKey}`);
    const message = await world.send(left, right, "eventually");
    await world.deliver();
    expect(
      (await world.storage.getAgentMailMessage(right.environmentId, right.tabId, message.id))
        .placementReason,
    ).toBe("retrying");
    expect(world.wakes(right)).toBe(0);
  });

  test("a follow-up to a busy worker joins its task: one wake, with both reports", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, "coordinator", "part one done");

    // The worker is still on its first request when the coordinator adds to it.
    const followUp = await world.delegate(coordinator, worker, "also add tests");
    expect(followUp.placement).toBe("pending-inject");
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);

    // Its first turn ends without having read the follow-up: no wake yet.
    await world.finishTurn(worker);
    expect(world.wakes(coordinator)).toBe(0);
    expect(world.received(worker)).toEqual(["also add tests"]);

    await world.send(worker, "coordinator", "tests added");
    await world.finishTurn(worker);
    expect(world.wakes(coordinator)).toBe(1);
    expect(world.received(coordinator)).toEqual(["part one done", "tests added"]);
  });

  test("a report held when the main was closed reaches the new main", async () => {
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, "coordinator", "the report");
    await world.closeMain();

    // The worker's turn ends; its wake starts a new main, which gets the report.
    await world.finishTurn(worker);
    const replacement = await world.main();
    expect(world.received(replacement)).toEqual(["the report"]);
  });

  test("coordinator mail for a stopped worker asks for it to be started, then arrives", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.finishTurn(worker);
    await world.finishTurn(coordinator);
    await world.setEnvironmentStatus(worker, "stopped");

    await world.delegate(coordinator, worker, "one more thing");
    await world.deliver();
    expect(world.startRequests).toContain(worker.environmentId);
    expect(world.received(worker)).toEqual([]);

    // Started (the backend does this for a local worker); the mail is delivered.
    await world.setEnvironmentStatus(worker, "running");
    await world.deliver();
    expect(world.received(worker)).toEqual(["one more thing"]);
  });

  test("peer mail never starts a stopped environment", async () => {
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, wakePeers: true },
    });
    const left = await world.addEnvironment("left");
    const right = await world.addEnvironment("right");
    await world.setEnvironmentStatus(right, "stopped");
    await world.send(left, right, "hello");
    await world.deliver();
    expect(world.startRequests).toEqual([]);
  });

  test("a backend restart mid-delegation loses nothing", async () => {
    const coordinator = await world.main();
    const worker = await world.addEnvironment("worker", { launched: true });
    await world.send(worker, "coordinator", "report before restart");

    await world.restart();
    await world.finishTurn(worker);
    expect(world.received(coordinator)).toEqual(["report before restart"]);
    await world.finishTurn(coordinator);

    // And a conversation continues normally afterwards.
    await world.delegate(coordinator, worker, "next");
    await world.deliver();
    expect(world.received(worker)).toEqual(["next"]);
  });
});
