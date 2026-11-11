/**
 * History paging ("Load earlier messages") under the progressive transport.
 *
 * The live tail arrives as a progressive transcript view that names a direct
 * history cursor, and `loadEarlierMessages` pages behind it through
 * `get_native_agent_message_page`. These cases cover the paging engine itself:
 * how much a page may ask for, a cursor chain, a rotated paging epoch, a page
 * a mutation supersedes, a page the client budget only partly accepts, and a
 * global history eviction. They moved here from the retired sync-v1-only
 * suite; the joined-cursor mint and the part-level head merges are covered in
 * `useNativeAgentSession.progressive.test.tsx`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentMessagePage,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import {
  evictNativeAgentHistoryCaches,
  nativeAgentProjectionStore,
} from "@/stores/nativeAgentProjectionStore";
import { appCommandScope } from "@/lib/node-scope-slots";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";

interface TestMessage {
  id: string;
  text: string;
}

/** Matches `createSessionKey("env-1", "tab-1")`. */
const SESSION_KEY = "env-env-1:tab-1";
/** The transcript's history epoch, which a direct cursor pages. */
const EPOCH = "epoch-1";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "codex",
  logicalSessionKey: SESSION_KEY,
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

const realBackendSnapshot = { ...realBackend };

let transcriptUpdates: Array<() => NativeAgentTranscriptUpdate<TestMessage>> = [];
let transcriptCalls: Array<{ knownToken?: string; forceSnapshot?: boolean }> = [];
let messagePages: Array<
  () => NativeAgentMessagePage<TestMessage> | Promise<NativeAgentMessagePage<TestMessage>>
> = [];
let messagePageCalls: Array<{ before: string; limit?: number; targetBytes?: number }> = [];

const getNativeAgentTranscriptUpdateMock = mock(
  async (input: { knownToken?: string; forceSnapshot?: boolean }) => {
    transcriptCalls.push({ knownToken: input.knownToken, forceSnapshot: input.forceSnapshot });
    const next = transcriptUpdates.shift();
    // A background poll between scripted steps changes nothing.
    if (!next) {
      return {
        viewVersion: 1,
        status: "unchanged",
        token: input.knownToken ?? "transcript-unscripted",
        identity,
      } satisfies NativeAgentTranscriptUpdate<TestMessage>;
    }
    return next();
  },
);
let stateUpdates: Array<() => NativeAgentSessionStateUpdate> = [];
const getNativeAgentSessionStateUpdateMock = mock(async (input: { knownToken?: string }) => {
  const next = stateUpdates.shift();
  if (next) return next();
  return input.knownToken
    ? ({ viewVersion: 1, status: "unchanged", token: input.knownToken, identity } as const)
    : ({
        viewVersion: 1,
        status: "snapshot",
        token: "state-1",
        value: {
          identity,
          connection: "connected",
          turn: { phase: "idle" },
          interactions: [],
          composerControls: [],
          capabilities: nativeAgentCapabilities("codex"),
          notices: [],
        },
      } satisfies NativeAgentSessionStateUpdate);
});
const getNativeAgentMessagePageMock = mock(
  async (input: { before: string; limit?: number; targetBytes?: number }) => {
    messagePageCalls.push({
      before: input.before,
      limit: input.limit,
      targetBytes: input.targetBytes,
    });
    const next = messagePages.shift();
    if (!next) throw new Error("No scripted message page remained");
    return next();
  },
);
const adoptNativeAgentSessionMock = mock(async (): Promise<unknown> => ({}));
const stopNativeAgentSessionMock = mock(
  async (): Promise<NativeAgentSessionProjection<TestMessage> | null> => null,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: async () => ({ viewVersion: 1, status: "missing" }),
  getNativeAgentMessagePage: getNativeAgentMessagePageMock,
  getNativeAgentProjectionUpdate: async () => {
    throw new Error("A direct cursor never needs the joined snapshot");
  },
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: SESSION_KEY,
    environmentId: "env-1",
    agent: "codex",
  }),
  adoptNativeAgentSession: adoptNativeAgentSessionMock,
  stopNativeAgentSession: stopNativeAgentSessionMock,
  resumeNativeAgentSession: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

