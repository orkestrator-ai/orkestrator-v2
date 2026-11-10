import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import {
  PR_MONITOR_CHANGED_EVENT,
  type PrMonitorEnvironmentState,
  type PrMonitorEvent,
  type PrMonitorSnapshot,
} from "@orkestrator/protocol/pr-monitor";
import * as realBackend from "@/lib/backend";
import { mockToastSuccess } from "../../mocks/sonner";
import type { Environment } from "../../../apps/web/src/types";

const realBackendSnapshot = { ...realBackend };

const mockGetPrMonitorState = mock<() => Promise<PrMonitorSnapshot>>(() =>
  Promise.resolve({ entries: [] }),
);

/**
 * Every backend in the support window stamps its PR monitor snapshots and
 * events. Like the real service, a snapshot carries the revision current when
 * it was requested, and each announced event advances it.
 */
const GENERATION = "a".repeat(32);
let revision = 0;

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getPrMonitorState: async () => {
    const stamp = revision;
    const snapshot = await mockGetPrMonitorState();
    return { ...snapshot, generation: GENERATION, revision: stamp };
  },
}));

/**
 * Drives the event stream by hand.
 *
 * The shared `@/lib/native/events` mock in tests/setup.ts returns a listener
 * that never fires, which is right for suites that only need the hook not to
 * explode. This file is specifically about what arrives on that stream, so it
 * installs a registry it can emit into and restores the shared mock afterwards.
 */
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const NATIVE_EVENT_STREAM_CONNECTED_EVENT = "native-event-stream-connected";

const defaultListen = (event: string, handler: (event: { payload: unknown }) => void) => {
  const wrapped = (payload: unknown) => handler({ payload });
  const existing = listeners.get(event) ?? new Set();
  existing.add(wrapped);
  listeners.set(event, existing);
  return Promise.resolve(() => {
    existing.delete(wrapped);
  });
};
const mockListen = mock(defaultListen);

mock.module("@/lib/native/events", () => ({
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  emit: mock(() => Promise.resolve()),
  listen: mockListen,
}));

// Import every stateful dependency after installing module mocks, so the hook
// and the assertions observe the same Zustand store instances.
const { prMonitorStore } = await import("../../../apps/web/src/stores/prMonitorStore");
const { appCommandStore } = await import("@/test/app-command-store");
const { environmentStore } = await import("../../../apps/web/src/stores/environmentStore");
const { usePrMonitorService } = await import("../../../apps/web/src/hooks/usePrMonitorService");

function emitEvent(event: string, payload: unknown) {
  const stamped =
    event === PR_MONITOR_CHANGED_EVENT && typeof payload === "object" && payload !== null
      ? { ...payload, generation: GENERATION, revision: ++revision }
      : payload;
  for (const handler of listeners.get(event) ?? []) handler(stamped);
}

function listenerCount(event: string): number {
  return listeners.get(event)?.size ?? 0;
}

function makeState(
  environmentId: string,
  overrides: Partial<PrMonitorEnvironmentState> = {},
): PrMonitorEnvironmentState {
  return {
    environmentId,
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-07-28T00:00:00.000Z",
    prUrl: "https://github.com/org/repo/pull/1",
    prState: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    ...overrides,
  };
}

