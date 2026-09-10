/**
 * Progressive-view coverage for the native-agent session hook.
 *
 * The sync-v1 suite still exercises the legacy joined projection. This file
 * advertises `progressiveViewVersions: [1]` and drives the three independent
 * domain reads: transcript can settle before session state, and discovery is
 * never on the text barrier.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentMessagePage,
  NativeAgentProjectionUpdate,
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentSessionStateView,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };

let transcriptUpdates: Array<
  () => NativeAgentTranscriptUpdate<TestMessage> | Promise<NativeAgentTranscriptUpdate<TestMessage>>
> = [];
let stateUpdates: Array<
  () => NativeAgentSessionStateUpdate | Promise<NativeAgentSessionStateUpdate>
> = [];
let discoveryUpdates: Array<
  () => NativeAgentDiscoveryUpdate | Promise<NativeAgentDiscoveryUpdate>
> = [];
let transcriptCalls: Array<{ knownToken?: string; forceSnapshot?: boolean }> = [];
let stateCalls: Array<{ knownToken?: string; forceSnapshot?: boolean }> = [];
let messagePages: Array<
  () => NativeAgentMessagePage<TestMessage> | Promise<NativeAgentMessagePage<TestMessage>>
> = [];
let messagePageCalls: Array<{ before: string }> = [];
let projectionUpdates: Array<
  () => NativeAgentProjectionUpdate<TestMessage> | Promise<NativeAgentProjectionUpdate<TestMessage>>
> = [];
let stopResults: Array<() => NativeAgentSessionProjection<TestMessage> | null> = [];

/**
 * The backend's history-paging epoch, which is not the transcript's.
 *
 * A transcript view carries the bridge's content epoch, while cursors and
 * pages are keyed by an epoch only the sync-v1 surfaces mint. Keeping the two
 * different here is the point: a fixture that shares one hides the case where
 * a poll would otherwise invalidate a cursor it has no business judging.
 */
const PAGING_EPOCH = "paging-epoch-1";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "codex",
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

