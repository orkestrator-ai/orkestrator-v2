import { eventSink } from "../backend-emit.js";
import { registrarFrom } from "../commands-registry-contracts.js";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createHash } from "node:crypto";
import { access, utimes } from "node:fs/promises";

import { renderAgentMailCarrier } from "@orkestrator/protocol/agent-mail";
import { MailWorld } from "../agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerNodeCommands } from "../commands-registry-nodes.js";
import { NodeCoordination } from "./node-coordination.js";
import { WorkerTabCloseAdmission } from "../worker-tab-close-admission.js";

/**
 * Leaf mail over the real mail store: a command node's coordinator mails an
 * agent on this (leaf) node, the agent replies to "coordinator", and the
 * reply waits in this leaf's outbox for that command node.
 */

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

function coordination(world: MailWorld, controllers: Array<{ id: string; name: string }>) {
  const nodes = {
    mode: () => "leaf",
    listControllers: () =>
      controllers.map((entry) => ({
        controllerId: entry.id,
        displayName: entry.name,
        attachedAt: "",
        lastContactAt: "",
      })),
    mostRecentControllerId: () => controllers[0]?.id,
    selfIdentity: async () => "bk_leaf",
    link: () => null,
    getNode: async () => ({ displayName: "node" }),
    subscribe: () => () => undefined,
    listNodes: async () => ({ nodes: [] }),
  };
  const portal = { readModel: { onNodeEvent: () => () => undefined } };
  const events: Array<{ event: string; payload: unknown }> = [];
  const instance = new NodeCoordination({
    storage: world.storage,
    nodes: nodes as never,
    portal: portal as never,
    invoke: async () => undefined as never,
    emit: eventSink((event, payload) => events.push({ event, payload })),
  });
  return { instance, events };
}

test("receive-only lifecycle expires abandoned incoming batches on startup and maintenance", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const { instance } = coordination(world, []);
  let maintenance: (() => void) | undefined;
  const interval = globalThis.setInterval;
  const clock = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    if (ms === 30_000) maintenance = callback;
    return interval(callback, ms);
  }) as typeof setInterval);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const incoming = async (batch: string, commit = true) => {
    const scope = { mailAttachments: batch };
    const bytes = Buffer.from("incoming image bytes");
    const upload = await instance.files.beginWrite({
      scope,
      path: "shot.png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      overwrite: false,
    });
    await instance.files.appendWrite(upload.uploadId, bytes.toString("base64"));
    if (commit) await instance.files.commitWrite(upload.uploadId);
    const directory = await instance.files.root(scope);
    await utimes(directory, old, old);
    return { directory, uploadId: upload.uploadId };
  };
  const removed = async (directory: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await access(directory).then(
          () => false,
          () => true,
        )
      )
        return;
      await Bun.sleep(5);
    }
    expect(
      await access(directory).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
  };
  try {
    const startup = await incoming("a".repeat(32));
    const outbox = await incoming("outbox-" + "b".repeat(32));
    const active = await incoming("c".repeat(32), false);
    instance.start();
    await removed(startup.directory);
    await access(outbox.directory);
    await access(active.directory);
    const abandoned = await incoming("d".repeat(32));
    maintenance!();
    await removed(abandoned.directory);
    await access(outbox.directory);
    await access(active.directory);
    await instance.files.abortWrite(active.uploadId);
  } finally {
    clock.mockRestore();
    instance.dispose();
  }
});

