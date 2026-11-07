import { useEffect } from "react";
import { readViewRevisionStamp, type ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { worktreeSnapshotChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
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
import type { UnlistenFn } from "@/lib/native/events";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { appCommandScope, listenInScope, onReconnectInScope } from "@/lib/node-scope-slots";
import { onViewSafetyCheck } from "@/lib/resource-sync";
import { useWorktreeSnapshotStore, worktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";

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

/**
 * Reads `scope`'s revision view, conditionally when a revisioned position is
 * known. The app's command scope keeps the `@/lib/backend` read suites spy on.
 */
export function fetchWorktreeSnapshotRevisions(
  known: ViewRevisionStamp | null,
  scope: NodeScope = appCommandScope(),
): Promise<HydrationFetchResult<WorktreeSnapshotEvent>> {
  return readViewSnapshot(
    WORKTREE_SNAPSHOT_REVISIONS_COMMAND,
    () =>
      backendApiForScope(scope, createFilesSessionsApi, {
        getWorktreeSnapshotRevisions: backend.getWorktreeSnapshotRevisions,
      }).getWorktreeSnapshotRevisions(known ?? undefined),
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
  // The node whose worktrees these are, read and followed through its own
  // client (plan item 3003).
  const scope = useShimNodeScope(worktreeSnapshotStore.name);

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
        const result = await fetchWorktreeSnapshotRevisions(known, scope);
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
        const stop = await listenInScope(scope, worktreeSnapshotChangedEvent, (payload) => {
          // Crosses a process boundary and drives reads: validate, never trust.
          if (!isWorktreeSnapshotEvent(payload)) return;
          hydration.receive(toWorktreeSnapshotUpdate(payload));
        });
        if (disposed) stop();
        else unlisteners.push(stop);
      } catch {
        // The snapshot and the panel's polling still work without events.
      }
      if (disposed) return;
      try {
        const stopReconnects = await onReconnectInScope(scope, () => {
          hydration.onReconnect();
        });
        if (disposed) stopReconnects();
        else unlisteners.push(stopReconnects);
      } catch {
        // Remounting retries the listener.
      }
      if (disposed) return;
      unlisteners.push(onViewSafetyCheck(() => hydration.safetyCheck(), scope));
      hydration.request("initial");
    };

    void subscribe();

    return () => {
      disposed = true;
      hydration.dispose();
      for (const unlisten of unlisteners) unlisten();
    };
  }, [enabled, applySnapshot, applyChange, setSyncStatus, setGeneration, clock, limits, scope]);
}