const getNativeAgentSyncCapabilitiesMock = mock(async () => ({
  projectionSyncVersions: [1],
  historyPagingVersions: [1],
  progressiveViewVersions: [1],
}));
const getNativeAgentTranscriptUpdateMock = mock(
  async (input: { knownToken?: string; forceSnapshot?: boolean }) => {
    transcriptCalls.push({ knownToken: input.knownToken, forceSnapshot: input.forceSnapshot });
    const next = transcriptUpdates.shift();
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
const getNativeAgentSessionStateUpdateMock = mock(
  async (input: { knownToken?: string; forceSnapshot?: boolean }) => {
    stateCalls.push({ knownToken: input.knownToken, forceSnapshot: input.forceSnapshot });
    const next = stateUpdates.shift();
    if (!next) {
      return {
        viewVersion: 1,
        status: "unchanged",
        token: "state-unscripted",
        identity,
      } satisfies NativeAgentSessionStateUpdate;
    }
    return next();
  },
);
const getNativeAgentDiscoveryUpdateMock = mock(async () => {
  const next = discoveryUpdates.shift();
  if (!next) {
    return {
      viewVersion: 1,
      status: "unchanged",
      token: "discovery-unscripted",
      identity,
    } satisfies NativeAgentDiscoveryUpdate;
  }
  return next();
});
const ensureNativeAgentSessionMock = mock(async () => ({
  providerSessionId: "session-1",
  logicalSessionKey: "env-env-1:tab-1",
  environmentId: "env-1",
  agent: "codex",
}));
const getNativeAgentMessagePageMock = mock(async (input: { before: string }) => {
  messagePageCalls.push({ before: input.before });
  const next = messagePages.shift();
  if (!next) throw new Error("Unexpected history page request");
  return next();
});
const getNativeAgentProjectionUpdateMock = mock(async () => {
  const next = projectionUpdates.shift();
  if (!next) throw new Error("Unexpected joined projection request");
  return next();
});
const stopNativeAgentSessionMock = mock(async () => {
  const next = stopResults.shift();
  return next ? next() : null;
});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: getNativeAgentSyncCapabilitiesMock,
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: getNativeAgentDiscoveryUpdateMock,
  getNativeAgentMessagePage: getNativeAgentMessagePageMock,
  ensureNativeAgentSession: ensureNativeAgentSessionMock,
  adoptNativeAgentSession: async () => ({}),
  stopNativeAgentSession: stopNativeAgentSessionMock,
  resumeNativeAgentSession: async () => null,
  getNativeAgentProjection: async () => null,
  getNativeAgentProjectionUpdate: getNativeAgentProjectionUpdateMock,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function message(id: string, text = `body-${id}`): TestMessage {
  return { id, text };
}

function transcriptView(
  messages: TestMessage[],
  extras: Partial<NativeAgentTranscriptView<TestMessage>> = {},
): NativeAgentTranscriptView<TestMessage> {
  return {
    identity,
    freshness: messages.length === 0 ? "empty" : "current",
    messages,
    historyEpoch: "epoch-1",
    historyComplete: true,
    ...extras,
  };
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
    value: transcriptView(messages, extras),
  };
}

/**
 * A progressive tail that reports earlier messages without a cursor.
 *
 * This is what the backend actually emits: only a sync-v1 read populates the
 * paging cache a transcript cursor would be minted from, so a session polled
 * purely through the progressive surface never sees one.
 */
function truncatedTail(
  token: string,
  messages: TestMessage[],
  extras: Partial<NativeAgentTranscriptView<TestMessage>> = {},
): NativeAgentTranscriptUpdate<TestMessage> {
  return transcriptSnapshot(token, messages, {
    historyComplete: false,
    messageWindow: {
      limit: messages.length,
      truncated: true,
      truncationReason: "count",
      canLoadEarlier: true,
    },
    ...extras,
  });
}

function projection(
  messages: TestMessage[],
  extras: Partial<NativeAgentSessionProjection<TestMessage>> = {},
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
    ...extras,
  };
}

