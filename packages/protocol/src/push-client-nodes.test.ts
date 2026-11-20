/**
 * The push client for a relayed node (design D10): a window's local client
 * and its per-node clients share the command node's stream, each with its
 * own set and `setRevision`, each acting only on its own namespace's changes
 * and resyncs while both check the shared `seq`.
 */
import { describe, expect, test } from "bun:test";
import { PushSubscriptionClient, type PushKeyChange } from "./push-client";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  parsePushChangedPayload,
  parsePushResyncPayload,
  parsePushStreamOffer,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
  type PushStreamOffer,
} from "./push-events";
import { ManualClock, flushMicrotasks } from "./testing/manual-clock";

const STREAM = "stream-aaaaaaaaaaaaaaaa";
const TOPIC = "native-session";
const NODE = "bk_leaf";
const OTHER = "bk_other";
const OFFER: PushStreamOffer = { versions: [1], streamId: STREAM, nodes: true };

interface PendingCall {
  args: PushSetSubscriptionsArgs;
  resolve(result: PushSetSubscriptionsResult): void;
}

function harness() {
  const clock = new ManualClock();
  const make = (nodeId?: string) => {
    const calls: PendingCall[] = [];
    const changes: PushKeyChange[] = [];
    const client = new PushSubscriptionClient({
      timers: clock,
      now: () => clock.now(),
      ...(nodeId === undefined ? {} : { nodeId }),
      setSubscriptions: (args) => new Promise((resolve) => calls.push({ args, resolve })),
    });
    const listen = (key: string) => client.subscribe(TOPIC, key, (change) => changes.push(change));
    const answer = async (result?: PushSetSubscriptionsResult) => {
      const call = calls.at(-1)!;
      call.resolve(
        result ?? {
          status: "applied",
          setRevision: call.args.setRevision,
          seqBase: 0,
          subscriptions: call.args.subscriptions.map(({ topic, key }) => ({
            topic,
            key,
            status: "ok" as const,
            generation: "g",
            revision: 1,
          })),
        },
      );
      await flushMicrotasks();
    };
    return { client, calls, changes, listen, answer };
  };
  const tick = async (ms = 0) => {
    await clock.advanceAsync(ms);
  };
  /** One frame on the shared stream, delivered to every client on it. */
  const deliver = (clients: PushSubscriptionClient[], event: string, payload: unknown) => {
    for (const client of clients) client.accept(event, payload);
  };
  return { make, tick, deliver };
}

