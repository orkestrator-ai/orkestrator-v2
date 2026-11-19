/**
 * The native session view over push (docs/architecture/push-events.md): while
 * its subscription is healthy the view reads when a frame names its session
 * and otherwise only on the 30 s recovery poll; when push is unavailable or
 * the stream drops it keeps its old cadence.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RECOVERY_POLL_MS,
  PUSH_RESYNC_EVENT,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import * as realBackend from "@/lib/backend";
import * as events from "@/lib/native/events";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };
const STREAM = "stream-aaaaaaaaaaaaaaaa";
const SESSION_KEY = "env-env-1:tab-1";
const PUSH_KEY = `env-1/claude/${SESSION_KEY}`;

const identity = (): NativeAgentViewIdentity => ({
  backendInstanceId: "backend-1",
  environmentId: "env-1",
  platform: "claude",
  logicalSessionKey: SESSION_KEY,
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
});

const getNativeAgentSessionStateUpdateMock = mock(
  async (): Promise<NativeAgentSessionStateUpdate> => ({
    viewVersion: 1,
    status: "snapshot",
    token: "state-running",
    value: {
      identity: identity(),
      connection: "connected",
      turn: { phase: "running" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("claude"),
      notices: [],
    },
  }),
);

const setPushSubscriptionsMock = mock(
  async (args: PushSetSubscriptionsArgs): Promise<PushSetSubscriptionsResult> => ({
    status: "applied",
    setRevision: args.setRevision,
    seqBase: 0,
    subscriptions: args.subscriptions.map(({ topic, key }) => ({
      topic,
      key,
      status: "ok" as const,
      generation: "g1",
      revision: 0,
    })),
  }),
);

let discoveryAvailability: "ready" | "stale" = "ready";
const getNativeAgentDiscoveryUpdate = mock(async (): Promise<NativeAgentDiscoveryUpdate> => ({
  viewVersion: 1,
  status: "snapshot",
  token: `catalog-${discoveryAvailability}`,
  value: {
    identity: identity(),
    sections: { commands: { availability: discoveryAvailability, revision: 1, value: [] } },
  },
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
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
  getNativeAgentDiscoveryUpdate,
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: SESSION_KEY,
    environmentId: "env-1",
    agent: "claude",
  }),
  adoptNativeAgentSession: async () => ({}),
  setPushSubscriptions: setPushSubscriptionsMock,
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");
const { resetResourceSync } = await import("@/lib/resource-sync");
const { resetReadCoordinatorForTests } = await import("@/lib/read-coordinator");
const { installFakeReadCoordinator } = await import("@/lib/testing/read-coordinator");
const { resetNativeObservationEventsForTests } = await import("@/lib/native-observation-events");
const { pushClientFor, pushDiagnostics, resetPushSubscriptionsForTests } =
  await import("@/lib/push/push-subscriptions");

const listenMock = events.listen as unknown as Mock<
  (event: string, handler: (event: { payload: unknown }) => unknown) => Promise<() => void>
>;
const handlers = new Map<string, (event: { payload: unknown }) => unknown>();

function emit(event: string, payload: unknown): void {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no listener for ${event}`);
  handler({ payload });
}

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  resetNativeObservationEventsForTests();
  resetPushSubscriptionsForTests();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const stateReads = () => getNativeAgentSessionStateUpdateMock.mock.calls.length;

async function settledSession() {
  const view = renderHookInAppCommandScope(() =>
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
  return view;
}

async function connectPush(): Promise<void> {
  await waitFor(() => expect(handlers.has(PUSH_STREAM_STATE_EVENT)).toBe(true));
  await act(async () => {
    emit(PUSH_STREAM_STATE_EVENT, {
      state: "connected",
      offer: { versions: [1], streamId: STREAM },
    });
  });
  await waitFor(() => expect(pushClientFor().isHealthy("native-session", PUSH_KEY)).toBe(true));
}

/** An activity announcement for this view's session (a question parking the turn). */
const announcement = () => ({
  environment_id: "env-1",
  agent: "claude",
  logical_session_key: SESSION_KEY,
  state: "waiting",
});