describe("CO-05/UP-02 coordinator mail to and from a leaf agent", () => {
  for (const policy of ["muted", "off", "hourly-limit"] as const) {
    test(`leaf response preserves the ${policy} placement and reason`, async () => {
      const world = await MailWorld.create();
      worlds.push(world);
      const worker = await world.addEnvironment("worker");
      const { instance } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);
      const input = {
        controllerId: "bk_cmd",
        coordinatorEnvironmentId: "coordinator:c1:conv-1",
        coordinatorTabId: "coord-tab",
        requestId: "first",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        body: "Correction.",
      };
      if (policy === "hourly-limit") {
        const config = await world.storage.loadConfig();
        await world.storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, hourlyWakeLimit: 1 },
        });
        await instance.deliverIncoming(input);
      } else
        await world.storage.updateAgentMailboxPolicy(
          worker.environmentId,
          worker.tabId,
          policy === "muted" ? { mutedInbound: true } : { inject: "off" },
        );
      expect(await instance.deliverIncoming({ ...input, requestId: "second" })).toMatchObject({
        placement: policy === "muted" ? "bounced" : policy === "off" ? "stored" : "inject-held",
        placementReason:
          policy === "muted"
            ? "recipient-muted"
            : policy === "off"
              ? "inject-policy-off"
              : "hourly-limit",
      });
    });
  }

  test("mail-origin framing reaches the leaf's own coordinator", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
    const { instance } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);
    for (const origin of ["mail", undefined] as const) {
      const { messageId } = await instance.deliverIncoming({
        controllerId: "bk_cmd",
        coordinatorEnvironmentId: "coordinator:c1:conv-1",
        coordinatorTabId: "coord-tab",
        projectId: world.projectId,
        toEnvironmentId: "coordinator",
        toTabId: "",
        requestId: `origin-${origin}`,
        body: "Status?",
        ...(origin ? { turnOrigin: origin } : {}),
      });
      const message = await world.storage.getAgentMailMessage(
        main.environmentId,
        main.tabId,
        messageId,
      );
      expect(renderAgentMailCarrier(message).includes("arose from agent mail")).toBe(
        origin === "mail",
      );
      expect(message.from).toMatchObject({ kind: "node", role: "coordinator" });
    }
  });

  test("a command node's mail from a turn the user did not start says so on the leaf", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker");
    const { instance } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);
    world.startTurn(worker);
    const input = {
      controllerId: "bk_cmd",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: "Please report your status.",
    };
    const carrier = async (requestId: string, extra: Record<string, unknown>) => {
      const { messageId } = await instance.deliverIncoming({ ...input, requestId, ...extra });
      return renderAgentMailCarrier(
        await world.storage.getAgentMailMessage(worker.environmentId, worker.tabId, messageId),
      );
    };
    expect(await carrier("from-mail", { turnOrigin: "mail" })).toContain("arose from agent mail");
    expect(await carrier("from-user", {})).not.toContain("arose from agent mail");
    await world.finishTurn(worker);
  });

  test("delivers as ordinary incoming mail and routes the agent's answer to that command node's outbox", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker");
    const { instance, events } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);

    // Hold the recipient's turn so the subscribed drain cannot inject between
    // publication and the placement assertions below.
    world.startTurn(worker);
    const delivered = await instance.deliverIncoming({
      controllerId: "bk_cmd",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
      requestId: "mail-1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: "Please report your status.",
    });
    // Admitted as ordinary mail waiting to wake the agent.
    expect(delivered.placement).toBe("pending-inject");
    // End the held recipient turn, then drain its pending mail.
    await world.finishTurn(worker);
    const incoming = await world.storage.getAgentMailMessage(
      worker.environmentId,
      worker.tabId,
      delivered.messageId,
    );
    expect(incoming.body).toContain("From the coordinator on Office desktop");
    expect(incoming.body).toContain("Please report your status.");
    // The node link authenticates it: same-project coordinator mail that wakes the agent.
    expect(incoming.from).toMatchObject({
      kind: "node",
      role: "coordinator",
      nodeId: "bk_cmd",
      nodeName: "Office desktop",
    });
    expect(incoming.trust).toBe("same-project");
    expect(incoming.route).toBe("coordinator");
    expect(incoming.placement).toBe("injected");
    expect(world.received(worker)).toEqual([incoming.body]);
    // The command node's transcript names the recipient by environment and tab.
    const tabName = (await world.storage.getAgentMailMailbox(worker.environmentId, worker.tabId))
      .descriptor.displayName;
    expect(tabName).toBeTruthy();
    expect(delivered).toMatchObject({ toEnvironmentName: "worker", toTabName: tabName });

    // The agent answers "coordinator": it goes to the command node that asked.
    const router = world.storage.nodeMailRouter!;
    const destination = await router.route({
      fromEnvironmentId: worker.environmentId,
      toEnvironmentId: "coordinator",
    });
    expect(destination).toMatchObject({ controllerId: "bk_cmd", coordinatorTabId: "coord-tab" });
    await router.enqueue(destination!, {
      requestId: "reply-1",
      fromEnvironmentId: worker.environmentId,
      fromTabId: worker.tabId,
      body: "All tests pass.",
    });
    expect(events.some((entry) => entry.event === "node-outbox-ready")).toBe(true);
    const outbox = await instance.leafMail.collect("bk_cmd" as never, 0);
    expect(outbox.items).toEqual([
      expect.objectContaining({
        body: "All tests pass.",
        fromEnvironmentName: "worker",
        fromTabName: tabName,
        toCoordinator: { environmentId: "coordinator:c1:conv-1", tabId: "coord-tab" },
      }),
    ]);
    // A reply on the coordinator's thread is routed the same way.
    expect(
      await router.route({
        fromEnvironmentId: worker.environmentId,
        toEnvironmentId: "",
        replyToMessageId: delivered.messageId,
      }),
    ).toMatchObject({ controllerId: "bk_cmd" });
  });

  test("an unattached command node cannot deliver mail, and without one mail stays local", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker");
    const { instance } = coordination(world, []);
    await expect(
      instance.deliverIncoming({
        controllerId: "bk_stranger",
        coordinatorEnvironmentId: "coordinator:c1:conv-1",
        coordinatorTabId: "coord-tab",
        toEnvironmentId: worker.environmentId,
        body: "hi",
      }),
    ).rejects.toThrow("Only an attached command node");
    expect(
      await world.storage.nodeMailRouter!.route({
        fromEnvironmentId: worker.environmentId,
        toEnvironmentId: "coordinator",
      }),
    ).toBeNull();
  });

  test("an agent no coordinator has contacted mails the command node even with a coordinator here", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const agent = await world.addEnvironment("agent");
    coordination(world, [{ id: "bk_cmd", name: "arktech-mini" }]);
    expect(await world.storage.coordinators.getCoordinatorWorkspace(world.projectId)).toBeTruthy();
    expect(
      await world.storage.nodeMailRouter!.route({
        fromEnvironmentId: agent.environmentId,
        fromTabId: agent.tabId,
        toEnvironmentId: "coordinator",
      }),
    ).toMatchObject({ controllerId: "bk_cmd", controllerName: "arktech-mini" });
  });

  // Delegations are not the only local contact: a leaf coordinator's build
  // pipeline reports to it too, and has no `environment` association.
  for (const kind of ["build-pipeline", "multi-review", "graph-run"] as const) {
    test(`a ${kind} the local coordinator started keeps its environment mail local`, async () => {
      const world = await MailWorld.create();
      worlds.push(world);
      const worker = await world.addEnvironment("pipeline-worker");
      coordination(world, [{ id: "bk_cmd", name: "arktech-mini" }]);
      const route = () =>
        world.storage.nodeMailRouter!.route({
          fromEnvironmentId: worker.environmentId,
          fromTabId: worker.tabId,
          toEnvironmentId: "coordinator",
        });
      expect(await route()).toMatchObject({ controllerId: "bk_cmd" });
      const pipelines =
        kind === "graph-run"
          ? spyOn(world.storage.graphRuns, "getGraphRun").mockResolvedValue({
              environmentId: worker.environmentId,
            } as never)
          : kind === "build-pipeline"
            ? spyOn(world.storage, "getBuildPipelineEnvironmentId").mockResolvedValue(
                worker.environmentId,
              )
            : spyOn(world.storage, "getMultiReviewWorkflow").mockResolvedValue({
                snapshot: { environmentId: worker.environmentId },
              } as never);
      const main = await world.main();
      try {
        await world.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: "pipeline-association",
          projectId: world.projectId,
          coordinatorId: world.coordinatorId,
          conversationId: main.conversationId!,
          kind,
          resourceId: "pipeline-1",
          requestId: "pipeline-request",
          createdAt: new Date().toISOString(),
        });
        await world.storage.coordinators.completeCoordinatorWorkflowAssociation(
          "pipeline-association",
          "pipeline-1",
        );
        // An older association must not require another full workflow read.
        await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
          id: "older-workflow",
          projectId: world.projectId,
          coordinatorId: world.coordinatorId,
          conversationId: main.conversationId!,
          kind,
          resourceId: "older",
          requestId: "older",
          createdAt: "2000-01-01T00:00:00.000Z",
        });
        expect(await route()).toBeNull();
        expect(pipelines).toHaveBeenCalledTimes(1);
      } finally {
        pipelines.mockRestore();
      }
    });
  }

  for (const body of ["Please create build environments.", "a".repeat(32768), "é".repeat(16384)]) {
    test(`hand-back preserves a ${Buffer.byteLength(body)} byte payload and leaves the outbox`, async () => {
      const world = await MailWorld.create();
      worlds.push(world);
      const agent = await world.addEnvironment("agent");
      const { instance } = coordination(world, [{ id: "bk_cmd", name: "arktech-mini" }]);
      const router = world.storage.nodeMailRouter!;
      const destination = await router.route({
        fromEnvironmentId: agent.environmentId,
        fromTabId: agent.tabId,
        toEnvironmentId: "coordinator",
      });
      const queued = await router.enqueue(destination!, {
        requestId: "handed-back",
        fromEnvironmentId: agent.environmentId,
        fromTabId: agent.tabId,
        body,
      });

      await expect(instance.returnOutboxMail("bk_stranger" as never, queued.seq)).rejects.toThrow(
        "Only an attached command node",
      );
      await instance.returnOutboxMail("bk_cmd" as never, queued.seq);

      const main = await world.main();
      const { messages } = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
      expect(messages).toHaveLength(1);
      const message = await world.storage.getAgentMailMessage(
        main.environmentId,
        main.tabId,
        messages[0]!.id,
      );
      expect(message.fallbackNotice).toContain(
        "arktech-mini has no coordinator for this repository",
      );
      expect(message.body).toBe(body);
      expect(message.from).toMatchObject({ kind: "tab", environmentId: agent.environmentId });
      expect((await instance.leafMail.collect("bk_cmd" as never, 0)).items).toEqual([]);
      // Already gone: a repeat from a lost answer does nothing.
      await instance.returnOutboxMail("bk_cmd" as never, queued.seq);
      expect(
        (await world.storage.getAgentMailMailbox(main.environmentId, main.tabId)).messages,
      ).toHaveLength(1);
    });
  }

  for (const mode of ["explicit", "fromCoordinator", "toCoordinator", "missing"] as const) {
    test(`hand-back refuses ${mode} mail without removing it`, async () => {
      const world = await MailWorld.create();
      worlds.push(world);
      const agent = await world.addEnvironment("agent");
      const { instance } = coordination(world, [{ id: "bk_cmd", name: "Command" }]);
      const queued = await instance.leafMail.enqueue("bk_cmd" as never, {
        requestId: mode,
        fromEnvironmentId: mode === "missing" ? "gone" : agent.environmentId,
        fromTabId: agent.tabId,
        body: "payload",
        ...(mode === "explicit" ? { allowLocalFallback: false as const } : {}),
        ...(mode === "fromCoordinator" ? { fromCoordinator: true as const } : {}),
        ...(mode === "toCoordinator"
          ? { toCoordinator: { environmentId: "coord", tabId: "tab" } }
          : {}),
      });
      await expect(instance.returnOutboxMail("bk_cmd" as never, queued.seq)).rejects.toThrow(
        mode === "missing" ? "no longer exists" : "addressed",
      );
      expect((await instance.leafMail.collect("bk_cmd" as never, 0, true)).items).toHaveLength(1);
      const main = await world.main();
      expect(
        (await world.storage.getAgentMailMailbox(main.environmentId, main.tabId)).messages,
      ).toHaveLength(0);
    });
  }

  // Regression (2026-10-26): on a leaf attached to a command node, a local
  // coordinator's worker reported to "coordinator" and the report went to the
  // command node's outbox. The local coordinator never saw it, and its
  // delegation closed as "finished without sending a report".
  test("a local coordinator's worker reports locally until a command node's coordinator contacts it", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker", { launched: true });
    const { instance } = coordination(world, [{ id: "bk_cmd", name: "arktech-mini" }]);
    const router = world.storage.nodeMailRouter!;
    const route = () =>
      router.route({
        fromEnvironmentId: worker.environmentId,
        fromTabId: worker.tabId,
        toEnvironmentId: "coordinator",
      });
    expect(await route()).toBeNull();
    // Sent locally, the report is held for the open delegation, not lost.
    const report = await world.send(worker, "coordinator", "Needs npm login: https://…");
    expect(report.toEnvironmentId).toBe((await world.main()).environmentId);
    expect(report.placement).toBe("inject-held");

    // The command node's coordinator writes to it: now that one is primary.
    const delivered = await instance.deliverIncoming({
      controllerId: "bk_cmd",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
      requestId: "remote-1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: "Status?",
    });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd", coordinatorTabId: "coord-tab" });

    // The local coordinator writes again: local is primary again, while a
    // reply to the command node's message still goes back to it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await world.delegate(await world.main(), worker, "One more thing.");
    expect(await route()).toBeNull();
    expect(
      await router.route({
        fromEnvironmentId: worker.environmentId,
        fromTabId: worker.tabId,
        toEnvironmentId: "",
        replyToMessageId: delivered.messageId,
      }),
    ).toMatchObject({ controllerId: "bk_cmd" });
  });
});

