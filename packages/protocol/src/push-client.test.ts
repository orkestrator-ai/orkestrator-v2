/**
 * Contract fixtures for the push client controller (design D12): subscribe
 * before snapshot, frames that overtake their answer, seq gaps, resyncs,
 * reconnects, generation changes, denied and missing keys, refused streams
 * and reordered answers. Every case must end with no lost invalidation and
 * the newest set in force.
 */
import { describe, expect, test } from "bun:test";
import { PushSubscriptionClient, type PushKeyChange } from "./push-client";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "./push-events";
import { ManualClock, flushMicrotasks } from "./testing/manual-clock";

const STREAM_A = "stream-aaaaaaaaaaaaaaaa";
const STREAM_B = "stream-bbbbbbbbbbbbbbbb";
const TOPIC = "native-session";

interface PendingCall {
  args: PushSetSubscriptionsArgs;
  signal: AbortSignal;
  resolve(result: PushSetSubscriptionsResult): void;
  reject(error: Error): void;
}

function harness() {
  const clock = new ManualClock();
  const calls: PendingCall[] = [];
  const client = new PushSubscriptionClient({
    timers: clock,
    now: () => clock.now(),
    setSubscriptions: (args, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ args, signal, resolve, reject });
      }),
  });
  const changes: PushKeyChange[] = [];
  const listen = (key: string) => client.subscribe(TOPIC, key, (change) => changes.push(change));
  const tick = async () => {
    clock.advance(0);
    await flushMicrotasks();
  };
  /** Answer the newest call: every key `ok` at the given stamps. */
  const applyLast = async (
    stamps: Record<string, { generation: string; revision: number } | "missing" | "denied">,
    seqBase = 0,
  ) => {
    const call = calls.at(-1)!;
    call.resolve({
      status: "applied",
      setRevision: call.args.setRevision,
      seqBase,
      subscriptions: call.args.subscriptions.map(({ topic, key }) => {
        const stamp = stamps[key] ?? { generation: "g1", revision: 0 };
        if (stamp === "missing") return { topic, key, status: "missing" as const };
        if (stamp === "denied")
          return { topic, key, status: "denied" as const, reason: "limit" as const };
        return { topic, key, status: "ok" as const, ...stamp };
      }),
    });
    await flushMicrotasks();
  };
  const frame = (
    seq: number,
    key: string,
    revision: number,
    parts = ["transcript"],
    generation = "g1",
  ) =>
    client.accept(PUSH_CHANGED_EVENT, {
      seq,
      changes: [{ topic: TOPIC, key, generation, revision, parts }],
    });
  return { clock, calls, client, changes, listen, tick, applyLast, frame };
}

