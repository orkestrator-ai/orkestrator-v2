/**
 * Push for relayed nodes through the real gateway (design D10): the offer
 * says `nodes: true`, two windows of the command node subscribe to different
 * sessions on the same leaf with `nodeId`, and the leaf's frames reach each
 * window on its own stream. The leaf is a fake: a second push hub behind the
 * port the relay gives the subscription controller.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  parsePushStreamOffer,
  type PushChangedPayload,
  type PushResyncPayload,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";

import { NodePushSubscriptionController } from "../src/core/nodes/node-push-subscriptions.js";
import { registryCommandAccess } from "../src/core/nodes/workspace-grant-test-support.js";
import { BackendPush } from "../src/core/push/index.js";
import { PushHub, type PushResolveAnswer } from "../src/core/push/push-hub.js";
import {
  eventFrames,
  openEventStream,
  readGatewayMetrics,
  requestUrl,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

const NODE = "bk_leaf" as BackendId;
const TOPIC = "native-session";
const KEY_A = "env-1/claude/tab-a";
const KEY_B = "env-1/claude/tab-b";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A leaf with one push connection held by the command node. */
function fakeLeaf(controller: NodePushSubscriptionController) {
  const hub = new PushHub({ coalesceMs: 1, keyThrottleMs: 1 });
  hub.registerTopic({
    topic: TOPIC,
    validKey: () => true,
    resolve: async (): Promise<PushResolveAnswer> => ({
      status: "ok",
      generation: "g",
      revision: 1,
    }),
    retain: () => undefined,
    release: () => undefined,
  });
  const calls: PushSetSubscriptionsArgs[] = [];
  const streamId = hub.openConnection("command-node-credential", {
    write: (event, payload) => {
      controller.upstreamFrame(NODE, event, payload);
      return true;
    },
    backpressured: () => false,
  });
  disposers.push(() => hub.dispose());
  return {
    hub,
    calls,
    streamId,
    port: {
      holdForPush: () => () => undefined,
      link: () => ({
        invoke: async <T>(_command: string, args?: Record<string, unknown>) => {
          calls.push(args as unknown as PushSetSubscriptionsArgs);
          return (await hub.setSubscriptions(
            "command-node-credential",
            args as unknown as PushSetSubscriptionsArgs,
          )) as T;
        },
      }),
    },
  };
}

function relayedPush() {
  const push = new BackendPush({
    sessionExists: async () => true,
    nativeAgents: () => undefined,
  });
  let leaf!: ReturnType<typeof fakeLeaf>;
  const controller = new NodePushSubscriptionController({
    leaf: { holdForPush: () => leaf.port.holdForPush(), link: () => leaf.port.link() },
  });
  leaf = fakeLeaf(controller);
  controller.attachDownstream(push.hub);
  push.attachNodeSubscriptions(controller);
  controller.upstreamConnected(NODE, { versions: [1], streamId: leaf.streamId });
  disposers.push(() => {
    controller.stop();
    push.dispose();
  });
  return { push, controller, leaf };
}

