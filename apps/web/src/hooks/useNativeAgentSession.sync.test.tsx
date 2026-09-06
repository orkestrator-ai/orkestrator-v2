/**
 * Integration coverage for the sync-v1 branch of the native-agent session hook.
 *
 * `AgentNativeTab.test.tsx` advertises no sync versions, so every assertion
 * there exercises the legacy full-projection path. This file advertises
 * sync-v1 and drives the branch a current backend actually serves: conditional
 * tokens, deltas, the bounded live tail, paged history, and the fences that
 * decide whether a read is still allowed to install anything.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentMessagePage,
  NativeAgentProjectionUpdate,
  NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };

let projectionUpdates: Array<
  (input: {
    knownToken?: string;
    forceSnapshot?: boolean;
  }) => NativeAgentProjectionUpdate<TestMessage> | Promise<NativeAgentProjectionUpdate<TestMessage>>
> = [];
let updateCalls: Array<{ knownToken?: string; forceSnapshot?: boolean }> = [];
let messagePages: Array<
  (input: {
    before: string;
    limit?: number;
    targetBytes?: number;
  }) => NativeAgentMessagePage<TestMessage> | Promise<NativeAgentMessagePage<TestMessage>>
> = [];
let messagePageCalls: Array<{ before: string; limit?: number; targetBytes?: number }> = [];

const getNativeAgentSyncCapabilitiesMock = mock(async () => ({
  projectionSyncVersions: [1],
  historyPagingVersions: [1],
}));
const getNativeAgentProjectionUpdateMock = mock(
  async (input: { knownToken?: string; forceSnapshot?: boolean }) => {
    updateCalls.push({ knownToken: input.knownToken, forceSnapshot: input.forceSnapshot });
    const next = projectionUpdates.shift();
    // A background poll may fire between scripted steps. Answering it
    // `unchanged` against the caller's own token keeps it a genuine no-op
    // rather than an error the assertions would then be reading.
    if (!next) {
      return {
        syncVersion: 1,
        status: "unchanged",
        token: input.knownToken ?? "token-unscripted",
      } as NativeAgentProjectionUpdate<TestMessage>;
    }
    return next(input);
  },
);
const getNativeAgentMessagePageMock = mock(
  async (input: { before: string; limit?: number; targetBytes?: number }) => {
    messagePageCalls.push({
      before: input.before,
      limit: input.limit,
      targetBytes: input.targetBytes,
    });
    const next = messagePages.shift();
    if (!next) throw new Error("No scripted message page remained");
    return next(input);
  },
);
const ensureNativeAgentSessionMock = mock(async () => ({
  providerSessionId: "session-1",
  logicalSessionKey: "env-env-1:tab-1",
  environmentId: "env-1",
  agent: "codex",
}));
const stopNativeAgentSessionMock = mock(
  async (): Promise<NativeAgentSessionProjection<TestMessage> | null> => null,
);
const resumeNativeAgentSessionMock = mock(
  async (): Promise<NativeAgentSessionProjection<TestMessage> | null> => null,
);
const getNativeAgentProjectionMock = mock(
  async (): Promise<NativeAgentSessionProjection<TestMessage> | null> => null,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: getNativeAgentSyncCapabilitiesMock,
  getNativeAgentProjectionUpdate: getNativeAgentProjectionUpdateMock,
  getNativeAgentMessagePage: getNativeAgentMessagePageMock,
  ensureNativeAgentSession: ensureNativeAgentSessionMock,
  adoptNativeAgentSession: async () => ({}),
  stopNativeAgentSession: stopNativeAgentSessionMock,
  resumeNativeAgentSession: resumeNativeAgentSessionMock,
  getNativeAgentProjection: getNativeAgentProjectionMock,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  // The negotiated capability is process-global and, once positive, is never
  // re-checked. Leaving it set would put every later file in this module
  // registry on the sync path with mocks that only serve the legacy one.
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

/** Matches `createSessionKey("env-1", "tab-1")`. */
const SESSION_KEY = "env-env-1:tab-1";

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
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: { provider: false, model: false, reasoning: false, speed: false, mode: false },
    },
    revision: 1,
    generation: "generation-1",
    ...overrides,
  };
}