describe("PushSubscriptionClient", () => {
  test("stays unhealthy until a stream offers push and the set is answered", async () => {
    const h = harness();
    h.listen("k1");
    await h.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.client.state()).toBe("connecting");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);

    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    expect(h.client.state()).toBe("snapshotting");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual({
      streamId: STREAM_A,
      setRevision: 1,
      subscriptions: [{ topic: TOPIC, key: "k1" }],
    });
    await h.applyLast({ k1: { generation: "g1", revision: 3 } });
    expect(h.client.state()).toBe("live");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
    // The first answer is read once: it covers the mount read's race.
    expect(h.changes).toEqual([{ topic: TOPIC, key: "k1", parts: null, reason: "subscribed" }]);
  });

  test("a stream without push leaves every key on its polling cadence", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected(null);
    await h.tick();
    expect(h.client.state()).toBe("unavailable");
    expect(h.calls).toHaveLength(0);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
  });

  test("batches mounts into one set call", async () => {
    const h = harness();
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    h.listen("k1");
    h.listen("k2");
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args.subscriptions.map((s) => s.key)).toEqual(["k1", "k2"]);
  });

  test("frames that arrive before their answer are applied and not repeated", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.frame(1, "k1", 4);
    expect(h.changes.map((c) => c.reason)).toEqual(["frame"]);
    // The answer's stamp is what the frame already delivered.
    await h.applyLast({ k1: { generation: "g1", revision: 4 } }, 0);
    expect(h.changes.map((c) => c.reason)).toEqual(["frame"]);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
  });

  test("frames for keys not in the set, and stale revisions, are ignored", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 5 } });
    h.changes.length = 0;
    h.frame(1, "other", 1);
    h.frame(2, "k1", 5);
    h.frame(3, "k1", 6, ["state"]);
    expect(h.changes).toEqual([{ topic: TOPIC, key: "k1", parts: ["state"], reason: "frame" }]);
    expect(h.client.diagnostics().changesIgnored).toBe(2);
  });

  test("duplicate frames are harmless", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 0 } });
    h.changes.length = 0;
    h.frame(1, "k1", 1);
    h.frame(1, "k1", 1);
    expect(h.changes).toHaveLength(1);
    expect(h.client.diagnostics().duplicateFrames).toBe(1);
    expect(h.client.state()).toBe("live");
  });

  test("a seq gap recovers by re-subscribing; the answer names what moved", async () => {
    const h = harness();
    h.listen("k1");
    h.listen("k2");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({
      k1: { generation: "g1", revision: 1 },
      k2: { generation: "g1", revision: 1 },
    });
    h.changes.length = 0;
    // seq 2 (k2's change) never arrives.
    h.frame(1, "k1", 2);
    h.frame(3, "k1", 3);
    expect(h.client.state()).toBe("recovering");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    await h.tick();
    expect(h.calls).toHaveLength(2);
    await h.applyLast(
      { k1: { generation: "g1", revision: 3 }, k2: { generation: "g1", revision: 2 } },
      3,
    );
    expect(h.client.state()).toBe("live");
    expect(h.changes).toEqual([
      { topic: TOPIC, key: "k1", parts: ["transcript"], reason: "frame" },
      { topic: TOPIC, key: "k1", parts: ["transcript"], reason: "frame" },
      { topic: TOPIC, key: "k2", parts: null, reason: "resubscribed" },
    ]);
    expect(h.client.diagnostics().seqGaps).toBe(1);
  });

  test("push.resync re-reads the named topic and re-subscribes", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 1 } });
    h.changes.length = 0;
    h.client.accept(PUSH_RESYNC_EVENT, { seq: 1, reason: "pending-bound", topics: [TOPIC] });
    expect(h.changes).toEqual([{ topic: TOPIC, key: "k1", parts: null, reason: "resync" }]);
    expect(h.client.state()).toBe("recovering");
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 1 } }, 1);
    expect(h.client.state()).toBe("live");
  });

  test("a reconnect is a new seq space; a changed generation reads again", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 7 } });
    h.frame(1, "k1", 8);
    h.changes.length = 0;
    h.client.streamDisconnected();
    expect(h.client.state()).toBe("recovering");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);

    h.client.streamConnected({ versions: [1], streamId: STREAM_B });
    await h.tick();
    expect(h.calls.at(-1)!.args.streamId).toBe(STREAM_B);
    // A restarted backend: a new generation at a lower revision is still news.
    await h.applyLast({ k1: { generation: "g2", revision: 0 } });
    expect(h.changes).toEqual([{ topic: TOPIC, key: "k1", parts: null, reason: "resubscribed" }]);
    // seq 1 is valid again on the new stream.
    h.frame(1, "k1", 1, ["state"], "g2");
    expect(h.changes).toHaveLength(2);
    expect(h.client.state()).toBe("live");
  });

  test("a late answer and visibility change cannot make a disconnected stream live", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    const oldRequest = h.calls[0]!;
    h.client.streamDisconnected();
    expect(oldRequest.signal.aborted).toBe(true);
    h.client.setPaused(true);
    h.client.setPaused(false);
    await h.applyLast({ k1: { generation: "old", revision: 7 } });
    h.frame(1, "k1", 8);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.changes).toEqual([]);
    expect(h.client.state()).toBe("recovering");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    h.client.dispose();
  });

  test("a replacement stream sends while the old transport is still stalled", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.client.streamDisconnected();
    h.client.streamConnected({ versions: [1], streamId: STREAM_B });
    await h.tick();
    expect(h.calls.map((call) => call.args.streamId)).toEqual([STREAM_A, STREAM_B]);
    await h.applyLast({ k1: { generation: "new", revision: 1 } });
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
    expect(h.changes).toMatchObject([{ reason: "subscribed" }]);
    h.client.dispose();
  });

  test("a missing session becomes healthy when its mapping is established", async () => {
    const h = harness();
    h.listen("k1");
    h.listen("ready");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: "missing" });
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    h.clock.advance(1_000);
    await h.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.client.isHealthy(TOPIC, "ready")).toBe(true);
    await h.applyLast({ k1: { generation: "created", revision: 1 } });
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
    h.client.dispose();
  });

  test("reports local frame processing and frame-to-projection measurements separately", async () => {
    const h = harness();
    h.client.subscribe(TOPIC, "k1", ({ reason }) => {
      if (reason === "frame") h.clock.advance(3);
    });
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({});
    h.frame(1, "k1", 1);
    h.client.noteObservationApplied(11);
    h.client.noteObservationApplied(25);
    expect(h.client.diagnostics()).toMatchObject({
      frameProcessingMs: 3,
      observationSamples: 2,
      observationMs: 36,
      maxObservationMs: 25,
    });
    h.client.dispose();
  });

  test("an unchanged stamp after reconnect costs no read", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 2 } });
    h.changes.length = 0;
    h.client.streamConnected({ versions: [1], streamId: STREAM_B });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 2 } });
    expect(h.changes).toEqual([]);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
  });

  test("denied and missing keys stay on polling while the others are healthy", async () => {
    const h = harness();
    h.listen("ok");
    h.listen("gone");
    h.listen("nope");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ gone: "missing", nope: "denied" });
    expect(h.client.isHealthy(TOPIC, "ok")).toBe(true);
    expect(h.client.isHealthy(TOPIC, "gone")).toBe(false);
    expect(h.client.isHealthy(TOPIC, "nope")).toBe(false);
  });

  test("a refused stream is unavailable until the next connection", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.calls.at(-1)!.resolve({ status: "refused", reason: "stream-unknown" });
    await flushMicrotasks();
    expect(h.client.state()).toBe("unavailable");
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    h.client.streamConnected({ versions: [1], streamId: STREAM_B });
    await h.tick();
    await h.applyLast({});
    expect(h.client.state()).toBe("live");
  });

  test("a failed call retries with backoff and stays unhealthy meanwhile", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.calls.at(-1)!.reject(new Error("offline"));
    await flushMicrotasks();
    expect(h.client.state()).toBe("recovering");
    h.clock.advance(999);
    await flushMicrotasks();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(1);
    await flushMicrotasks();
    expect(h.calls).toHaveLength(2);
    await h.applyLast({});
    expect(h.client.state()).toBe("live");
  });

  test("a set changed while a call is out is sent next, and the newest set wins", async () => {
    const h = harness();
    const stop = h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.listen("k2");
    stop();
    await h.tick();
    expect(h.calls).toHaveLength(1);
    await h.applyLast({});
    // The first answer applied, but the set is dirty: not live yet.
    expect(h.client.state()).toBe("snapshotting");
    await h.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.args.subscriptions.map((s) => s.key)).toEqual(["k2"]);
    expect(h.calls[1]!.args.setRevision).toBe(2);
    await h.applyLast({});
    expect(h.client.state()).toBe("live");
    expect(h.client.isHealthy(TOPIC, "k2")).toBe(true);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
  });

  test("an answer for an older set revision is ignored", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    const call = h.calls[0]!;
    call.resolve({
      status: "applied",
      setRevision: call.args.setRevision - 1,
      seqBase: 0,
      subscriptions: [{ topic: TOPIC, key: "k1", status: "ok", generation: "g", revision: 1 }],
    });
    await flushMicrotasks();
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    expect(h.changes).toEqual([]);
  });

  test("superseded: sends again past the backend's revision", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    h.calls[0]!.resolve({ status: "superseded", setRevision: 9 });
    await flushMicrotasks();
    await h.tick();
    expect(h.calls[1]!.args.setRevision).toBe(10);
  });

  test("a hidden document sends an empty set and is unhealthy; returning re-subscribes", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    await h.tick();
    await h.applyLast({ k1: { generation: "g1", revision: 1 } });
    h.changes.length = 0;
    h.client.setPaused(true);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(false);
    await h.tick();
    expect(h.calls.at(-1)!.args.subscriptions).toEqual([]);
    await h.applyLast({});
    h.client.setPaused(false);
    await h.tick();
    expect(h.calls.at(-1)!.args.subscriptions).toEqual([{ topic: TOPIC, key: "k1" }]);
    await h.applyLast({ k1: { generation: "g1", revision: 4 } });
    expect(h.changes).toEqual([{ topic: TOPIC, key: "k1", parts: null, reason: "resubscribed" }]);
    expect(h.client.isHealthy(TOPIC, "k1")).toBe(true);
  });

  test("a listener that throws does not stop the others or the controller", async () => {
    const errors: unknown[] = [];
    const clock = new ManualClock();
    const client = new PushSubscriptionClient({
      timers: clock,
      setSubscriptions: async (args) => ({
        status: "applied",
        setRevision: args.setRevision,
        seqBase: 0,
        subscriptions: args.subscriptions.map(({ topic, key }) => ({
          topic,
          key,
          status: "ok" as const,
          generation: "g",
          revision: 0,
        })),
      }),
      onListenerError: (error) => errors.push(error),
    });
    const heard: string[] = [];
    client.subscribe(TOPIC, "k", () => {
      throw new Error("boom");
    });
    client.subscribe(TOPIC, "k", (change) => heard.push(change.reason));
    client.streamConnected({ versions: [1], streamId: STREAM_A });
    clock.advance(0);
    await flushMicrotasks();
    expect(heard).toEqual(["subscribed"]);
    expect(errors).toHaveLength(1);
  });

  test("dispose stops everything", async () => {
    const h = harness();
    h.listen("k1");
    h.client.streamConnected({ versions: [1], streamId: STREAM_A });
    h.client.dispose();
    await h.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.client.state()).toBe("closed");
    expect(h.client.accept(PUSH_CHANGED_EVENT, { seq: 1, changes: [] })).toBe(true);
  });
});