describe("a command node's deliverNow on this leaf", () => {
  async function leaf(worker: { launched?: boolean; terminal?: boolean } = {}) {
    const world = await MailWorld.create();
    worlds.push(world);
    const recipient = await world.addEnvironment("worker", worker);
    const { instance } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);
    const commands = new Map<string, CommandHandler>();
    registerNodeCommands(registrarFrom((name, handler) => commands.set(name, handler)));
    const context = {
      storage: world.storage,
      nodeCoordination: instance,
      drainAgentMail: mock(() => world.mail.drainInjects()),
    } as unknown as CommandContext;
    let counter = 0;
    const deliver = (body: string, extra: Record<string, unknown> = {}) =>
      commands.get("deliver_node_mail")!(
        {
          controllerId: "bk_cmd",
          coordinatorEnvironmentId: "coordinator:c1:conv-1",
          coordinatorTabId: "coord-tab",
          requestId: `remote-${(counter += 1)}`,
          toEnvironmentId: recipient.environmentId,
          toTabId: recipient.tabId,
          body,
          ...extra,
        },
        context,
      ) as Promise<Record<string, unknown>>;
    return { world, recipient, deliver, drain: context.drainAgentMail! };
  }

  test("a muted recipient bounces and replays without reading the mailbox or draining", async () => {
    const { world, recipient, deliver, drain } = await leaf({ launched: true });
    await world.storage.updateAgentMailboxPolicy(recipient.environmentId, recipient.tabId, {
      mutedInbound: true,
    });
    const read = spyOn(world.storage, "getAgentMailMessage");
    try {
      const input = { steer: true, requestId: "muted-replay" };
      const result = await deliver("Correction.", input);
      expect(result).toMatchObject({
        placement: "bounced",
        placementReason: "recipient-muted",
        deliverNow: "not queued",
        deliverNowNote: expect.stringContaining("recipient-muted"),
      });
      expect(await deliver("Correction.", input)).toEqual(result);
      expect(read).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      expect(world.steered(recipient)).toEqual([]);
      expect(world.received(recipient)).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  test("a busy native worker gets the correction steered into its running turn", async () => {
    const { world, recipient, deliver } = await leaf({ launched: true });

    const result = await deliver("Stop: the requirement changed.", { steer: true });

    expect(result).toMatchObject({
      placement: "injected",
      injectedVia: "steer",
      deliverNow: "steered",
    });
    expect(result).not.toHaveProperty("placementReason");
    expect(world.steered(recipient)).toHaveLength(1);
    expect(world.steered(recipient)[0]).toContain("Stop: the requirement changed.");
    expect(world.wakes(recipient)).toBe(0);
  });

  test("an idle worker gets an ordinary delivery", async () => {
    const { world, recipient, deliver } = await leaf();

    expect(await deliver("Add the docs too.", { steer: true })).toMatchObject({
      placement: "injected",
      deliverNow: "delivered",
    });
    expect(world.steered(recipient)).toEqual([]);
    expect(world.received(recipient)).toHaveLength(1);
  });

  for (const held of [false, true]) {
    test(`node coordinator requests stay pending while ${held ? "held" : "queued"}, until injection`, async () => {
      const { world, recipient, deliver } = await leaf({ launched: true });
      if (held) {
        const config = await world.storage.loadConfig();
        await world.storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, hourlyWakeLimit: 1 },
        });
        await deliver("Uses the first wake budget.");
        // Settle this delivery before releasing another message. Otherwise its
        // busy backoff can expire under suite load and consume the next turn.
        await world.finishTurn(recipient);
      }
      const result = await deliver("Pending remote request.");
      expect(result.placement).toBe(held ? "inject-held" : "pending-inject");
      expect(
        await world.storage.hasUndeliveredCoordinatorRequest(
          recipient.environmentId,
          recipient.tabId,
        ),
      ).toBe(true);
      if (held) {
        await world.storage.retryAgentMailInject(
          recipient.environmentId,
          recipient.tabId,
          String(result.messageId),
        );
      }
      await world.finishTurn(recipient);
      expect(
        await world.storage.getAgentMailMessage(
          recipient.environmentId,
          recipient.tabId,
          String(result.messageId),
        ),
      ).toMatchObject({ placement: "injected" });
      expect(
        await world.storage.hasUndeliveredCoordinatorRequest(
          recipient.environmentId,
          recipient.tabId,
        ),
      ).toBe(false);
    });
  }

  test("a terminal worker reports unsupported and keeps the mail for turn end", async () => {
    const { world, recipient, deliver } = await leaf({ launched: true, terminal: true });

    expect(await deliver("Also fix the lint.", { steer: true })).toMatchObject({
      placement: "pending-inject",
      placementReason: "steer-unsupported",
      deliverNow: "unsupported, queued",
    });
    await world.finishTurn(recipient);
    expect(world.received(recipient)).toHaveLength(1);
  });

  test("without steer a busy worker's mail waits for its turn to end, and nothing is settled", async () => {
    const { world, recipient, deliver } = await leaf({ launched: true });

    const result = await deliver("Routine.");
    expect(result).toMatchObject({ placement: "pending-inject" });
    expect(result).not.toHaveProperty("deliverNow");
    expect(world.steered(recipient)).toEqual([]);
  });

  // Strict until plan item 1010: `deliver_node_mail` is now a defined command,
  // whose arguments decode tolerantly (§11.4). An unknown key is dropped; a
  // must-understand one would be named in the envelope's `critical` list.
  test("other unknown fields are dropped, not refused, and do not steer", async () => {
    const { world, recipient, deliver } = await leaf({ launched: true });
    const result = await deliver("hi", { deliverNow: true });
    expect(result).toMatchObject({ placement: "pending-inject" });
    expect(result).not.toHaveProperty("deliverNow");
    expect(world.steered(recipient)).toEqual([]);
  });
});

