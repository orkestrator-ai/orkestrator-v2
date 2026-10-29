import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { MailWorld } from "../agent-mail-world-test-support.js";
import { NodeCoordination } from "./node-coordination.js";

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
    emit: (event, payload) => events.push({ event, payload }),
  });
  return { instance, events };
}

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

  test("delivers as ordinary incoming mail and routes the agent's answer to that command node's outbox", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const worker = await world.addEnvironment("worker");
    const { instance, events } = coordination(world, [{ id: "bk_cmd", name: "Office desktop" }]);

    const delivered = await instance.deliverIncoming({
      controllerId: "bk_cmd",
      coordinatorEnvironmentId: "coordinator:c1:conv-1",
      coordinatorTabId: "coord-tab",
      requestId: "mail-1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      body: "Please report your status.",
    });
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
    expect(incoming.placement).toBe("pending-inject");
    expect(delivered.placement).toBe("pending-inject");
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

describe("UP-02/CO-05 collected leaf mail reaches the coordinator on the command node", () => {
  test("an item for a known conversation lands in that coordinator's mailbox, then is acknowledged", async () => {
    const world = await MailWorld.create();
    worlds.push(world);
    const main = await world.main();
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
    expect(message.placement).toBe("pending-inject");
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
    await world.storage.coordinators.openCoordinatorDelegation(association.id, "startup-agent");
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
