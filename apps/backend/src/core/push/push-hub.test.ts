import { describe, expect, test } from "bun:test";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  type PushChangedPayload,
  type PushResyncPayload,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  PushHub,
  type PushHubOptions,
  type PushResolveAnswer,
  type PushTopicProvider,
} from "./push-hub.js";

const TOPIC = "native-session";

class FakeTopic implements PushTopicProvider {
  readonly topic: string;
  retained: string[] = [];
  released: string[] = [];
  answers = new Map<string, PushResolveAnswer>();
  constructor(topic = TOPIC) {
    this.topic = topic;
  }
  validKey(key: string): boolean {
    return !key.includes("bad");
  }
  async resolve(key: string): Promise<PushResolveAnswer> {
    return this.answers.get(key) ?? { status: "ok", generation: "g", revision: 0 };
  }
  retain(key: string): void {
    this.retained.push(key);
  }
  release(key: string): void {
    this.released.push(key);
  }
}

interface Written {
  event: string;
  payload: unknown;
}

function harness(options: { limits?: PushHubOptions["limits"] } = {}) {
  const clock = new ManualClock();
  const hub = new PushHub({ timers: clock, now: () => clock.now(), limits: options.limits });
  const topic = new FakeTopic();
  hub.registerTopic(topic);
  const open = (owner = "owner") => {
    const written: Written[] = [];
    const state = { backpressured: false, refuse: false };
    const streamId = hub.openConnection(owner, {
      write: (event, payload) => {
        if (state.refuse) return false;
        written.push({ event, payload });
        return true;
      },
      backpressured: () => state.backpressured,
    });
    return { streamId, written, state };
  };
  const set = async (
    owner: string,
    streamId: string,
    setRevision: number,
    keys: string[],
    topicName = TOPIC,
  ): Promise<PushSetSubscriptionsResult> =>
    hub.setSubscriptions(owner, {
      streamId,
      setRevision,
      subscriptions: keys.map((key) => ({ topic: topicName, key })),
    });
  const changes = (written: Written[]) =>
    written
      .filter((w) => w.event === PUSH_CHANGED_EVENT)
      .flatMap((w) => (w.payload as PushChangedPayload).changes);
  return { clock, hub, topic, open, set, changes };
}

