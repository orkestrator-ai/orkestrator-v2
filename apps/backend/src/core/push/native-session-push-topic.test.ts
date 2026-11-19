import { describe, expect, test } from "bun:test";
import type { NativeAgentLiveUpdate } from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { formatNativeSessionPushKey, type PushStamp } from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  NATIVE_SESSION_OBSERVE_IDLE_MS,
  NATIVE_SESSION_OBSERVE_RESPONSIVE_MS,
  NativeSessionPushTopic,
  type NativeSessionLiveRead,
} from "./native-session-push-topic.js";
import { BackendPush } from "./index.js";

const KEY = { environmentId: "env-1", agent: "claude", logicalSessionKey: "tab-1" };
const PUSH_KEY = formatNativeSessionPushKey(KEY);

interface SessionModel {
  transcript: number;
  state: number;
  phase: string;
}

function liveUpdate(model: SessionModel, input: NativeSessionLiveRead): NativeAgentLiveUpdate {
  const transcriptToken = `t${model.transcript}`;
  const stateToken = `s${model.state}:${model.phase}`;
  const identity = {} as never;
  return {
    viewVersion: 1,
    transcript:
      input.transcriptToken === transcriptToken
        ? { viewVersion: 1, status: "unchanged", token: transcriptToken, identity }
        : { viewVersion: 1, status: "snapshot", token: transcriptToken, value: {} as never },
    state:
      input.stateToken === stateToken
        ? { viewVersion: 1, status: "unchanged", token: stateToken, identity }
        : {
            viewVersion: 1,
            status: "snapshot",
            token: stateToken,
            value: { turn: { phase: model.phase } } as never,
          },
  };
}

function harness(model: SessionModel = { transcript: 1, state: 1, phase: "idle" }) {
  const clock = new ManualClock();
  const reads: NativeSessionLiveRead[] = [];
  const published: Array<{ key: string; stamp: PushStamp; parts: readonly string[] }> = [];
  const wakes: string[] = [];
  let observed = 0;
  const topic = new NativeSessionPushTopic({
    timers: clock,
    readLiveUpdate: async (input) => {
      reads.push(input);
      return liveUpdate(model, input);
    },
    sessionExists: async (key) => key.logicalSessionKey !== "missing",
    publish: (key, stamp, parts) => published.push({ key, stamp, parts }),
    onWake: (key) => wakes.push(key.logicalSessionKey),
    observeSession: () => {
      observed += 1;
      return () => {
        observed -= 1;
      };
    },
  });
  const advance = async (ms: number) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  return { clock, topic, model, reads, published, wakes, observed: () => observed, advance };
}

