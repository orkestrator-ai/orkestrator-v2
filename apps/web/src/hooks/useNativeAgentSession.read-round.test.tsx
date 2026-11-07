/**
 * What one background round of a visible native session sends: discovery only
 * when something says it may have moved, and transcript and state in one
 * request once the backend offers it and the view holds both tokens.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentLiveUpdate,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "claude",
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

let phase: "idle" | "running" = "running";
let liveUpdateVersions: number[] | undefined;
const transcriptSnapshot = (): NativeAgentTranscriptUpdate<TestMessage> => ({
  viewVersion: 1,
  status: "snapshot",
  token: "transcript-1",
  value: {
    identity,
    freshness: "current",
    messages: [{ id: "m1", text: "hello" }],
    historyEpoch: "epoch-1",
    historyComplete: true,
  },
});
const stateSnapshot = (): NativeAgentSessionStateUpdate => ({
  viewVersion: 1,
  status: "snapshot",
  token: `state-${phase}`,
  value: {
    identity,
    connection: "connected",
    turn: { phase },
    interactions: [],
    composerControls: [],
    capabilities: nativeAgentCapabilities("claude"),
    notices: [],
  },
});
const transcriptUnchanged: NativeAgentTranscriptUpdate<TestMessage> = {
  viewVersion: 1,
  status: "unchanged",
  token: "transcript-1",
  identity,
};
const stateUnchanged = (): NativeAgentSessionStateUpdate => ({
  viewVersion: 1,
  status: "unchanged",
  token: `state-${phase}`,
  identity,
});
const discoveryReady = (
  availability: "ready" | "loading" = "ready",
): NativeAgentDiscoveryUpdate => ({
  viewVersion: 1,
  status: "snapshot",
  token: `discovery-${availability}`,
  value: {
    identity,
    sections: { models: { availability, value: [], revision: 1 } },
  },
});

const getNativeAgentTranscriptUpdateMock = mock(
  async (input: { knownToken?: string }): Promise<NativeAgentTranscriptUpdate<TestMessage>> =>
    input.knownToken ? transcriptUnchanged : transcriptSnapshot(),
);
const getNativeAgentSessionStateUpdateMock = mock(
  async (input: { knownToken?: string }): Promise<NativeAgentSessionStateUpdate> =>
    input.knownToken === `state-${phase}` ? stateUnchanged() : stateSnapshot(),
);
const getNativeAgentDiscoveryUpdateMock = mock(
  async (_input: { knownToken?: string; forceSnapshot?: boolean }) =>
    discoveryReady() as NativeAgentDiscoveryUpdate,
);
const getNativeAgentLiveUpdateMock = mock(
  async (input: {
    transcriptToken?: string;
    stateToken?: string;
  }): Promise<NativeAgentLiveUpdate<TestMessage>> => ({
    viewVersion: 1,
    transcript: input.transcriptToken ? transcriptUnchanged : transcriptSnapshot(),
    state: input.stateToken === `state-${phase}` ? stateUnchanged() : stateSnapshot(),
  }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
    ...(liveUpdateVersions ? { liveUpdateVersions } : {}),
  }),
  getNativeAgentTranscriptUpdate: getNativeAgentTranscriptUpdateMock,
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: getNativeAgentDiscoveryUpdateMock,
  getNativeAgentLiveUpdate: getNativeAgentLiveUpdateMock,
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: "env-env-1:tab-1",
    environmentId: "env-1",
    agent: "claude",
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");
const { dispatchResourceChange, requestResourceResync, resetResourceSync } =
  await import("@/lib/resource-sync");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");
const { installFakeReadCoordinator } = await import("@/lib/testing/read-coordinator");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const discoveryReads = () => getNativeAgentDiscoveryUpdateMock.mock.calls.length;
const stateReads = () => getNativeAgentSessionStateUpdateMock.mock.calls.length;
const transcriptReads = () => getNativeAgentTranscriptUpdateMock.mock.calls.length;
const liveReads = () => getNativeAgentLiveUpdateMock.mock.calls.length;
const realTick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function changeFor(revision: number, cause?: string) {
  return {
    resource: "native-agent-session" as const,
    id: "env-1",
    revision,
    agent: "claude",
    logicalSessionKey: "env-env-1:tab-1",
    ...(cause ? { cause } : {}),
  };
}

async function settledSession() {
  const view = renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform: "claude",
      environmentId: "env-1",
      tabId: "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
  await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("current"));
  await waitFor(() => expect(view.result.current.isRefreshing).toBe(false));
  await waitFor(() => expect(discoveryReads()).toBeGreaterThan(0));
  await act(() => realTick(0));
  return view;
}

beforeEach(() => {
  phase = "running";
  liveUpdateVersions = undefined;
  resetNativeAgentSyncCapabilityForTests();
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  getNativeAgentDiscoveryUpdateMock.mockClear();
  getNativeAgentLiveUpdateMock.mockClear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  resetResourceSync();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("discovery leaves the 500 ms round", () => {
  test("a mount reads it once; running rounds do not", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    const before = stateReads();

    for (let tick = 0; tick < 10; tick += 1) await act(() => clock.advance(500));

    await waitFor(() => expect(stateReads()).toBeGreaterThanOrEqual(before + 10));
    expect(discoveryReads()).toBe(mounted);
  });

  test("the backstop reads again after 30 s with the view's token", async () => {
    const { clock } = installFakeReadCoordinator();
    const realNow = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => realNow + clock.time);
    try {
      await settledSession();
      const mounted = discoveryReads();

      await act(() => clock.advance(29_000));
      expect(discoveryReads()).toBe(mounted);
      await act(() => clock.advance(1_500));
      await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
      expect(getNativeAgentDiscoveryUpdateMock.mock.calls.at(-1)?.[0].knownToken).toBe(
        "discovery-ready",
      );
    } finally {
      now.mockRestore();
    }
  });

  test("an invalidation that names discovery reads it; any other does not", async () => {
    installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    const before = stateReads();

    dispatchResourceChange(changeFor(1, "projection-read"));
    await act(() => realTick(70));
    await waitFor(() => expect(stateReads()).toBeGreaterThan(before));
    expect(discoveryReads()).toBe(mounted);

    dispatchResourceChange(changeFor(2, "discovery-renewal"));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
    await act(() => realTick(70));

    dispatchResourceChange(changeFor(3, "command-catalog"));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 2));
  });

  test("an environment-wide catalogue change reaches every view of it", async () => {
    installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    dispatchResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
      cause: "command-catalog",
    });
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
  });

  test("a change from a backend before causes still reads it", async () => {
    installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    dispatchResourceChange(changeFor(1));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
  });

  test("a resync reads it", async () => {
    installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    requestResourceResync();
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
  });

  test("returning to a hidden document reads it", async () => {
    const { clock, document } = installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    document.setVisibility("hidden");
    await act(() => clock.advance(1_000));
    document.setVisibility("visible");
    await act(() => clock.advance(50));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
  });

  test("a phase change reads it", async () => {
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    const mounted = discoveryReads();
    phase = "idle";
    await act(() => clock.advance(500));
    await waitFor(() => expect(view.result.current.projection?.turn.phase).toBe("idle"));
    expect(discoveryReads()).toBe(mounted);
    await act(() => clock.advance(1_500));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
  });

  test("a manual refresh reads it and asks for a snapshot", async () => {
    installFakeReadCoordinator();
    const view = await settledSession();
    const mounted = discoveryReads();
    await act(async () => {
      await view.result.current.refresh({ manual: true });
    });
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
    expect(getNativeAgentDiscoveryUpdateMock.mock.calls.at(-1)?.[0].forceSnapshot).toBe(true);
  });

  test("a failed read is tried again on the next round", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const mounted = discoveryReads();
    getNativeAgentDiscoveryUpdateMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    requestResourceResync();
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
    await act(() => realTick(0));
    await act(() => clock.advance(500));
    await waitFor(() => expect(discoveryReads()).toBe(mounted + 2));
    await act(() => realTick(0));
    await act(() => clock.advance(500));
    expect(discoveryReads()).toBe(mounted + 2);
  });

  test("a section still loading is read again until it settles", async () => {
    const { clock } = installFakeReadCoordinator();
    const realNow = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => realNow + clock.time);
    try {
      getNativeAgentDiscoveryUpdateMock.mockImplementationOnce(async () =>
        discoveryReady("loading"),
      );
      await settledSession();
      const mounted = discoveryReads();
      await act(() => clock.advance(1_500));
      expect(discoveryReads()).toBe(mounted);
      await act(() => clock.advance(500));
      await waitFor(() => expect(discoveryReads()).toBe(mounted + 1));
      await act(() => realTick(0));
      await act(() => clock.advance(5_000));
      expect(discoveryReads()).toBe(mounted + 1);
    } finally {
      now.mockRestore();
    }
  });
});

describe("transcript and state in one request", () => {
  test("a backend that offers it gets one request per round", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const beforeTranscript = transcriptReads();
    const beforeState = stateReads();

    await act(() => clock.advance(500));
    await waitFor(() => expect(liveReads()).toBe(1));
    await act(() => realTick(0));
    await act(() => clock.advance(500));
    await waitFor(() => expect(liveReads()).toBe(2));

    expect(transcriptReads()).toBe(beforeTranscript);
    expect(stateReads()).toBe(beforeState);
    expect(getNativeAgentLiveUpdateMock.mock.calls.at(-1)?.[0]).toMatchObject({
      transcriptToken: "transcript-1",
      stateToken: "state-running",
    });
  });

  test("the first read of a view stays two requests", async () => {
    liveUpdateVersions = [1];
    installFakeReadCoordinator();
    await settledSession();
    expect(liveReads()).toBe(0);
    expect(transcriptReads()).toBeGreaterThan(0);
    expect(stateReads()).toBeGreaterThan(0);
  });

  test("an older backend keeps the two reads and is never sent the command", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const beforeTranscript = transcriptReads();
    const beforeState = stateReads();
    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBe(beforeState + 1));
    expect(transcriptReads()).toBe(beforeTranscript + 1);
    expect(liveReads()).toBe(0);
  });

  test("a change from it applies like the separate reads", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    phase = "idle";
    await act(() => clock.advance(500));
    await waitFor(() => expect(view.result.current.projection?.turn.phase).toBe("idle"));
    expect(liveReads()).toBe(1);
    expect(view.result.current.sessionStateAvailability).toBe("current");
  });

  test("a pending part is read on its own, and the answered part is not sent again", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    const beforeTranscript = transcriptReads();
    const beforeState = stateReads();
    phase = "idle";
    getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => ({
      viewVersion: 1,
      transcript: { viewVersion: 1, status: "pending" },
      state: stateSnapshot(),
    }));

    await act(() => clock.advance(500));
    await waitFor(() => expect(transcriptReads()).toBe(beforeTranscript + 1));
    await waitFor(() => expect(view.result.current.projection?.turn.phase).toBe("idle"));
    expect(stateReads()).toBe(beforeState);
    expect(getNativeAgentTranscriptUpdateMock.mock.calls.at(-1)?.[0].knownToken).toBe(
      "transcript-1",
    );
  });

  test("an unavailable state part revokes authority, and the next round reads apart", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    const beforeState = stateReads();
    getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => ({
      viewVersion: 1,
      transcript: transcriptUnchanged,
      state: { viewVersion: 1, status: "unavailable", retryable: true, error: "gone" },
    }));

    await act(() => clock.advance(500));
    await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("unavailable"));
    await act(() => realTick(0));
    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBe(beforeState + 1));
    await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("current"));
  });

  test("a backend without the command falls back in the same round and stays there", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const beforeTranscript = transcriptReads();
    const beforeState = stateReads();
    getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => {
      throw new Error("Unknown backend command: get_native_agent_live_update");
    });

    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBe(beforeState + 1));
    expect(transcriptReads()).toBe(beforeTranscript + 1);
    await act(() => realTick(0));
    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBe(beforeState + 2));
    expect(liveReads()).toBe(1);
  });

  for (const message of [
    "Native agent live update response exceeded 20 MiB",
    "Invalid native agent live update response",
  ]) {
    test(`falls back in the same round and disables combined reads: ${message}`, async () => {
      liveUpdateVersions = [1];
      const { clock } = installFakeReadCoordinator();
      await settledSession();
      const beforeTranscript = transcriptReads();
      const beforeState = stateReads();
      getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => {
        throw new Error(message);
      });
      await act(() => clock.advance(500));
      await waitFor(() => expect(stateReads()).toBe(beforeState + 1));
      expect(transcriptReads()).toBe(beforeTranscript + 1);
      await act(() => realTick(0));
      await act(() => clock.advance(500));
      await waitFor(() => expect(stateReads()).toBe(beforeState + 2));
      expect(liveReads()).toBe(1);
    });
  }

  test("both pending parts are read separately in the same round", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    const beforeTranscript = transcriptReads();
    const beforeState = stateReads();
    getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => ({
      viewVersion: 1,
      transcript: { viewVersion: 1, status: "pending" },
      state: { viewVersion: 1, status: "pending" },
    }));
    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBe(beforeState + 1));
    expect(transcriptReads()).toBe(beforeTranscript + 1);
  });

  for (const replacement of [
    { ...identity, providerSessionId: "session-2" },
    { ...identity, sourceGeneration: "generation-2" },
  ]) {
    test(`state-first replacement refreshes discovery: ${replacement.providerSessionId}/${replacement.sourceGeneration}`, async () => {
      liveUpdateVersions = [1];
      const { clock } = installFakeReadCoordinator();
      const oldDiscovery = discoveryReady();
      if (oldDiscovery.status !== "snapshot") throw new Error("expected snapshot");
      const oldCommands = [
        {
          name: "/old",
          id: "claude:/old",
          source: "project" as const,
          executionKind: "bridge-template" as const,
          bindingRevision: "old",
        },
      ];
      getNativeAgentDiscoveryUpdateMock.mockImplementationOnce(async () => ({
        ...oldDiscovery,
        value: {
          ...oldDiscovery.value,
          sections: { commands: { availability: "ready", revision: 1, value: oldCommands } },
        },
      }));
      const view = await settledSession();
      await waitFor(() =>
        expect(view.result.current.projection?.slashCommands).toEqual(oldCommands),
      );
      const beforeDiscovery = discoveryReads();
      const state = stateSnapshot();
      if (state.status !== "snapshot") throw new Error("expected snapshot");
      getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => ({
        viewVersion: 1,
        transcript: { viewVersion: 1, status: "pending" },
        state: {
          ...state,
          token: "replacement-state",
          value: { ...state.value, identity: replacement },
        },
      }));
      let release!: (value: NativeAgentTranscriptUpdate<TestMessage>) => void;
      getNativeAgentTranscriptUpdateMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await act(() => clock.advance(500));
      await waitFor(() =>
        expect(view.result.current.projection?.generation).toBe(replacement.sourceGeneration),
      );
      expect(view.result.current.projection?.slashCommands).toBeUndefined();
      const transcript = transcriptSnapshot();
      if (transcript.status !== "snapshot") throw new Error("expected snapshot");
      await act(async () =>
        release({
          ...transcript,
          token: "replacement-transcript",
          value: { ...transcript.value, identity: replacement },
        }),
      );
      getNativeAgentLiveUpdateMock.mockImplementation(async () => ({
        viewVersion: 1,
        transcript: {
          ...transcriptUnchanged,
          identity: replacement,
          token: "replacement-transcript",
        },
        state: { ...stateUnchanged(), identity: replacement, token: "replacement-state" },
      }));
      const discovery = discoveryReady();
      if (discovery.status !== "snapshot") throw new Error("expected snapshot");
      getNativeAgentDiscoveryUpdateMock.mockImplementationOnce(async () => ({
        ...discovery,
        token: "replacement-discovery",
        value: {
          ...discovery.value,
          identity: replacement,
          sections: { commands: { availability: "ready", revision: 2, value: [] } },
        },
      }));
      await act(() => realTick(0));
      await act(() => clock.advance(500));
      await waitFor(() => expect(discoveryReads()).toBe(beforeDiscovery + 1));
      expect(getNativeAgentDiscoveryUpdateMock.mock.calls.at(-1)?.[0].knownToken).toBeUndefined();
      await waitFor(() => expect(view.result.current.projection?.slashCommands).toEqual([]));
    });
  }

  test("any other failure is reported, as a failed read would be", async () => {
    liveUpdateVersions = [1];
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    getNativeAgentLiveUpdateMock.mockImplementationOnce(async () => {
      throw new Error("Gateway command failed with HTTP 500");
    });

    await act(() => clock.advance(500));
    await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("unavailable"));
    await act(() => realTick(0));
    expect(liveReads()).toBe(1);
  });
});