describe("PushHub subscriptions", () => {
  test("registers before reading stamps and answers seqBase", async () => {
    const h = harness();
    const c = h.open();
    h.topic.answers.set("k1", { status: "ok", generation: "g1", revision: 4 });
    const result = await h.set("owner", c.streamId, 1, ["k1", "k2"]);
    expect(result).toEqual({
      status: "applied",
      setRevision: 1,
      seqBase: 0,
      subscriptions: [
        { topic: TOPIC, key: "k1", status: "ok", generation: "g1", revision: 4 },
        { topic: TOPIC, key: "k2", status: "ok", generation: "g", revision: 0 },
      ],
    });
    expect(h.topic.retained).toEqual(["k1", "k2"]);
    expect(h.hub.isObserved(TOPIC, "k1")).toBe(true);
  });

  test("a change between registration and the answer is delivered after seqBase", async () => {
    const h = harness();
    const c = h.open();
    let release!: () => void;
    h.topic.resolve = () =>
      new Promise<PushResolveAnswer>((resolve) => {
        release = () => resolve({ status: "ok", generation: "g", revision: 1 });
      });
    const answer = h.set("owner", c.streamId, 1, ["k1"]);
    await flushMicrotasks();
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 2 }, ["state"]);
    release();
    const result = await answer;
    expect(result.status === "applied" && result.seqBase).toBe(0);
    h.clock.advance(50);
    expect(c.written).toHaveLength(1);
    expect((c.written[0]!.payload as PushChangedPayload).seq).toBe(1);
  });

  test("refuses another credential's stream and an unknown stream", async () => {
    const h = harness();
    const c = h.open("alice");
    expect(await h.set("mallory", c.streamId, 1, ["k1"])).toEqual({
      status: "refused",
      reason: "stream-unknown",
    });
    expect(await h.set("alice", "nope-nope-nope-nope", 1, ["k1"])).toEqual({
      status: "refused",
      reason: "stream-unknown",
    });
    expect(h.topic.retained).toEqual([]);
  });

  test("an older or repeated setRevision is superseded and changes nothing", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 5, ["k1"]);
    expect(await h.set("owner", c.streamId, 5, ["k2"])).toEqual({
      status: "superseded",
      setRevision: 5,
    });
    expect(await h.set("owner", c.streamId, 3, [])).toEqual({
      status: "superseded",
      setRevision: 5,
    });
    expect(h.hub.isObserved(TOPIC, "k1")).toBe(true);
    expect(h.hub.isObserved(TOPIC, "k2")).toBe(false);
  });

  test("denies unknown topics, invalid keys and keys over the limits; one bad key never fails the set", async () => {
    const h = harness({ limits: { maxSubscriptions: 2 } });
    const c = h.open();
    const result = await h.hub.setSubscriptions("owner", {
      streamId: c.streamId,
      setRevision: 1,
      subscriptions: [
        { topic: "nope", key: "k" },
        { topic: TOPIC, key: "bad-key" },
        { topic: TOPIC, key: "" },
        { topic: TOPIC, key: "x".repeat(2_000) },
        { topic: TOPIC, key: "k1" },
        { topic: TOPIC, key: "k1" },
        { topic: TOPIC, key: "k2" },
        { topic: TOPIC, key: "k3" },
      ],
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.subscriptions.map((s) => [s.key.slice(0, 7), s.status])).toEqual([
      ["k", "denied"],
      ["bad-key", "denied"],
      ["", "denied"],
      ["xxxxxxx", "denied"],
      ["k3", "denied"],
      ["k1", "ok"],
      ["k2", "ok"],
    ]);
    expect(h.hub.metrics().deniedByReason).toEqual({
      "unknown-topic": 1,
      "invalid-key": 3,
      limit: 1,
    });
  });

  test("missing keys are answered and not observed", async () => {
    const h = harness();
    const c = h.open();
    h.topic.answers.set("gone", { status: "missing" });
    const result = await h.set("owner", c.streamId, 1, ["gone", "here"]);
    expect(result.status === "applied" && result.subscriptions.map((s) => s.status)).toEqual([
      "missing",
      "ok",
    ]);
    expect(h.hub.isObserved(TOPIC, "gone")).toBe(false);
    expect(h.topic.released).toEqual(["gone"]);
  });

  test("two connections share one observation; it ends with the last subscriber", async () => {
    const h = harness();
    const a = h.open();
    const b = h.open();
    await h.set("owner", a.streamId, 1, ["k1"]);
    await h.set("owner", b.streamId, 1, ["k1"]);
    expect(h.topic.retained).toEqual(["k1"]);
    await h.set("owner", a.streamId, 2, []);
    expect(h.topic.released).toEqual([]);
    h.hub.closeConnection(b.streamId);
    expect(h.topic.released).toEqual(["k1"]);
    expect(h.hub.metrics().observedKeysByTopic).toEqual({});
  });
});

