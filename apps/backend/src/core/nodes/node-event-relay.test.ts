import { describe, expect, test } from "bun:test";

import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";
import {
  NODE_EVENT_WATCH_TTL_MS,
  RELAYED_NODE_EVENT,
  type RelayedNodeEvent,
} from "@orkestrator/protocol/node-events";

import { NodeEventRelay } from "./node-event-relay.js";
import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

async function commandWithLeaf() {
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  leaf.commands.set("get_projects", () => []);
  await command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
  await settle(40);
  return { network, command, leaf };
}

function relayed(node: TestNode): RelayedNodeEvent[] {
  return node.events
    .filter((entry) => entry.event === RELAYED_NODE_EVENT)
    .map((entry) => entry.payload as RelayedNodeEvent);
}

describe("relaying another node's events on request", () => {
  test("relays only the watched events, qualified by node, after a resync", async () => {
    const { command, leaf } = await commandWithLeaf();
    const watch = command.portal.events.watch({
      nodeId: "bk_leaf",
      prefixes: ["change-projection-changed"],
    });
    expect(watch.renewed).toBe(false);
    await settle(40);
    expect(relayed(command)).toContainEqual({ nodeId: "bk_leaf" as never, kind: "resync" });

    leaf.emit("change-projection-changed", { kind: "deleted", resourceKey: "k" });
    leaf.emit("agent-activity-changed", { environmentId: "e1" });
    leaf.emit("terminal-output-s1", { data: "secret" });
    await settle(40);

    const events = relayed(command).filter((frame) => frame.kind === "event");
    expect(events).toEqual([
      {
        nodeId: "bk_leaf" as never,
        kind: "event",
        event: "change-projection-changed",
        payload: { kind: "deleted", resourceKey: "k" },
      },
    ]);
  });

  test("one stream per node for the union of watches; the last unwatch closes it", async () => {
    const { command, leaf } = await commandWithLeaf();
    const first = command.portal.events.watch({ nodeId: "bk_leaf", prefixes: ["a-"] });
    const second = command.portal.events.watch({ nodeId: "bk_leaf", prefixes: ["b-", "a-"] });
    await settle(40);
    expect(command.portal.events.diagnostics().relays).toEqual([
      { nodeId: "bk_leaf" as never, prefixes: ["a-", "b-"] },
    ]);

    command.portal.events.unwatch(second.watchId);
    expect(command.portal.events.diagnostics().relays[0]?.prefixes).toEqual(["a-"]);
    command.portal.events.unwatch(first.watchId);
    expect(command.portal.events.diagnostics().relays).toEqual([]);

    await settle(40);
    const before = relayed(command).length;
    leaf.emit("a-thing", {});
    await settle(40);
    expect(relayed(command).length).toBe(before);
  });

  test("renewing keeps the lease; a lease the node does not hold reports so", async () => {
    const { command } = await commandWithLeaf();
    const watch = command.portal.events.watch({ nodeId: "bk_leaf", prefixes: ["a-"] });
    expect(
      command.portal.events.watch({ nodeId: "bk_leaf", prefixes: ["a-"], watchId: watch.watchId })
        .renewed,
    ).toBe(true);
    expect(
      command.portal.events.watch({ nodeId: "bk_leaf", prefixes: ["a-"], watchId: "unknown-id" })
        .renewed,
    ).toBe(false);
  });

  test("an unrenewed lease expires and its stream closes", async () => {
    const { network, command } = await commandWithLeaf();
    let now = 1_000;
    const emitted: unknown[] = [];
    const relay = new NodeEventRelay({
      nodes: command.service,
      emit: (_event, payload) => emitted.push(payload),
      fetchImpl: network.fetch,
      now: () => now,
    });
    relay.start();
    relay.watch({ nodeId: "bk_leaf", prefixes: ["a-"] });
    expect(relay.diagnostics().relays).toHaveLength(1);
    now += NODE_EVENT_WATCH_TTL_MS;
    relay.watch({ nodeId: "bk_other", prefixes: ["a-"] });
    expect(relay.diagnostics().relays.map((entry) => entry.nodeId)).toEqual([]);
    expect(relay.diagnostics().watches).toBe(1);
    relay.stop();
  });

  test("refuses terminal output, the relay itself and malformed watches", () => {
    const relay = new NodeEventRelay({
      nodes: { link: () => null, subscribe: () => () => undefined, isLeaf: () => false },
      emit: () => undefined,
    });
    for (const prefixes of [
      ["terminal"],
      ["terminal-output-s1"],
      [RELAYED_NODE_EVENT],
      [],
      ["a,b"],
    ]) {
      expect(() => relay.watch({ nodeId: "bk_leaf", prefixes })).toThrow();
    }
    expect(() => relay.watch({ nodeId: "not a node", prefixes: ["a-"] })).toThrow();
  });

  test("watching is a command of the command node itself, never routed onward", async () => {
    const { command } = await commandWithLeaf();
    await expect(
      command.portal.invokeOnNode({
        nodeId: "bk_leaf",
        command: "watch_node_events",
        args: { nodeId: "bk_other", prefixes: ["a-"] },
      }),
    ).rejects.toThrow("cannot be run on another node");
  });
  test("portal hover prefixes do not reconnect or resync unrelated badges", async () => {
    const { command, leaf } = await commandWithLeaf();
    const badge = command.portal.events.watch({
      nodeId: "bk_leaf",
      prefixes: ["change-projection-changed"],
    });
    await settle(40);
    const streams = [...leaf.streams];
    const before = relayed(command).filter((frame) => frame.kind === "resync").length;
    const hover = command.portal.events.watch({
      nodeId: "bk_leaf",
      prefixes: ["resource-changed", "native-agent-session-activity"],
    });
    await settle(40);
    leaf.emit("resource-changed", { resource: "environment", id: "e" });
    await settle(40);
    expect(
      relayed(command).some(
        (frame) => frame.kind === "event" && frame.event === "resource-changed",
      ),
    ).toBe(true);
    command.portal.events.unwatch(hover.watchId);
    await settle(40);
    expect([...leaf.streams]).toEqual(streams);
    expect(relayed(command).filter((frame) => frame.kind === "resync")).toHaveLength(before);
    const events = relayed(command).length;
    leaf.emit("resource-changed", {});
    await settle(40);
    expect(relayed(command)).toHaveLength(events);
    command.portal.events.unwatch(badge.watchId);
  });

  test("disconnect, epoch replacement and leaf mode stop stale streams", async () => {
    const { network, command, leaf } = await commandWithLeaf();
    const link = command.service.link("bk_leaf" as BackendId)!;
    let connected = true;
    let epoch = link.view.epoch;
    let isLeaf = false;
    let notify: () => void = () => undefined;
    const frames: RelayedNodeEvent[] = [];
    const relay = new NodeEventRelay({
      nodes: {
        subscribe: (listener) => {
          notify = listener;
          return () => {
            notify = () => undefined;
          };
        },
        isLeaf: () => isLeaf,
        link: () => ({
          get connected() {
            return connected;
          },
          get view() {
            return { epoch };
          },
          invoke: link.invoke.bind(link),
          transport: link.transport.bind(link),
        }),
      },
      emit: (_event, payload) => frames.push(payload as RelayedNodeEvent),
      fetchImpl: network.fetch,
    });
    relay.start();
    try {
      relay.watch({ nodeId: "bk_leaf", prefixes: ["a-"] });
      await settle(40);
      expect(relay.diagnostics().relays).toHaveLength(1);
      connected = false;
      notify();
      await settle(40);
      expect(relay.diagnostics().relays).toHaveLength(0);
      const before = frames.length;
      leaf.emit("a-old", {});
      await settle(40);
      expect(frames).toHaveLength(before);
      const disconnectedResyncs = frames.filter((frame) => frame.kind === "resync").length;
      connected = true;
      epoch++;
      notify();
      await settle(40);
      const reconnectedResyncs = frames.filter((frame) => frame.kind === "resync").length;
      expect(reconnectedResyncs).toBeGreaterThan(disconnectedResyncs);
      epoch++;
      notify();
      await settle(40);
      expect(frames.filter((frame) => frame.kind === "resync").length).toBeGreaterThan(
        reconnectedResyncs,
      );
      leaf.emit("a-new", {});
      await settle(40);
      expect(frames.filter((frame) => frame.kind === "event")).toHaveLength(1);
      isLeaf = true;
      notify();
      await settle(40);
      expect(relay.diagnostics().relays).toHaveLength(0);
      const end = frames.length;
      leaf.emit("a-hidden", {});
      await settle(40);
      expect(frames).toHaveLength(end);
      isLeaf = false;
      notify();
      await settle(40);
      expect(relay.diagnostics().relays).toHaveLength(1);
    } finally {
      relay.stop();
    }
  });
});
