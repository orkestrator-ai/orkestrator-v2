import { useEffect } from "react";
import { readViewRevisionStamp, type ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
  isWorktreeSnapshotEvent,
  isWorktreeSnapshotRevisionsSnapshot,
  type WorktreeSnapshotEvent,
  type WorktreeSnapshotRevisionsSnapshot,
  type WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import * as backend from "@/lib/backend";
import {
  createBoundedHydration,
  readViewSnapshot,
  type BoundedHydrationLimits,
  type HydrationClock,
  type HydrationEntry,
  type HydrationFetchResult,
  type HydrationUpdate,
} from "@/lib/bounded-hydration";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { onViewSafetyCheck } from "@/lib/resource-sync";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";

export interface WorktreeSnapshotRevisionsOptions {
  /** Subscribe only while something shows file lists or trees. */
  enabled: boolean;
  /** Test seams; production uses real timers and default bounds. */
  clock?: HydrationClock;
  limits?: Partial<BoundedHydrationLimits>;
}

function toEntries(
  snapshot: WorktreeSnapshotRevisionsSnapshot,
): HydrationEntry<WorktreeSnapshotEvent>[] {
  return snapshot.entries.map((entry) => ({ key: entry.environmentId, value: entry }));
}

/** Reads the revision view, conditionally when a revisioned position is known. */
export function fetchWorktreeSnapshotRevisions(
  known: ViewRevisionStamp | null,
): Promise<HydrationFetchResult<WorktreeSnapshotEvent>> {
  return readViewSnapshot(
    WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
    () => backend.getWorktreeSnapshotRevisions(known ?? undefined),
    isWorktreeSnapshotRevisionsSnapshot,
    toEntries,
  );
}

export function toWorktreeSnapshotUpdate(
  event: WorktreeSnapshotEvent,
): HydrationUpdate<WorktreeSnapshotEvent> {
  const stamp = readViewRevisionStamp(event, "event");
  return {
    key: event.environmentId,
    value: event,
    // Validated by isWorktreeSnapshotEvent, so never "invalid" here.
    stamp: stamp === "invalid" ? null : stamp,
  };
}

/**
 * Mirrors the backend's worktree snapshot revisions into
 * `useWorktreeSnapshotStore` while `enabled`.
 *
 * Subscribe-before-snapshot through the bounded hydration controller (see
 * `docs/architecture/event-snapshot-recovery.md`): events that land during a
 * snapshot are coalesced per environment within fixed bounds, gaps and
 * generation changes trigger conditional reads, and the resource-sync safety
 * cadence runs one compact read every five minutes. A backend without the
 * command is `unsupported`, and the Files panel keeps its polling.
 */
export function useWorktreeSnapshotRevisions(options: WorktreeSnapshotRevisionsOptions) {
  const applySnapshot = useWorktreeSnapshotStore((state) => state.applySnapshot);
  const applyChange = useWorktreeSnapshotStore((state) => state.applyChange);
  const setSyncStatus = useWorktreeSnapshotStore((state) => state.setSyncStatus);
  const setGeneration = useWorktreeSnapshotStore((state) => state.setGeneration);
  const { enabled, clock, limits } = options;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    // The generation of the snapshot about to be applied; revisions of
    // different generations are unrelated, so the store records it too.
    let fetchedGeneration: string | null = null;

    const hydration = createBoundedHydration<WorktreeSnapshotEvent>({
      name: "worktree-snapshot-revisions",
      fetchSnapshot: async ({ known }) => {
        const result = await fetchWorktreeSnapshotRevisions(known);
        if (result.kind === "snapshot") fetchedGeneration = result.stamp?.generation ?? null;
        return result;
      },
      replaceAll: (entries) => {
        setGeneration(fetchedGeneration);
        applySnapshot(
          entries
            .map((entry) => entry.value)
            .filter((value): value is WorktreeSnapshotState => !("removed" in value)),
        );
      },
      applyUpdate: (_environmentId, event) => {
        if (!event) return;
        if (event.generation) setGeneration(event.generation);
        applyChange(event);
      },
      onStatusChange: setSyncStatus,
      clock,
      limits,
    });

    const subscribe = async () => {
      try {
        const stop = await listen<unknown>(WORKTREE_SNAPSHOT_CHANGED_EVENT, (event) => {
          // Crosses a process boundary and drives reads: validate, never trust.
          if (!isWorktreeSnapshotEvent(event.payload)) return;
          hydration.receive(toWorktreeSnapshotUpdate(event.payload));
        });
        if (disposed) stop();
        else unlisteners.push(stop);
      } catch {
        // The snapshot and the panel's polling still work without events.
      }
      if (disposed) return;
      try {
        const stopReconnects = await listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
          hydration.onReconnect();
        });
        if (disposed) stopReconnects();
        else unlisteners.push(stopReconnects);
      } catch {
        // Remounting retries the listener.
      }
      if (disposed) return;
      unlisteners.push(onViewSafetyCheck(() => hydration.safetyCheck()));
      hydration.request("initial");
    };

    void subscribe();

    return () => {
      disposed = true;
      hydration.dispose();
      for (const unlisten of unlisteners) unlisten();
    };
  }, [enabled, applySnapshot, applyChange, setSyncStatus, setGeneration, clock, limits]);
}