describe("UP-02/CO-05 collected leaf mail reaches the coordinator on the command node", () => {
  test("an item for a known conversation lands in that coordinator's mailbox, then is acknowledged", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
    // Keep the recipient busy so this admission assertion cannot race the
    // automatic injection drain; delivery itself has separate coverage.
    world.startTurn(main);
    const acks: number[] = [];
    const link = {
      connected: true,
      invoke: async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (command === "collect_node_outbox") {
          return {
            items: acks.length
              ? []
              : [
                  {
                    seq: 7,
                    requestId: "reply-1",
                    createdAt: "",
                    fromEnvironmentId: "leaf-env",
                    fromEnvironmentName: "worker",
                    fromTabId: "startup-agent",
                    fromTabName: "Claude 2",
                    toCoordinator: { environmentId: main.environmentId, tabId: main.tabId },
                    body: "All tests pass.",
                    bytes: 15,
                  },
                ],
            more: false,
          } as T;
        }
        if (command === "ack_node_outbox") acks.push(...(args.sequences as number[]));
        return {} as T;
      },
    };
    const nodes = {
      listControllers: () => [],
      mostRecentControllerId: () => undefined,
      selfIdentity: async () => "bk_cmd",
      link: () => link,
      getNode: async () => ({ displayName: "Build box" }),
      subscribe: () => () => undefined,
      listNodes: async () => ({ nodes: [] }),
    };
    const instance = new NodeCoordination({
      storage: world.storage,
      nodes: nodes as never,
      portal: { readModel: { onNodeEvent: () => () => undefined } } as never,
      invoke: async () => undefined as never,
      emit: () => undefined,
    });
    await instance.collector.collect("bk_leaf" as never);
    expect(acks).toEqual([7]);
    // End the held recipient turn, then drain its pending mail.
    await world.finishTurn(main);
    const mailbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId, {
      limit: 10,
    });
    const received = mailbox.messages.at(-1)!;
    const message = await world.storage.getAgentMailMessage(
      main.environmentId,
      main.tabId,
      received.id,
    );
    expect(message.body).toContain(
      "From worker (environment leaf-env), tab startup-agent, on node Build box",
    );
    expect(message.body).toContain('Reply with send_message and nodeId "bk_leaf"');
    expect(message.body).toContain("All tests pass.");
    // Authenticated by the node link: it wakes the coordinator like a local worker's report.
    expect(message.from).toMatchObject({
      kind: "node",
      role: "agent",
      nodeId: "bk_leaf",
      environmentId: "leaf-env",
      tabId: "startup-agent",
      // Named like a local worker: its environment and its tab.
      environmentName: "worker",
      title: "Claude 2",
    });
    expect(message.trust).toBe("same-project");
    expect(message.placement).toBe("injected");
    expect(world.received(main)).toEqual([message.body]);
  });

  test("a report from a leaf worker the coordinator is waiting on is held until the delegation settles", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
    const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "remote-launch",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: main.conversationId!,
      kind: "environment",
      resourceId: "leaf-env",
      nodeId: "bk_leaf",
      requestId: "launch-remote",
      createdAt: new Date().toISOString(),
    });
    await world.storage.coordinators.openCoordinatorDelegation(
      new WorkerTabCloseAdmission(),
      association.id,
      "startup-agent",
    );
    let collected = false;
    const link = {
      connected: true,
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "collect_node_outbox") {
          const items = collected
            ? []
            : [
                {
                  seq: 1,
                  requestId: "report-1",
                  createdAt: "",
                  fromEnvironmentId: "leaf-env",
                  fromTabId: "startup-agent",
                  toCoordinator: { environmentId: main.environmentId, tabId: main.tabId },
                  body: "Done.",
                  bytes: 5,
                },
              ];
          collected = true;
          return { items, more: false } as T;
        }
        return {} as T;
      },
    };
    const instance = new NodeCoordination({
      storage: world.storage,
      nodes: {
        listControllers: () => [],
        mostRecentControllerId: () => undefined,
        selfIdentity: async () => "bk_cmd",
        link: () => link,
        getNode: async () => ({ displayName: "Build box" }),
        subscribe: () => () => undefined,
        listNodes: async () => ({ nodes: [] }),
      } as never,
      portal: { readModel: { onNodeEvent: () => () => undefined } } as never,
      invoke: async () => undefined as never,
      emit: () => undefined,
    });

    await instance.collector.collect("bk_leaf" as never);

    const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId, {
      limit: 10,
    });
    const report = inbox.messages.at(-1)!;
    expect(report.placement).toBe("inject-held");
    expect(report.placementReason).toBe("delegation-running");
    expect(
      await world.storage.hasDelegationHeldAgentMail(
        association.id,
        main.environmentId,
        main.tabId,
        "leaf-env",
        "startup-agent",
      ),
    ).toBe(true);
    // The turn end releases it as the wake.
    expect(
      await world.storage.releaseDelegationHeldAgentMail(
        association.id,
        main.environmentId,
        main.tabId,
        "leaf-env",
        "startup-agent",
      ),
    ).toBe(1);
  });
});

