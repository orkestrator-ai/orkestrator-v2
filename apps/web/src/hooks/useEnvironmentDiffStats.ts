import { useEffect } from "react";
import { environmentDiffStatsChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
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
import type { UnlistenFn } from "@/lib/native/events";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { appCommandScope, listenInScope, onReconnectInScope } from "@/lib/node-scope-slots";
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

/**
 * Reads `scope`'s diff-stat view, conditionally when a revisioned position is
 * known. The app's command scope keeps the `@/lib/backend` read suites spy on.
 */
export function fetchEnvironmentDiffStatsView(
  known: ViewRevisionStamp | null,
  scope: NodeScope = appCommandScope(),
) {
  return readViewSnapshot(
    () =>
      backendApiForScope(scope, createFilesSessionsApi, {
        getEnvironmentDiffStats: backend.getEnvironmentDiffStats,
      }).getEnvironmentDiffStats(known ?? undefined),
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
 * fixed bounds and applied only when newer than the snapshot's revision.
 *
 * Mount it once, at the sidebar level.
 */
export function useEnvironmentDiffStats(options: EnvironmentDiffStatsOptions = {}) {
  const applySnapshot = useEnvironmentDiffStore((s) => s.applySnapshot);
  const applyChange = useEnvironmentDiffStore((s) => s.applyChange);
  const setSyncStatus = useEnvironmentDiffStore((s) => s.setSyncStatus);
  const { clock, limits } = options;
  // The node whose worktrees these counts are, read and followed through its
  // own client (plan item 3003).
  const scope = useNodeScope();

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    // Values are whole events: a removal is kept as the backend's removal
    // (with its comparison ref) rather than reconstructed from a key.
    const hydration = createBoundedHydration<EnvironmentDiffStatsEvent>({
      name: "environment-diff-stats",
      fetchSnapshot: ({ known }) => fetchEnvironmentDiffStatsView(known, scope),
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
        const stopChanges = await listenInScope(
          scope,
          environmentDiffStatsChangedEvent,
          (payload) => {
            // The payload crosses a process boundary and is the only thing
            // driving the badge, so it is validated rather than trusted.
            if (!isEnvironmentDiffStatsEvent(payload)) return;
            hydration.receive(toEnvironmentDiffStatsUpdate(payload));
          },
        );
        if (disposed) stopChanges();
        else unlisteners.push(stopChanges);
      } catch {
        // A snapshot remains useful when native event subscription is
        // temporarily unavailable.
      }

      if (disposed) return;

      try {
        const stopReconnects = await onReconnectInScope(scope, () => {
          hydration.onReconnect();
        });
        if (disposed) stopReconnects();
        else unlisteners.push(stopReconnects);
      } catch {
        // The initial snapshot still runs. Remounting retries the listener.
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
  }, [applySnapshot, applyChange, setSyncStatus, clock, limits, scope]);
}
