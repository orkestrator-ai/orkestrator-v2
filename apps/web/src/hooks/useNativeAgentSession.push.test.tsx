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
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RECOVERY_POLL_MS,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
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
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery",
    identity: identity(),
  }),
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
