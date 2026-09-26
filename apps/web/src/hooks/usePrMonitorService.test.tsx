import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  PR_MONITOR_CHANGED_EVENT,
  type PrMonitorEnvironmentState,
  type PrMonitorEvent,
  type PrMonitorTransition,
} from "@orkestrator/protocol/pr-monitor";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import * as realBackend from "@/lib/backend";
import * as realNativeEvents from "@/lib/native/events";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { useEnvironmentStore } from "@/stores/environmentStore";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const callOrder: string[] = [];
const listen = mock(async (event: string, handler: (event: { payload: unknown }) => void) => {
  callOrder.push(`listen:${event}`);
  handlers.set(event, handler);
  return () => handlers.delete(event);
});
const getPrMonitorState = mock(async (_known?: unknown): Promise<unknown> => {
  callOrder.push("snapshot");
  return { entries: [] };
});
const playConfiguredNotificationSound = mock(async () => true);
// Terminal side effects are backend-owned; the subscriber must never call these.
const prMonitorWatch = mock(async () => undefined);
const prMonitorRefresh = mock(async () => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  getPrMonitorState,
  prMonitorWatch,
  prMonitorRefresh,
}));
mock.module("@/lib/native/events", () => ({ ...realNativeEvents, listen }));
mock.module("@/lib/notification-sounds", () => ({
  ...realNotificationSounds,
  playConfiguredNotificationSound,
}));

const { usePrMonitorService } = await import("./usePrMonitorService");
const { requestViewSafetyChecks } = await import("@/lib/resource-sync");
const { usePrMonitorStore } = await import("@/stores/prMonitorStore");

beforeEach(() => {
  handlers.clear();
  callOrder.length = 0;
  listen.mockClear();
  getPrMonitorState.mockClear();
  getPrMonitorState.mockImplementation(async () => {
    callOrder.push("snapshot");
    return { entries: [] };
  });
  playConfiguredNotificationSound.mockClear();
  prMonitorWatch.mockClear();
  prMonitorRefresh.mockClear();
  usePrMonitorStore.setState({ states: new Map(), syncStatus: "idle" });
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", branch: "feature/sounds" }] as never,
  });
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
  mock.module("@/lib/native/events", () => realNativeEvents);
  mock.module("@/lib/notification-sounds", () => realNotificationSounds);
});

describe("usePrMonitorService sound notifications", () => {
  test("plays the merge cue once for a deduplicated merged transition", async () => {
    const observer = renderHook(() => usePrMonitorService());
    await waitFor(() => expect(handlers.has(PR_MONITOR_CHANGED_EVENT)).toBe(true));

    const event: PrMonitorEvent = {
      environmentId: "env-1",
      state: {
        environmentId: "env-1",
        mode: "normal",
        checkInProgress: false,
        consecutiveErrors: 0,
        lastCheckAt: "2026-09-19T12:00:00.000Z",
        prUrl: "https://github.com/example/repo/pull/1",
        prState: "merged",
        hasMergeConflicts: false,
        checkSummary: null,
      },
      transition: {
        url: "https://github.com/example/repo/pull/1",
        state: "merged",
        previousState: "open",
      },
    };

    act(() => {
      handlers.get(PR_MONITOR_CHANGED_EVENT)?.({ payload: event });
      handlers.get(PR_MONITOR_CHANGED_EVENT)?.({ payload: event });
    });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("pr-merged");
    observer.unmount();
  });
});

const GENERATION = "pr-generation-1";
const PR_1 = "https://github.com/example/repo/pull/1";
const PR_2 = "https://github.com/example/repo/pull/2";

function monitorState(
  overrides: Partial<PrMonitorEnvironmentState> = {},
): PrMonitorEnvironmentState {
  return {
    environmentId: "env-1",
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-09-19T12:00:00.000Z",
    prUrl: PR_1,
    prState: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    ...overrides,
  };
}

function stamped(
  revision: number,
  state: Partial<PrMonitorEnvironmentState>,
  transition?: PrMonitorTransition,
): PrMonitorEvent {
  return {
    environmentId: "env-1",
    state: monitorState(state),
    transition,
    generation: GENERATION,
    revision,
  };
}

function merged(url: string) {
  return { url, state: "merged" as const, previousState: "open" as const };
}

async function mountRevisioned(revision: number, entries: PrMonitorEnvironmentState[]) {
  getPrMonitorState.mockImplementation(async () => {
    callOrder.push("snapshot");
    return { entries, generation: GENERATION, revision };
  });
  const observer = renderHook(() => usePrMonitorService());
  await waitFor(() => expect(usePrMonitorStore.getState().syncStatus).toBe("current"));
  return observer;
}

function emit(payload: unknown) {
  act(() => {
    handlers.get(PR_MONITOR_CHANGED_EVENT)?.({ payload });
  });
}

