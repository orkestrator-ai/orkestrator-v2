import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DIFF_STATS_CHANGED_EVENT } from "@orkestrator/protocol/diff-stats";
import * as backend from "@/lib/backend";
import * as nativeEvents from "@/lib/native/events";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import { useEnvironmentDiffStats } from "./useEnvironmentDiffStats";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
};

const callbacks = new Map<string, (event: { payload: unknown }) => void>();
let listenSpy: ReturnType<typeof spyOn>;
let snapshotSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  callbacks.clear();
  useEnvironmentDiffStore.setState({ stats: new Map() });
  listenSpy = spyOn(nativeEvents, "listen").mockImplementation(async (event, callback) => {
    callbacks.set(event, callback as (event: { payload: unknown }) => void);
    return mock(() => undefined);
  });
  snapshotSpy = spyOn(backend, "getEnvironmentDiffStats");
});

afterEach(() => {
  cleanup();
  listenSpy.mockRestore();
  snapshotSpy.mockRestore();
  useEnvironmentDiffStore.setState({ stats: new Map() });
});

describe("useEnvironmentDiffStats", () => {
  test("replays buffered changes after every overlapping reconnect snapshot", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    snapshotSpy
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({ payload: undefined });
      callbacks.get(DIFF_STATS_CHANGED_EVENT)?.({
        payload: {
          environmentId: "env-1",
          comparisonRef: "main",
          computedAt: "2026-09-15T09:00:00.000Z",
          stats: { additions: 9, deletions: 2, filesChanged: 3, truncated: false },
        },
      });
    });
    await act(async () => {
      first.resolve({
        entries: [
          {
            environmentId: "env-1",
            comparisonRef: "main",
            computedAt: "2026-09-15T08:00:00.000Z",
            stats: { additions: 1, deletions: 1, filesChanged: 1, truncated: false },
          },
        ],
      });
      await Promise.resolve();
    });
    await act(async () => {
      second.resolve({
        entries: [
          {
            environmentId: "env-1",
            comparisonRef: "main",
            computedAt: "2026-09-15T08:30:00.000Z",
            stats: { additions: 2, deletions: 1, filesChanged: 1, truncated: false },
          },
        ],
      });
      await Promise.resolve();
    });

    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(useEnvironmentDiffStore.getState().stats.get("env-1")).toEqual({
      additions: 9,
      deletions: 2,
      filesChanged: 3,
      truncated: false,
    });
  });

  test("rehydrates again when a reconnect arrives after the snapshot loop exits", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    snapshotSpy
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      first.resolve({ entries: [] });
      await Promise.resolve();
    });
    // The snapshot loop has exited and yielded; fire reconnect before the
    // hook clears `rehydrating` so the follow-up snapshot is not dropped.
    act(() => {
      callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)?.({ payload: undefined });
    });
    await act(async () => {
      await Promise.resolve();
      second.resolve({ entries: [] });
      await Promise.resolve();
    });

    expect(snapshotSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("validates live payloads and detaches both listeners on unmount", async () => {
    snapshotSpy.mockResolvedValue({ entries: [] });
    const unlisteners = [mock(() => undefined), mock(() => undefined)];
    listenSpy.mockImplementation(
      async (event: string, callback: (event: { payload: unknown }) => unknown) => {
        callbacks.set(event, callback as (event: { payload: unknown }) => void);
        return unlisteners[callbacks.size - 1]!;
      },
    );
    const { unmount } = renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => callbacks.get(DIFF_STATS_CHANGED_EVENT)?.({ payload: { environmentId: 7 } }));
    expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);

    unmount();
    expect(unlisteners[0]).toHaveBeenCalledTimes(1);
    expect(unlisteners[1]).toHaveBeenCalledTimes(1);
  });
});

describe("useEnvironmentDiffStats revision-aware recovery", () => {
  const generation = "diff-generation-1";
  const stats = (additions: number) => ({
    additions,
    deletions: 0,
    filesChanged: 1,
    truncated: false,
  });
  const change = (environmentId: string, additions: number, revision?: number) => ({
    environmentId,
    comparisonRef: "main",
    computedAt: "2026-09-24T09:00:00.000Z",
    stats: stats(additions),
    ...(revision === undefined ? {} : { generation, revision }),
  });
  const emitChange = (payload: unknown) =>
    act(() => callbacks.get(DIFF_STATS_CHANGED_EVENT)?.({ payload }));

  test("an older buffered change never overwrites the newer snapshot", async () => {
    const snapshot = deferred<unknown>();
    snapshotSpy.mockImplementationOnce(() => snapshot.promise);
    renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });

    // Emitted before the snapshot was captured (revision 4 <= 5).
    emitChange(change("env-1", 4, 4));
    await act(async () => {
      snapshot.resolve({ entries: [change("env-1", 5)], generation, revision: 5 });
      await Promise.resolve();
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.additions).toBe(5);
    expect(useEnvironmentDiffStore.getState().syncStatus).toBe("current");
  });

  test("an untracked environment's removal does not resurrect from a late change", async () => {
    snapshotSpy.mockResolvedValue({ entries: [change("env-1", 1)], generation, revision: 1 });
    renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(true);

    emitChange({
      environmentId: "env-1",
      comparisonRef: "main",
      computedAt: "2026-09-24T09:01:00.000Z",
      removed: true,
      generation,
      revision: 2,
    });
    emitChange(change("env-1", 9, 2)); // duplicate revision, different body
    emitChange(change("env-1", 9, 1)); // older than the removal

    expect(useEnvironmentDiffStore.getState().stats.has("env-1")).toBe(false);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  test("a revision gap triggers one conditional read from the contiguous position", async () => {
    snapshotSpy.mockResolvedValueOnce({ entries: [], generation, revision: 3 });
    renderHook(() => useEnvironmentDiffStats());
    await act(async () => {
      await Promise.resolve();
    });

    snapshotSpy.mockResolvedValueOnce({
      status: "snapshot",
      generation,
      revision: 6,
      snapshot: { entries: [change("env-1", 5), change("env-2", 6)] },
    });
    emitChange(change("env-2", 6, 6)); // revisions 4 and 5 were missed
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(snapshotSpy.mock.calls[1]?.[0]).toEqual({ generation, revision: 3 });
    expect(useEnvironmentDiffStore.getState().stats.get("env-1")?.additions).toBe(5);
    expect(useEnvironmentDiffStore.getState().stats.get("env-2")?.additions).toBe(6);
  });
});
