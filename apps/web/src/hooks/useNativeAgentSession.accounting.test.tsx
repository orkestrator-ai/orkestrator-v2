/**
 * Retained-history byte accounting for the native-agent session hook.
 *
 * Every installed update must keep the store's per-session and process-wide
 * byte totals exactly equal to encoding what it retains, while serializing only
 * the messages that actually changed. Each scenario compares the running
 * totals with a slow full recomputation after every step.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentMessagePage,
  NativeAgentProjectionUpdate,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import {
  measureEncodedValue,
  setEncodedValueMeasureForTests,
  slowEncodedBytes,
} from "@/lib/native-history-accounting";
import {
  evictNativeAgentHistoryCaches,
  recomputeNativeAgentProjectionTotals,
  useNativeAgentProjectionStore,
} from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  text: string;
  parts?: Array<{ type: string; content: string }>;
}

const realBackendSnapshot = { ...realBackend };
const SESSION_KEY = "env-env-1:tab-1";
const PAGING_EPOCH = "paging-epoch-1";

let transcriptUpdates: Array<() => NativeAgentTranscriptUpdate<TestMessage>> = [];
let stateUpdates: Array<() => NativeAgentSessionStateUpdate> = [];
let projectionUpdates: Array<() => NativeAgentProjectionUpdate<TestMessage>> = [];
let messagePages: Array<() => NativeAgentMessagePage<TestMessage>> = [];

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "codex",
  logicalSessionKey: SESSION_KEY,
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  getNativeAgentTranscriptUpdate: async (input: { knownToken?: string }) =>
    transcriptUpdates.shift()?.() ?? {
      viewVersion: 1,
      status: "unchanged",
      token: input.knownToken ?? "transcript-unscripted",
      identity,
    },
  getNativeAgentSessionStateUpdate: async () =>
    stateUpdates.shift()?.() ?? {
      viewVersion: 1,
      status: "unchanged",
      token: "state-unscripted",
      identity,
    },
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery-unscripted",
    identity,
  }),
  getNativeAgentMessagePage: async () => {
    const next = messagePages.shift();
    if (!next) throw new Error("Unexpected history page request");
    return next();
  },
  getNativeAgentProjectionUpdate: async () => {
    const next = projectionUpdates.shift();
    if (!next) throw new Error("Unexpected joined projection request");
    return next();
  },
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: SESSION_KEY,
    environmentId: "env-1",
    agent: "codex",
  }),
  adoptNativeAgentSession: async () => ({}),
  stopNativeAgentSession: async () => null,
  resumeNativeAgentSession: async () => null,
  getNativeAgentProjection: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function message(id: string, text = `body-${id}`, parts?: TestMessage["parts"]): TestMessage {
  return parts ? { id, text, parts } : { id, text };
}

function parts(count: number): Array<{ type: string; content: string }> {
  return Array.from({ length: count }, (_, index) => ({ type: "text", content: `part-${index}` }));
}

function transcriptSnapshot(
  token: string,
  messages: TestMessage[],
  extras: Partial<NativeAgentTranscriptView<TestMessage>> = {},
): NativeAgentTranscriptUpdate<TestMessage> {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      freshness: messages.length === 0 ? "empty" : "current",
      messages,
      historyEpoch: "epoch-1",
      historyComplete: true,
      ...extras,
    },
  };
}

/** A live tail whose earlier messages have aged out of the server window. */
function tail(token: string, messages: TestMessage[]): NativeAgentTranscriptUpdate<TestMessage> {
  return transcriptSnapshot(token, messages, {
    historyComplete: false,
    messageWindow: {
      limit: messages.length,
      truncated: true,
      truncationReason: "count",
      canLoadEarlier: true,
    },
  });
}

function upsertDelta(
  baseToken: string,
  token: string,
  upserted: TestMessage,
  liveMessageIds: string[],
): NativeAgentTranscriptUpdate<TestMessage> {
  return {
    viewVersion: 1,
    status: "delta",
    baseToken,
    token,
    identity,
    delta: {
      messageUpserts: [upserted],
      liveMessageIds,
      deletedMessageIds: [],
      freshness: "current",
      historyEpoch: "epoch-1",
      historyComplete: false,
    },
  };
}

function stateSnapshot(
  token: string,
  viewIdentity: NativeAgentViewIdentity = identity,
): NativeAgentSessionStateUpdate {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity: viewIdentity,
      connection: "connected",
      turn: { phase: "idle" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
    },
  };
}

