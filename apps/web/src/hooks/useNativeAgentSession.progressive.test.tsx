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

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: getNativeAgentSyncCapabilitiesMock,
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: getNativeAgentDiscoveryUpdateMock,
  ensureNativeAgentSession: ensureNativeAgentSessionMock,
  adoptNativeAgentSession: async () => ({}),
  stopNativeAgentSession: async () => null,
  resumeNativeAgentSession: async () => null,
  getNativeAgentProjection: async () => null,
  getNativeAgentProjectionUpdate: async () => {
    throw new Error("joined projection must not run on the progressive path");
  },
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
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  getNativeAgentDiscoveryUpdateMock.mockClear();
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
    expect(result.current.projection?.messageWindow?.canLoadEarlier).toBe(true);
  });

  test("drops retained history when the history epoch rotates", async () => {
    transcriptUpdates = [
      () => transcriptSnapshot("transcript-1", [message("m1"), message("m2")]),
    ];
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
});