function stateEvent(
  environmentId: string,
  overrides: Partial<PrMonitorEnvironmentState> = {},
  transition?: {
    url: string;
    state: "open" | "merged" | "closed";
    previousState: "open" | "merged" | "closed" | null;
  },
): PrMonitorEvent {
  return { environmentId, state: makeState(environmentId, overrides), transition };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "PR monitor environment",
    branch: "feature/pr-monitor",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Waits for the hook's async subscribe/rehydrate to settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePrMonitorService", () => {
  beforeEach(() => {
    listeners.clear();
    revision = 0;
    mockListen.mockClear();
    mockListen.mockImplementation(defaultListen);
    mockGetPrMonitorState.mockClear();
    mockGetPrMonitorState.mockImplementation(() => Promise.resolve({ entries: [] }));
    mockToastSuccess.mockClear();
    appCommandStore(prMonitorStore).setState({ states: new Map() });
    appCommandStore(environmentStore).setState({ environments: [] });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  test("rehydrates from the authoritative snapshot on mount", async () => {
    mockGetPrMonitorState.mockImplementation(() =>
      Promise.resolve({
        entries: [
          makeState("env-1"),
          makeState("env-2", { mode: "create-pending", prUrl: null, prState: null }),
        ],
      }),
    );

    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    expect(mockGetPrMonitorState).toHaveBeenCalledTimes(1);
    const states = appCommandStore(prMonitorStore).getState().states;
    expect(states.size).toBe(2);
    expect(states.get("env-1")?.prState).toBe("open");
    expect(states.get("env-2")?.mode).toBe("create-pending");
  });

  test("rehydrates CI completion missed while an environment view was inactive", async () => {
    mockGetPrMonitorState.mockResolvedValueOnce({
      entries: [makeState("env-1", { checkSummary: { passed: 2, total: 3, pending: 1 } })],
    });
    const mounted = renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();
    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.checkSummary).toEqual({
      passed: 2,
      total: 3,
      pending: 1,
    });

    mounted.unmount();
    appCommandStore(prMonitorStore).setState({ states: new Map() });
    mockGetPrMonitorState.mockResolvedValueOnce({
      entries: [makeState("env-1", { checkSummary: { passed: 3, total: 3, pending: 0 } })],
    });

    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.checkSummary).toEqual({
      passed: 3,
      total: 3,
      pending: 0,
    });
  });

  test("ignores a malformed snapshot rather than trusting the wire", async () => {
    appCommandStore(prMonitorStore).getState().applyEvent(stateEvent("env-1"));
    mockGetPrMonitorState.mockImplementation(() =>
      Promise.resolve({ entries: [{ environmentId: "env-2" }] } as never),
    );

    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    // The invalid payload neither replaced nor cleared the existing state.
    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")).toBeDefined();
    expect(appCommandStore(prMonitorStore).getState().states.get("env-2")).toBeUndefined();
  });

  test("applies live state changes and removals to the store", async () => {
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1", { mode: "merge-pending" }));
    });
    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.mode).toBe(
      "merge-pending",
    );

    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, { environmentId: "env-1", removed: true });
    });
    expect(appCommandStore(prMonitorStore).getState().states.has("env-1")).toBe(false);

    // Malformed payloads are dropped.
    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, { environmentId: "env-9" });
    });
    expect(appCommandStore(prMonitorStore).getState().states.has("env-9")).toBe(false);
  });

  test("buffers events during a rehydrate and replays them over the snapshot", async () => {
    const snapshot = deferred<PrMonitorSnapshot>();
    mockGetPrMonitorState.mockImplementation(() => snapshot.promise);

    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    // The snapshot is still in flight; a newer live update arrives.
    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1", { prState: "merged" }));
    });

    snapshot.resolve({ entries: [makeState("env-1", { prState: "open" })] });
    await flush();

    // The buffered event was applied after the snapshot, so the newer merged
    // reading was not overwritten by the older snapshot.
    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.prState).toBe("merged");
  });

  test("rehydrates again on every event-stream reconnect", async () => {
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();
    expect(mockGetPrMonitorState).toHaveBeenCalledTimes(1);

    act(() => {
      emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    });
    await flush();

    expect(mockGetPrMonitorState).toHaveBeenCalledTimes(2);
  });

  test("retries a failed change listener on event-stream reconnect", async () => {
    let changeAttempts = 0;
    mockListen.mockImplementation((event, handler) => {
      if (event === PR_MONITOR_CHANGED_EVENT && changeAttempts++ === 0) {
        return Promise.reject(new Error("listener temporarily unavailable"));
      }
      return defaultListen(event, handler);
    });

    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    expect(changeAttempts).toBe(1);
    expect(listenerCount(PR_MONITOR_CHANGED_EVENT)).toBe(0);
    expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(1);

    act(() => {
      emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    });
    await flush();

    expect(changeAttempts).toBe(2);
    expect(listenerCount(PR_MONITOR_CHANGED_EVENT)).toBe(1);

    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1"));
    });
    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.prState).toBe("open");
  });

  test("announces a merged transition once, with the environment branch", async () => {
    appCommandStore(environmentStore).setState({ environments: [makeEnvironment()] });
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    const transition = {
      url: "https://github.com/org/repo/pull/1",
      state: "merged" as const,
      previousState: "open" as const,
    };
    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1", { prState: "merged" }, transition));
    });

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith("Branch merged", {
      description: "feature/pr-monitor",
      id: "branch-merged-env-1",
    });

    // The backend may re-emit the same transition while a failed persist is
    // retried; the user hears about the merge once.
    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1", { prState: "merged" }, transition));
    });
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });

  test("a transition buffered during a rehydrate still notifies", async () => {
    appCommandStore(environmentStore).setState({ environments: [makeEnvironment()] });
    const snapshot = deferred<PrMonitorSnapshot>();
    mockGetPrMonitorState.mockImplementation(() => snapshot.promise);
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    act(() => {
      emitEvent(
        PR_MONITOR_CHANGED_EVENT,
        stateEvent(
          "env-1",
          { prState: "merged" },
          {
            url: "https://github.com/org/repo/pull/1",
            state: "merged",
            previousState: "open",
          },
        ),
      );
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();

    snapshot.resolve({ entries: [] });
    await flush();

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });

  test("does not announce open or closed transitions", async () => {
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    act(() => {
      emitEvent(
        PR_MONITOR_CHANGED_EVENT,
        stateEvent(
          "env-1",
          {},
          {
            url: "https://github.com/org/repo/pull/1",
            state: "open",
            previousState: null,
          },
        ),
      );
      emitEvent(
        PR_MONITOR_CHANGED_EVENT,
        stateEvent(
          "env-1",
          { prState: "closed" },
          {
            url: "https://github.com/org/repo/pull/1",
            state: "closed",
            previousState: "open",
          },
        ),
      );
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("unsubscribes from the stream on unmount", async () => {
    const { unmount } = renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();
    expect(listenerCount(PR_MONITOR_CHANGED_EVENT)).toBe(1);
    expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(1);

    unmount();

    expect(listenerCount(PR_MONITOR_CHANGED_EVENT)).toBe(0);
    expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(0);
  });

  test("keeps working when the snapshot request fails", async () => {
    mockGetPrMonitorState.mockImplementation(() => Promise.reject(new Error("backend offline")));
    renderHookInAppCommandScope(() => usePrMonitorService());
    await flush();

    act(() => {
      emitEvent(PR_MONITOR_CHANGED_EVENT, stateEvent("env-1"));
    });

    expect(appCommandStore(prMonitorStore).getState().states.get("env-1")?.prState).toBe("open");
  });
});