function projection(messages: TestMessage[]): NativeAgentSessionProjection<TestMessage> {
  return {
    platform: "codex",
    environmentId: "env-1",
    sessionId: "session-1",
    connection: "connected",
    turn: { phase: "idle" },
    messages,
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("codex"),
    revision: 1,
    generation: "generation-1",
  };
}

function historyPage(
  messages: TestMessage[],
  extras: { nextCursor?: string; complete?: boolean } = {},
): NativeAgentMessagePage<TestMessage> {
  return {
    syncVersion: 1,
    messages,
    historyEpoch: PAGING_EPOCH,
    ...(extras.nextCursor ? { nextCursor: extras.nextCursor } : {}),
    complete: extras.complete ?? true,
    truncated: Boolean(extras.nextCursor),
  };
}

function renderSession(isActive = true) {
  return renderHook(
    (props: { isActive: boolean }) =>
      useNativeAgentSession<TestMessage>({
        platform: "codex",
        environmentId: "env-1",
        tabId: "tab-1",
        isActive: props.isActive,
        enabled: true,
      }),
    { initialProps: { isActive } },
  );
}

/** Counts the objects the accounting module actually serializes. */
function countMeasuredObjects(): unknown[] {
  const measured: unknown[] = [];
  setEncodedValueMeasureForTests((value) => {
    if (value !== null && typeof value === "object") measured.push(value);
    return measureEncodedValue(value);
  });
  return measured;
}

function ids(messages: readonly TestMessage[] | undefined): string[] {
  return (messages ?? []).map(({ id }) => id);
}

/** Running totals and per-session sizes against a slow full re-encoding. */
function expectExactAccounting(): void {
  const state = useNativeAgentProjectionStore.getState();
  const slow = recomputeNativeAgentProjectionTotals(state);
  expect(state.projectionBytesTotal).toBe(slow.projectionBytesTotal);
  expect(state.historyBytesTotal).toBe(slow.historyBytesTotal);
  expect(state.progressiveCacheBytesTotal).toBe(slow.progressiveCacheBytesTotal);
  for (const [key, bytes] of state.projectionBytes) {
    expect(bytes).toBe(slowEncodedBytes(state.projections.get(key)!.messages));
  }
  for (const cache of state.syncCaches.values()) {
    expect(cache.historyBytes).toBe(
      cache.historyMessages.length ? slowEncodedBytes(cache.historyMessages) : 0,
    );
  }
}

async function refresh(result: { current: ReturnType<typeof useNativeAgentSession<TestMessage>> }) {
  await act(async () => {
    await result.current.refresh();
  });
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
  projectionUpdates = [];
  messagePages = [];
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  setEncodedValueMeasureForTests();
  useNativeAgentProjectionStore.getState().reset();
});