test("leaf mail addressed to a worker is retained while coordinator mail is delivered", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const worker = await world.addEnvironment("worker");
  const main = await world.main();
  const acks: number[] = [];
  const nodes = {
    listControllers: () => [],
    mostRecentControllerId: () => undefined,
    selfIdentity: async () => "bk_cmd",
    subscribe: () => () => {},
    listNodes: async () => ({ nodes: [] }),
    getNode: async () => ({ displayName: "Leaf" }),
    link: () => ({
      connected: true,
      invoke: async <T>(command: string, args: Record<string, unknown>) => {
        if (command === "collect_node_outbox")
          return {
            more: false,
            items: [worker, main].map((actor, i) => ({
              seq: i + 1,
              requestId: `r${i}`,
              fromEnvironmentId: "leaf-env",
              fromTabId: "t",
              body: "mail",
              bytes: 4,
              createdAt: "",
              toCoordinator: { environmentId: actor.environmentId, tabId: actor.tabId },
            })),
          } as T;
        acks.push(...(args.sequences as number[]));
        return {} as T;
      },
    }),
  };
  const instance = new NodeCoordination({
    storage: world.storage,
    nodes: nodes as never,
    portal: { readModel: { onNodeEvent: () => () => {} } } as never,
    invoke: async () => undefined as never,
    emit: () => {},
  });
  await instance.collector.collect("bk_leaf" as never);
  expect(acks).toEqual([2]);
  expect(
    (await world.storage.getAgentMailMailbox(worker.environmentId, worker.tabId, { limit: 10 }))
      .messages,
  ).toHaveLength(0);
  instance.collector.dispose();
});

