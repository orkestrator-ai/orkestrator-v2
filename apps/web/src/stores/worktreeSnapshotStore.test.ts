import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeSnapshotState } from "@orkestrator/protocol/worktree-snapshots";
import type { StoreApi } from "zustand/vanilla";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { worktreeSnapshotStore, type WorktreeSnapshotStoreState } from "./worktreeSnapshotStore";

// Each test names its node scope, as converted code does (plan item 3003).
let windowScope: WindowScope;
let snapshots: StoreApi<WorktreeSnapshotStoreState>;

beforeEach(() => {
  windowScope = new WindowScope();
  snapshots = windowScope
    .open({ role: "command", client: new FakeNodeClient() })
    .store(worktreeSnapshotStore);
});

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

afterEach(() => windowScope.dispose());

describe("worktreeSnapshotStore remote freshness", () => {
  test("keeps a container's remote freshness from snapshots and changes", () => {
    const store = snapshots.getState();
    store.applySnapshot([entry({ remote: { state: "unknown" } })]);
    expect(snapshots.getState().entries.get("env-1")?.remote).toEqual({
      state: "unknown",
    });

    store.applyChange(
      entry({
        remote: { state: "stale", lastSuccessAt: "2026-10-25T09:30:00.000Z", failure: "network" },
      }),
    );
    expect(snapshots.getState().entries.get("env-1")?.remote).toEqual({
      state: "stale",
      lastSuccessAt: "2026-10-25T09:30:00.000Z",
      failure: "network",
    });
  });

  test("a change in remote freshness alone is applied, an identical one is not", () => {
    const store = snapshots.getState();
    store.applySnapshot([entry({ remote: { state: "current" } })]);
    const before = snapshots.getState().entries;

    store.applySnapshot([entry({ remote: { state: "current" } })]);
    expect(snapshots.getState().entries).toBe(before);

    store.applyChange(entry({ remote: { state: "stale" } }));
    expect(snapshots.getState().entries).not.toBe(before);
    expect(snapshots.getState().entries.get("env-1")?.remote?.state).toBe("stale");
  });

  test("an entry without remote freshness has none", () => {
    snapshots.getState().applySnapshot([entry()]);
    expect(snapshots.getState().entries.get("env-1")).not.toHaveProperty("remote");
  });
});
