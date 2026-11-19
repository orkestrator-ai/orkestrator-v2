/**
 * The subscription controller over the real relay (design D10): a held key
 * keeps a stream to the leaf open even with no watch, the leaf's push offer
 * on that stream is the controller's, the union goes to the leaf over the
 * command node's own link credential, the leaf's frames come back through
 * the relay to the controller, and letting go of the last key closes it all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";
import type { PushSetSubscriptionsArgs, PushStamp } from "@orkestrator/protocol/push-events";

import { PUSH_HOLD_EVENT_PREFIX } from "./node-event-relay.js";
import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
  type TestNode,
} from "./node-network-test-support.js";

afterEach(stopTestNodeNetworks);

const NODE = "bk_leaf" as BackendId;
const TOPIC = "native-session";
const KEY = "env-1/claude/tab-1";

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

async function commandWithPushLeaf() {
  const network = new TestNodeNetwork();
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  leaf.commands.set("get_projects", () => []);
  let streams = 0;
  leaf.connectedPayload = () => {
    streams += 1;
    return { push: { versions: [1], streamId: `leaf-push-stream-${streams}-abcdef` } };
  };
  const leafSets: PushSetSubscriptionsArgs[] = [];
  leaf.commands.set("push_set_subscriptions", (args) => {
    const set = args as unknown as PushSetSubscriptionsArgs;
    leafSets.push(set);
    return {
      status: "applied",
      setRevision: set.setRevision,
      seqBase: 0,
      subscriptions: set.subscriptions.map((entry) => ({
        ...entry,
        status: "ok",
        generation: "g",
        revision: 1,
      })),
    };
  });
  await command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
  await settle(40);

  const published: Array<{ streamId: string; nodeId: string; key: string; stamp: PushStamp }> = [];
  const resynced: Array<{ streamId: string; nodeId: string }> = [];
  const controller = command.portal.pushSubscriptions;
  controller.attachDownstream({
    publishToNode: (streamId, nodeId, _topic, key, stamp) =>
      published.push({ streamId, nodeId, key, stamp }),
    resyncNode: (streamId, nodeId) => resynced.push({ streamId, nodeId }),
  });
  /** A frame on every open stream of the leaf, as its gateway writes push frames: no id. */
  const pushFrame = (event: string, payload: unknown) => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ event, payload })}\n\n`);
    for (const stream of leaf.streams) stream.enqueue(bytes);
  };
  return { command, leaf, leafSets, controller, published, resynced, pushFrame };
}

describe("node push subscriptions over the relay", () => {
  test("a held key opens the leaf stream, subscribes on its offer and relays its frames", async () => {
    const { command, leaf, leafSets, controller, published, pushFrame } =
      await commandWithPushLeaf();

    const answered = controller.apply("window-stream", NODE, [{ topic: TOPIC, key: KEY }]);
    // No watch: the hold alone keeps a stream, asking only for the push prefix.
    expect(command.portal.events.diagnostics().relays).toEqual([
      { nodeId: NODE, prefixes: [PUSH_HOLD_EVENT_PREFIX] },
    ]);
    expect(await answered).toEqual([
      { topic: TOPIC, key: KEY, status: "ok", generation: "g", revision: 1 },
    ]);
    // One call, on the offer of the relay's stream (the read model has its own).
    expect(leafSets).toEqual([
      {
        streamId: expect.stringMatching(/^leaf-push-stream-\d+-abcdef$/u),
        setRevision: 1,
        subscriptions: [{ topic: TOPIC, key: KEY }],
      },
    ]);
    // Over the command node's own link, never a window's credential.
    expect(leaf.received.filter((entry) => entry.command === "push_set_subscriptions")).toEqual([
      { command: "push_set_subscriptions", controller: expect.any(String) },
    ]);

    pushFrame("push.changed", {
      seq: 1,
      changes: [{ topic: TOPIC, key: KEY, generation: "g", revision: 2, parts: ["transcript"] }],
    });
    await settle(20);
    expect(published).toEqual([
      {
        streamId: "window-stream",
        nodeId: NODE,
        key: KEY,
        stamp: { generation: "g", revision: 2 },
      },
    ]);
    // Push frames are not relayed as node events.
    expect(command.events.some((entry) => JSON.stringify(entry).includes("push.changed"))).toBe(
      false,
    );

    // The window leaves: the leaf is told, and the stream closes.
    controller.connectionClosed("window-stream");
    await settle(20);
    expect(leafSets.at(-1)?.subscriptions).toEqual([]);
    expect(command.portal.events.diagnostics().relays).toEqual([]);
    expect(controller.diagnostics()).toEqual([]);
  });

  test("a dropped leaf stream resyncs the window, and its replacement gets the union", async () => {
    const { leaf, leafSets, controller, resynced } = await commandWithPushLeaf();
    await controller.apply("window-stream", NODE, [{ topic: TOPIC, key: KEY }]);
    expect(leafSets).toHaveLength(1);

    leaf.dropStreams();
    await settle(20);
    expect(resynced).toContainEqual({ streamId: "window-stream", nodeId: NODE });
    // The relay reopens after its backoff; the new connection's offer is new.
    for (let round = 0; round < 50 && leafSets.length < 2; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(leafSets.at(-1)?.streamId).not.toBe(leafSets[0]!.streamId);
    expect(leafSets.at(-1)?.subscriptions).toEqual([{ topic: TOPIC, key: KEY }]);
    controller.stop();
  });
});