test("multi-target unknown deletion reports earlier completed targets", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const main = await world.main();
  const nodes = {
    selfIdentity: async () => "bk_self",
    subscribe: () => () => {},
    listNodes: async () => ({ nodes: [] }),
  };
  const instance = new NodeCoordination({
    storage: world.storage,
    nodes: nodes as never,
    portal: {
      readModel: { onNodeEvent: () => () => {} },
      invokeOnNode: async () => ({ outcome: "unknown", outcomeId: "unknown" }),
    } as never,
    invoke: async () => ({ deleted: true }) as never,
    emit: () => {},
  });
  const request = await instance.actions.create({
    kind: "delete-environment",
    requestedBy: {
      projectId: world.projectId,
      coordinatorEnvironmentId: main.environmentId,
      coordinatorTabId: main.tabId,
    },
    targets: [
      { nodeId: "bk_self", nodeName: "Self", environmentId: "first", environmentName: "First" },
      { nodeId: "bk_leaf", nodeName: "Leaf", environmentId: "second", environmentName: "Second" },
    ],
  });
  const resolved = await instance.actions.resolve(request.requestId, "approve");
  expect(resolved.state).toBe("outcome-unknown");
  expect(resolved.result?.message).toContain("Already deleted “First” on Self");
  expect(resolved.result?.message).toContain("Second");
  instance.collector.dispose();
});