beforeEach(() => {
  handlers.clear();
  listenMock.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return Promise.resolve(() => {
      if (handlers.get(event) === handler) handlers.delete(event);
    });
  });
  resetNativeAgentSyncCapabilityForTests();
  resetNativeObservationEventsForTests();
  resetPushSubscriptionsForTests();
  getNativeAgentSessionStateUpdateMock.mockClear();
  setPushSubscriptionsMock.mockClear();
  discoveryAvailability = "ready";
  getNativeAgentDiscoveryUpdate.mockClear();
  appCommandStore(paneLayoutStore).setState({
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
  resetNativeObservationEventsForTests();
  resetPushSubscriptionsForTests();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("useNativeAgentSession over push", () => {
  test("subscribes its session while active", async () => {
    installFakeReadCoordinator();
    await settledSession();
    await connectPush();
    expect(setPushSubscriptionsMock.mock.calls.at(-1)?.[0]).toEqual({
      streamId: STREAM,
      setRevision: 1,
      subscriptions: [{ topic: "native-session", key: PUSH_KEY }],
    });
  });

  test("a healthy running view reads on frames and otherwise only on the recovery poll", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await connectPush();
    // The subscription's first answer reads once (it covers the mount read's race).
    await act(() => clock.advance(10));
    const afterSubscribe = stateReads();

    // A quiet running turn: no reads at the old 500 ms cadence.
    await act(() => clock.advance(10_000));
    expect(stateReads()).toBe(afterSubscribe);

    // A frame for this session reads at once.
    await act(async () => {
      emit(PUSH_CHANGED_EVENT, {
        seq: 1,
        changes: [
          {
            topic: "native-session",
            key: PUSH_KEY,
            generation: "g1",
            revision: 1,
            parts: ["state"],
          },
        ],
      });
    });
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(afterSubscribe + 1));

    // Another session's frame does not.
    await act(async () => {
      emit(PUSH_CHANGED_EVENT, {
        seq: 2,
        changes: [
          {
            topic: "native-session",
            key: "env-1/claude/other",
            generation: "g1",
            revision: 1,
            parts: [],
          },
        ],
      });
    });
    await act(() => clock.advance(100));
    expect(stateReads()).toBe(afterSubscribe + 1);

    // The recovery poll still runs, at its own slow cadence.
    await act(() => clock.advance(PUSH_RECOVERY_POLL_MS));
    await waitFor(() => expect(stateReads()).toBeGreaterThanOrEqual(afterSubscribe + 2));
    expect(stateReads()).toBeLessThanOrEqual(afterSubscribe + 3);
  });

  test("while healthy an activity announcement reads once, through its push frame", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await connectPush();
    await act(() => clock.advance(10));
    const before = stateReads();

    // The announcement alone reads nothing: the backend's observer wakes on it.
    await act(async () => emit(NATIVE_AGENT_ACTIVITY_EVENT, announcement()));
    await act(() => clock.advance(100));
    expect(stateReads()).toBe(before);

    // The frame the observer sends for the change is the one read.
    await act(async () => {
      emit(PUSH_CHANGED_EVENT, {
        seq: 1,
        changes: [
          {
            topic: "native-session",
            key: PUSH_KEY,
            generation: "g1",
            revision: 1,
            parts: ["state"],
          },
        ],
      });
    });
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(before + 1));
    await act(() => clock.advance(100));
    expect(stateReads()).toBe(before + 1);
  });

  test("without a healthy subscription an activity announcement still reads at once", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await waitFor(() => expect(handlers.has(PUSH_STREAM_STATE_EVENT)).toBe(true));
    await act(async () => emit(PUSH_STREAM_STATE_EVENT, { state: "connected", offer: null }));
    // Align with the old 500 ms cadence, so the next poll is a whole interval away.
    const polled = stateReads();
    await act(() => clock.advance(500));
    await waitFor(() => expect(stateReads()).toBeGreaterThan(polled));
    const before = stateReads();
    await act(async () => emit(NATIVE_AGENT_ACTIVITY_EVENT, announcement()));
    await act(() => clock.advance(1));
    await waitFor(() => expect(stateReads()).toBe(before + 1));
  });

  test("a stale discovery section retries during quiet healthy push", async () => {
    const { clock } = installFakeReadCoordinator();
    discoveryAvailability = "stale";
    await settledSession();
    await connectPush();
    await act(() => clock.advance(10));
    const reads = getNativeAgentDiscoveryUpdate.mock.calls.length;
    discoveryAvailability = "ready";
    await act(async () => {
      // The hook schedules the discovery deadline independently of coordinator time.
      await Bun.sleep(2_100);
    });
    await act(() => clock.advance(10));
    await waitFor(() =>
      expect(getNativeAgentDiscoveryUpdate.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(pushClientFor().isHealthy("native-session", PUSH_KEY)).toBe(true);
  });

  test("a missed frame marks the view recovering, and a new producer snapshot clears it", async () => {
    const { clock } = installFakeReadCoordinator();
    const view = await settledSession();
    await connectPush();
    await act(() => clock.advance(10));
    const before = stateReads();
    await act(async () => {
      emit(PUSH_RESYNC_EVENT, { seq: 12, reason: "topic-reset", topics: "all" });
      emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
    });
    expect(view.result.current.pushRecovering).toBe(true);
    expect(view.result.current.projection?.turn.phase).toBe("running");
    await act(async () => {
      emit(PUSH_STREAM_STATE_EVENT, {
        state: "connected",
        offer: { versions: [1], streamId: "stream-bbbbbbbbbbbbbbbb" },
      });
    });
    await waitFor(() => expect(view.result.current.pushRecovering).toBe(false));
    await act(() => clock.advance(10));
    await waitFor(() => expect(stateReads()).toBeGreaterThan(before));
    expect(view.result.current.projection?.turn.phase).toBe("running");
  });

  test("a dropped stream returns the view to its old cadence until push is healthy again", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await connectPush();
    await act(() => clock.advance(10));
    await act(async () => emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" }));
    expect(pushClientFor().isHealthy("native-session", PUSH_KEY)).toBe(false);
    const before = stateReads();
    await act(() => clock.advance(1_000));
    await waitFor(() => expect(stateReads()).toBeGreaterThan(before));
    expect(pushDiagnostics()?.state).toBe("recovering");
  });

  test("a node without push leaves the old cadence in place", async () => {
    const { clock } = installFakeReadCoordinator();
    await settledSession();
    await waitFor(() => expect(handlers.has(PUSH_STREAM_STATE_EVENT)).toBe(true));
    await act(async () => emit(PUSH_STREAM_STATE_EVENT, { state: "connected", offer: null }));
    expect(setPushSubscriptionsMock).not.toHaveBeenCalled();
    const before = stateReads();
    await act(() => clock.advance(1_000));
    await waitFor(() => expect(stateReads()).toBeGreaterThan(before));
  });

  test("unmounting releases the subscription", async () => {
    installFakeReadCoordinator();
    const view = await settledSession();
    await connectPush();
    view.unmount();
    await waitFor(() =>
      expect(setPushSubscriptionsMock.mock.calls.at(-1)?.[0].subscriptions).toEqual([]),
    );
  });
});