describe("PushSubscriptionClient for a relayed node", () => {
  test("parses nodes in the offer and nodeId on changes and resyncs", () => {
    expect(
      parsePushStreamOffer({ push: { versions: [1], streamId: STREAM, nodes: true } }),
    ).toEqual(OFFER);
    expect(parsePushStreamOffer({ push: { versions: [1], streamId: STREAM } })).toEqual({
      versions: [1],
      streamId: STREAM,
    });
    expect(
      parsePushChangedPayload({
        seq: 1,
        changes: [
          { topic: TOPIC, key: "k", generation: "g", revision: 1, parts: [], nodeId: NODE },
          { topic: TOPIC, key: "bad", generation: "g", revision: 1, parts: [], nodeId: "" },
        ],
      })?.changes,
    ).toEqual([{ topic: TOPIC, key: "k", generation: "g", revision: 1, parts: [], nodeId: NODE }]);
    expect(
      parsePushResyncPayload({ seq: 2, reason: "node-reset", topics: "all", nodeId: NODE }),
    ).toEqual({ seq: 2, reason: "node-reset", topics: "all", nodeId: NODE });
  });

  test("sends its set with nodeId, with its own setRevision beside the local client's", async () => {
    const h = harness();
    const local = h.make();
    const node = h.make(NODE);
    local.listen("local-key");
    node.listen("node-key");
    local.client.streamConnected(OFFER);
    node.client.streamConnected(OFFER);
    await h.tick();
    expect(local.calls[0]!.args).toEqual({
      streamId: STREAM,
      setRevision: 1,
      subscriptions: [{ topic: TOPIC, key: "local-key" }],
    });
    expect(node.calls[0]!.args).toEqual({
      streamId: STREAM,
      setRevision: 1,
      subscriptions: [{ topic: TOPIC, key: "node-key" }],
      nodeId: NODE,
    });
    await local.answer();
    await node.answer();
    expect(local.client.isHealthy(TOPIC, "local-key")).toBe(true);
    expect(node.client.isHealthy(TOPIC, "node-key")).toBe(true);
  });

  test("a stream that does not offer nodes is unavailable for a node client", async () => {
    const h = harness();
    const node = h.make(NODE);
    node.listen("node-key");
    node.client.streamConnected({ versions: [1], streamId: STREAM });
    await h.tick();
    expect(node.client.state()).toBe("unavailable");
    expect(node.calls).toHaveLength(0);
  });

  test("each client acts only on its namespace's changes and both track the shared seq", async () => {
    const h = harness();
    const local = h.make();
    const node = h.make(NODE);
    local.listen("same-key");
    node.listen("same-key");
    for (const side of [local, node]) side.client.streamConnected(OFFER);
    await h.tick();
    await local.answer();
    await node.answer();
    local.changes.length = 0;
    node.changes.length = 0;
    const clients = [local.client, node.client];

    h.deliver(clients, PUSH_CHANGED_EVENT, {
      seq: 1,
      changes: [{ topic: TOPIC, key: "same-key", generation: "g", revision: 2, parts: [] }],
    });
    h.deliver(clients, PUSH_CHANGED_EVENT, {
      seq: 2,
      changes: [
        { topic: TOPIC, key: "same-key", generation: "g", revision: 3, parts: [], nodeId: NODE },
        { topic: TOPIC, key: "same-key", generation: "g", revision: 9, parts: [], nodeId: OTHER },
      ],
    });
    expect(local.changes.map((change) => change.reason)).toEqual(["frame"]);
    expect(node.changes).toEqual([{ topic: TOPIC, key: "same-key", parts: null, reason: "frame" }]);
    // A frame the node client acts on nothing in still counts toward its seq.
    expect(node.client.diagnostics().seqGaps).toBe(0);
    expect(local.client.diagnostics().seqGaps).toBe(0);
    expect(local.client.state()).toBe("live");
    expect(node.client.state()).toBe("live");
  });

  test("a resync naming another node only consumes seq; one naming this node or none recovers", async () => {
    const h = harness();
    const local = h.make();
    const node = h.make(NODE);
    local.listen("a");
    node.listen("b");
    for (const side of [local, node]) side.client.streamConnected(OFFER);
    await h.tick();
    await local.answer();
    await node.answer();
    const clients = [local.client, node.client];

    h.deliver(clients, PUSH_RESYNC_EVENT, {
      seq: 1,
      reason: "node-reset",
      topics: "all",
      nodeId: OTHER,
    });
    expect(local.client.state()).toBe("live");
    expect(node.client.state()).toBe("live");

    h.deliver(clients, PUSH_RESYNC_EVENT, {
      seq: 2,
      reason: "node-reset",
      topics: "all",
      nodeId: NODE,
    });
    expect(local.client.state()).toBe("live");
    expect(node.client.state()).toBe("recovering");
    expect(node.changes.at(-1)).toEqual({ topic: TOPIC, key: "b", parts: null, reason: "resync" });
    await h.tick();
    expect(node.calls).toHaveLength(2);
    await node.answer();
    expect(node.client.state()).toBe("live");

    // A connection-wide resync (the pending bound) concerns every namespace.
    h.deliver(clients, PUSH_RESYNC_EVENT, { seq: 3, reason: "pending-bound", topics: "all" });
    expect(local.client.state()).toBe("recovering");
    expect(node.client.state()).toBe("recovering");
  });

  test("an unavailable answer for a node set is retried with backoff, and a node resync retries at once", async () => {
    const h = harness();
    const node = h.make(NODE);
    node.listen("b");
    node.client.streamConnected(OFFER);
    await h.tick();
    await node.answer({ status: "refused", reason: "unavailable" });
    expect(node.client.state()).toBe("recovering");
    expect(node.client.isHealthy(TOPIC, "b")).toBe(false);
    await h.tick(999);
    expect(node.calls).toHaveLength(1);
    await h.tick(1);
    expect(node.calls).toHaveLength(2);
    await node.answer({ status: "refused", reason: "unavailable" });

    // The command node reached the node again and says so: no waiting out the backoff.
    node.client.accept(PUSH_RESYNC_EVENT, {
      seq: 1,
      reason: "node-reset",
      topics: "all",
      nodeId: NODE,
    });
    await h.tick();
    expect(node.calls).toHaveLength(3);
    await node.answer();
    expect(node.client.isHealthy(TOPIC, "b")).toBe(true);
  });

  test("a refused stream still leaves a local client unavailable", async () => {
    const h = harness();
    const local = h.make();
    local.listen("a");
    local.client.streamConnected(OFFER);
    await h.tick();
    await local.answer({ status: "refused", reason: "unavailable" });
    expect(local.client.state()).toBe("unavailable");
  });
});