for (const scenario of ["selected", "fallback", "remote", "multiple", "failed"]) {
  test(`approved root-change ${scenario} execution and coordinator outcome mail`, async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
    const { instance } = coordination(world, []);
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    // Exercise the approval executor without a Docker or provider dependency.
    const options = (
      instance as unknown as {
        options: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
      }
    ).options;
    options.invoke = async (command, args) => {
      calls.push({ command, args });
      if (scenario === "failed") throw new Error("Changes do not apply");
      return { files: args.paths };
    };
    const notice = spyOn(world.storage, "sendAgentMail");
    const target = {
      nodeId: scenario === "remote" ? "bk_remote" : "bk_leaf",
      nodeName: "Leaf",
      environmentId: "worker",
      environmentName: "Worker",
      projectId: world.projectId,
      files: ["suggested.ts"],
    };
    const input = {
      requestId: `root-${scenario}`,
      kind: "apply-root-changes",
      targets: scenario === "multiple" ? [target, target] : [target],
      requestedBy: {
        coordinatorEnvironmentId: main.environmentId,
        coordinatorTabId: main.tabId,
        projectId: world.projectId,
      },
    };
    const request = await instance.createActionRequest(input);
    const duplicate = await instance.createActionRequest(input);
    expect(duplicate.requestId).toBe(request.requestId);
    expect(await instance.actions.list()).toHaveLength(1);
    const resolved = await instance.actions.resolve(
      request.requestId,
      "approve",
      scenario === "fallback" ? {} : { paths: ["selected.ts"] },
    );
    expect(resolved.state).toBe(
      ["remote", "multiple", "failed"].includes(scenario) ? "failed" : "executed",
    );
    if (["remote", "multiple"].includes(scenario)) expect(calls).toHaveLength(0);
    else
      expect(calls).toEqual([
        {
          command: "apply_project_root_changes",
          args: {
            environmentId: "worker",
            projectId: world.projectId,
            paths: [scenario === "fallback" ? "suggested.ts" : "selected.ts"],
          },
        },
      ]);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]![1]).toMatchObject({
      toEnvironmentId: main.environmentId,
      toTabId: main.tabId,
      requestId: `node-action:${request.requestId}:${resolved.state}`,
    });
    await instance.createActionRequest(input);
    expect(notice).toHaveBeenCalledTimes(1);
    notice.mockRestore();
  });
}

