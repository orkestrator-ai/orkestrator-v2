import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  type WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import * as backend from "@/lib/backend";
import * as nativeEvents from "@/lib/native/events";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import { useWorktreeSnapshotRevisions } from "./useWorktreeSnapshotRevisions";

const callbacks = new Map<string, (event: { payload: unknown }) => void>();
const order: string[] = [];
let listenSpy: ReturnType<typeof spyOn>;
let snapshotSpy: ReturnType<typeof spyOn>;

const state = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "env-1",
  targetGeneration: 1,
  comparisonRef: "main",
  fileListRevision: 1,
  treeRevision: 0,
  freshness: "current",
  watched: true,
  ...overrides,
});

function resetStore() {
  useWorktreeSnapshotStore.setState({ entries: new Map(), generation: null, syncStatus: "idle" });
}

beforeEach(() => {
  callbacks.clear();
  order.length = 0;
  resetStore();
  listenSpy = spyOn(nativeEvents, "listen").mockImplementation(async (event, callback) => {
    order.push(`listen:${event}`);
    callbacks.set(event, callback as (event: { payload: unknown }) => void);
    return mock(() => undefined);
  });
  snapshotSpy = spyOn(backend, "getWorktreeSnapshotRevisions").mockImplementation(async () => {
    order.push("snapshot");
    return { entries: [state() as WorktreeSnapshotState], generation: "gen-1", revision: 1 };
  });
});

afterEach(() => {
  cleanup();
  listenSpy.mockRestore();
  snapshotSpy.mockRestore();
  resetStore();
});

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

describe("useWorktreeSnapshotRevisions", () => {
  test("subscribes before hydrating and records the owner generation", async () => {
    renderHook(() => useWorktreeSnapshotRevisions({ enabled: true }));
    await flush();

    expect(order.indexOf(`listen:${WORKTREE_SNAPSHOT_CHANGED_EVENT}`)).toBeLessThan(
      order.indexOf("snapshot"),
    );
    const store = useWorktreeSnapshotStore.getState();
    expect(store.generation).toBe("gen-1");
    expect(store.entries.get("env-1")).toMatchObject({ fileListRevision: 1 });
    expect(store.syncStatus).toBe("current");
  });

  test("applies a stamped change, ignores invalid payloads and keeps identical state", async () => {
    renderHook(() => useWorktreeSnapshotRevisions({ enabled: true }));
    await flush();
    const emit = callbacks.get(WORKTREE_SNAPSHOT_CHANGED_EVENT)!;

    act(() =>
      emit({ payload: { ...state({ fileListRevision: 2 }), generation: "gen-1", revision: 2 } }),
    );
    const afterChange = useWorktreeSnapshotStore.getState().entries;
    expect(afterChange.get("env-1")).toMatchObject({ fileListRevision: 2 });

    act(() =>
      emit({ payload: { ...state({ freshness: "bogus" }), generation: "gen-1", revision: 3 } }),
    );
    expect(useWorktreeSnapshotStore.getState().entries).toBe(afterChange);

    act(() =>
      emit({
        payload: { environmentId: "env-1", removed: true, generation: "gen-1", revision: 3 },
      }),
    );
    expect(useWorktreeSnapshotStore.getState().entries.has("env-1")).toBe(false);
  });

  test("an older backend without the command is unsupported, not retried", async () => {
    snapshotSpy.mockImplementation(async () => {
      throw new Error("Unknown backend command: get_worktree_snapshot_revisions");
    });
    renderHook(() => useWorktreeSnapshotRevisions({ enabled: true }));
    await flush();
    expect(useWorktreeSnapshotStore.getState().syncStatus).toBe("unsupported");
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  test("does nothing while disabled", async () => {
    renderHook(() => useWorktreeSnapshotRevisions({ enabled: false }));
    await flush();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  test("an identical rehydrate keeps every entry object", async () => {
    const { rerender } = renderHook(({ enabled }) => useWorktreeSnapshotRevisions({ enabled }), {
      initialProps: { enabled: true },
    });
    await flush();
    const entry = useWorktreeSnapshotStore.getState().entries.get("env-1");
    rerender({ enabled: false });
    rerender({ enabled: true });
    await flush();
    expect(useWorktreeSnapshotStore.getState().entries.get("env-1")).toBe(entry);
  });
});