function snapshot(
  token: string,
  messages: TestMessage[],
  extra: {
    historyCursor?: string;
    historyEpoch?: string;
    historyComplete?: boolean;
    projection?: Partial<NativeAgentSessionProjection<TestMessage>>;
  } = {},
): NativeAgentProjectionUpdate<TestMessage> {
  return {
    syncVersion: 1,
    status: "snapshot",
    token,
    projection: projection(messages, extra.projection),
    historyEpoch: extra.historyEpoch ?? "epoch-1",
    historyComplete: extra.historyComplete ?? true,
    ...(extra.historyCursor ? { historyCursor: extra.historyCursor } : {}),
  };
}

function renderSession(options: { environmentId?: string; tabId?: string } = {}) {
  return renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: options.environmentId ?? "env-1",
      tabId: options.tabId ?? "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
}

/** Resolves once the hook has installed a projection for the first time. */
async function renderConnectedSession(options: { environmentId?: string; tabId?: string } = {}) {
  const rendered = renderSession(options);
  await waitFor(() => expect(rendered.result.current.projection).not.toBeNull());
  return rendered;
}

beforeEach(() => {
  // For the same reason in reverse: a preceding file may have cached "no sync".
  resetNativeAgentSyncCapabilityForTests();
  projectionUpdates = [];
  updateCalls = [];
  messagePages = [];
  messagePageCalls = [];
  getNativeAgentProjectionUpdateMock.mockClear();
  getNativeAgentMessagePageMock.mockClear();
  ensureNativeAgentSessionMock.mockClear();
  stopNativeAgentSessionMock.mockClear();
  stopNativeAgentSessionMock.mockImplementation(async () => null);
  resumeNativeAgentSessionMock.mockClear();
  resumeNativeAgentSessionMock.mockImplementation(async () => null);
  getNativeAgentProjectionMock.mockClear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useNativeAgentProjectionStore.getState().reset();
});

describe("useNativeAgentSession sync-v1 transport", () => {
  test("negotiates sync-v1 once and installs the first snapshot", async () => {
    projectionUpdates = [() => snapshot("token-1", [message("m1")])];

    const { result } = await renderConnectedSession();

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
    expect(updateCalls[0]?.knownToken).toBeUndefined();
    const cache = useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY);
    expect(cache?.token).toBe("token-1");
    expect(cache?.historyMessages).toEqual([]);
  });

  test("sends the held token and applies a delta over the live tail", async () => {
    projectionUpdates = [
      () => snapshot("token-1", [message("m1")]),
      () => ({
        syncVersion: 1,
        status: "delta",
        baseToken: "token-1",
        token: "token-2",
        delta: {
          messageUpserts: [message("m2")],
          liveMessageIds: ["m1", "m2"],
          deletedMessageIds: [],
          setFields: {},
          unsetFields: [],
          revision: 2,
          generation: "generation-1",
        },
        historyEpoch: "epoch-1",
        historyComplete: true,
      }),
    ];

    const { result } = await renderConnectedSession();
    await act(async () => {
      await result.current.refresh();
    });

    expect(updateCalls[1]?.knownToken).toBe("token-1");
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.token).toBe(
      "token-2",
    );
  });

  test("an unchanged answer transfers nothing and keeps the installed projection", async () => {
    projectionUpdates = [
      () => snapshot("token-1", [message("m1")]),
      () => ({ syncVersion: 1, status: "unchanged", token: "token-1" }),
    ];

    const { result } = await renderConnectedSession();
    const before = result.current.projection;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection).toBe(before!);
  });

  test("recovers from an unusable delta by forcing a snapshot", async () => {
    projectionUpdates = [
      () => snapshot("token-1", [message("m1")]),
      // A base token this client never held cannot be applied.
      () => ({
        syncVersion: 1,
        status: "delta",
        baseToken: "token-unknown",
        token: "token-2",
        delta: {
          messageUpserts: [],
          deletedMessageIds: [],
          setFields: {},
          unsetFields: [],
          revision: 2,
          generation: "generation-1",
        },
        historyEpoch: "epoch-1",
        historyComplete: true,
      }),
      () => snapshot("token-3", [message("m1"), message("m2")], { projection: { revision: 3 } }),
    ];

    const { result } = await renderConnectedSession();
    await act(async () => {
      await result.current.refresh();
    });

    expect(updateCalls[2]?.forceSnapshot).toBe(true);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
  });

  test("a missing session clears the projection and the sync cache", async () => {
    projectionUpdates = [
      () => snapshot("token-1", [message("m1")]),
      () => ({ syncVersion: 1, status: "missing" }),
    ];

    const { result } = await renderConnectedSession();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection).toBeNull();
    expect(useNativeAgentProjectionStore.getState().syncCaches.has(SESSION_KEY)).toBe(false);
  });

  test("rejects a snapshot whose identity does not match the tab", async () => {
    projectionUpdates = [
      () => snapshot("token-1", [message("m1")]),
      () =>
        snapshot("token-2", [message("m9")], {
          projection: { platform: "claude", revision: 2 },
        }),
      () => snapshot("token-3", [message("m1")], { projection: { revision: 3 } }),
    ];

    const { result } = await renderConnectedSession();
    await act(async () => {
      await result.current.refresh();
    });

    // The mismatched snapshot forced a fresh read rather than being installed.
    expect(updateCalls[2]?.forceSnapshot).toBe(true);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
  });

  test("a remount rehydrates the token and retained history from the shared cache", async () => {
    projectionUpdates = [() => snapshot("token-1", [message("m1")])];
    const first = await renderConnectedSession();
    first.unmount();

    projectionUpdates = [() => ({ syncVersion: 1, status: "unchanged", token: "token-1" })];
    updateCalls = [];
    const second = await renderConnectedSession();

    expect(updateCalls[0]?.knownToken).toBe("token-1");
    expect(second.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
  });
});