test("an approved account switch keeps its account fields and runs the Settings switch", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const main = await world.main();
  const { instance } = coordination(world, []);
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const options = (
    instance as unknown as {
      options: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    }
  ).options;
  options.invoke = async (command, args) => {
    calls.push({ command, args });
    return {};
  };
  const notice = spyOn(world.storage, "sendAgentMail");
  const request = await instance.createActionRequest({
    requestId: "switch-1",
    kind: "switch-agent-account",
    targets: [
      {
        nodeId: "bk_leaf",
        nodeName: "Leaf",
        platform: "claude",
        accountId: "acct-work",
        accountLabel: "Work",
        // Not a field this kind has: dropped.
        secret: "never stored",
      },
    ],
    requestedBy: {
      coordinatorEnvironmentId: main.environmentId,
      coordinatorTabId: main.tabId,
      projectId: world.projectId,
    },
    reason: "Switch when the limit is hit",
  });
  expect(request.targets).toEqual([
    {
      nodeId: "bk_leaf",
      nodeName: "Leaf",
      platform: "claude",
      accountId: "acct-work",
      accountLabel: "Work",
    },
  ]);
  const resolved = await instance.actions.resolve(request.requestId, "approve");
  expect(resolved).toMatchObject({ state: "executed", result: { code: "switched" } });
  expect(calls).toEqual([
    { command: "set_active_agent_account", args: { platform: "claude", accountId: "acct-work" } },
  ]);
  expect(notice.mock.calls[0]![1]).toMatchObject({
    toEnvironmentId: main.environmentId,
    subject: expect.stringContaining("Switch the active Claude account on Leaf to “Work”"),
    // Nothing restarts a tab a limit stopped; the coordinator is told to.
    body: expect.stringContaining("send each listed tab of that provider one short prompt"),
  });
  notice.mockRestore();
  instance.collector.dispose();
});

test("production take-back pass retries from the 60-second recovery timer", async () => {
  const world = await MailWorld.create();
  worlds.push(world);
  const { instance } = coordination(world, []);
  let minute: (() => void) | undefined;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    if (ms === 60_000) minute = callback;
    return interval(callback, ms);
  }) as typeof setInterval);
  const take = mock(async () => {
    throw new Error("temporary");
  });
  instance.setCoordinatorNotices({ deliverFromLeaf: async () => "delivered", takeBack: take });
  await instance.leafMail.enqueue("bk_gone" as never, {
    requestId: "recover",
    fromEnvironmentId: "machine",
    fromTabId: "notice",
    body: "notice",
    coordinatorNotice: { kind: "repository", createSession: true },
  });
  try {
    instance.start();
    await instance.takeBackNotices();
    expect(take).toHaveBeenCalledTimes(1);
    take.mockImplementation(async () => undefined as never);
    expect(minute).toBeDefined();
    minute!();
    await instance.takeBackNotices();
    expect(take).toHaveBeenCalledTimes(2);
    expect(await instance.leafMail.pending("bk_gone" as never)).toBe(0);
  } finally {
    timers.mockRestore();
    instance.dispose();
  }
});