describe("PushHub frames", () => {
  test("an unsubscribed key costs nothing", () => {
    const h = harness();
    const c = h.open();
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, ["state"]);
    h.clock.advance(10_000);
    expect(c.written).toEqual([]);
    expect(h.hub.metrics().changesPublished).toBe(0);
  });

  test("leading edge within the coalescing window, then at most one frame per throttle", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1"]);
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, ["transcript"]);
    h.clock.advance(49);
    expect(c.written).toHaveLength(0);
    h.clock.advance(1);
    expect(h.changes(c.written)).toEqual([
      { topic: TOPIC, key: "k1", generation: "g", revision: 1, parts: ["transcript"] },
    ]);
    // A burst during the throttle collapses into one change with the union of parts.
    for (let revision = 2; revision <= 10; revision += 1) {
      h.clock.advance(20);
      h.hub.publish(
        TOPIC,
        "k1",
        { generation: "g", revision },
        revision % 2 ? ["state"] : ["transcript"],
      );
    }
    // Now at 230 ms; the key's last frame went at 50 ms, so the next is due at 550 ms.
    h.clock.advance(549 - 230);
    expect(c.written).toHaveLength(1);
    h.clock.advance(1);
    expect(c.written).toHaveLength(2);
    const second = h.changes(c.written)[1]!;
    expect(second.revision).toBe(10);
    expect([...second.parts].sort()).toEqual(["state", "transcript"]);
    expect(h.hub.metrics().changesCoalesced).toBe(8);
    expect(c.written.map((w) => (w.payload as PushChangedPayload).seq)).toEqual([1, 2]);
  });

  test("changes of different keys share a frame; a frame holds at most maxFrameChanges", async () => {
    const h = harness({ limits: { maxFrameChanges: 2 } });
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["a", "b", "c"]);
    for (const key of ["a", "b", "c"])
      h.hub.publish(TOPIC, key, { generation: "g", revision: 1 }, null);
    h.clock.advance(50);
    expect(c.written.map((w) => (w.payload as PushChangedPayload).changes.length)).toEqual([2, 1]);
    expect(c.written.map((w) => (w.payload as PushChangedPayload).seq)).toEqual([1, 2]);
    // `null` parts are sent as "read everything" (an empty list).
    expect(h.changes(c.written)[0]!.parts).toEqual([]);
  });

  test("a full pending map becomes one resync, never a silent drop", async () => {
    const h = harness({ limits: { maxPendingEntries: 2 } });
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["a", "b", "c"]);
    for (const key of ["a", "b", "c"])
      h.hub.publish(TOPIC, key, { generation: "g", revision: 1 }, null);
    expect(c.written).toEqual([
      {
        event: PUSH_RESYNC_EVENT,
        payload: { seq: 1, reason: "pending-bound", topics: [TOPIC] } satisfies PushResyncPayload,
      },
    ]);
    h.clock.advance(1_000);
    expect(c.written).toHaveLength(1);
    expect(h.hub.metrics().resyncsByReason).toEqual({ "pending-bound": 1 });
  });

  test("the pending map is bounded by bytes too", async () => {
    const h = harness({ limits: { maxPendingBytes: 300 } });
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k".repeat(100), "j".repeat(100), "i".repeat(100)]);
    for (const key of ["k".repeat(100), "j".repeat(100), "i".repeat(100)]) {
      h.hub.publish(TOPIC, key, { generation: "g", revision: 1 }, ["state"]);
    }
    expect(c.written.map((w) => w.event)).toEqual([PUSH_RESYNC_EVENT]);
  });

  test("a backpressured socket holds changes in the map and retries", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1"]);
    c.state.backpressured = true;
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, ["state"]);
    h.clock.advance(50);
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 2 }, ["state"]);
    h.clock.advance(1_000);
    expect(c.written).toEqual([]);
    expect(h.hub.metrics().pendingEntries).toBe(1);
    c.state.backpressured = false;
    h.clock.advance(250);
    expect(h.changes(c.written).map((change) => change.revision)).toEqual([2]);
    expect(h.hub.metrics().backpressureHolds).toBeGreaterThan(0);
  });

  test("a refused write closes the connection and releases its keys", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1"]);
    c.state.refuse = true;
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, null);
    h.clock.advance(50);
    expect(h.hub.metrics().connections).toBe(0);
    expect(h.topic.released).toEqual(["k1"]);
  });

  test("unsubscribing drops the key's pending change", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1", "k2"]);
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, null);
    h.hub.publish(TOPIC, "k2", { generation: "g", revision: 1 }, null);
    await h.set("owner", c.streamId, 2, ["k2"]);
    h.clock.advance(50);
    expect(h.changes(c.written).map((change) => change.key)).toEqual(["k2"]);
  });

  test("seq continues across set changes", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1"]);
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, null);
    h.clock.advance(50);
    const result = await h.set("owner", c.streamId, 2, ["k1", "k2"]);
    expect(result.status === "applied" && result.seqBase).toBe(1);
    h.hub.publish(TOPIC, "k2", { generation: "g", revision: 1 }, null);
    h.clock.advance(50);
    expect(c.written.map((w) => (w.payload as PushChangedPayload).seq)).toEqual([1, 2]);
  });

  test("resyncTopic reaches only connections subscribed to that topic", async () => {
    const h = harness();
    const other = new FakeTopic("other");
    h.hub.registerTopic(other);
    const a = h.open();
    const b = h.open();
    await h.set("owner", a.streamId, 1, ["k1"]);
    await h.set("owner", b.streamId, 1, ["k1"], "other");
    h.hub.resyncTopic(TOPIC);
    expect(a.written.map((w) => w.event)).toEqual([PUSH_RESYNC_EVENT]);
    expect(b.written).toEqual([]);
  });

  test("closing a connection cancels its timers and leaves nothing behind", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["k1"]);
    h.hub.publish(TOPIC, "k1", { generation: "g", revision: 1 }, null);
    h.hub.closeConnection(c.streamId);
    expect(h.clock.pendingCount()).toBe(0);
    h.clock.advance(1_000);
    expect(c.written).toEqual([]);
    expect(h.hub.metrics()).toMatchObject({ connections: 0, pendingEntries: 0, pendingBytes: 0 });
  });

  test("metrics are content-free", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["secret-session-key"]);
    h.hub.publish(TOPIC, "secret-session-key", { generation: "g", revision: 1 }, null);
    h.clock.advance(50);
    expect(JSON.stringify(h.hub.metrics())).not.toContain("secret-session-key");
    expect(JSON.stringify(h.hub.metrics())).not.toContain(c.streamId);
  });
});

