import { describe, expect, test } from "bun:test";
import type { NativeAgentLiveUpdate } from "@orkestrator/protocol/native-agent";
import {
  formatNativeSessionPushKey,
  formatToolOutputPushKey,
  type PushStamp,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  NATIVE_SESSION_OBSERVE_RESPONSIVE_MS,
  NativeSessionPushTopic,
  type NativeSessionLiveRead,
} from "./native-session-push-topic.js";
import { ToolOutputPushTopic, type ToolOutputSourceAnswer } from "./tool-output-push-topic.js";
import { BackendPush } from "./index.js";

const SESSION = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };
const CALL = { ...SESSION, toolUseId: "call-1" };
const KEY = formatToolOutputPushKey(CALL);
const SESSION_KEY = formatNativeSessionPushKey(SESSION);

interface Model {
  /** Moves the observer's transcript token. */
  transcript: number;
  source: ToolOutputSourceAnswer;
}

function liveUpdate(model: Model, input: NativeSessionLiveRead): NativeAgentLiveUpdate {
  const transcriptToken = `t${model.transcript}`;
  const identity = {} as never;
  return {
    viewVersion: 1,
    transcript:
      input.transcriptToken === transcriptToken
        ? { viewVersion: 1, status: "unchanged", token: transcriptToken, identity }
        : { viewVersion: 1, status: "snapshot", token: transcriptToken, value: {} as never },
    state:
      input.stateToken === "s"
        ? { viewVersion: 1, status: "unchanged", token: "s", identity }
        : {
            viewVersion: 1,
            status: "snapshot",
            token: "s",
            value: { turn: { phase: "running" } } as never,
          },
  };
}

function running(detailRef: string): ToolOutputSourceAnswer {
  return { located: true, detailRef, toolState: "pending", complete: false };
}

function harness(model: Model = { transcript: 1, source: running("ref-1") }) {
  const clock = new ManualClock();
  const reads: NativeSessionLiveRead[] = [];
  const sessionPublished: string[] = [];
  const published: Array<{ key: string; stamp: PushStamp; parts: readonly string[] }> = [];
  let observedSessions = 0;
  let sourceCalls = 0;
  const sessions = new NativeSessionPushTopic({
    timers: clock,
    readLiveUpdate: async (input) => {
      reads.push(input);
      return liveUpdate(model, input);
    },
    sessionExists: async (key) => key.logicalSessionKey !== "missing",
    publish: (key) => sessionPublished.push(key),
    observeSession: () => {
      observedSessions += 1;
      return () => {
        observedSessions -= 1;
      };
    },
  });
  const topic = new ToolOutputPushTopic({
    holdSession: (key, listener) => sessions.hold(key, listener),
    source: () => {
      sourceCalls += 1;
      return model.source;
    },
    sessionExists: async (key) => key.logicalSessionKey !== "missing",
    publish: (key, stamp, parts) => published.push({ key, stamp, parts }),
  });
  const advance = async (ms: number) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  return {
    clock,
    sessions,
    topic,
    model,
    reads,
    published,
    sessionPublished,
    observedSessions: () => observedSessions,
    sourceCalls: () => sourceCalls,
    advance,
  };
}