describe("NativeSessionPushTopic", () => {
  test("validates keys against the known agents", () => {
    const { topic } = harness();
    expect(topic.validKey(PUSH_KEY)).toBe(true);
    expect(topic.validKey("env-1/not-an-agent/tab")).toBe(false);
    expect(topic.validKey("garbage")).toBe(false);
  });

  test("the first read is a baseline; later token moves publish the parts that moved", async () => {
    const h = harness();
    h.topic.retain(PUSH_KEY);
    await h.advance(0);
    expect(h.reads).toHaveLength(1);
    expect(h.published).toEqual([]);
    expect(await h.topic.resolve(PUSH_KEY)).toMatchObject({ status: "ok", revision: 0 });

    h.model.transcript = 2;
    await h.advance(NATIVE_SESSION_OBSERVE_IDLE_MS);
    expect(h.reads.at(-1)).toMatchObject({ transcriptToken: "t1", stateToken: "s1:idle" });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.parts).toEqual(["transcript"]);
    expect(h.published[0]!.stamp.revision).toBe(1);
    expect(await h.topic.resolve(PUSH_KEY)).toMatchObject({ status: "ok", revision: 1 });
  });

  test("a phase change also names discovery, and a running turn is observed at the responsive cadence", async () => {
    const h = harness();
    h.topic.retain(PUSH_KEY);
    await h.advance(0);
    h.model.phase = "running";
    h.model.state = 2;
    await h.advance(NATIVE_SESSION_OBSERVE_IDLE_MS);
    expect([...h.published[0]!.parts].sort()).toEqual(["discovery", "state"]);
    const readsBefore = h.reads.length;
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    expect(h.reads.length).toBe(readsBefore + 1);
  });

  test("a quiet session publishes nothing, and a qualified idle one backs off", async () => {
    const h = harness();
    h.topic.retain(PUSH_KEY);
    await h.advance(0);
    await h.advance(60_000);
    expect(h.published).toEqual([]);
    // Claude's idle view is qualified only with quietObservation, so it keeps
    // the 1.5 s cadence: 40 reads a minute, the old one-viewer poll.
    expect(h.reads.length).toBeLessThanOrEqual(42);

    const codex = harness();
    const codexKey = formatNativeSessionPushKey({ ...KEY, agent: "opencode" });
    codex.topic.retain(codexKey);
    await codex.advance(0);
    await codex.advance(60_000);
    // The quiet ladder (3, 5, 10, 15 s...) reads far less.
    expect(codex.reads.length).toBeLessThan(10);
  });

  test("an activity announcement or invalidation wakes the session's observer at once", async () => {
    const h = harness();
    h.topic.retain(PUSH_KEY);
    await h.advance(0);
    h.model.state = 2;
    h.topic.observeEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: "env-1",
      agent: "claude",
      logical_session_key: "tab-1",
      state: "working",
    });
    await h.advance(0);
    expect(h.published.map((p) => p.parts)).toEqual([["state"]]);
    expect(h.wakes).toEqual(["tab-1"]);

    h.topic.observeEvent("resource-changed", {
      resource: "native-agent-session",
      id: "env-1",
      agent: "claude",
      logicalSessionKey: "tab-1",
    });
    await h.advance(0);
    expect(h.wakes).toEqual(["tab-1", "tab-1"]);
    // Another session's events and other resources do not wake it.
    h.topic.observeEvent("resource-changed", { resource: "native-agent-session", id: "env-2" });
    h.topic.observeEvent("resource-changed", { resource: "kanban", id: "env-1" });
    h.topic.observeEvent("terminal-output-x", { data: "..." });
    expect(h.wakes).toHaveLength(2);
  });

  test("a missing or unavailable part is announced once, not on every read", async () => {
    let fail = false;
    const clock = new ManualClock();
    const published: string[][] = [];
    const topic = new NativeSessionPushTopic({
      timers: clock,
      readLiveUpdate: async (input) => {
        const update = liveUpdate({ transcript: 1, state: 1, phase: "idle" }, input);
        return fail
          ? { ...update, state: { viewVersion: 1, status: "unavailable", retryable: true } }
          : update;
      },
      sessionExists: async () => true,
      publish: (_key, _stamp, parts) => published.push([...parts]),
    });
    topic.retain(PUSH_KEY);
    await clock.advanceAsync(0);
    fail = true;
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_IDLE_MS);
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_IDLE_MS);
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_IDLE_MS);
    expect(published).toEqual([["state"]]);
    fail = false;
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_IDLE_MS);
    expect(published).toEqual([["state"], ["state"]]);
    topic.dispose();
  });

  test("release stops the observer and its read sharing; retain again starts a new generation", async () => {
    const h = harness();
    h.topic.retain(PUSH_KEY);
    await h.advance(0);
    expect(h.observed()).toBe(1);
    const first = await h.topic.resolve(PUSH_KEY);
    h.topic.release(PUSH_KEY);
    expect(h.observed()).toBe(0);
    expect(h.clock.pendingCount()).toBe(0);
    const reads = h.reads.length;
    await h.advance(60_000);
    expect(h.reads.length).toBe(reads);
    expect(await h.topic.resolve(PUSH_KEY)).toEqual({ status: "missing" });

    h.topic.retain(PUSH_KEY);
    const second = await h.topic.resolve(PUSH_KEY);
    expect(
      first.status === "ok" && second.status === "ok" && first.generation !== second.generation,
    ).toBe(true);
    h.topic.dispose();
  });

  test("a session that does not exist resolves missing", async () => {
    const h = harness();
    const key = formatNativeSessionPushKey({ ...KEY, logicalSessionKey: "missing" });
    h.topic.retain(key);
    expect(await h.topic.resolve(key)).toEqual({ status: "missing" });
    h.topic.dispose();
  });
});

