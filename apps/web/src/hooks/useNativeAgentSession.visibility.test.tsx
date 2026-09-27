/**
 * Background-read scheduling for the native-agent session hook through the
 * shared read coordinator: the baseline 500/1,500 ms cadence, hidden-document
 * pause, deferred invalidations and a single critical reconcile on return.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
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

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "codex",
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

let phase: "idle" | "running" = "idle";

const getNativeAgentTranscriptUpdateMock = mock(
  async (): Promise<NativeAgentTranscriptUpdate<TestMessage>> => ({
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
  }),
);
const getNativeAgentSessionStateUpdateMock = mock(
  async (): Promise<NativeAgentSessionStateUpdate> => ({
    viewVersion: 1,
    status: "snapshot",
    token: `state-${phase}`,
    value: {
      identity,
      connection: "connected",
      turn: { phase },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
    },
  }),
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
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery",
    identity,
  }),
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: "env-env-1:tab-1",
    environmentId: "env-1",
    agent: "codex",
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");
const { dispatchResourceChange, resetResourceSync } = await import("@/lib/resource-sync");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");
const { installFakeReadCoordinator } = await import("@/lib/testing/read-coordinator");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const stateReads = () => getNativeAgentSessionStateUpdateMock.mock.calls.length;
const realTick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function renderSession(isActive = true) {
  return renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: "env-1",
      tabId: "tab-1",
      isActive,
      enabled: true,
    }),
  );
}

async function settledSession(isActive = true) {
  const view = renderSession(isActive);
  await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("current"));
  await waitFor(() => expect(view.result.current.isRefreshing).toBe(false));
  return view;
}

beforeEach(() => {
  phase = "idle";
  resetNativeAgentSyncCapabilityForTests();
  getNativeAgentTranscriptUpdateMock.mockClear();
  getNativeAgentSessionStateUpdateMock.mockClear();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeAgentProjectionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  resetResourceSync();
  useNativeAgentProjectionStore.getState().reset();
});

describe("useNativeAgentSession coordinated background reads", () => {
  test("keeps the 1,500 ms idle and 500 ms active cadence while visible", async () => {
    const { clock } = installFakeReadCoordinator();
    const { result } = await settledSession();
    const afterConnect = stateReads();

    await act(() => clock.advance(1_499));
    expect(stateReads()).toBe(afterConnect);
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(afterConnect + 1));

    // The next read reports a running turn; the cadence tightens to 500 ms.
    phase = "running";
    await act(() => clock.advance(1_500));
    await waitFor(() => expect(result.current.projection?.turn.phase).toBe("running"));
    const running = stateReads();
    await act(() => clock.advance(499));
    expect(stateReads()).toBe(running);
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(running + 1));
  });

  test("a hidden document stops background reads and returning reconciles once, first", async () => {
    const { clock, document } = installFakeReadCoordinator();
    phase = "running";
    await settledSession();
    const beforeHide = stateReads();

    document.setVisibility("hidden");
    await act(() => clock.advance(30_000));
    expect(stateReads()).toBe(beforeHide);
    expect(clock.pending).toBe(0);

    document.setVisibility("visible");
    // Critical priority: no spread beyond the 50 ms coalescing window.
    await act(() => clock.advance(49));
    expect(stateReads()).toBe(beforeHide);
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(beforeHide + 1));
    await act(() => clock.advance(499));
    expect(stateReads()).toBe(beforeHide + 1);
  });

  test("resource changes while hidden are deferred into one reconcile", async () => {
    const { clock, document } = installFakeReadCoordinator();
    await settledSession();
    const beforeHide = stateReads();

    document.setVisibility("hidden");
    for (let revision = 1; revision <= 3; revision += 1) {
      dispatchResourceChange({
        resource: "native-agent-session",
        id: "env-1",
        revision,
        agent: "codex",
        logicalSessionKey: "env-env-1:tab-1",
      });
      // resource-sync coalesces on a real 50 ms timer.
      await act(() => realTick(70));
    }
    expect(stateReads()).toBe(beforeHide);

    document.setVisibility("visible");
    await act(() => clock.advance(50));
    await waitFor(() => expect(stateReads()).toBe(beforeHide + 1));
    await act(() => realTick(20));
    expect(stateReads()).toBe(beforeHide + 1);
  });

  test("resource changes while visible still refresh immediately", async () => {
    installFakeReadCoordinator();
    await settledSession();
    const before = stateReads();
    dispatchResourceChange({
      resource: "native-agent-session",
      id: "env-1",
      revision: 1,
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
    });
    await waitFor(() => expect(stateReads()).toBe(before + 1));
  });

  test("an inactive tab keeps no background demand", async () => {
    const { clock } = installFakeReadCoordinator();
    renderSession(false);
    await act(() => clock.advance(30_000));
    expect(stateReads()).toBe(0);
    expect(clock.pending).toBe(0);
  });
});
