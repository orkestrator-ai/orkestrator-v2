import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  type WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import * as backend from "@/lib/backend";
import * as nativeEvents from "@/lib/native/events";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { useEnvironmentStore, useFilesPanelStore, useUIStore } from "@/stores";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import type { Environment } from "@/types";
import { isAnnouncedNewer, useFilesPanel } from "./useFilesPanel";

/**
 * The Files panel's event-led reads over the backend's worktree snapshot
 * revisions: an announced revision newer than what the panel shows re-reads
 * exactly that view; duplicates, hidden documents and legacy backends do not.
 */

const callbacks = new Map<string, (event: { payload: unknown }) => void>();
let spies: Array<ReturnType<typeof spyOn>> = [];
let listRevision = 1;
let treeRevision = 1;
let targetGeneration = 1;
let legacy = false;

const stamp = (revision: number) => ({
  generation: "gen-1",
  environmentId: "env-1",
  targetGeneration,
  revision,
  freshness: "current" as const,
  watched: true,
});

const announced = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "env-1",
  targetGeneration,
  comparisonRef: "main",
  fileListRevision: listRevision,
  treeRevision,
  freshness: "current",
  watched: true,
  ...overrides,
});

let eventRevision = 1;
function announce(overrides: Record<string, unknown> = {}) {
  eventRevision += 1;
  act(() => {
    callbacks.get(WORKTREE_SNAPSHOT_CHANGED_EVENT)?.({
      payload: { ...announced(overrides), generation: "gen-1", revision: eventRevision },
    });
  });
}

let listSpy: ReturnType<typeof spyOn>;
let treeSpy: ReturnType<typeof spyOn>;
let revisionsSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  callbacks.clear();
  listRevision = 1;
  treeRevision = 1;
  targetGeneration = 1;
  eventRevision = 1;
  legacy = false;
  useWorktreeSnapshotStore.setState({ entries: new Map(), generation: null, syncStatus: "idle" });
  useUIStore.setState({ selectedEnvironmentId: "env-1" });
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        environmentType: "local",
        worktreePath: "/worktree",
        status: "running",
      } as Environment,
    ],
  });
  useFilesPanelStore.setState({ isOpen: true, activeTab: "changes", changes: [], fileTree: [] });
  spies = [
    spyOn(nativeEvents, "listen").mockImplementation(async (event, callback) => {
      callbacks.set(event, callback as (event: { payload: unknown }) => void);
      return mock(() => undefined);
    }),
  ];
  listSpy = spyOn(backend, "getLocalGitStatusSnapshot").mockImplementation(async () => ({
    unchanged: false,
    digest: `list-${targetGeneration}-${listRevision}`,
    value: [
      {
        path: `file-${listRevision}.ts`,
        filename: `file-${listRevision}.ts`,
        directory: "",
        additions: 1,
        deletions: 0,
        status: "M",
      },
    ],
    ...(legacy ? {} : { view: stamp(listRevision) }),
  }));
  treeSpy = spyOn(backend, "getLocalFileTreeSnapshot").mockImplementation(async () => ({
    unchanged: false,
    digest: `tree-${treeRevision}`,
    value: [{ name: `dir-${treeRevision}`, path: `dir-${treeRevision}`, isDirectory: true }],
    ...(legacy ? {} : { view: stamp(treeRevision) }),
  }));
  revisionsSpy = spyOn(backend, "getWorktreeSnapshotRevisions").mockImplementation(async () => {
    if (legacy) throw new Error("Unknown backend command: get_worktree_snapshot_revisions");
    return { entries: [announced() as WorktreeSnapshotState], generation: "gen-1", revision: 1 };
  });
  spies.push(listSpy, treeSpy, revisionsSpy);
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  for (const spy of spies) spy.mockRestore();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

describe("useFilesPanel worktree snapshot revisions", () => {
  test("an announced list revision re-reads the list once, even with identical counts", async () => {
    renderHook(() => useFilesPanel());
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(1);

    listRevision = 2;
    announce();
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(useFilesPanelStore.getState().changes.map((change) => change.path)).toEqual([
      "file-2.ts",
    ]);

    // A duplicate or already-applied announcement reads nothing.
    announce();
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(2);
    // The changes tab never reads the tree.
    expect(treeSpy).not.toHaveBeenCalled();
  });

  test("a tree revision re-reads only the tree on the all-files tab", async () => {
    useFilesPanelStore.setState({ activeTab: "all-files" });
    renderHook(() => useFilesPanel());
    await flush();
    expect(treeSpy).toHaveBeenCalledTimes(1);
    const listReads = listSpy.mock.calls.length;

    treeRevision = 2;
    announce();
    await flush();
    expect(treeSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenCalledTimes(listReads);
    expect(useFilesPanelStore.getState().fileTree.map((node) => node.path)).toEqual(["dir-2"]);
  });

  test("a retargeted lineage is re-read even at a lower revision", async () => {
    renderHook(() => useFilesPanel());
    await flush();
    targetGeneration = 2;
    listRevision = 1;
    announce();
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  test("a hidden document leaves announced reads to the coordinator's return", async () => {
    renderHook(() => useFilesPanel());
    await flush();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    listRevision = 2;
    announce();
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  test("a manual refresh asks the backend for a post-click observation", async () => {
    const { result } = renderHook(() => useFilesPanel());
    await flush();
    await act(async () => {
      await result.current.refresh();
    });
    expect(listSpy.mock.calls.at(-1)).toEqual(["/worktree", "main", "list-1-1", { refresh: true }]);
  });

  test("a legacy backend (no stamps, no revisions command) keeps polling only", async () => {
    legacy = true;
    renderHook(() => useFilesPanel());
    await flush();
    expect(useWorktreeSnapshotStore.getState().syncStatus).toBe("unsupported");
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  test("an unchanged read with the same stamp does not rewrite the store", async () => {
    renderHook(() => useFilesPanel());
    await flush();
    const before = useFilesPanelStore.getState().changes;
    listSpy.mockImplementation(async () => ({
      unchanged: true,
      digest: "list-1-1",
      view: stamp(1),
    }));
    listRevision = 1;
    announce({ freshness: "stale" }); // state moved, revisions did not
    await flush();
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(useFilesPanelStore.getState().changes).toBe(before);
  });
});

describe("isAnnouncedNewer", () => {
  const applied = { ...stamp(3), targetGeneration: 1 };
  test("compares within one owner generation and lineage only", () => {
    expect(isAnnouncedNewer({ targetGeneration: 1, revision: 3 }, "gen-1", applied)).toBe(false);
    expect(isAnnouncedNewer({ targetGeneration: 1, revision: 4 }, "gen-1", applied)).toBe(true);
    expect(isAnnouncedNewer({ targetGeneration: 2, revision: 1 }, "gen-1", applied)).toBe(true);
    expect(isAnnouncedNewer({ targetGeneration: 1, revision: 1 }, "gen-2", applied)).toBe(true);
    expect(isAnnouncedNewer({ targetGeneration: 1, revision: 9 }, "gen-1", undefined)).toBe(false);
    expect(isAnnouncedNewer({ targetGeneration: 1, revision: 9 }, null, applied)).toBe(false);
  });
});
