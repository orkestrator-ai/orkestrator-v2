import { create } from "zustand";
import type {
  WorktreeRemoteFreshness,
  WorktreeSnapshotEvent,
  WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import type { HydrationStatus } from "@/lib/bounded-hydration";

/**
 * Mirror of the backend's worktree snapshot revisions: per environment, the
 * file-list and tree revisions the backend's read owner has announced.
 *
 * It holds revisions, never file lists or trees. The Files panel compares
 * them with the revisions of what it last read and re-reads only what moved,
 * so an edit that leaves the diff counts unchanged still refreshes the list.
 */
interface WorktreeSnapshotStoreState {
  entries: Map<string, WorktreeSnapshotState>;
  /** Owner generation of `entries`; revisions of different generations are unrelated. */
  generation: string | null;
  syncStatus: HydrationStatus;
  setSyncStatus: (status: HydrationStatus) => void;
  setGeneration: (generation: string | null) => void;
  /** Replaces the whole map from an authoritative snapshot. */
  applySnapshot: (entries: WorktreeSnapshotState[]) => void;
  /** Applies one announced change or removal. */
  applyChange: (event: WorktreeSnapshotEvent) => void;
}

function sameRemote(
  a: WorktreeRemoteFreshness | undefined,
  b: WorktreeRemoteFreshness | undefined,
): boolean {
  return (
    a?.state === b?.state && a?.lastSuccessAt === b?.lastSuccessAt && a?.failure === b?.failure
  );
}

function sameState(a: WorktreeSnapshotState, b: WorktreeSnapshotState): boolean {
  return (
    a.targetGeneration === b.targetGeneration &&
    a.comparisonRef === b.comparisonRef &&
    a.fileListRevision === b.fileListRevision &&
    a.treeRevision === b.treeRevision &&
    a.freshness === b.freshness &&
    a.watched === b.watched &&
    sameRemote(a.remote, b.remote)
  );
}

function toState(event: WorktreeSnapshotState): WorktreeSnapshotState {
  return {
    environmentId: event.environmentId,
    targetGeneration: event.targetGeneration,
    comparisonRef: event.comparisonRef,
    fileListRevision: event.fileListRevision,
    treeRevision: event.treeRevision,
    freshness: event.freshness,
    watched: event.watched,
    // Container fetch freshness; absent for local worktrees and older backends.
    ...(event.remote
      ? {
          remote: {
            state: event.remote.state,
            ...(event.remote.lastSuccessAt ? { lastSuccessAt: event.remote.lastSuccessAt } : {}),
            ...(event.remote.failure ? { failure: event.remote.failure } : {}),
          },
        }
      : {}),
  };
}

export const useWorktreeSnapshotStore = create<WorktreeSnapshotStoreState>()((set) => ({
  entries: new Map(),
  generation: null,
  syncStatus: "idle",
  setSyncStatus: (syncStatus) =>
    set((state) => (state.syncStatus === syncStatus ? state : { syncStatus })),
  setGeneration: (generation) =>
    set((state) => (state.generation === generation ? state : { generation })),

  applySnapshot: (entries) =>
    set((state) => {
      const next = new Map<string, WorktreeSnapshotState>();
      for (const entry of entries) {
        const existing = state.entries.get(entry.environmentId);
        // Keep the existing object when nothing moved, so selectors do not
        // re-render (or re-read) for an identical rehydrate.
        next.set(
          entry.environmentId,
          existing && sameState(existing, entry) ? existing : toState(entry),
        );
      }
      if (next.size === state.entries.size) {
        let identical = true;
        for (const [environmentId, entry] of next) {
          if (state.entries.get(environmentId) !== entry) {
            identical = false;
            break;
          }
        }
        if (identical) return state;
      }
      return { entries: next };
    }),

  applyChange: (event) =>
    set((state) => {
      if ("removed" in event) {
        if (!state.entries.has(event.environmentId)) return state;
        const next = new Map(state.entries);
        next.delete(event.environmentId);
        return { entries: next };
      }
      const existing = state.entries.get(event.environmentId);
      if (existing && sameState(existing, event)) return state;
      const next = new Map(state.entries);
      next.set(event.environmentId, toState(event));
      return { entries: next };
    }),
}));
