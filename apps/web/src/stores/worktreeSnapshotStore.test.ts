import { afterEach, describe, expect, test } from "bun:test";
import type { WorktreeSnapshotState } from "@orkestrator/protocol/worktree-snapshots";
import { useWorktreeSnapshotStore } from "./worktreeSnapshotStore";

function entry(overrides: Partial<WorktreeSnapshotState> = {}): WorktreeSnapshotState {
  return {
    environmentId: "env-1",
    targetGeneration: 1,
    comparisonRef: "origin/main",
    fileListRevision: 3,
    treeRevision: 2,
    freshness: "current",
    watched: false,
    ...overrides,
  };
}

afterEach(() => {
  useWorktreeSnapshotStore.setState({ entries: new Map(), generation: null, syncStatus: "idle" });
});

describe("worktreeSnapshotStore remote freshness", () => {
  test("keeps a container's remote freshness from snapshots and changes", () => {
    const store = useWorktreeSnapshotStore.getState();
    store.applySnapshot([entry({ remote: { state: "unknown" } })]);
    expect(useWorktreeSnapshotStore.getState().entries.get("env-1")?.remote).toEqual({
      state: "unknown",
    });

    store.applyChange(
      entry({
        remote: { state: "stale", lastSuccessAt: "2026-10-25T09:30:00.000Z", failure: "network" },
      }),
    );
    expect(useWorktreeSnapshotStore.getState().entries.get("env-1")?.remote).toEqual({
      state: "stale",
      lastSuccessAt: "2026-10-25T09:30:00.000Z",
      failure: "network",
    });
  });

  test("a change in remote freshness alone is applied, an identical one is not", () => {
    const store = useWorktreeSnapshotStore.getState();
    store.applySnapshot([entry({ remote: { state: "current" } })]);
    const before = useWorktreeSnapshotStore.getState().entries;

    store.applySnapshot([entry({ remote: { state: "current" } })]);
    expect(useWorktreeSnapshotStore.getState().entries).toBe(before);

    store.applyChange(entry({ remote: { state: "stale" } }));
    expect(useWorktreeSnapshotStore.getState().entries).not.toBe(before);
    expect(useWorktreeSnapshotStore.getState().entries.get("env-1")?.remote?.state).toBe("stale");
  });

  test("an entry without remote freshness has none", () => {
    useWorktreeSnapshotStore.getState().applySnapshot([entry()]);
    expect(useWorktreeSnapshotStore.getState().entries.get("env-1")).not.toHaveProperty("remote");
  });
});