/** Mirrors the hook's own process-wide retained-history ceiling. */
const CLIENT_HISTORY_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

function message(id: string, text = `body-${id}`): TestMessage {
  return { id, text };
}

function projection(
  messages: TestMessage[],
  overrides: Partial<NativeAgentSessionProjection<TestMessage>> = {},
): NativeAgentSessionProjection<TestMessage> {
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
    ...overrides,
  };
}

/** A live tail with earlier messages behind the direct cursor `cursor`. */
function tail(
  token: string,
  messages: TestMessage[],
  extras: Partial<NativeAgentTranscriptView<TestMessage>> & { cursor?: string } = {},
): NativeAgentTranscriptUpdate<TestMessage> {
  const { cursor = `cursor-before-${messages[0]!.id}`, ...view } = extras;
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      freshness: "current",
      messages,
      messageWindow: {
        limit: messages.length,
        truncated: true,
        truncationReason: "count",
        canLoadEarlier: true,
      },
      historyEpoch: EPOCH,
      historyComplete: false,
      historyCursor: cursor,
      historyPaging: "direct",
      ...view,
    },
  };
}

function page(
  messages: TestMessage[],
  extras: Partial<NativeAgentMessagePage<TestMessage>> = {},
): NativeAgentMessagePage<TestMessage> {
  return {
    syncVersion: 1,
    messages,
    historyEpoch: EPOCH,
    complete: true,
    truncated: Boolean(extras.nextCursor),
    ...extras,
  };
}

function ids(projection: NativeAgentSessionProjection<TestMessage> | null | undefined) {
  return projection?.messages.map(({ id }) => id);
}

function syncCache() {
  return appCommandStore(nativeAgentProjectionStore).getState().syncCaches.get(SESSION_KEY);
}