async function setSubscriptions(
  info: { url: string; token: string },
  args: Record<string, unknown>,
): Promise<PushSetSubscriptionsResult> {
  const response = await requestUrl(`${info.url}__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "push_set_subscriptions", args }),
  });
  expect(response.status).toBe(200);
  return (response.json() as { result: PushSetSubscriptionsResult }).result;
}

function payloads<T>(received: string, event: string): T[] {
  return eventFrames(received, event).map(
    (frame) => (JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as { payload: T }).payload,
  );
}

function offerOf(received: string) {
  const frame = eventFrames(received, "gateway.connected")[0]!;
  return parsePushStreamOffer(
    (JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as { payload: unknown }).payload,
  );
}

describe("gateway push for relayed nodes", () => {
  test("two windows viewing different sessions on one leaf each receive theirs; one leaving keeps the other", async () => {
    const { push, leaf } = relayedPush();
    const { gateway, info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
    });
    const first = await openEventStream(gateway, info, "?excludeEvents=terminal-output-");
    const second = await openEventStream(gateway, info, "?excludeEvents=terminal-output-");
    await waitUntil(
      () => [first, second].every((stream) => stream.received().includes("gateway.connected")),
      "no connected frames",
    );
    const firstOffer = offerOf(first.received())!;
    const secondOffer = offerOf(second.received())!;
    expect(firstOffer.nodes).toBe(true);

    expect(
      await setSubscriptions(info, {
        streamId: firstOffer.streamId,
        setRevision: 1,
        nodeId: NODE,
        subscriptions: [{ topic: TOPIC, key: KEY_A }],
      }),
    ).toMatchObject({
      status: "applied",
      subscriptions: [{ key: KEY_A, status: "ok", generation: "g", revision: 1 }],
    });
    expect(
      await setSubscriptions(info, {
        streamId: secondOffer.streamId,
        setRevision: 1,
        nodeId: NODE,
        subscriptions: [{ topic: TOPIC, key: KEY_B }],
      }),
    ).toMatchObject({ status: "applied", subscriptions: [{ key: KEY_B, status: "ok" }] });
    // One union at the leaf, with the controller's own revisions.
    expect(leaf.calls.map((call) => call.setRevision)).toEqual([1, 2]);
    expect(leaf.calls.at(-1)?.subscriptions.map((entry) => entry.key)).toEqual([KEY_A, KEY_B]);

    leaf.hub.publish(TOPIC, KEY_A, { generation: "g", revision: 2 }, ["transcript"]);
    leaf.hub.publish(TOPIC, KEY_B, { generation: "g", revision: 2 }, ["state"]);
    await waitUntil(
      () =>
        payloads(first.received(), PUSH_CHANGED_EVENT).length === 1 &&
        payloads(second.received(), PUSH_CHANGED_EVENT).length === 1,
      "the leaf's changes did not reach both windows",
    );
    expect(payloads<PushChangedPayload>(first.received(), PUSH_CHANGED_EVENT)).toEqual([
      {
        seq: 1,
        changes: [
          {
            topic: TOPIC,
            key: KEY_A,
            generation: "g",
            revision: 2,
            parts: ["transcript"],
            nodeId: NODE,
          },
        ],
      },
    ]);
    expect(payloads<PushChangedPayload>(second.received(), PUSH_CHANGED_EVENT)[0]?.changes).toEqual(
      [{ topic: TOPIC, key: KEY_B, generation: "g", revision: 2, parts: ["state"], nodeId: NODE }],
    );

    // The first window changes its set, then closes: the second stays subscribed.
    expect(
      await setSubscriptions(info, {
        streamId: firstOffer.streamId,
        setRevision: 2,
        nodeId: NODE,
        subscriptions: [],
      }),
    ).toMatchObject({ status: "applied", subscriptions: [] });
    first.close();
    await waitUntil(() => push.metrics().connections === 1, "first connection not closed");
    await waitUntil(
      () =>
        leaf.calls
          .at(-1)
          ?.subscriptions.map((entry) => entry.key)
          .join() === KEY_B,
      "the leaf still holds the first window's key",
    );
    expect(leaf.hub.isObserved(TOPIC, KEY_A)).toBe(false);

    leaf.hub.publish(TOPIC, KEY_B, { generation: "g", revision: 3 }, ["transcript"]);
    await waitUntil(
      () => payloads(second.received(), PUSH_CHANGED_EVENT).length === 2,
      "the second window stopped receiving",
    );
    expect(payloads<PushChangedPayload>(second.received(), PUSH_CHANGED_EVENT)[1]).toEqual({
      seq: 2,
      changes: [
        {
          topic: TOPIC,
          key: KEY_B,
          generation: "g",
          revision: 3,
          parts: ["transcript"],
          nodeId: NODE,
        },
      ],
    });

    // The controller's counters reach the metrics block, content-free.
    const metrics = (await readGatewayMetrics(info)) as unknown as {
      push: { nodeSets: number; relayedNodes?: Record<string, number> };
    };
    expect(metrics.push.nodeSets).toBe(1);
    expect(metrics.push.relayedNodes).toMatchObject({
      nodes: 1,
      heldKeys: 1,
      downstreamSets: 1,
      leafSetCalls: 3,
      changesFannedOut: 3,
    });
    const serialized = JSON.stringify(metrics.push);
    for (const secret of [KEY_A, KEY_B, NODE, firstOffer.streamId, secondOffer.streamId]) {
      expect(serialized).not.toContain(secret);
    }
    // `get_push_metrics` answers the same method.
    expect(push.metrics().relayedNodes).toEqual(metrics.push.relayedNodes);
    second.close();
  });

  test("a leaf stream replaced under the controller resyncs the window for that node", async () => {
    const { push, controller, leaf } = relayedPush();
    const { gateway, info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
    });
    const stream = await openEventStream(gateway, info, "?excludeEvents=terminal-output-");
    await waitUntil(() => stream.received().includes("gateway.connected"), "no connected frame");
    const offer = offerOf(stream.received())!;
    await setSubscriptions(info, {
      streamId: offer.streamId,
      setRevision: 1,
      nodeId: NODE,
      subscriptions: [{ topic: TOPIC, key: KEY_A }],
    });

    const replacement = leaf.hub.openConnection("command-node-credential", {
      write: (event, payload) => {
        controller.upstreamFrame(NODE, event, payload);
        return true;
      },
      backpressured: () => false,
    });
    controller.upstreamConnected(NODE, { versions: [1], streamId: replacement });
    await waitUntil(
      () => payloads(stream.received(), PUSH_RESYNC_EVENT).length === 1,
      "no resync for the node",
    );
    expect(payloads<PushResyncPayload>(stream.received(), PUSH_RESYNC_EVENT)).toEqual([
      { seq: 1, reason: "node-reset", topics: "all", nodeId: NODE },
    ]);
    await waitUntil(
      () => leaf.calls.at(-1)?.streamId === replacement,
      "the union was not re-sent to the new stream",
    );
    stream.close();
  });

  test("a workspace-grant caller is refused a node set but keeps its local set", async () => {
    const { push, leaf } = relayedPush();
    const grant = "okg_window.secret";
    const { gateway, info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
      nodeHooks: {
        isPortalOriginAllowed: () => false,
        noteControllerContact: () => undefined,
        authenticateGrant: (token: string) => (token === grant ? Date.now() + 60_000 : null),
      },
    });
    const viaGrant = { url: info.url, token: grant };
    const stream = await openEventStream(gateway, viaGrant, "?excludeEvents=terminal-output-");
    await waitUntil(() => stream.received().includes("gateway.connected"), "no connected frame");
    const offer = offerOf(stream.received())!;
    expect(
      await setSubscriptions(viaGrant, {
        streamId: offer.streamId,
        setRevision: 1,
        nodeId: NODE,
        subscriptions: [{ topic: TOPIC, key: KEY_A }],
      }),
    ).toEqual({ status: "refused", reason: "unavailable" });
    // Nothing reached the controller or the leaf.
    expect(leaf.calls).toEqual([]);
    expect(push.metrics().nodeSets).toBe(0);
    // The grant's own (local) set is unaffected by the refusal.
    expect(
      await setSubscriptions(viaGrant, {
        streamId: offer.streamId,
        setRevision: 1,
        subscriptions: [],
      }),
    ).toMatchObject({ status: "applied", setRevision: 1 });
    expect(
      await setSubscriptions(viaGrant, {
        streamId: offer.streamId,
        setRevision: 2,
        nodeId: null,
        subscriptions: [{ topic: TOPIC, key: KEY_A }],
      }),
    ).toMatchObject({
      status: "applied",
      setRevision: 2,
      subscriptions: [{ topic: TOPIC, key: KEY_A, status: "ok" }],
    });
    expect(leaf.calls).toEqual([]);
    expect(push.metrics().nodeSets).toBe(0);
    stream.close();
  });

  test("a backend without a controller offers no nodes and refuses a node set", async () => {
    const push = new BackendPush({
      sessionExists: async () => true,
      nativeAgents: () => undefined,
    });
    disposers.push(() => push.dispose());
    const { gateway, info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
    });
    const stream = await openEventStream(gateway, info, "?excludeEvents=terminal-output-");
    await waitUntil(() => stream.received().includes("gateway.connected"), "no connected frame");
    const offer = offerOf(stream.received())!;
    expect(offer.nodes).toBeUndefined();
    expect(
      await setSubscriptions(info, {
        streamId: offer.streamId,
        setRevision: 1,
        nodeId: NODE,
        subscriptions: [{ topic: TOPIC, key: KEY_A }],
      }),
    ).toEqual({ status: "refused", reason: "unavailable" });
    stream.close();
  });
});