describe("useNativeAgentSession sync-v1 staleness fences", () => {
  /**
   * A resume replaces the provider session, so the projection it returns
   * carries a new generation. That is the case the projection-level revision
   * guard cannot catch — revisions are only comparable within a generation —
   * which leaves the refresh fence as the only thing standing between a poll
   * issued before the resume and the transcript of the session it replaced.
   */
  const resumed = () =>
    projection([message("m1")], {
      sessionId: "session-2",
      generation: "generation-2",
      revision: 1,
      title: "resumed",
    });

  test("a poll that resolves after a session replacement is discarded", async () => {
    projectionUpdates = [() => snapshot("token-1", [message("m1")])];
    const { result } = await renderConnectedSession();

    let releaseStalePoll: () => void = () => {};
    const stalePoll = new Promise<void>((resolve) => {
      releaseStalePoll = resolve;
    });
    projectionUpdates = [
      async () => {
        await stalePoll;
        return snapshot("token-stale", [message("m1"), message("m-stale")], {
          projection: { revision: 5, title: "superseded" },
        });
      },
    ];
    resumeNativeAgentSessionMock.mockImplementation(async () => resumed());

    await act(async () => {
      const inFlight = result.current.refresh({ manual: false });
      await result.current.resume("session-2");
      releaseStalePoll();
      await inFlight;
    });

    expect(result.current.projection?.title).toBe("resumed");
    expect(result.current.projection?.sessionId).toBe("session-2");
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
  });

  test("a missing answer that lands after a session replacement is discarded", async () => {
    projectionUpdates = [() => snapshot("token-1", [message("m1")])];
    const { result } = await renderConnectedSession();

    let releaseStalePoll: () => void = () => {};
    const stalePoll = new Promise<void>((resolve) => {
      releaseStalePoll = resolve;
    });
    projectionUpdates = [
      async () => {
        await stalePoll;
        return { syncVersion: 1, status: "missing" } as const;
      },
    ];
    resumeNativeAgentSessionMock.mockImplementation(async () => resumed());

    await act(async () => {
      const inFlight = result.current.refresh({ manual: false });
      await result.current.resume("session-2");
      releaseStalePoll();
      await inFlight;
    });

    expect(result.current.projection?.title).toBe("resumed");
    // The discarded answer must not have forgotten the sync state either: the
    // next read still conditions on the token this tab legitimately holds.
    projectionUpdates = [
      () => snapshot("token-3", [message("m1")], { projection: { revision: 3 } }),
    ];
    updateCalls = [];
    await act(async () => {
      await result.current.refresh();
    });
    expect(updateCalls[0]?.knownToken).toBe("token-1");
  });

  test("a stale poll does not roll the conditional token backwards", async () => {
    projectionUpdates = [() => snapshot("token-1", [message("m1")])];
    const { result } = await renderConnectedSession();

    let releaseStalePoll: () => void = () => {};
    const stalePoll = new Promise<void>((resolve) => {
      releaseStalePoll = resolve;
    });
    projectionUpdates = [
      async () => {
        await stalePoll;
        return snapshot("token-stale", [message("m1")], { projection: { revision: 2 } });
      },
    ];
    resumeNativeAgentSessionMock.mockImplementation(async () => resumed());

    await act(async () => {
      const inFlight = result.current.refresh({ manual: false });
      await result.current.resume("session-2");
      releaseStalePoll();
      await inFlight;
    });

    // The next read must condition on the token the newest state was built
    // from, not on one a discarded read happened to see.
    projectionUpdates = [
      () => snapshot("token-3", [message("m1")], { projection: { revision: 3 } }),
    ];
    updateCalls = [];
    await act(async () => {
      await result.current.refresh();
    });
    expect(updateCalls[0]?.knownToken).toBe("token-1");
  });
});