describe("PushHub budgets", () => {
  test("a busy key never delays another key's first change (an approval during a noisy build)", async () => {
    const h = harness();
    const c = h.open();
    await h.set("owner", c.streamId, 1, ["build", "approval"]);
    let revision = 0;
    for (let tick = 0; tick < 100; tick += 1) {
      revision += 1;
      h.hub.publish(TOPIC, "build", { generation: "g", revision }, ["transcript"]);
      if (tick === 60)
        h.hub.publish(TOPIC, "approval", { generation: "g", revision: 1 }, ["state"]);
      h.clock.advance(10);
      if (tick === 60) {
        // Published at 600 ms; out within the coalescing window, not the build's throttle.
        h.clock.advance(40);
        expect(h.changes(c.written).some((change) => change.key === "approval")).toBe(true);
      }
    }
    // The build was announced at most once per throttle window.
    const builds = h.changes(c.written).filter((change) => change.key === "build");
    expect(builds.length).toBeLessThanOrEqual(Math.ceil(h.clock.now() / 500) + 1);
  });

  test("thirty minutes of noisy output with views coming and going keeps every queue bounded", async () => {
    const h = harness();
    const keys = Array.from({ length: 20 }, (_, index) => `session-${index}`);
    let open = Array.from({ length: 4 }, () => h.open());
    let revision = 0;
    let maxPendingEntries = 0;
    let maxPendingBytes = 0;
    for (const [index, connection] of open.entries()) {
      await h.set("owner", connection.streamId, 1, index % 2 ? keys : keys.slice(0, 5));
    }
    const minutes = 30;
    for (let second = 0; second < minutes * 60; second += 1) {
      for (let burst = 0; burst < 10; burst += 1) {
        revision += 1;
        h.hub.publish(TOPIC, keys[revision % keys.length]!, { generation: "g", revision }, [
          "transcript",
        ]);
      }
      h.clock.advance(1_000);
      const metrics = h.hub.metrics();
      maxPendingEntries = Math.max(maxPendingEntries, metrics.pendingEntries);
      maxPendingBytes = Math.max(maxPendingBytes, metrics.pendingBytes);
      // Every five minutes one view closes and another opens.
      if (second % 300 === 299) {
        const [closing, ...rest] = open;
        h.hub.closeConnection(closing!.streamId);
        const next = h.open();
        await h.set("owner", next.streamId, 1, keys);
        open = [...rest, next];
      }
    }
    expect(maxPendingEntries).toBeLessThanOrEqual(keys.length * open.length);
    expect(maxPendingBytes).toBeLessThan(64 * 1024);
    for (const connection of open) h.hub.closeConnection(connection.streamId);
    expect(h.hub.metrics()).toMatchObject({
      connections: 0,
      pendingEntries: 0,
      pendingBytes: 0,
      observedKeysByTopic: {},
    });
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.topic.released.sort()).toEqual([...h.topic.retained].sort());
  });
});
