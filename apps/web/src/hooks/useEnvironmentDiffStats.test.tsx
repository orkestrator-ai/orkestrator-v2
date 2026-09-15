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