describe("useNativeAgentSession sync-v1 history paging", () => {
  const liveTail = [message("m3"), message("m4")];

  async function sessionWithHistory() {
    projectionUpdates = [
      () =>
        snapshot("token-1", liveTail, {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
        }),
    ];
    return renderConnectedSession();
  }

  test("offers the control while the server reports messages before the live tail", async () => {
    const { result } = await sessionWithHistory();
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("merges a page and stops offering the control once history is exhausted", async () => {
    const { result } = await sessionWithHistory();
    // No `nextCursor`, so this is the final page of the conversation.
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m1"), message("m2")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBeUndefined();

    // The next poll still reports its own live-tail boundary. That must not put
    // an inert control back on screen.
    projectionUpdates = [
      () =>
        snapshot("token-2", liveTail, {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
          projection: { revision: 2 },
        }),
    ];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBeUndefined();
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  test("bounds the page request by the room the client actually has", async () => {
    const { result } = await sessionWithHistory();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m2")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(messagePageCalls[0]?.before).toBe("cursor-before-m3");
    expect(messagePageCalls[0]?.limit).toBeGreaterThan(0);
    expect(messagePageCalls[0]?.targetBytes).toBeGreaterThan(0);
  });

  test("keeps paging through a cursor chain and retains every page", async () => {
    const { result } = await sessionWithHistory();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m2")],
        historyEpoch: "epoch-1",
        nextCursor: "cursor-before-m2",
        complete: true,
        truncated: true,
      }),
      () => ({
        syncVersion: 1,
        messages: [message("m1")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
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
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBeUndefined();
  });

  test("a rotated history epoch drops retained pages and reconciles from a snapshot", async () => {
    const { result } = await sessionWithHistory();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m2")],
        historyEpoch: "epoch-2",
        complete: true,
        truncated: false,
      }),
    ];
    projectionUpdates = [
      () =>
        snapshot("token-2", liveTail, {
          historyEpoch: "epoch-2",
          historyCursor: "cursor-epoch-2",
          historyComplete: true,
          projection: { revision: 2 },
        }),
    ];

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(updateCalls.at(-1)?.forceSnapshot).toBe(true);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3", "m4"]);
    const cache = useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY);
    expect(cache?.historyEpoch).toBe("epoch-2");
    expect(cache?.historyMessages).toEqual([]);
  });

  test("an authoritative deletion prunes the message from retained history", async () => {
    const { result } = await sessionWithHistory();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m1"), message("m2")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    projectionUpdates = [
      () => ({
        syncVersion: 1,
        status: "delta",
        baseToken: useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)!.token,
        token: "token-after-delete",
        delta: {
          messageUpserts: [],
          deletedMessageIds: ["m1"],
          setFields: {},
          unsetFields: [],
          revision: 4,
          generation: "generation-1",
        },
        historyEpoch: "epoch-1",
        historyComplete: true,
      }),
    ];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);
  });

  test("a page that arrives after a mutation is discarded rather than merged", async () => {
    const { result } = await sessionWithHistory();
    let releasePage: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    messagePages = [
      async () => {
        await held;
        return {
          syncVersion: 1,
          messages: [message("m1"), message("m2")],
          historyEpoch: "epoch-1",
          complete: true,
          truncated: false,
        } as const;
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
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3", "m4"]);
  });

  test("a mutation keeps previously paged history while updating authoritative state", async () => {
    const { result } = await sessionWithHistory();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m1"), message("m2")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    stopNativeAgentSessionMock.mockImplementation(async () =>
      projection(liveTail, { revision: 20, title: "stopped" }),
    );
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.projection?.title).toBe("stopped");
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });
});

