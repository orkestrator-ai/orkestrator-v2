import { useEffect } from "react";
import {
  DIFF_STATS_CHANGED_EVENT,
  isEnvironmentDiffStatsEvent,
  isEnvironmentDiffStatsSnapshot,
  type EnvironmentDiffStatsChange,
  type EnvironmentDiffStatsEvent,
  type EnvironmentDiffStatsSnapshot,
} from "@orkestrator/protocol/diff-stats";
import { readViewRevisionStamp, type ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import * as backend from "@/lib/backend";
import {
  createBoundedHydration,
  readViewSnapshot,
  type BoundedHydrationLimits,
  type HydrationClock,
  type HydrationEntry,
  type HydrationUpdate,
} from "@/lib/bounded-hydration";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { onViewSafetyCheck } from "@/lib/resource-sync";

export interface EnvironmentDiffStatsOptions {
  /** Test seams; production uses real timers and default bounds. */
  clock?: HydrationClock;
  limits?: Partial<BoundedHydrationLimits>;
}

function toEntries(
  snapshot: EnvironmentDiffStatsSnapshot,
): HydrationEntry<EnvironmentDiffStatsEvent>[] {
  return snapshot.entries.map((entry) => ({ key: entry.environmentId, value: entry }));
}

/** Reads the diff-stat view, conditionally when a revisioned position is known. */
export function fetchEnvironmentDiffStatsView(known: ViewRevisionStamp | null) {
  return readViewSnapshot(
    "get_environment_diff_stats",
    () => backend.getEnvironmentDiffStats(known ?? undefined),
    isEnvironmentDiffStatsSnapshot,
    toEntries,
  );
}

export function toEnvironmentDiffStatsUpdate(
  event: EnvironmentDiffStatsEvent,
): HydrationUpdate<EnvironmentDiffStatsEvent> {
  const stamp = readViewRevisionStamp(event, "event");
  return {
    key: event.environmentId,
    value: event,
    // Validated by isEnvironmentDiffStatsEvent, so never "invalid" here.
    stamp: stamp === "invalid" ? null : stamp,
  };
}

/**
 * Mirrors the backend's diff statistics into the store.
 *
 * This used to compute the counts here: every client shelled out to git for
 * every environment on a fifteen-second timer, so two windows meant two `git
 * fetch`es and two worktree walks for one answer, and the work stopped entirely
 * when the last window closed. The counts are a fact about a worktree rather
 * than about a window, so the backend owns them now and this only listens.
 *
 * Subscribe-before-snapshot through the bounded hydration controller: changes
 * that land while a snapshot is in flight are coalesced per environment within
 * fixed bounds and applied only when newer than the snapshot's revision (or,
 * for a legacy backend without revisions, replayed over it as before).
 *
 * Mount it once, at the sidebar level.
 */
export function useEnvironmentDiffStats(options: EnvironmentDiffStatsOptions = {}) {
  const applySnapshot = useEnvironmentDiffStore((s) => s.applySnapshot);
  const applyChange = useEnvironmentDiffStore((s) => s.applyChange);
  const setSyncStatus = useEnvironmentDiffStore((s) => s.setSyncStatus);
  const { clock, limits } = options;

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    // Values are whole events: a removal is kept as the backend's removal
    // (with its comparison ref) rather than reconstructed from a key.
    const hydration = createBoundedHydration<EnvironmentDiffStatsEvent>({
      name: "environment-diff-stats",
      fetchSnapshot: ({ known }) => fetchEnvironmentDiffStatsView(known),
      replaceAll: (entries) =>
        applySnapshot(
          entries
            .map((entry) => entry.value)
            .filter((value): value is EnvironmentDiffStatsChange => !("removed" in value)),
        ),
      applyUpdate: (_environmentId, event) => {
        if (event) applyChange(event);
      },
      onStatusChange: setSyncStatus,
      clock,
      limits,
    });

    const subscribe = async () => {
      try {
        const stopChanges = await listen<unknown>(DIFF_STATS_CHANGED_EVENT, (event) => {
          // The payload crosses a process boundary and is the only thing
          // driving the badge, so it is validated rather than trusted.
          if (!isEnvironmentDiffStatsEvent(event.payload)) return;
          hydration.receive(toEnvironmentDiffStatsUpdate(event.payload));
        });
        if (disposed) stopChanges();
        else unlisteners.push(stopChanges);
      } catch {
        // A snapshot remains useful when native event subscription is
        // temporarily unavailable.
      }

      if (disposed) return;

      try {
        const stopReconnects = await listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
          hydration.onReconnect();
        });
        if (disposed) stopReconnects();
        else unlisteners.push(stopReconnects);
      } catch {
        // The initial snapshot still runs. Remounting retries the listener.
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
  }, [applySnapshot, applyChange, setSyncStatus, clock, limits]);
}