describe("usePrMonitorService revision-aware recovery", () => {
  test("subscribes to changes before reading the snapshot", async () => {
    const observer = await mountRevisioned(0, []);
    expect(callOrder.indexOf(`listen:${PR_MONITOR_CHANGED_EVENT}`)).toBeLessThan(
      callOrder.indexOf("snapshot"),
    );
    observer.unmount();
  });

  test("a retried or re-delivered transition toasts once and a rehydrate never re-toasts", async () => {
    const observer = await mountRevisioned(1, [monitorState()]);

    emit(stamped(2, { prState: "merged" }, merged(PR_1)));
    emit(stamped(2, { prState: "merged" }, merged(PR_1))); // replay duplicate
    emit(stamped(3, { prState: "merged", consecutiveErrors: 1 }, merged(PR_1))); // retry
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);

    // Reconnect rehydrates state only; the snapshot carries no transitions.
    getPrMonitorState.mockImplementation(async () => ({
      status: "snapshot",
      generation: GENERATION,
      revision: 3,
      snapshot: { entries: [monitorState({ prState: "merged" })] },
    }));
    act(() => handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({ payload: undefined }));
    await waitFor(() => expect(getPrMonitorState).toHaveBeenCalledTimes(2));
    expect(getPrMonitorState.mock.calls[1]?.[0]).toEqual({ generation: GENERATION, revision: 3 });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(usePrMonitorStore.getState().states.get("env-1")?.prState).toBe("merged");
    // The subscriber never performs terminal side effects itself.
    expect(prMonitorWatch).not.toHaveBeenCalled();
    expect(prMonitorRefresh).not.toHaveBeenCalled();
    observer.unmount();
  });

  test("a replacement PR's merge is announced even after its predecessor's", async () => {
    const observer = await mountRevisioned(1, [monitorState()]);

    emit(stamped(2, { prState: "merged" }, merged(PR_1)));
    emit(stamped(3, { prUrl: PR_2, prState: "open" }));
    emit(stamped(4, { prUrl: PR_2, prState: "merged" }, merged(PR_2)));
    emit(stamped(4, { prUrl: PR_2, prState: "merged" }, merged(PR_2)));

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(2);
    expect(usePrMonitorStore.getState().states.get("env-1")?.prUrl).toBe(PR_2);
    observer.unmount();
  });

  test("a missed transition never prevents current state recovery", async () => {
    const observer = await mountRevisioned(1, [monitorState()]);
    getPrMonitorState.mockImplementation(async () => ({
      status: "snapshot",
      generation: GENERATION,
      revision: 3,
      snapshot: {
        entries: [
          monitorState({ prState: "merged", checkSummary: { passed: 2, total: 2, pending: 0 } }),
        ],
      },
    }));

    // Revision 2 (the merged transition) was lost; revision 3 reveals the gap.
    emit(stamped(3, { prState: "merged", checkSummary: { passed: 2, total: 2, pending: 0 } }));
    await waitFor(() => expect(getPrMonitorState).toHaveBeenCalledTimes(2));
    expect(getPrMonitorState.mock.calls[1]?.[0]).toEqual({ generation: GENERATION, revision: 1 });
    await waitFor(() => expect(usePrMonitorStore.getState().syncStatus).toBe("current"));

    expect(usePrMonitorStore.getState().states.get("env-1")?.prState).toBe("merged");
    // Best-effort notifications: the lost transition is not replayed.
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    observer.unmount();
  });

  test("the resource-sync safety cadence runs a compact check that writes nothing when unchanged", async () => {
    const observer = await mountRevisioned(4, [monitorState()]);
    const before = usePrMonitorStore.getState().states;
    getPrMonitorState.mockImplementation(async () => ({
      status: "unchanged",
      generation: GENERATION,
      revision: 4,
    }));

    act(() => requestViewSafetyChecks("interval"));
    await waitFor(() => expect(getPrMonitorState).toHaveBeenCalledTimes(2));
    expect(getPrMonitorState.mock.calls[1]?.[0]).toEqual({ generation: GENERATION, revision: 4 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(usePrMonitorStore.getState().states).toBe(before);
    expect(usePrMonitorStore.getState().syncStatus).toBe("current");
    observer.unmount();

    // Unmounting unsubscribes from the cadence.
    act(() => requestViewSafetyChecks("interval"));
    expect(getPrMonitorState).toHaveBeenCalledTimes(2);
  });

  test("an unknown snapshot command selects the unsupported capability", async () => {
    getPrMonitorState.mockImplementation(async () => {
      throw new Error("Unknown backend command: get_pr_monitor_state");
    });
    const observer = renderHook(() => usePrMonitorService());
    await waitFor(() => expect(usePrMonitorStore.getState().syncStatus).toBe("unsupported"));

    act(() => requestViewSafetyChecks("interval"));
    expect(getPrMonitorState).toHaveBeenCalledTimes(1);
    observer.unmount();
  });
});
