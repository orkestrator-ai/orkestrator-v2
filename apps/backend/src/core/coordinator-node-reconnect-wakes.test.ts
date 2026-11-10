/**
 * Wakes for a coordinator refused on a disconnected node (3800 task 8): the
 * refusal records who tried, nothing is queued, and the reconnect tells each
 * conversation once. The coordinator side is the real mail world; the node
 * link is simulated.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import {
  coordinatorNodeTarget,
  registerCoordinatorNodeCommands,
} from "./commands-registry-coordinator-nodes.js";
import { createNodeTargets } from "./control-mcp-nodes.js";
import {
  CoordinatorNodeReconnectWakes,
  connectCoordinatorNodeWakes,
  NODE_RECONNECT_WAKE_MAX_AGE_MS,
  NODE_RECONNECT_WAKE_MAX_NODES,
  NODE_RECONNECT_WAKE_MAX_WAITERS,
  type CoordinatorNodeReconnectContext,
} from "./coordinator-node-reconnect-wakes.js";
import { NodeCoordination } from "./nodes/node-coordination.js";

type Sent = { requestId: string; toEnvironmentId: string; subject: string; body: string };

function fakeWakes(
  options: {
    now?: () => number;
    send?: (mail: Sent) => Promise<void>;
    address?: CoordinatorNodeReconnectContext["mainAddress"];
  } = {},
) {
  const sent: Sent[] = [];
  const wakes = new CoordinatorNodeReconnectWakes({
    storage: {
      sendAgentMail: (async (_from: unknown, mail: Sent) => {
        if (options.send) await options.send(mail);
        sent.push(mail);
        return {} as never;
      }) as never,
    },
    mainAddress:
      options.address ??
      (async (coordinatorId) => ({ environmentId: `${coordinatorId}:main`, tabId: "tab" })),
    nodeName: async () => "Build box",
    ...(options.now ? { now: options.now } : {}),
  });
  return { wakes, sent };
}

const attempt = (coordinatorId = "coord-1", nodeId = "bk_leaf") => ({
  projectId: "p1",
  coordinatorId,
  nodeId,
});

describe("CoordinatorNodeReconnectWakes", () => {
  test("each coordinator that tried is told once when the node reconnects", async () => {
    let now = Date.parse("2026-11-10T10:00:00.000Z");
    const { wakes, sent } = fakeWakes({ now: () => now });
    wakes.noteRefused(attempt("coord-1"));
    now += 60_000;
    wakes.noteRefused(attempt("coord-1"));
    wakes.noteRefused(attempt("coord-2"));
    wakes.noteRefused(attempt("coord-3", "bk_other"));
    expect(wakes.waitingOn("bk_leaf")).toBe(2);

    await wakes.nodeConnected("bk_leaf");
    expect(sent.map((mail) => mail.toEnvironmentId).sort()).toEqual([
      "coord-1:main",
      "coord-2:main",
    ]);
    const first = sent.find((mail) => mail.toEnvironmentId === "coord-1:main")!;
    expect(first.subject).toBe("Machine Build box reconnected");
    expect(first.body).toContain("Build box (nodeId bk_leaf) is connected again");
    expect(first.body).toContain(
      "2 times between 2026-11-10T10:00:00.000Z and 2026-11-10T10:01:00.000Z",
    );
    expect(first.body).toContain("nothing was started or queued there");
    expect(first.body).toContain("get_launch_options");
    // The request id is stable for one episode, so a retried send is one message.
    expect(first.requestId).toBe("node-reconnect-bk_leaf-coord-1-2026-11-10T10:00:00.000Z");

    // Told once: a second connect, or a flap, says nothing more.
    await wakes.nodeConnected("bk_leaf");
    expect(sent).toHaveLength(2);
    expect(wakes.waitingOn("bk_leaf")).toBe(0);
    expect(wakes.waitingOn("bk_other")).toBe(1);
  });

  test("reconciliation and the reconnect callback drain a waiter only once", async () => {
    const { wakes, sent } = fakeWakes();
    wakes.noteRefused(attempt());
    await Promise.all([wakes.nodeConnected("bk_leaf"), wakes.nodeConnected("bk_leaf")]);
    expect(sent).toHaveLength(1);
    expect(wakes.waitingOn("bk_leaf")).toBe(0);
  });

  test("a node nobody tried says nothing when it connects", async () => {
    const { wakes, sent } = fakeWakes();
    await wakes.nodeConnected("bk_leaf");
    expect(sent).toEqual([]);
  });

  test("an attempt older than the wake window is dropped unannounced", async () => {
    let now = 1_000_000;
    const { wakes, sent } = fakeWakes({ now: () => now });
    wakes.noteRefused(attempt("stale"));
    now += NODE_RECONNECT_WAKE_MAX_AGE_MS - 1_000;
    wakes.noteRefused(attempt("fresh"));
    now += 2_000;
    await wakes.nodeConnected("bk_leaf");
    expect(sent.map((mail) => mail.toEnvironmentId)).toEqual(["fresh:main"]);
  });

  test("memory is bounded: the stalest coordinator and node are evicted", async () => {
    const { wakes, sent } = fakeWakes();
    for (let i = 0; i <= NODE_RECONNECT_WAKE_MAX_WAITERS; i += 1)
      wakes.noteRefused(attempt(`c${i}`));
    expect(wakes.waitingOn("bk_leaf")).toBe(NODE_RECONNECT_WAKE_MAX_WAITERS);
    await wakes.nodeConnected("bk_leaf");
    expect(sent.map((mail) => mail.toEnvironmentId)).not.toContain("c0:main");

    for (let i = 0; i <= NODE_RECONNECT_WAKE_MAX_NODES; i += 1)
      wakes.noteRefused(attempt("c", `bk_${i}`));
    expect(wakes.waitingOn("bk_0")).toBe(0);
    expect(wakes.waitingOn(`bk_${NODE_RECONNECT_WAKE_MAX_NODES}`)).toBe(1);
  });

  test("a failed or duplicate send never throws and does not stop the others", async () => {
    const { wakes, sent } = fakeWakes({
      send: async (mail) => {
        if (mail.toEnvironmentId.startsWith("broken")) throw new Error("store unavailable");
        if (mail.toEnvironmentId.startsWith("dup"))
          throw new AgentMailError("idempotency-conflict", "already sent");
      },
    });
    wakes.noteRefused(attempt("broken"));
    wakes.noteRefused(attempt("dup"));
    wakes.noteRefused(attempt("ok"));
    await wakes.nodeConnected("bk_leaf");
    expect(sent.map((mail) => mail.toEnvironmentId)).toEqual(["ok:main"]);
  });

  test("a coordinator that is gone has nobody to tell", async () => {
    const { wakes, sent } = fakeWakes({ address: async () => null });
    wakes.noteRefused(attempt());
    await wakes.nodeConnected("bk_leaf");
    expect(sent).toEqual([]);
  });
});

describe("on the real coordinator", () => {
  const worlds: MailWorld[] = [];
  afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
  });

  async function world(connected = false) {
    const created = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
    worlds.push(created);
    const commands = new Map<string, CommandHandler>();
    registerCoordinatorNodeCommands(registrarFrom((name, handler) => commands.set(name, handler)));
    const context = {
      storage: created.storage,
      coordinators: created.coordinator,
      nodes: { link: () => ({ connected }) },
    } as unknown as CommandContext;
    const note = (scope: Record<string, unknown>, nodeId = "bk_leaf") =>
      commands.get("note_coordinator_node_unavailable")!({ scope, nodeId }, context);
    return { world: created, note, context };
  }

  test("a refused conversation is woken with one message when the node reconnects", async () => {
    const { world: w, note } = await world();
    const main = await w.main();
    const scope = {
      projectId: w.projectId,
      coordinatorId: w.coordinatorId,
      conversationId: main.conversationId!,
    };
    expect(await note(scope)).toEqual({ noted: true });
    await w.coordinator.nodeConnected("bk_leaf");
    await w.deliver();
    const received = w.received(main);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("bk_leaf");
    expect(received[0]).toContain("is connected again");
    await w.coordinator.nodeConnected("bk_leaf");
    await w.deliver();
    expect(w.received(main)).toHaveLength(1);
  });

  test("MCP stale offline summary is reconciled after reconnect and before registration", async () => {
    const { world: w, note } = await world(true);
    const main = await w.main();
    const scope = {
      projectId: w.projectId,
      coordinatorId: w.coordinatorId,
      conversationId: main.conversationId!,
    };
    const targets = createNodeTargets(
      (async (command: string, args: Record<string, unknown>) => {
        if (command === "get_node_status")
          return { mode: "command", nodeId: "bk_cmd", controllers: [] };
        if (command === "get_node_summaries") {
          // The old summary is on its way back while the live reconnect fires.
          await w.coordinator.nodeConnected("bk_leaf");
          return {
            nodes: [
              { nodeId: "bk_leaf", available: false, view: { displayName: "Leaf" }, projects: [] },
            ],
          };
        }
        if (command === "note_coordinator_node_unavailable")
          return note(args.scope as Record<string, unknown>);
        throw new Error(`unexpected ${command}`);
      }) as never,
      scope,
    );
    await expect(targets.targetOrSelf("bk_leaf")).rejects.toThrow("not connected");
    await w.deliver();
    expect(w.received(main)).toHaveLength(1);
    await w.coordinator.nodeConnected("bk_leaf");
    await w.deliver();
    expect(w.received(main)).toHaveLength(1);
  });

  test("backend stale offline summary reconciles the live link without another reconnect", async () => {
    const { world: w, context } = await world(true);
    const main = await w.main();
    context.nodes = {
      status: async () => ({ mode: "command", nodeId: "bk_cmd" }),
      link: () => ({ connected: true }),
    } as never;
    context.nodePortal = {
      summaries: async () => {
        await w.coordinator.nodeConnected("bk_leaf");
        return {
          nodes: [
            { nodeId: "bk_leaf", available: false, view: { displayName: "Leaf" }, projects: [] },
          ],
        };
      },
    } as never;
    await expect(
      coordinatorNodeTarget(
        context,
        {
          projectId: w.projectId,
          coordinatorId: w.coordinatorId,
          conversationId: main.conversationId!,
        },
        "bk_leaf",
      ),
    ).rejects.toThrow("not connected");
    await w.deliver();
    expect(w.received(main)).toHaveLength(1);
  });

  test("a refusal in a side conversation wakes the main, which is started if closed", async () => {
    const { world: w, note } = await world();
    const side = await w.addSide();
    await note({
      projectId: w.projectId,
      coordinatorId: w.coordinatorId,
      conversationId: side.conversationId!,
    });
    await w.closeMain();
    await w.coordinator.nodeConnected("bk_leaf");
    await w.deliver();
    const main = await w.main();
    expect(w.received(side)).toHaveLength(0);
    expect(w.received(main)).toHaveLength(1);
    expect(w.received(main)[0]).toContain("is connected again");
  });

  test("the command refuses a scope that is not a coordinator conversation", async () => {
    const { world: w, note } = await world();
    await expect(
      note({ projectId: w.projectId, coordinatorId: w.coordinatorId, conversationId: "nope" }),
    ).rejects.toThrow();
  });
});

describe("the coordinator tools' node gate", () => {
  function gate(options: { noteFails?: boolean } = {}) {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = (async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === "get_node_status")
        return { mode: "command", nodeId: "bk_cmd", controllers: [] };
      if (command === "get_node_summaries")
        return {
          nodes: [
            {
              nodeId: "bk_leaf",
              available: false,
              view: { displayName: "Build box" },
              projects: [],
            },
          ],
        };
      if (command === "note_coordinator_node_unavailable") {
        if (options.noteFails) throw new Error("backend busy");
        return { noted: true };
      }
      throw new Error(`unexpected ${command}`);
    }) as never;
    const scope = { projectId: "p1", coordinatorId: "coord-1", conversationId: "conv-1" };
    return { targets: createNodeTargets(invoke, scope), calls, scope };
  }

  test("a disconnected node is refused, and the attempt is noted for the reconnect wake", async () => {
    const { targets, calls, scope } = gate();
    await expect(targets.targetOrSelf("bk_leaf")).rejects.toThrow(
      "You will get one message when it reconnects",
    );
    expect(
      calls.find((call) => call.command === "note_coordinator_node_unavailable")?.args,
    ).toEqual({ scope, nodeId: "bk_leaf" });
  });

  test("the refusal stands when the note cannot be recorded", async () => {
    const { targets } = gate({ noteFails: true });
    await expect(targets.targetOrSelf("bk_leaf")).rejects.toThrow("Build box is not connected");
  });
});

describe("NodeCoordination.onNodeConnected", () => {
  test("listeners hear each node that connects or reconnects, once per transition", async () => {
    const world = await MailWorld.create();
    let listener: () => void = () => {};
    let connected: string[] = [];
    const nodes = {
      listControllers: () => [],
      selfIdentity: async () => "bk_cmd",
      subscribe: (next: () => void) => {
        listener = next;
        return () => {};
      },
      listNodes: async () => ({
        nodes: connected.map((nodeId) => ({ nodeId, connection: { state: "connected" } })),
      }),
      link: () => null,
    };
    const instance = new NodeCoordination({
      storage: world.storage,
      nodes: nodes as never,
      portal: {
        readModel: { onNodeEvent: () => () => {} },
        summaries: async () => ({ nodes: [] }),
      } as never,
      invoke: async () => undefined as never,
      emit: () => {},
    });
    try {
      const main = await world.main();
      world.coordinator.noteNodeUnavailable({
        projectId: world.projectId,
        coordinatorId: world.coordinatorId,
        nodeId: "bk_leaf",
      });
      const unsubscribe = connectCoordinatorNodeWakes(instance, world.coordinator);
      const heard: string[] = [];
      instance.onNodeConnected((nodeId) => heard.push(nodeId));
      // A throwing listener does not stop the others.
      instance.onNodeConnected(() => {
        throw new Error("listener failed");
      });
      const settle = async () => {
        listener();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      };
      connected = ["bk_leaf"];
      await settle();
      await settle();
      expect(heard).toEqual(["bk_leaf"]);
      connected = [];
      await settle();
      connected = ["bk_leaf"];
      await settle();
      expect(heard).toEqual(["bk_leaf", "bk_leaf"]);
      // The production subscription delivers to the real main-conversation mailbox.
      await world.deliver();
      expect(world.received(main)).toHaveLength(1);
      expect(world.received(main)[0]).toContain("is connected again");
      unsubscribe();
    } finally {
      instance.dispose();
      await world.close();
    }
  });
});