async function renderConnectedSession(first: NativeAgentTranscriptUpdate<TestMessage>) {
  transcriptUpdates = [() => first];
  const rendered = renderHookInAppCommandScope(() =>
    useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: "env-1",
      tabId: "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
  await waitFor(() => expect(rendered.result.current.sessionStateAvailability).toBe("current"));
  await waitFor(() =>
    expect(rendered.result.current.projection?.messages.length).toBeGreaterThan(0),
  );
  return rendered;
}

const liveTail = [message("m3"), message("m4")];

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  transcriptCalls = [];
  stateUpdates = [];
  messagePages = [];
  messagePageCalls = [];
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  getNativeAgentMessagePageMock.mockClear();
  adoptNativeAgentSessionMock.mockReset();
  adoptNativeAgentSessionMock.mockImplementation(async () => ({}));
  stopNativeAgentSessionMock.mockReset();
  stopNativeAgentSessionMock.mockImplementation(async () => null);
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

afterEach(() => {
  cleanup();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("useNativeAgentSession history paging", () => {
  test("bounds the page request by the room the client actually has", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    messagePages = [() => page([message("m2")])];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(messagePageCalls[0]?.before).toBe("cursor-before-m3");
    expect(messagePageCalls[0]?.limit).toBeGreaterThan(0);
    expect(messagePageCalls[0]?.targetBytes).toBeGreaterThan(0);
  });

  test("keeps paging through a cursor chain and retains every page", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    messagePages = [
      () => page([message("m2")], { nextCursor: "cursor-before-m2" }),
      () => page([message("m1")]),
    ];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(messagePageCalls.map(({ before }) => before)).toEqual([
      "cursor-before-m3",
      "cursor-before-m2",
    ]);
    expect(ids(result.current.projection)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBeUndefined();
  });

  test("a rotated history epoch drops retained pages and reconciles from a snapshot", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    messagePages = [() => page([message("m2")], { historyEpoch: "epoch-2" })];
    transcriptUpdates = [
      () =>
        tail("transcript-2", liveTail, {
          historyEpoch: "epoch-2",
          historyComplete: true,
          cursor: "cursor-epoch-2",
        }),
    ];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(transcriptCalls.at(-1)?.forceSnapshot).toBe(true);
    expect(ids(result.current.projection)).toEqual(["m3", "m4"]);
    expect(syncCache()?.historyEpoch).toBe("epoch-2");
    expect(syncCache()?.historyMessages).toEqual([]);
  });

  test("a page that arrives after a mutation is discarded rather than merged", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    let releasePage: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    messagePages = [
      async () => {
        await held;
        return page([message("m1"), message("m2")]);
      },
    ];
    stopNativeAgentSessionMock.mockImplementation(async () =>
      projection(liveTail, { revision: 9, title: "stopped" }),
    );

    await act(async () => {
      const paging = result.current.loadEarlierMessages();
      await result.current.stop();
      releasePage();
      await paging;
    });

    expect(result.current.projection?.title).toBe("stopped");
    expect(ids(result.current.projection)).toEqual(["m3", "m4"]);
  });

  /**
   * Starts a page that is held until the returned release is called, and
   * waits until its request has gone out.
   */
  async function holdPage(
    result: Awaited<ReturnType<typeof renderConnectedSession>>["result"],
    messages: TestMessage[],
  ) {
    const gate = Promise.withResolvers<void>();
    messagePages = [
      async () => {
        await gate.promise;
        return page(messages);
      },
    ];
    let paging: Promise<unknown> = Promise.resolve();
    act(() => {
      paging = result.current.loadEarlierMessages();
    });
    await waitFor(() => expect(messagePageCalls).toHaveLength(1));
    return async () => {
      await act(async () => {
        gate.resolve();
        await paging;
      });
    };
  }

  // The native tab polls every 500–1500 ms, so a page slower than that used to
  // be retired by the poll and the reader's click did nothing (flakes 0483, 1602).
  test("a background poll that lands while a page is in flight keeps the page", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    const release = await holdPage(result, [message("m1"), message("m2")]);
    // The poll brings a new live row; the cursor the page was fetched behind holds.
    transcriptUpdates = [() => tail("transcript-2", [...liveTail, message("m5")])];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    expect(ids(result.current.projection)).toEqual(["m3", "m4", "m5"]);

    await release();

    expect(ids(result.current.projection)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBeUndefined();
  });

  test("a page fetched behind a cursor a poll has since replaced is discarded", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    const release = await holdPage(result, [message("m1"), message("m2")]);
    // The history rotated: the page describes rows of a history no longer shown.
    transcriptUpdates = [
      () =>
        tail("transcript-2", liveTail, {
          historyEpoch: "epoch-2",
          cursor: "cursor-epoch-2",
        }),
    ];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });

    await release();

    expect(ids(result.current.projection)).toEqual(["m3", "m4"]);
    expect(syncCache()?.historyCursor).toBe("cursor-epoch-2");
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("a page that outlives a poll which found the session gone is discarded", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    const release = await holdPage(result, [message("m1"), message("m2")]);
    transcriptUpdates = [() => ({ viewVersion: 1, status: "missing" })];
    stateUpdates = [() => ({ viewVersion: 1, status: "missing" })];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    expect(result.current.projection).toBeNull();

    await release();

    // The late page must not reinstall the projection the poll removed.
    expect(result.current.projection).toBeNull();
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().projections.get(SESSION_KEY) ?? null,
    ).toBeNull();
    expect(syncCache()?.historyMessages ?? []).toEqual([]);
  });

  test("a row a poll revised while an overlapping page was in flight keeps its revision", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", liveTail));
    // m3 ages out of the live tail and is held; the direct cursor now points at
    // the tail's head, so the next page overlaps the held row.
    transcriptUpdates = [
      () => tail("transcript-2", [message("m4"), message("m5")], { cursor: "cursor-before-m4" }),
    ];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    expect(ids(result.current.projection)).toEqual(["m3", "m4", "m5"]);

    // The page was read before the revision below and carries the old copy.
    const release = await holdPage(result, [message("m2"), message("m3", "running")]);
    const revisedTail = () =>
      tail("transcript-3", [message("m4"), message("m5")], {
        cursor: "cursor-before-m4",
        revisedMessages: [message("m3", "completed")],
      });
    transcriptUpdates = [revisedTail];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    const textOf = (id: string) =>
      result.current.projection?.messages.find((row) => row.id === id)?.text;
    expect(textOf("m3")).toBe("completed");

    await release();

    expect(ids(result.current.projection)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(textOf("m3")).toBe("completed");
    // A later unchanged poll keeps it too.
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    expect(textOf("m3")).toBe("completed");
  });
});