describe("BackendPush end to end", () => {
  test("two viewers of one session cost one observer read per round, and both get the frame", async () => {
    const clock = new ManualClock();
    const model: SessionModel = { transcript: 1, state: 1, phase: "running" };
    const reads: NativeSessionLiveRead[] = [];
    const push = new BackendPush({
      hub: { timers: clock, now: () => clock.now() },
      sessionExists: async () => true,
      nativeAgents: () => ({
        getLiveUpdate: async (input) => {
          reads.push(input);
          return liveUpdate(model, input);
        },
        observePushSession: () => () => undefined,
        forgetPushSettled: () => undefined,
      }),
    });
    const frames: Array<{ viewer: string; event: string; payload: unknown }> = [];
    const open = (viewer: string) =>
      push.openConnection("owner", {
        write: (event, payload) => {
          frames.push({ viewer, event, payload });
          return true;
        },
        backpressured: () => false,
      });
    const a = open("a");
    const b = open("b");
    const subscriptions = [{ topic: "native-session", key: PUSH_KEY }];
    await push.setSubscriptions("owner", { streamId: a, setRevision: 1, subscriptions });
    await push.setSubscriptions("owner", { streamId: b, setRevision: 1, subscriptions });
    await clock.advanceAsync(0);
    expect(reads).toHaveLength(1);
    // A quiet running turn for ten seconds: one observer read per 500 ms, no frames.
    await clock.advanceAsync(10_000);
    expect(reads.length).toBeLessThanOrEqual(21);
    expect(frames).toEqual([]);

    model.transcript = 2;
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    await clock.advanceAsync(50);
    expect(frames.map((f) => f.viewer).sort()).toEqual(["a", "b"]);
    expect(push.metrics()).toMatchObject({
      connections: 2,
      subscriptionsByTopic: { "native-session": 2 },
      observedKeysByTopic: { "native-session": 1 },
      topics: { "native-session": { observers: 1 } },
    });

    // Closing both views stops the observer: nothing is read for a session no one sees.
    push.closeConnection(a);
    push.closeConnection(b);
    const after = reads.length;
    await clock.advanceAsync(10_000);
    expect(reads.length).toBe(after);
    expect(push.metrics().topics["native-session"].observers).toBe(0);
    push.dispose();
  });

  test("an announced activity reaches the subscribed connection within the coalescing window", async () => {
    const clock = new ManualClock();
    const model: SessionModel = { transcript: 1, state: 1, phase: "idle" };
    const push = new BackendPush({
      hub: { timers: clock, now: () => clock.now() },
      sessionExists: async () => true,
      nativeAgents: () => ({
        getLiveUpdate: async (input) => liveUpdate(model, input),
        observePushSession: () => () => undefined,
        forgetPushSettled: () => undefined,
      }),
    });
    const written: number[] = [];
    const stream = push.openConnection("owner", {
      write: () => {
        written.push(clock.now());
        return true;
      },
      backpressured: () => false,
    });
    await push.setSubscriptions("owner", {
      streamId: stream,
      setRevision: 1,
      subscriptions: [{ topic: "native-session", key: PUSH_KEY }],
    });
    await clock.advanceAsync(0);
    // An approval parks the turn: the bridge-side change and its announcement.
    model.state = 2;
    const announcedAt = clock.now() + 100;
    await clock.advanceAsync(100);
    push.observeEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: KEY.environmentId,
      agent: KEY.agent,
      logical_session_key: KEY.logicalSessionKey,
      state: "waiting",
    });
    await clock.advanceAsync(0);
    await clock.advanceAsync(50);
    expect(written).toHaveLength(1);
    // Backend share of the observation latency, excluding the provider read.
    expect(written[0]! - announcedAt).toBeLessThanOrEqual(50);
    push.dispose();
  });

  test("rejects malformed subscribe arguments", async () => {
    const push = new BackendPush({
      sessionExists: async () => true,
      nativeAgents: () => undefined,
    });
    await expect(
      push.setSubscriptions("o", { streamId: "x", setRevision: -1, subscriptions: [] }),
    ).rejects.toThrow("setRevision");
    await expect(
      push.setSubscriptions("o", { streamId: 1, setRevision: 1, subscriptions: [] }),
    ).rejects.toThrow("streamId");
    push.dispose();
  });
});
