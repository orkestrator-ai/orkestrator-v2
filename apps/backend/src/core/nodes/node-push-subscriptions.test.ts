/**
 * The command node's push subscription controller (design D10) between a
 * real downstream hub (the command node's connections) and a fake leaf: a
 * second real hub standing in for the leaf's gateway, reached through the
 * port the relay gives the controller. Everything runs on one manual clock.
 */
import { describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  type PushChange,
  type PushChangedPayload,
  type PushResyncPayload,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";

import { PushHub, type PushResolveAnswer, type PushTopicProvider } from "../push/push-hub.js";
import {
  NodePushSubscriptionController,
  type NodePushLeafPort,
} from "./node-push-subscriptions.js";

const TOPIC = "native-session";
const NODE = "bk_leaf" as BackendId;
const OWNER = "window";

class LeafTopic implements PushTopicProvider {
  readonly topic = TOPIC;
  answers = new Map<string, PushResolveAnswer>();
  validKey(key: string): boolean {
    return !key.includes("bad");
  }
  async resolve(key: string): Promise<PushResolveAnswer> {
    return this.answers.get(key) ?? { status: "ok", generation: "g", revision: 3 };
  }
  retain(): void {}
  release(): void {}
}

interface Written {
  event: string;
  payload: unknown;
}

function harness(options: { maxSubscriptions?: number } = {}) {
  const clock = new ManualClock();
  const timing = { timers: clock, now: () => clock.now() };

  // The fake leaf: its own hub, a topic, and the command node's push connection.
  const leafHub = new PushHub(timing);
  const leafTopic = new LeafTopic();
  leafHub.registerTopic(leafTopic);
  const leafCalls: PushSetSubscriptionsArgs[] = [];
  const leaf = {
    connected: true,
    holds: 0,
    failCalls: false,
    failNextEmpty: false,
    delay: null as Promise<void> | null,
  };
  const port: NodePushLeafPort = {
    holdForPush: () => {
      leaf.holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leaf.holds -= 1;
      };
    },
    link: () =>
      leaf.connected
        ? {
            invoke: async <T>(command: string, args?: Record<string, unknown>) => {
              expect(command).toBe("push_set_subscriptions");
              if (leaf.failCalls) throw new Error("the node did not answer");
              const set = args as unknown as PushSetSubscriptionsArgs;
              leafCalls.push(set);
              if (set.subscriptions.length === 0 && leaf.failNextEmpty) {
                leaf.failNextEmpty = false;
                throw new Error("temporary empty-set failure");
              }
              const delay = leaf.delay;
              leaf.delay = null;
              if (delay) await delay;
              return (await leafHub.setSubscriptions(
                "command-node",
                args as unknown as PushSetSubscriptionsArgs,
              )) as T;
            },
          }
        : null,
  };
  const controller = new NodePushSubscriptionController({
    leaf: port,
    timers: clock,
    limits: options.maxSubscriptions ? { maxSubscriptions: options.maxSubscriptions } : undefined,
  });

  // The command node's own hub, with the controller attached.
  const hub = new PushHub(timing);
  hub.registerTopic(new LeafTopic());
  hub.attachNodeSubscriptions(controller);
  controller.attachDownstream(hub);

  const openUpstream = () => {
    const streamId = leafHub.openConnection("command-node", {
      write: (event, payload) => {
        controller.upstreamFrame(NODE, event, payload);
        return true;
      },
      backpressured: () => false,
    });
    controller.upstreamConnected(NODE, { versions: [1], streamId });
    return streamId;
  };

  const open = () => {
    const written: Written[] = [];
    const streamId = hub.openConnection(OWNER, {
      write: (event, payload) => {
        written.push({ event, payload });
        return true;
      },
      backpressured: () => false,
    });
    return { streamId, written };
  };

  const set = async (
    streamId: string,
    setRevision: number,
    keys: string[],
    nodeId: string | null = NODE,
  ): Promise<PushSetSubscriptionsResult> => {
    const answer = hub.setSubscriptions(OWNER, {
      streamId,
      setRevision,
      subscriptions: keys.map((key) => ({ topic: TOPIC, key })),
      ...(nodeId === null ? {} : { nodeId }),
    });
    await flushMicrotasks();
    return answer;
  };

  const settle = async (ms = 100) => {
    await clock.advanceAsync(ms);
  };

  const changes = (written: Written[]): PushChange[] =>
    written
      .filter((entry) => entry.event === PUSH_CHANGED_EVENT)
      .flatMap((entry) => (entry.payload as PushChangedPayload).changes);
  const resyncs = (written: Written[]): PushResyncPayload[] =>
    written
      .filter((entry) => entry.event === PUSH_RESYNC_EVENT)
      .map((entry) => entry.payload as PushResyncPayload);
  const seqs = (written: Written[]) =>
    written.map((entry) => (entry.payload as { seq: number }).seq);

  return {
    clock,
    leafHub,
    leafTopic,
    leafCalls,
    leaf,
    controller,
    hub,
    openUpstream,
    open,
    set,
    settle,
    changes,
    resyncs,
    seqs,
  };
}