function joinedSnapshot(
  token: string,
  messages: TestMessage[],
  extras: { historyCursor?: string; historyComplete?: boolean } = {},
): NativeAgentProjectionUpdate<TestMessage> {
  return {
    syncVersion: 1,
    status: "snapshot",
    token,
    projection: projection(messages),
    ...(extras.historyCursor ? { historyCursor: extras.historyCursor } : {}),
    historyEpoch: PAGING_EPOCH,
    historyComplete: extras.historyComplete ?? false,
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

function stateView(extras: Partial<NativeAgentSessionStateView> = {}): NativeAgentSessionStateView {
  return {
    identity,
    connection: "connected",
    turn: { phase: "idle" },
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("codex"),
    ...extras,
  };
}

function stateSnapshot(token: string): NativeAgentSessionStateUpdate {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: stateView(),
  };
}

function renderSession() {
  return renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: "env-1",
      tabId: "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
  discoveryUpdates = [];
  transcriptCalls = [];
  stateCalls = [];
  messagePages = [];
  messagePageCalls = [];
  projectionUpdates = [];
  stopResults = [];
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  getNativeAgentDiscoveryUpdateMock.mockClear();
  getNativeAgentMessagePageMock.mockClear();
  getNativeAgentProjectionUpdateMock.mockClear();
  stopNativeAgentSessionMock.mockClear();
  ensureNativeAgentSessionMock.mockClear();
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

describe("useNativeAgentSession progressive view", () => {
  test("installs transcript text without waiting for held discovery", async () => {
    let releaseDiscovery!: () => void;
    const heldDiscovery = new Promise<NativeAgentDiscoveryUpdate>((resolve) => {
      releaseDiscovery = () =>
        resolve({
          viewVersion: 1,
          status: "snapshot",
          token: "discovery-1",
          value: { identity, sections: {} },
        });
    });
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    discoveryUpdates = [() => heldDiscovery];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]),
    );
    expect(result.current.transcriptAvailability).toBe("current");
    expect(getNativeAgentDiscoveryUpdateMock).toHaveBeenCalled();
    releaseDiscovery();
  });

  test("keeps actions non-authoritative until session state arrives", async () => {
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () => resolve(stateSnapshot("state-1"));
    });
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [() => heldState];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]),
    );
    expect(result.current.sessionStateAvailability).not.toBe("current");
    expect(result.current.projection?.turn.phase).toBe("recovering");
    expect(result.current.projection?.interactions).toEqual([]);
    expect(result.current.projection?.connection).toBe("connecting");

    releaseState();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    expect(result.current.projection?.turn.phase).toBe("idle");
    expect(result.current.projection?.connection).toBe("connected");
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
  });

  test("applies a transcript delta over the held live tail", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1")]),
      () => ({
        viewVersion: 1,
        status: "delta",
        baseToken: "transcript-1",
        token: "transcript-2",
        identity,
        delta: {
          messageUpserts: [message("m2")],
          liveMessageIds: ["m1", "m2"],
          deletedMessageIds: [],
          freshness: "current",
          historyEpoch: "epoch-1",
          historyComplete: true,
        },
      }),
    ];
    stateUpdates = [() => stateSnapshot("state-1"), () => stateSnapshot("state-2")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(transcriptCalls[1]?.knownToken).toBe("transcript-1");
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(
      useNativeAgentProjectionStore.getState().progressiveCaches.get("env-env-1:tab-1")
        ?.transcriptToken,
    ).toBe("transcript-2");
  });

  test("a remount keeps cached transcript text from the shared store", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [() => stateSnapshot("state-1")];

    const first = renderSession();
    await waitFor(() =>
      expect(first.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]),
    );
    first.unmount();

    transcriptUpdates = [];
    stateUpdates = [];
    const remount = renderSession();
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
    expect(remount.result.current.transcriptAvailability).toBe("cached");
  });

  test("keeps session state authoritative while a later refresh is in flight", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [
      () =>
        ({
          viewVersion: 1,
          status: "snapshot",
          token: "state-1",
          value: stateView({
            turn: { phase: "running" },
            interactions: [
              {
                id: "approval-1",
                kind: "command-approval",
                createdAt: "2026-09-09T00:00:00.000Z",
              },
            ] as unknown as NativeAgentSessionStateView["interactions"],
            composerControls: [
              { id: "stop", label: "Stop", kind: "stop" },
            ] as unknown as NativeAgentSessionStateView["composerControls"],
          }),
        }) satisfies NativeAgentSessionStateUpdate,
    ];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    expect(result.current.projection?.interactions).toHaveLength(1);

    /*
     * The second refresh returns a changed transcript while the state read is
     * held. Transcript is the deliberately faster domain, so this ordering is
     * the ordinary one, not a rare race: if a refresh dropped authority the
     * pending approval would unmount on every poll.
     */
    let releaseState!: () => void;
    const heldState = new Promise<NativeAgentSessionStateUpdate>((resolve) => {
      releaseState = () =>
        resolve({ viewVersion: 1, status: "unchanged", token: "state-1", identity });
    });
    transcriptUpdates = [() => transcriptSnapshot("transcript-2", [message("m1"), message("m2")])];
    stateUpdates = [() => heldState];

    let refreshed!: Promise<unknown>;
    await act(async () => {
      refreshed = result.current.refresh();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]),
    );

    expect(result.current.sessionStateAvailability).toBe("current");
    expect(result.current.sessionStateRefreshing).toBe(true);
    expect(result.current.projection?.turn.phase).toBe("running");
    expect(result.current.projection?.connection).toBe("connected");
    expect(result.current.projection?.interactions).toHaveLength(1);
    expect(result.current.projection?.composerControls).toHaveLength(1);

    releaseState();
    await act(async () => {
      await refreshed;
    });
    await waitFor(() => expect(result.current.sessionStateRefreshing).toBe(false));
    expect(result.current.sessionStateAvailability).toBe("current");
  });

  test("drops authority when the session state read fails", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));

    transcriptUpdates = [];
    stateUpdates = [
      () =>
        ({
          viewVersion: 1,
          status: "unavailable",
          retryable: true,
          error: "status endpoint timed out",
        }) satisfies NativeAgentSessionStateUpdate,
    ];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.sessionStateAvailability).toBe("unavailable");
    expect(result.current.sessionStateError).toBe("status endpoint timed out");
    // The transcript is unaffected: a failed state read is not evidence the
    // conversation is gone.
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
  });

  test("a remount re-reads session state instead of replaying its token", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1")])];
    stateUpdates = [() => stateSnapshot("state-1")];

    const first = renderSession();
    await waitFor(() => expect(first.result.current.sessionStateAvailability).toBe("current"));
    first.unmount();

    stateCalls = [];
    transcriptUpdates = [];
    stateUpdates = [() => stateSnapshot("state-2")];
    const remount = renderSession();
    // Cached transcript text is readable on the first paint; action authority
    // is not inherited with it.
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1"]);
    expect(remount.result.current.sessionStateAvailability).not.toBe("current");

    await waitFor(() => expect(stateCalls.length).toBeGreaterThan(0));
    expect(stateCalls[0]?.knownToken).toBeUndefined();
  });

  test("a remount keeps messages that a later live snapshot omits", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1"), message("m2"), message("m3")]),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];
    const first = renderSession();
    await waitFor(() =>
      expect(first.result.current.projection?.messages.map(({ id }) => id)).toEqual([
        "m1",
        "m2",
        "m3",
      ]),
    );
    first.unmount();

    transcriptCalls = [];
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2"), message("m3")], {
          historyComplete: false,
          messageWindow: { limit: 2, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [() => stateSnapshot("state-2")];
    const remount = renderSession();
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    await waitFor(() => expect(transcriptCalls.length).toBeGreaterThan(0));
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  test("keeps messages that aged out of the live tail after a later snapshot", async () => {
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-1", [message("m1"), message("m2"), message("m3")], {
          historyComplete: false,
          messageWindow: { limit: 3, truncated: false, canLoadEarlier: false },
        }),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2", "m3"]),
    );

    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2"), message("m3"), message("m4")], {
          historyCursor: "cursor-before-m2",
          historyComplete: false,
          messageWindow: {
            limit: 3,
            truncated: true,
            truncationReason: "count",
            canLoadEarlier: true,
          },
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    // The server reports messages before its live tail and this client holds no
    // cursor for them, so the control stays: one click mints a cursor through
    // the joined snapshot and fetches what is older than m1.
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("drops retained history when the history epoch rotates", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [message("m1"), message("m2")])];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]),
    );

    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2")], {
          historyEpoch: "epoch-2",
          historyComplete: false,
          messageWindow: { limit: 1, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2"]);
  });

  test("a remount drops retained history when the history epoch rotated", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1"), message("m2"), message("m3")]),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];
    const first = renderSession();
    await waitFor(() =>
      expect(first.result.current.projection?.messages.map(({ id }) => id)).toEqual([
        "m1",
        "m2",
        "m3",
      ]),
    );
    first.unmount();

    transcriptCalls = [];
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2"), message("m3")], {
          historyEpoch: "epoch-2",
          historyComplete: false,
          messageWindow: { limit: 2, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [() => stateSnapshot("state-2")];
    const remount = renderSession();
    await waitFor(() => expect(transcriptCalls.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3"]),
    );
  });

  test("drops a retained message that a later delta deletes", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1"), message("m2"), message("m3")]),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2", "m3"]),
    );

    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2"), message("m3"), message("m4")], {
          historyComplete: false,
          messageWindow: { limit: 3, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);

    transcriptUpdates = [
      () => ({
        viewVersion: 1,
        status: "delta",
        baseToken: "transcript-2",
        token: "transcript-3",
        identity,
        delta: {
          messageUpserts: [],
          liveMessageIds: ["m2", "m3", "m4"],
          deletedMessageIds: ["m1"],
          freshness: "current",
          historyEpoch: "epoch-1",
          historyComplete: false,
        },
      }),
    ];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);
  });

  test("collapses retained history at the client message ceiling", async () => {
    const all = Array.from({ length: 4_100 }, (_, index) => message(`m${index}`));
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", all)];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.projection?.messages.length).toBe(4_100));

    const tail = [...all.slice(-10), message("m4100")];
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", tail, {
          historyComplete: false,
          messageWindow: { limit: 11, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });

    // Retaining 4,090 aged-out messages alongside the tail would cross
    // CLIENT_HISTORY_MAX_MESSAGES, so the whole prefix is released.
    expect(result.current.projection?.messages.length).toBe(11);
    expect(result.current.projection?.messages[0]?.id).toBe("m4090");
  });

  test("drops retained history when the store evicts this session", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1"), message("m2"), message("m3")]),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2", "m3"]),
    );

    useNativeAgentProjectionStore.setState({
      historyEvictions: new Map([["env-env-1:tab-1", 1]]),
    });
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m2"), message("m3"), message("m4")], {
          historyComplete: false,
          messageWindow: { limit: 3, truncated: true, canLoadEarlier: true },
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);
  });

  test("drops messages after the live tail when the provider rewinds", async () => {
    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-1", [
          message("m1"),
          message("m2"),
          message("m3"),
          message("m4"),
        ]),
    ];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() =>
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
        "m1",
        "m2",
        "m3",
        "m4",
      ]),
    );

    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [message("m1"), message("m2")], {
          historyComplete: true,
        }),
    ];
    stateUpdates = [];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
  });

  test("mints a paging cursor through the joined snapshot when the tail has none", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3"), message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    projectionUpdates = [
      () =>
        joinedSnapshot("joined-1", [message("m3"), message("m4")], {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
        }),
    ];
    messagePages = [() => historyPage([message("m1"), message("m2")])];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(getNativeAgentProjectionUpdateMock).toHaveBeenCalledTimes(1);
    expect(messagePageCalls).toEqual([{ before: "cursor-before-m3" }]);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(result.current.projection?.messageWindow).toBeUndefined();
    // Paging only changes transcript content; state that arrived independently
    // must remain authoritative.
    expect(result.current.projection?.connection).toBe("connected");
    expect(result.current.projection?.turn.phase).toBe("idle");
  });

  test("keeps the paging cursor across a poll whose transcript epoch differs", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    projectionUpdates = [
      () =>
        joinedSnapshot("joined-1", [message("m4")], {
          historyCursor: "cursor-before-m4",
        }),
    ];
    messagePages = [
      () => historyPage([message("m3")], { nextCursor: "cursor-before-m3", complete: true }),
      () => historyPage([message("m1"), message("m2")]),
    ];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3", "m4"]);

    // A poll carrying the bridge's content epoch says nothing about the
    // backend's paging epoch, so it must not invalidate the cursor just paged
    // to. Without this the next click restarts from the live-tail boundary and
    // re-fetches a page the user is already looking at.
    transcriptUpdates = [() => truncatedTail("transcript-2", [message("m4")])];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);

    await act(async () => {
      await result.current.loadEarlierMessages();
    });

    expect(messagePageCalls.map(({ before }) => before)).toEqual([
      "cursor-before-m4",
      "cursor-before-m3",
    ]);
    expect(getNativeAgentProjectionUpdateMock).toHaveBeenCalledTimes(1);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  test("does not restore an exhausted history cursor on the next progressive poll", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3"), message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    projectionUpdates = [
      () =>
        joinedSnapshot("joined-1", [message("m3"), message("m4")], {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
        }),
    ];
    messagePages = [() => historyPage([message("m1"), message("m2")])];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.projection?.messageWindow).toBeUndefined();

    // The server keeps reporting that messages exist before its live tail,
    // because they do — this client is simply holding all of them already.
    transcriptUpdates = [() => truncatedTail("transcript-2", [message("m3"), message("m4")])];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(result.current.projection?.messageWindow).toBeUndefined();
    // No second bootstrap: a walked-past boundary is not a reason to re-read
    // the joined projection.
    expect(getNativeAgentProjectionUpdateMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the next paging cursor across a remount", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    projectionUpdates = [
      () => joinedSnapshot("joined-1", [message("m3")], { historyCursor: "cursor-before-m3" }),
    ];
    messagePages = [
      () => historyPage([message("m2")], { nextCursor: "cursor-before-m2", complete: true }),
    ];

    const first = renderSession();
    await waitFor(() => expect(first.result.current.sessionStateAvailability).toBe("current"));
    await act(async () => {
      await first.result.current.loadEarlierMessages();
    });
    first.unmount();

    transcriptUpdates = [() => truncatedTail("transcript-2", [message("m3")])];
    stateUpdates = [() => stateSnapshot("state-2")];
    messagePages = [() => historyPage([message("m1")])];
    const remount = renderSession();
    await waitFor(() => expect(remount.result.current.sessionStateAvailability).toBe("current"));
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3"]);

    await act(async () => {
      await remount.result.current.loadEarlierMessages();
    });

    expect(messagePageCalls.map(({ before }) => before)).toEqual([
      "cursor-before-m3",
      "cursor-before-m2",
    ]);
    // The remount inherits the cursor, so it never re-reads the joined
    // projection to mint one.
    expect(getNativeAgentProjectionUpdateMock).toHaveBeenCalledTimes(1);
    expect(remount.result.current.projection?.messages.map(({ id }) => id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(remount.result.current.projection?.messageWindow).toBeUndefined();
  });

  test("discards a cursor bootstrap that a mutation superseded", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3"), message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));

    let releaseJoined = (): void => {};
    const joinedGate = new Promise<void>((resolve) => {
      releaseJoined = resolve;
    });
    projectionUpdates = [
      async () => {
        await joinedGate;
        return joinedSnapshot("joined-1", [message("m3"), message("m4")], {
          historyCursor: "cursor-before-m3",
          historyComplete: true,
        });
      },
    ];
    stopResults = [
      () => projection([message("m3"), message("m4"), message("m5")], { revision: 9 }),
    ];

    await act(async () => {
      const paging = result.current.loadEarlierMessages();
      await result.current.stop();
      releaseJoined();
      await paging;
    });

    // The stop owns the transcript now. Committing the pre-stop snapshot would
    // rewrite the paging refs from a live tail that no longer exists, so the
    // click has to abandon its own read.
    expect(messagePageCalls).toEqual([]);
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3", "m4", "m5"]);
  });

  test("a mutation keeps retained history and the load-earlier control", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3"), message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];
    projectionUpdates = [
      () =>
        joinedSnapshot("joined-1", [message("m3"), message("m4")], {
          historyCursor: "cursor-before-m3",
        }),
    ];
    messagePages = [
      () => historyPage([message("m2")], { nextCursor: "cursor-before-m2", complete: true }),
    ];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);

    // A mutation answers on the legacy projection surface, whose window knows
    // nothing about the page this tab has loaded. Applying it verbatim would
    // drop m2 and the control that fetches what is older still.
    stopResults = [() => projection([message("m3"), message("m4")], { revision: 2 })];
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("a mutation keeps the control while only a bootstrap is available", async () => {
    transcriptUpdates = [() => truncatedTail("transcript-1", [message("m3"), message("m4")])];
    stateUpdates = [() => stateSnapshot("state-1")];

    const { result } = renderSession();
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);

    stopResults = [
      () =>
        projection([message("m3"), message("m4")], {
          revision: 2,
          messageWindow: { limit: 2, truncated: true, canLoadEarlier: true },
        }),
    ];
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m3", "m4"]);
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });
});
