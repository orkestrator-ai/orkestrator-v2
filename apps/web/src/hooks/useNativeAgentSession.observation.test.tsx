/**
 * Quiet idle-view backoff and backend observation invalidations for the
 * native-agent session hook (recurring-processes step 07).
 *
 * A qualified provider's idle view slows through the quiet schedule only when
 * the backend advertises stamped activity announcements; any announcement
 * for the view, and any gap in the announcement stamps, reads immediately.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import * as realBackend from "@/lib/backend";
import * as events from "@/lib/native/events";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };
let platform: AgentPlatform = "pi";
let observationEventVersions: number[] | undefined = [1];

const identity = (): NativeAgentViewIdentity => ({
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform,
  logicalSessionKey: "env-env-1:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
});

const getNativeAgentSessionStateUpdateMock = mock(
  async (): Promise<NativeAgentSessionStateUpdate> => ({
    viewVersion: 1,
    status: "snapshot",
    token: "state-idle",
    value: {
      identity: identity(),
      connection: "connected",
      turn: { phase: "idle" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities(platform),
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
    ...(observationEventVersions ? { observationEventVersions } : {}),
  }),
  getNativeAgentTranscriptUpdate: async (): Promise<NativeAgentTranscriptUpdate<TestMessage>> => ({
    viewVersion: 1,
    status: "snapshot",
    token: "transcript-1",
    value: {
      identity: identity(),
      freshness: "current",
      messages: [{ id: "m1", text: "hello" }],
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  }),
  getNativeAgentSessionStateUpdate: getNativeAgentSessionStateUpdateMock,
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery",
    identity: identity(),
  }),
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: "env-env-1:tab-1",
    environmentId: "env-1",
    agent: platform,
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");
const { resetResourceSync } = await import("@/lib/resource-sync");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");
const { installFakeReadCoordinator } = await import("@/lib/testing/read-coordinator");
const { resetNativeObservationEventsForTests } = await import("@/lib/native-observation-events");

const listenMock = events.listen as unknown as Mock<
  (event: string, handler: (event: { payload: unknown }) => unknown) => Promise<() => void>
>;
const handlers = new Map<string, (event: { payload: unknown }) => unknown>();

function announce(payload: Record<string, unknown>): void {
  const handler = handlers.get("native-agent-session-activity");
  if (!handler) throw new Error("no activity announcement listener");
  handler({ payload });
}

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  resetNativeObservationEventsForTests();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const stateReads = () => getNativeAgentSessionStateUpdateMock.mock.calls.length;

async function settledSession() {
  const view = renderHook(() =>
    useNativeAgentSession<TestMessage>({
      platform,
      environmentId: "env-1",
      tabId: "tab-1",
      isActive: true,
      enabled: true,
    }),
  );
  await waitFor(() => expect(view.result.current.sessionStateAvailability).toBe("current"));
  await waitFor(() => expect(view.result.current.isRefreshing).toBe(false));
  return view;
}

beforeEach(() => {
  platform = "pi";
  observationEventVersions = [1];
  handlers.clear();
  listenMock.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return Promise.resolve(() => {
      if (handlers.get(event) === handler) handlers.delete(event);
    });
  });
  resetNativeAgentSyncCapabilityForTests();
  resetNativeObservationEventsForTests();
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
  resetNativeObservationEventsForTests();
  useNativeAgentProjectionStore.getState().reset();
});

/** Advance through `ms` and report whether a periodic read landed exactly at its end. */
async function readsExactlyAfter(
  clock: { advance(ms: number): Promise<void> | void },
  ms: number,
): Promise<void> {
  const before = stateReads();
  await act(() => clock.advance(ms - 1));
  expect(stateReads()).toBe(before);
  await act(() => clock.advance(1));
  await waitFor(() => expect(stateReads()).toBe(before + 1));
}

describe("useNativeAgentSession observation invalidations", () => {
  test("a qualified idle view backs off quietly and an announced transition reads at once", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();

    // Quiet schedule: 1.5 s, then 3 s, then 5 s between unchanged idle reads.
    await readsExactlyAfter(clock, 1_500);
    await readsExactlyAfter(clock, 3_000);
    await readsExactlyAfter(clock, 5_000);

    // Another tab's transition is not this view's business.
    const quiet = stateReads();
    await act(async () => {
      announce({
        environment_id: "env-1",
        agent: platform,
        logical_session_key: "env-env-1:tab-2",
        previous_state: "idle",
        state: "working",
        generation: "observer-1",
        revision: 1,
      });
    });
    await act(() => clock.advance(100));
    expect(stateReads()).toBe(quiet);

    // This view's turn started elsewhere: read immediately, cadence restored.
    await act(async () => {
      announce({
        environment_id: "env-1",
        agent: platform,
        logical_session_key: "env-env-1:tab-1",
        previous_state: "idle",
        state: "working",
        generation: "observer-1",
        revision: 2,
      });
    });
    await waitFor(() => expect(stateReads()).toBe(quiet + 1));
    await readsExactlyAfter(clock, 1_500);
  });

  test("a missed announcement (stamp gap) or a new observer lifetime re-reads the view", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await act(async () => {
      announce({
        environment_id: "env-other",
        agent: "codex",
        logical_session_key: "env-env-other:tab-9",
        state: "working",
        generation: "observer-1",
        revision: 1,
      });
    });
    await act(() => clock.advance(100));
    const before = stateReads();

    // Revision 2 was never delivered.
    await act(async () => {
      announce({
        environment_id: "env-other",
        agent: "codex",
        logical_session_key: "env-env-other:tab-9",
        state: "idle",
        generation: "observer-1",
        revision: 3,
      });
    });
    await waitFor(() => expect(stateReads()).toBe(before + 1));

    // A duplicate replay is ignored.
    await act(async () => {
      announce({
        environment_id: "env-other",
        agent: "codex",
        logical_session_key: "env-env-other:tab-9",
        state: "idle",
        generation: "observer-1",
        revision: 3,
      });
    });
    await act(() => clock.advance(100));
    expect(stateReads()).toBe(before + 1);

    // A restarted backend is a new lifetime.
    await act(async () => {
      announce({
        environment_id: "env-other",
        agent: "codex",
        state: "idle",
        generation: "observer-2",
        revision: 1,
      });
    });
    await waitFor(() => expect(stateReads()).toBe(before + 2));
  });

  test("an older backend without announcements keeps the baseline idle cadence", async () => {
    observationEventVersions = undefined;
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    for (let read = 0; read < 4; read += 1) await readsExactlyAfter(clock, 1_500);
  });

  test("an unqualified provider keeps the baseline idle cadence", async () => {
    platform = "claude";
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    for (let read = 0; read < 4; read += 1) await readsExactlyAfter(clock, 1_500);
  });
});