describe("useNativeAgentSession sync-v1 client budgets", () => {
  /** Mirrors the hook's own process-wide retained-history ceiling. */
  const CLIENT_HISTORY_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

  test("a partially accepted page leaves its omitted range reachable", async () => {
    projectionUpdates = [
      () =>
        snapshot("token-1", [message("m9")], {
          historyCursor: "cursor-before-m9",
          historyComplete: true,
        }),
    ];
    const { result } = await renderConnectedSession();

    // Both page messages encode to the same size, so a ceiling of one of them
    // plus a little slack accepts exactly the newest and rejects the older.
    const older = message("m1", "a".repeat(256));
    const newer = message("m2", "b".repeat(256));
    const messageBytes = new TextEncoder().encode(JSON.stringify(newer)).byteLength;
    act(() => {
      const store = useNativeAgentProjectionStore.getState();
      const syncCaches = new Map(store.syncCaches);
      syncCaches.set("other-session", {
        token: "other-token",
        liveProjection: projection([]),
        historyEpoch: "epoch-other",
        historyComplete: true,
        historyMessages: [],
        historyBytes: CLIENT_HISTORY_TOTAL_MAX_BYTES - messageBytes - 20,
      });
      useNativeAgentProjectionStore.setState({ syncCaches });
    });

    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [older, newer],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m9"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);

    // The rejected older half is still behind the cursor the page was fetched
    // with, so asking again requests exactly that range rather than skipping it.
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [older, newer],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(messagePageCalls.map(({ before }) => before)).toEqual([
      "cursor-before-m9",
      "cursor-before-m9",
    ]);
  });

  test("a global history eviction releases the pages this hook still held", async () => {
    projectionUpdates = [
      () =>
        snapshot("token-1", [message("m3")], {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
        }),
    ];
    const { result } = await renderConnectedSession();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m1"), message("m2")],
        historyEpoch: "epoch-1",
        complete: true,
        truncated: false,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(
      useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.historyBytes,
    ).toBeGreaterThan(0);

    // Another tab's eviction pass reclaims this session's history.
    act(() => {
      const store = useNativeAgentProjectionStore.getState();
      const cache = store.syncCaches.get(SESSION_KEY)!;
      const syncCaches = new Map(store.syncCaches);
      syncCaches.delete(SESSION_KEY);
      const projections = new Map(store.projections);
      projections.set(SESSION_KEY, cache.liveProjection);
      const historyEvictions = new Map(store.historyEvictions);
      historyEvictions.set(SESSION_KEY, 1);
      useNativeAgentProjectionStore.setState({ projections, syncCaches, historyEvictions });
    });

    projectionUpdates = [
      () =>
        snapshot("token-2", [message("m3")], {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
          projection: { revision: 2 },
        }),
    ];
    await act(async () => {
      await result.current.refresh();
    });

    const cache = useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY);
    expect(cache?.historyMessages).toEqual([]);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3"]);
    // Paging remains available from the boundary the server last reported.
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("history completeness recovers after a transient incomplete read", async () => {
    projectionUpdates = [
      () =>
        snapshot("token-1", [message("m3")], {
          historyCursor: "cursor-before-m3",
          historyComplete: false,
        }),
    ];
    const { result } = await renderConnectedSession();
    messagePages = [
      () => ({
        syncVersion: 1,
        messages: [message("m2")],
        historyEpoch: "epoch-1",
        complete: false,
        truncated: true,
      }),
    ];
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(
      useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.historyComplete,
    ).toBe(false);

    projectionUpdates = [
      () =>
        snapshot("token-2", [message("m3")], {
          historyComplete: true,
          projection: { revision: 2 },
        }),
    ];
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      useNativeAgentProjectionStore.getState().syncCaches.get(SESSION_KEY)?.historyComplete,
    ).toBe(true);
  });
});