describe("useNativeAgentSession history client budgets", () => {
  test("a partially accepted page leaves its omitted range reachable", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", [message("m9")]));

    // Both page messages encode to the same size, so a ceiling of one of them
    // plus a little slack accepts exactly the newest and rejects the older.
    const older = message("m1", "a".repeat(256));
    const newer = message("m2", "b".repeat(256));
    const messageBytes = new TextEncoder().encode(JSON.stringify(newer)).byteLength;
    act(() => {
      // Through the store action, so the running history total counts it.
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection("other-session", projection([]), {
          token: "other-token",
          liveProjection: projection([]),
          historyEpoch: "epoch-other",
          historyComplete: true,
          historyMessages: [],
          historyBytes: CLIENT_HISTORY_TOTAL_MAX_BYTES - messageBytes - 20,
        });
    });

    messagePages = [() => page([older, newer])];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(ids(result.current.projection)).toEqual(["m2", "m9"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);

    // The rejected older half is still behind the cursor the page was fetched
    // with, so asking again requests exactly that range rather than skipping it.
    messagePages = [() => page([older, newer])];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(messagePageCalls.map(({ before }) => before)).toEqual([
      "cursor-before-m9",
      "cursor-before-m9",
    ]);
  });

  test("a global history eviction releases the pages this hook still held", async () => {
    const { result } = await renderConnectedSession(tail("transcript-1", [message("m3")]));
    messagePages = [() => page([message("m1"), message("m2")])];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(syncCache()?.historyBytes).toBeGreaterThan(0);

    // Another tab's eviction pass reclaims this session's history.
    act(() => {
      evictNativeAgentHistoryCaches("other-session", CLIENT_HISTORY_TOTAL_MAX_BYTES, 0);
    });
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().historyEvictions.get(SESSION_KEY),
    ).toBe(1);
    expect(appCommandScope().budgets.transcripts.usedBytes).toBe(0);

    transcriptUpdates = [() => tail("transcript-2", [message("m3")])];
    await act(async () => {
      await result.current.refresh();
    });

    expect(syncCache()?.historyMessages).toEqual([]);
    expect(ids(result.current.projection)).toEqual(["m3"]);
    // Paging remains available from the cursor the transcript still names.
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("clears transcriptRefreshing when an establishing read is skipped", async () => {
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection(SESSION_KEY, projection([message("m1")]));
    let releaseAdopt: (() => void) | undefined;
    adoptNativeAgentSessionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAdopt = () => resolve({});
        }),
    );
    transcriptUpdates = [() => ({ viewVersion: 1, status: "missing" })];
    stateUpdates = [() => ({ viewVersion: 1, status: "missing" })];

    const { result } = renderHookInAppCommandScope(() =>
      useNativeAgentSession<TestMessage>({
        platform: "codex",
        environmentId: "env-1",
        tabId: "tab-1",
        isActive: true,
        enabled: true,
        initialProviderSessionId: "session-1",
      }),
    );

    await waitFor(() => expect(transcriptCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.transcriptRefreshing).toBe(false));
    expect(ids(result.current.projection)).toEqual(["m1"]);
    expect(result.current.transcriptAvailability).toBe("cached");
    releaseAdopt?.();
  });
});