describe("ToolOutputPushTopic", () => {
  test("validates keys", () => {
    const { topic } = harness();
    expect(topic.validKey(KEY)).toBe(true);
    expect(topic.validKey(formatToolOutputPushKey({ ...CALL, agent: "nope" }))).toBe(false);
    expect(topic.validKey(SESSION_KEY.slice(0, 5))).toBe(false);
  });

  test("holds the session and announces only when the call's output moved", async () => {
    const h = harness();
    h.topic.retain(KEY);
    expect(h.observedSessions()).toBe(1);
    expect(await h.topic.resolve(KEY)).toMatchObject({ status: "ok", revision: 0 });
    // The observer's first answer: the session moved, the call did not.
    await h.advance(0);
    expect(h.reads).toHaveLength(1);
    expect(h.published).toEqual([]);

    // The transcript moves but this call's reference does not: nothing.
    h.model.transcript = 2;
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    expect(h.sourceCalls()).toBeGreaterThan(1);
    expect(h.published).toEqual([]);

    // The call's output grew: its reference moved.
    h.model.transcript = 3;
    h.model.source = running("ref-2");
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ key: KEY, parts: ["output"] });
    expect(h.published[0]!.stamp.revision).toBe(1);
    // The frame names ids and a stamp only.
    expect(JSON.stringify(h.published)).not.toContain("ref-2");
  });

  test("lets go of the session once completion is announced", async () => {
    const h = harness();
    h.topic.retain(KEY);
    await h.advance(0);
    h.model.transcript = 2;
    h.model.source = { located: true, detailRef: "ref-9", toolState: "success", complete: true };
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    expect(h.published).toHaveLength(1);
    expect(h.observedSessions()).toBe(0);
    const readsAfter = h.reads.length;
    await h.advance(10_000);
    expect(h.reads.length).toBe(readsAfter);
    expect(h.topic.metrics()).toMatchObject({ watches: 1, holding: 0, completions: 1 });
    h.topic.release(KEY);
    expect(h.topic.metrics()).toMatchObject({ watches: 0, holding: 0 });
  });

  test("a call already complete when subscribed holds nothing", async () => {
    const h = harness({
      transcript: 1,
      source: { located: true, toolState: "success", complete: true },
    });
    h.topic.retain(KEY);
    expect(h.observedSessions()).toBe(0);
    await h.advance(5_000);
    expect(h.reads).toHaveLength(0);
  });

  test("release stops all work and keeps nothing", async () => {
    const h = harness();
    h.topic.retain(KEY);
    await h.advance(0);
    h.topic.release(KEY);
    expect(h.observedSessions()).toBe(0);
    expect(h.sessions.metrics().observers).toBe(0);
    const reads = h.reads.length;
    const sources = h.sourceCalls();
    h.model.transcript = 5;
    h.model.source = running("ref-5");
    await h.advance(20_000);
    expect(h.reads.length).toBe(reads);
    expect(h.sourceCalls()).toBe(sources);
    expect(h.published).toEqual([]);
    expect(h.topic.metrics()).toMatchObject({ watches: 0, holding: 0 });
    expect(await h.topic.resolve(KEY)).toEqual({ status: "missing" });
  });

  test("shares the session's observer with a native-session subscriber", async () => {
    const h = harness();
    h.sessions.retain(SESSION_KEY);
    h.topic.retain(KEY);
    expect(h.sessions.metrics().observers).toBe(1);
    expect(h.observedSessions()).toBe(1);
    // The view's own subscription lets go first: the row's hold keeps it.
    h.sessions.release(SESSION_KEY);
    expect(h.sessions.metrics().observers).toBe(1);
    h.topic.release(KEY);
    expect(h.sessions.metrics().observers).toBe(0);
    // And the other way round: the row lets go, the view keeps it.
    h.topic.retain(KEY);
    h.sessions.retain(SESSION_KEY);
    h.topic.release(KEY);
    expect(h.sessions.metrics().observers).toBe(1);
    h.sessions.release(SESSION_KEY);
    expect(h.sessions.metrics().observers).toBe(0);
  });

  test("a call that leaves the live view is announced once", async () => {
    const h = harness();
    h.topic.retain(KEY);
    await h.advance(0);
    h.model.transcript = 2;
    h.model.source = { located: false };
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    h.model.transcript = 3;
    await h.advance(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    expect(h.published).toHaveLength(1);
  });

  test("a missing session is answered missing", async () => {
    const h = harness();
    const key = formatToolOutputPushKey({ ...CALL, logicalSessionKey: "missing" });
    h.topic.retain(key);
    expect(await h.topic.resolve(key)).toEqual({ status: "missing" });
    h.topic.release(key);
  });
});

describe("BackendPush tool-output", () => {
  test("a subscribed row hears its call's output move through the session observer", async () => {
    const clock = new ManualClock();
    const model: Model = { transcript: 1, source: running("ref-1") };
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
        toolOutputSource: () => model.source,
      }),
    });
    const frames: Array<{ event: string; payload: unknown }> = [];
    const stream = push.openConnection("owner", {
      write: (event, payload) => {
        frames.push({ event, payload });
        return true;
      },
      backpressured: () => false,
    });
    const answer = await push.setSubscriptions("owner", {
      streamId: stream,
      setRevision: 1,
      subscriptions: [{ topic: "tool-output", key: KEY }],
    });
    expect(answer).toMatchObject({
      status: "applied",
      subscriptions: [{ topic: "tool-output", key: KEY, status: "ok" }],
    });
    await clock.advanceAsync(0);
    expect(reads).toHaveLength(1);
    model.transcript = 2;
    model.source = running("ref-2");
    await clock.advanceAsync(NATIVE_SESSION_OBSERVE_RESPONSIVE_MS);
    await clock.advanceAsync(50);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: "push.changed",
      payload: { changes: [{ topic: "tool-output", key: KEY, parts: ["output"] }] },
    });
    expect(push.metrics().topics["tool-output"]).toMatchObject({ watches: 1, holding: 1 });

    // Collapsing the row sends a set without it: the observer stops.
    await push.setSubscriptions("owner", { streamId: stream, setRevision: 2, subscriptions: [] });
    const readsAfter = reads.length;
    model.transcript = 3;
    await clock.advanceAsync(10_000);
    expect(reads.length).toBe(readsAfter);
    expect(push.metrics().topics["tool-output"]).toMatchObject({ watches: 0, holding: 0 });
    expect(push.metrics().topics["native-session"]).toMatchObject({ observers: 0 });
    push.dispose();
  });
});