describe("node push subscription controller", () => {
  test("sends the leaf the union of every connection's set with its own setRevision and copies the stamps", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    const b = h.open();

    // Each window's own revisions are independent; the leaf sees one counter.
    expect(await h.set(a.streamId, 7, ["env/claude/a"])).toEqual({
      status: "applied",
      setRevision: 7,
      seqBase: 0,
      subscriptions: [
        { topic: TOPIC, key: "env/claude/a", status: "ok", generation: "g", revision: 3 },
      ],
    });
    h.leafTopic.answers.set("env/claude/b", { status: "ok", generation: "h", revision: 9 });
    expect(await h.set(b.streamId, 1, ["env/claude/b"])).toMatchObject({
      status: "applied",
      setRevision: 1,
      subscriptions: [{ key: "env/claude/b", status: "ok", generation: "h", revision: 9 }],
    });

    expect(
      h.leafCalls.map((call) => [call.setRevision, call.subscriptions.map((s) => s.key)]),
    ).toEqual([
      [1, ["env/claude/a"]],
      [2, ["env/claude/a", "env/claude/b"]],
    ]);
    expect(h.leafHub.isObserved(TOPIC, "env/claude/a")).toBe(true);
    expect(h.leafHub.isObserved(TOPIC, "env/claude/b")).toBe(true);
    expect(h.controller.diagnostics()).toEqual([
      { nodeId: NODE, keys: 2, sets: 2, upstream: true },
    ]);
  });

  test("a second viewer of a held key is answered from the leaf's stamps without a leaf call", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    const b = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    expect(h.leafCalls).toHaveLength(1);

    expect(await h.set(b.streamId, 1, ["env/claude/a"])).toMatchObject({
      status: "applied",
      subscriptions: [{ key: "env/claude/a", status: "ok", generation: "g", revision: 3 }],
    });
    expect(h.leafCalls).toHaveLength(1);
    expect(h.controller.metrics().answeredFromCache).toBe(1);
  });

  test("fans a leaf change out to each subscribed connection only, numbered in its own seq, with nodeId", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    const b = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    await h.set(b.streamId, 1, ["env/claude/b"]);

    h.leafHub.publish(TOPIC, "env/claude/a", { generation: "g", revision: 4 }, ["transcript"]);
    await h.settle();
    expect(h.changes(a.written)).toEqual([
      {
        topic: TOPIC,
        key: "env/claude/a",
        generation: "g",
        revision: 4,
        parts: ["transcript"],
        nodeId: NODE,
      },
    ]);
    expect(h.seqs(a.written)).toEqual([1]);
    expect(b.written).toEqual([]);

    // The stamp the controller holds advanced with the frame: a later viewer
    // is answered with it.
    const c = h.open();
    expect(await h.set(c.streamId, 1, ["env/claude/a"])).toMatchObject({
      subscriptions: [{ key: "env/claude/a", status: "ok", revision: 4 }],
    });
  });

  test("local and per-node sets are separate namespaces with their own setRevision order", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    expect(await h.set(a.streamId, 5, ["env/claude/local"], null)).toMatchObject({
      status: "applied",
      setRevision: 5,
    });
    // A node set with a lower revision than the local one is not superseded.
    expect(await h.set(a.streamId, 1, ["env/claude/a"])).toMatchObject({
      status: "applied",
      setRevision: 1,
    });
    expect(await h.set(a.streamId, 1, ["env/claude/b"])).toEqual({
      status: "superseded",
      setRevision: 1,
    });
    // Neither replaced the other.
    expect(h.hub.isObserved(TOPIC, "env/claude/local")).toBe(true);
    expect(h.leafHub.isObserved(TOPIC, "env/claude/a")).toBe(true);
    expect(await h.set(a.streamId, 4, [], null)).toEqual({
      status: "superseded",
      setRevision: 5,
    });
    expect(h.hub.metrics().nodeSets).toBe(1);
  });

  test("a key stays in the union until its last subscriber lets go, then the leaf drops it", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    const b = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    await h.set(b.streamId, 1, ["env/claude/a", "env/claude/b"]);
    expect(h.leafCalls).toHaveLength(2);

    // A lets go: B still holds the key, so the union does not change.
    expect(await h.set(a.streamId, 2, [])).toMatchObject({ status: "applied", subscriptions: [] });
    await h.settle();
    expect(h.leafCalls).toHaveLength(2);
    h.leafHub.publish(TOPIC, "env/claude/a", { generation: "g", revision: 5 }, null);
    await h.settle();
    expect(h.changes(a.written)).toEqual([]);
    expect(h.changes(b.written).map((change) => change.key)).toEqual(["env/claude/a"]);

    // B's stream closes: the union empties, the leaf is told, the hold ends.
    expect(h.leaf.holds).toBe(1);
    h.hub.closeConnection(b.streamId);
    await h.settle();
    expect(h.leafCalls.at(-1)?.subscriptions).toEqual([]);
    expect(h.leafHub.isObserved(TOPIC, "env/claude/a")).toBe(false);
    expect(h.leaf.holds).toBe(0);
    expect(h.controller.diagnostics()).toEqual([]);
  });

  test("the union is bounded by the leaf's limits; past them a key is denied with limit", async () => {
    const h = harness({ maxSubscriptions: 2 });
    h.openUpstream();
    const a = h.open();
    const b = h.open();
    await h.set(a.streamId, 1, ["env/claude/a", "env/claude/b"]);
    expect(await h.set(b.streamId, 1, ["env/claude/a", "env/claude/c"])).toMatchObject({
      status: "applied",
      subscriptions: [
        { key: "env/claude/a", status: "ok" },
        { key: "env/claude/c", status: "denied", reason: "limit" },
      ],
    });
    expect(h.leafCalls.at(-1)?.subscriptions.map((entry) => entry.key)).toEqual([
      "env/claude/a",
      "env/claude/b",
    ]);
    // Room freed by a key let go in the same set is used at once.
    expect(await h.set(a.streamId, 2, ["env/claude/c"])).toMatchObject({
      subscriptions: [{ key: "env/claude/c", status: "ok" }],
    });
    expect(h.controller.metrics().limitDenials).toBe(1);
  });

  test("a key the leaf answers missing is not held for that connection", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    h.leafTopic.answers.set("env/claude/gone", { status: "missing" });
    expect(await h.set(a.streamId, 1, ["env/claude/gone", "env/claude/a"])).toMatchObject({
      subscriptions: [
        { key: "env/claude/gone", status: "missing" },
        { key: "env/claude/a", status: "ok" },
      ],
    });
    expect(h.controller.diagnostics()[0]?.keys).toBe(1);
  });

  test("a new upstream stream re-sends the union there and resyncs every connection for that node", async () => {
    const h = harness();
    const first = h.openUpstream();
    const a = h.open();
    const b = h.open();
    const local = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    await h.set(b.streamId, 1, ["env/claude/b"]);
    await h.set(local.streamId, 1, ["env/claude/local"], null);

    const second = h.openUpstream();
    expect(second).not.toBe(first);
    await h.settle();
    const last = h.leafCalls.at(-1)!;
    expect(last.streamId).toBe(second);
    // The controller's counter is per upstream stream.
    expect(last.setRevision).toBe(1);
    expect(last.subscriptions.map((entry) => entry.key)).toEqual(["env/claude/a", "env/claude/b"]);
    for (const connection of [a, b]) {
      expect(h.resyncs(connection.written)).toEqual([
        { seq: 1, reason: "node-reset", topics: "all", nodeId: NODE },
      ]);
    }
    // A connection with no set for that node hears nothing.
    expect(local.written).toEqual([]);

    // Frames on the old stream no longer count; the new one's do.
    h.leafHub.publish(TOPIC, "env/claude/a", { generation: "g", revision: 8 }, null);
    await h.settle();
    expect(h.changes(a.written)).toHaveLength(1);
  });

  test("a leaf seq gap or push.resync re-sends the union and resyncs the node's connections", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    const calls = h.leafCalls.length;

    h.leafHub.resyncTopic(TOPIC);
    await h.settle();
    expect(h.leafCalls.length).toBe(calls + 1);
    expect(h.resyncs(a.written)).toEqual([
      { seq: 1, reason: "node-reset", topics: "all", nodeId: NODE },
    ]);

    // The leaf's seq skips: the resync that follows replaces the frame's
    // change, which the window's re-sent set answers anyway.
    h.controller.upstreamFrame(NODE, PUSH_CHANGED_EVENT, {
      seq: 5,
      changes: [{ topic: TOPIC, key: "env/claude/a", generation: "g", revision: 7, parts: [] }],
    });
    await h.settle();
    expect(h.controller.metrics().seqGaps).toBe(1);
    expect(h.resyncs(a.written)).toHaveLength(2);
    expect(h.leafCalls.length).toBe(calls + 2);
    // The stamp still advanced: a re-sent set is answered with it.
    expect(await h.set(a.streamId, 2, ["env/claude/a"])).toMatchObject({
      subscriptions: [{ key: "env/claude/a", status: "ok", revision: 7 }],
    });
    // A duplicate is ignored.
    h.controller.upstreamFrame(NODE, PUSH_CHANGED_EVENT, {
      seq: 5,
      changes: [{ topic: TOPIC, key: "env/claude/a", generation: "g", revision: 9, parts: [] }],
    });
    await h.settle();
    expect(h.changes(a.written)).toEqual([]);
    expect(h.resyncs(a.written)).toHaveLength(2);
  });

  test("the relay's resync hint resyncs an answered upstream, not one still being sent the union", async () => {
    const h = harness();
    const a = h.open();
    const pending = h.set(a.streamId, 1, ["env/claude/a"]);
    h.openUpstream();
    // The hint that comes with every fresh connection: the union is already on its way.
    h.controller.upstreamResync(NODE);
    await pending;
    await h.settle();
    // One union call, and one resync: the stream's arrival, which tells a
    // window that was answered unavailable meanwhile to try again.
    expect(h.leafCalls).toHaveLength(1);
    expect(h.resyncs(a.written)).toHaveLength(1);

    h.controller.upstreamResync(NODE);
    await h.settle();
    expect(h.leafCalls).toHaveLength(2);
    expect(h.resyncs(a.written)).toHaveLength(2);
  });

  test("a closed upstream resyncs the windows and answers unavailable until a stream returns", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);

    h.controller.upstreamClosed(NODE);
    await h.settle();
    expect(h.resyncs(a.written)).toHaveLength(1);

    const pending = h.set(a.streamId, 2, ["env/claude/a"]);
    await h.clock.advanceAsync(8_000);
    expect(await pending).toEqual({ status: "refused", reason: "unavailable" });

    // The stream comes back: the union goes to it and the window is told.
    h.openUpstream();
    await h.settle();
    expect(h.resyncs(a.written)).toHaveLength(2);
    expect(await h.set(a.streamId, 3, ["env/claude/a"])).toMatchObject({
      status: "applied",
      subscriptions: [{ key: "env/claude/a", status: "ok" }],
    });
  });

  test("a failed leaf call answers unavailable and is retried by the next set, not in a loop", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    h.leaf.failCalls = true;
    expect(await h.set(a.streamId, 1, ["env/claude/a"])).toEqual({
      status: "refused",
      reason: "unavailable",
    });
    await h.settle(1_000);
    expect(h.hub.metrics().nodeSets).toBe(0);
    h.leaf.failCalls = false;
    expect(await h.set(a.streamId, 2, ["env/claude/a"])).toMatchObject({ status: "applied" });
  });

  test("superseded limit denials cannot release a key accepted by a newer set", async () => {
    const h = harness({ maxSubscriptions: 1 });
    h.openUpstream();
    const a = h.open();
    const key = "env/claude/new";
    const delayed = Promise.withResolvers<void>();
    h.leaf.delay = delayed.promise;
    const older = h.set(a.streamId, 1, ["env/claude/old", key]);
    await flushMicrotasks();
    const newer = h.set(a.streamId, 2, [key]);
    delayed.resolve();
    expect(await older).toMatchObject({ status: "superseded" });
    expect(await newer).toMatchObject({ subscriptions: [{ key, status: "ok" }] });
    expect(h.controller.diagnostics()[0]?.keys).toBe(1);
    expect(h.leafHub.isObserved(TOPIC, key)).toBe(true);
  });

  test("a transient empty-union failure retries on the same upstream stream", async () => {
    const h = harness();
    const upstream = h.openUpstream();
    const a = h.open();
    const key = "env/claude/old";
    await h.set(a.streamId, 1, [key]);
    h.leaf.failNextEmpty = true;
    await h.set(a.streamId, 2, []);
    expect(h.leafHub.isObserved(TOPIC, key)).toBe(true);
    await h.settle(500);
    expect(h.leafCalls.at(-1)).toMatchObject({ streamId: upstream, subscriptions: [] });
    expect(h.leafHub.isObserved(TOPIC, key)).toBe(false);
    expect(h.leaf.holds).toBe(0);
    h.controller.stop();
  });

  test("cleared namespaces release capacity and fence delayed revisions after eviction", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    for (let index = 0; index < 66; index += 1) {
      expect(await h.set(a.streamId, index + 2, [], `bk_retired${index}`)).toMatchObject({
        status: "applied",
      });
    }
    expect(h.hub.metrics().nodeSets).toBe(0);
    expect(await h.set(a.streamId, 1, ["env/claude/stale"], "bk_retired0")).toEqual({
      status: "superseded",
      setRevision: 3,
    });
    expect(await h.set(a.streamId, 68, ["env/claude/live"])).toMatchObject({ status: "applied" });
  });

  test("a set is refused without a controller, and stop() releases every hold", async () => {
    const h = harness();
    h.openUpstream();
    const a = h.open();
    await h.set(a.streamId, 1, ["env/claude/a"]);
    expect(h.leaf.holds).toBe(1);
    h.controller.stop();
    expect(h.leaf.holds).toBe(0);
    expect(await h.set(a.streamId, 2, ["env/claude/a"])).toEqual({
      status: "refused",
      reason: "unavailable",
    });
    h.hub.attachNodeSubscriptions(null);
    expect(await h.set(a.streamId, 3, ["env/claude/a"])).toEqual({
      status: "refused",
      reason: "unavailable",
    });
  });
});