describe("useNativeAgentSession retained-history accounting", () => {
  test("streaming into one live message over ~8 MiB of history measures only that message", async () => {
    const measured = countMeasuredObjects();
    const history = Array.from({ length: 2_000 }, (_, index) =>
      message(`h${index}`, "x".repeat(4_000)),
    );
    const liveIds = ["l1", "l2", "l3", "l4", "l5"];
    transcriptUpdates = [
      () =>
        transcriptSnapshot("t1", [...history, ...liveIds.map((id) => message(id))], {
          historyComplete: false,
        }),
    ];
    stateUpdates = [() => stateSnapshot("s1")];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection?.messages.length).toBe(2_005));

    // The history ages out of the live window and is retained client-side.
    transcriptUpdates = [
      () =>
        tail(
          "t2",
          liveIds.map((id) => message(id)),
        ),
    ];
    await refresh(result);
    expect(result.current.projection?.messages.length).toBe(2_005);
    const retainedBytes =
      useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.historyBytes ?? 0;
    expect(retainedBytes).toBe(slowEncodedBytes(history));
    expect(retainedBytes).toBeGreaterThan(7.5 * 1024 * 1024);
    expectExactAccounting();

    let token = "t2";
    let streaming = message("l5", "");
    for (let update = 0; update < 10; update += 1) {
      streaming = message("l5", `${streaming.text}chunk-${update} `);
      const baseToken = token;
      const nextToken = `t${update + 3}`;
      const delta = upsertDelta(baseToken, nextToken, streaming, liveIds);
      transcriptUpdates = [() => delta];
      token = nextToken;
      measured.length = 0;
      await refresh(result);
      expect(result.current.projection?.messages.at(-1)).toBe(streaming);
      expect(measured).toEqual([streaming]);
    }
    expect(ids(result.current.projection?.messages)).toEqual([
      ...history.map(({ id }) => id),
      ...liveIds,
    ]);
    expectExactAccounting();

    // An idle poll installs nothing and measures nothing.
    measured.length = 0;
    await refresh(result);
    expect(measured).toEqual([]);
  });

  test("two views share a session and the survivor keeps receiving changes", async () => {
    transcriptUpdates = [() => transcriptSnapshot("t1", [message("m1"), message("m2")])];
    stateUpdates = [() => stateSnapshot("s1")];
    const first = renderSession();
    await waitFor(() =>
      expect(ids(first.result.current.projection?.messages)).toEqual(["m1", "m2"]),
    );
    const second = renderSession();
    expect(ids(second.result.current.projection?.messages)).toEqual(["m1", "m2"]);

    transcriptUpdates = [() => tail("t2", [message("m2"), message("m3")])];
    await refresh(first.result);
    await waitFor(() =>
      expect(ids(second.result.current.projection?.messages)).toEqual(["m1", "m2", "m3"]),
    );
    expectExactAccounting();

    first.unmount();
    const changed = message("m3", "changed");
    transcriptUpdates = [() => tail("t3", [message("m2"), changed, message("m4")])];
    await refresh(second.result);
    expect(ids(second.result.current.projection?.messages)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(second.result.current.projection?.messages[2]).toBe(changed);
    expectExactAccounting();
  });

  test("a global eviction while the hook is mounted but inactive stays released", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("t1", [message("m1"), message("m2"), message("m3")]),
    ];
    stateUpdates = [() => stateSnapshot("s1")];
    const view = renderSession();
    await waitFor(() => expect(view.result.current.projection?.messages.length).toBe(3));
    transcriptUpdates = [() => tail("t2", [message("m3"), message("m4")])];
    await refresh(view.result);
    expect(ids(view.result.current.projection?.messages)).toEqual(["m1", "m2", "m3", "m4"]);
    const retained = useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY);
    expect(retained?.historyBytes).toBeGreaterThan(0);

    view.rerender({ isActive: false });
    // Another session's page load needs the whole remaining budget.
    const otherLive = projection([message("o1")]);
    const otherHistory = [message("o0", "o".repeat(64))];
    act(() => {
      useNativeAgentProjectionStore.getState().setProjection("other", otherLive, {
        liveProjection: otherLive,
        historyComplete: false,
        historyMessages: otherHistory,
        historyBytes: slowEncodedBytes(otherHistory),
      });
      evictNativeAgentHistoryCaches("other", 0, slowEncodedBytes(otherHistory));
    });
    const evicted = useNativeAgentProjectionStore.getState();
    expect(evicted.syncCaches.has(SESSION_KEY)).toBe(false);
    expect(evicted.historyEvictions.get(SESSION_KEY)).toBe(1);
    expect(evicted.historyBytesTotal).toBe(slowEncodedBytes(otherHistory));
    expect(ids(evicted.projections.get(SESSION_KEY)?.messages as TestMessage[])).toEqual([
      "m3",
      "m4",
    ]);
    expectExactAccounting();

    // The mounted hook still holds the pages in refs; its next install must
    // honour the eviction rather than republish them.
    // Reactivating reads straight away; that read carries the next tail.
    transcriptUpdates = [() => tail("t3", [message("m4"), message("m5")])];
    view.rerender({ isActive: true });
    await waitFor(() =>
      expect(ids(view.result.current.projection?.messages)).toEqual(["m4", "m5"]),
    );
    const after = useNativeAgentProjectionStore.getState();
    expect(after.syncCaches.get(SESSION_KEY)?.historyMessages).toEqual([]);
    expect(after.historyBytesTotal).toBe(slowEncodedBytes(otherHistory));
    expectExactAccounting();
  });

  test("delete, partial live head, rewind and provider replacement keep order and totals", async () => {
    const fullHead = message("m5", "turn", parts(4));
    transcriptUpdates = [
      () =>
        transcriptSnapshot("t1", [
          message("m1"),
          message("m2"),
          message("m3"),
          message("m4"),
          fullHead,
          message("m6"),
        ]),
    ];
    stateUpdates = [() => stateSnapshot("s1")];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection?.messages.length).toBe(6));

    transcriptUpdates = [() => tail("t2", [message("m4"), fullHead, message("m6"), message("m7")])];
    await refresh(result);
    expect(ids(result.current.projection?.messages)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expectExactAccounting();

    // Deleting a retained message.
    transcriptUpdates = [
      () => ({
        viewVersion: 1,
        status: "delta",
        baseToken: "t2",
        token: "t3",
        identity,
        delta: {
          messageUpserts: [],
          liveMessageIds: ["m4", "m5", "m6", "m7"],
          deletedMessageIds: ["m2"],
          freshness: "current",
          historyEpoch: "epoch-1",
          historyComplete: false,
        },
      }),
    ];
    await refresh(result);
    expect(ids(result.current.projection?.messages)).toEqual(["m1", "m3", "m4", "m5", "m6", "m7"]);
    expectExactAccounting();

    // A part-trimmed live head this client already holds in full.
    transcriptUpdates = [
      () =>
        transcriptSnapshot(
          "t4",
          [message("m5", "turn", parts(4).slice(2)), message("m6"), message("m7"), message("m8")],
          {
            historyComplete: false,
            messageWindow: {
              limit: 4,
              truncated: true,
              truncationReason: "bytes",
              omittedParts: 2,
              canLoadEarlier: true,
            },
          },
        ),
    ];
    await refresh(result);
    expect(ids(result.current.projection?.messages)).toEqual([
      "m1",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
    ]);
    expect(result.current.projection?.messages[3]).toBe(fullHead);
    expectExactAccounting();

    // A rewind to an earlier prefix drops everything after it.
    transcriptUpdates = [() => transcriptSnapshot("t5", [message("m1"), message("m3")])];
    await refresh(result);
    expect(ids(result.current.projection?.messages)).toEqual(["m1", "m3"]);
    expect(useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.historyBytes).toBe(
      0,
    );
    expectExactAccounting();

    // A different provider session (a new runtime) replaces the transcript.
    const replaced = {
      ...identity,
      providerSessionId: "session-2",
      sourceGeneration: "generation-2",
    };
    transcriptUpdates = [
      () => ({
        viewVersion: 1,
        status: "snapshot",
        token: "t6",
        value: {
          identity: replaced,
          freshness: "current",
          messages: [message("n1"), message("n2")],
          historyEpoch: "epoch-2",
          historyComplete: true,
        },
      }),
    ];
    stateUpdates = [() => stateSnapshot("s2", replaced)];
    await refresh(result);
    expect(ids(result.current.projection?.messages)).toEqual(["n1", "n2"]);
    expectExactAccounting();
  });

  test("duplicate and overlapping pages keep order and measure new messages once", async () => {
    const measured = countMeasuredObjects();
    transcriptUpdates = [() => tail("t1", [message("m5"), message("m6")])];
    stateUpdates = [() => stateSnapshot("s1")];
    projectionUpdates = [
      () => ({
        syncVersion: 1,
        status: "snapshot",
        token: "joined-1",
        projection: projection([message("m5"), message("m6")]),
        historyCursor: "cursor-before-m5",
        historyEpoch: PAGING_EPOCH,
        historyComplete: false,
      }),
    ];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));

    const loadEarlier = async () => {
      await act(async () => {
        await result.current.loadEarlierMessages();
      });
    };

    messagePages = [
      () =>
        historyPage([message("m3"), message("m4")], {
          nextCursor: "cursor-before-m3",
          complete: false,
        }),
    ];
    await loadEarlier();
    expect(ids(result.current.projection?.messages)).toEqual(["m3", "m4", "m5", "m6"]);
    expectExactAccounting();

    // Every message is already held, one of them in the live window.
    messagePages = [
      () =>
        historyPage([message("m3"), message("m4"), message("m5")], {
          nextCursor: "cursor-before-m3",
          complete: false,
        }),
    ];
    measured.length = 0;
    await loadEarlier();
    expect(ids(result.current.projection?.messages)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(measured).toEqual([]);
    expectExactAccounting();

    // Overlaps what is held: only the two new messages are measured, once.
    const m1 = message("m1");
    const m2 = message("m2");
    messagePages = [() => historyPage([m1, m2, message("m3")], { complete: true })];
    measured.length = 0;
    await loadEarlier();
    expect(ids(result.current.projection?.messages)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(new Set(measured)).toEqual(new Set([m1, m2]));
    expect(measured).toHaveLength(2);
    expectExactAccounting();
  });
});
