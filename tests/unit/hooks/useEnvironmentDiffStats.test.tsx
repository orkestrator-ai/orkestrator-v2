import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  DIFF_STATS_CHANGED_EVENT,
  type EnvironmentDiffStatsChange,
  type EnvironmentDiffStatsRemoval,
} from "@orkestrator/protocol/diff-stats";
import * as realBackend from "@/lib/backend";
import { useEnvironmentDiffStore } from "../../../apps/web/src/stores/environmentDiffStore";

const realBackendSnapshot = { ...realBackend };

const mockGetEnvironmentDiffStats = mock<() => Promise<{ entries: EnvironmentDiffStatsChange[] }>>(
  () => Promise.resolve({ entries: [] }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getEnvironmentDiffStats: mockGetEnvironmentDiffStats,
}));

/**
 * Drives the event stream by hand.
 *
 * The shared `@/lib/native/events` mock in tests/setup.ts returns a listener that
 * never fires, which is right for suites that only need the hook not to explode.
 * This file is specifically about what arrives on that stream, so it installs a
 * registry it can emit into and restores the shared mock afterwards.
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

const { useEnvironmentDiffStats } = await import("../../../apps/web/src/hooks/useEnvironmentDiffStats");

function emitEvent(event: string, payload: unknown) {
  for (const handler of listeners.get(event) ?? []) handler(payload);
}

function listenerCount(event: string): number {
  return listeners.get(event)?.size ?? 0;
}

function change(
  environmentId: string,
  overrides: Partial<EnvironmentDiffStatsChange["stats"]> = {},
  comparisonRef = "main",
): EnvironmentDiffStatsChange {
  return {
    environmentId,
    comparisonRef,
    computedAt: "2026-07-27T12:00:00.000Z",
    stats: { additions: 3, deletions: 1, filesChanged: 2, truncated: false, ...overrides },
  };
}

function removal(environmentId: string): EnvironmentDiffStatsRemoval {
  return {
    environmentId,
    comparisonRef: "release",
    computedAt: "2026-07-27T12:01:00.000Z",
    removed: true,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Waits for the hook's async subscribe/rehydrate to settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useEnvironmentDiffStats", () => {
  beforeEach(() => {
    listeners.clear();
    mockListen.mockClear();
    mockListen.mockImplementation(defaultListen);
    mockGetEnvironmentDiffStats.mockClear();
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({ entries: [] }));
    useEnvironmentDiffStore.setState({ stats: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  test("rehydrates from the authoritative snapshot on mount", async () => {
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-1"), change("env-2", { additions: 9, deletions: 0, filesChanged: 1 })],
    }));

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.size).toBe(2);
    });
    expect(useEnvironmentDiffStore.getState().stats.get("env-2")).toEqual({
      additions: 9,
      deletions: 0,
      filesChanged: 1,
      truncated: false,
    });
  });

  test("applies incremental changes announced by the backend", async () => {
    renderHook(() => useEnvironmentDiffStats());
    await flush();

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, change("env-1", { additions: 12, deletions: 4, filesChanged: 3 }));
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-1")).toEqual({
        additions: 12,
        deletions: 4,
        filesChanged: 3,
        truncated: false,
      });
    });
  });

  test("carries the truncated flag through to the store", async () => {
    renderHook(() => useEnvironmentDiffStats());
    await flush();

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, change("env-1", { truncated: true }));
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.truncated).toBe(true);
    });
  });

  test("removes counts invalidated by the backend", async () => {
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-1")],
    }));
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(true));

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, removal("env-1"));
    });

    expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(false);
  });

  // The payload crosses a process boundary and is the only thing driving the
  // badge, so a malformed frame must be dropped rather than written through.
  test.each([
    ["missing stats", { environmentId: "env-1", comparisonRef: "main", computedAt: "now" }],
    ["wrong stats shape", { environmentId: "env-1", comparisonRef: "main", computedAt: "now", stats: { additions: "3" } }],
    ["missing environmentId", { comparisonRef: "main", computedAt: "now", stats: { additions: 1, deletions: 0, filesChanged: 1, truncated: false } }],
    ["not an object", "nonsense"],
    ["null", null],
  ])("ignores a malformed change event (%s)", async (_label, payload) => {
    renderHook(() => useEnvironmentDiffStats());
    await flush();

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, payload);
    });
    await flush();

    expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);
  });

  // The stream has no replay buffer, so anything that happened while this client
  // was disconnected exists only in the snapshot.
  test("re-reads the snapshot when the event stream reconnects", async () => {
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));

    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-late", { additions: 5, deletions: 5, filesChanged: 2 })],
    }));

    act(() => {
      emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-late")).toEqual({
        additions: 5,
        deletions: 5,
        filesChanged: 2,
        truncated: false,
      });
    });
  });

  test("replays a newer event over a snapshot that resolves later", async () => {
    const snapshot = deferred<{ entries: EnvironmentDiffStatsChange[] }>();
    mockGetEnvironmentDiffStats.mockImplementation(() => snapshot.promise);
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, change("env-1", { additions: 12 }));
    });
    expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(false);

    await act(async () => {
      snapshot.resolve({ entries: [change("env-1", { additions: 2 })] });
      await snapshot.promise;
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.additions).toBe(12);
  });

  test("replays a removal over a snapshot that resolves later", async () => {
    const snapshot = deferred<{ entries: EnvironmentDiffStatsChange[] }>();
    mockGetEnvironmentDiffStats.mockImplementation(() => snapshot.promise);
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));

    act(() => {
      emitEvent(DIFF_STATS_CHANGED_EVENT, removal("env-1"));
    });
    await act(async () => {
      snapshot.resolve({ entries: [change("env-1")] });
      await snapshot.promise;
    });

    expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(false);
  });

  test("serialises overlapping reconnect snapshots and applies the newest last", async () => {
    mockGetEnvironmentDiffStats.mockImplementationOnce(() => Promise.resolve({ entries: [] }));
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));

    const first = deferred<{ entries: EnvironmentDiffStatsChange[] }>();
    const second = deferred<{ entries: EnvironmentDiffStatsChange[] }>();
    mockGetEnvironmentDiffStats
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    act(() => emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined));
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(2));
    act(() => emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined));
    expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({ entries: [change("env-1", { additions: 1 })] });
      await first.promise;
    });
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(3));

    await act(async () => {
      second.resolve({ entries: [change("env-1", { additions: 9 })] });
      await second.promise;
    });
    expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.additions).toBe(9);
  });

  test("drops environments missing from a later snapshot", async () => {
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-1"), change("env-2")],
    }));
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(useEnvironmentDiffStore.getState().stats.size).toBe(2));

    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-1")],
    }));
    act(() => {
      emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    });

    await waitFor(() => {
      expect([...useEnvironmentDiffStore.getState().stats.keys()]).toEqual(["env-1"]);
    });
  });

  test("keeps existing stats when the snapshot request fails", async () => {
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({ entries: [change("env-1")] }));
    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(useEnvironmentDiffStore.getState().stats.size).toBe(1));

    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.reject(new Error("backend down")));
    act(() => {
      emitEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    });
    await flush();

    expect(useEnvironmentDiffStore.getState().stats.get("env-1")).toBeDefined();
  });

  test("ignores a malformed snapshot from the process boundary", async () => {
    useEnvironmentDiffStore.getState().applyChange(change("env-existing"));
    mockGetEnvironmentDiffStats.mockImplementation(
      () => Promise.resolve({
        entries: [change("env-bad", { additions: -1 })],
      }),
    );

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));
    await flush();

    expect([...useEnvironmentDiffStore.getState().stats.keys()]).toEqual(["env-existing"]);
  });

  test("still rehydrates when the change listener rejects", async () => {
    mockListen.mockImplementation((event, handler) => {
      if (event === DIFF_STATS_CHANGED_EVENT) return Promise.reject(new Error("listen failed"));
      return defaultListen(event, handler);
    });
    mockGetEnvironmentDiffStats.mockImplementation(() => Promise.resolve({
      entries: [change("env-1")],
    }));

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(true));
    expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(1);
  });

  test("cleans up the first listener when the reconnect listener rejects", async () => {
    mockListen.mockImplementation((event, handler) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
        return Promise.reject(new Error("listen failed"));
      }
      return defaultListen(event, handler);
    });
    const { unmount } = renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(1));

    unmount();

    expect(listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(0);
  });

  test("unsubscribes from both streams on unmount", async () => {
    const { unmount } = renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => {
      expect(listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(1);
      expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(1);
    });

    unmount();

    await waitFor(() => {
      expect(listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(0);
      expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(0);
    });
  });

  // `listen` resolves asynchronously, so an unmount can land before the
  // subscription exists. It still has to be torn down.
  test("does not leak a listener when unmounted before subscribing resolves", async () => {
    const { unmount } = renderHook(() => useEnvironmentDiffStats());
    unmount();
    await flush();

    expect(listenerCount(DIFF_STATS_CHANGED_EVENT)).toBe(0);
    expect(listenerCount(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(0);
  });

  test("does not write a snapshot that resolves after unmount", async () => {
    let resolveSnapshot: (value: { entries: EnvironmentDiffStatsChange[] }) => void = () => {};
    mockGetEnvironmentDiffStats.mockImplementation(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    const { unmount } = renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetEnvironmentDiffStats).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      resolveSnapshot({ entries: [change("env-late")] });
      await Promise.resolve();
    });

    expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);
  });
});
