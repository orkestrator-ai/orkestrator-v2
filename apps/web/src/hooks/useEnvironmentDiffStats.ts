import { useEffect } from "react";
import {
  DIFF_STATS_CHANGED_EVENT,
  isEnvironmentDiffStatsChange,
  type EnvironmentDiffStatsChange,
} from "@orkestrator/protocol/diff-stats";
import { useEnvironmentDiffStore } from "@/stores/environmentDiffStore";
import * as backend from "@/lib/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";

/**
 * Mirrors the backend's diff statistics into the store.
 *
 * This used to compute the counts here: every client shelled out to git for
 * every environment on a fifteen-second timer, so two windows meant two `git
 * fetch`es and two worktree walks for one answer, and the work stopped entirely
 * when the last window closed. The counts are a fact about a worktree rather
 * than about a window, so the backend owns them now and this only listens.
 *
 * Mount it once, at the sidebar level.
 */
export function useEnvironmentDiffStats() {
  const applySnapshot = useEnvironmentDiffStore((s) => s.applySnapshot);
  const applyChange = useEnvironmentDiffStore((s) => s.applyChange);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    // The event stream has no replay buffer, so anything that happened while
    // this client was disconnected is only recoverable from the snapshot. This
    // runs on mount and again on every reconnect.
    const rehydrate = async () => {
      try {
        const snapshot = await backend.getEnvironmentDiffStats();
        if (!disposed) applySnapshot(snapshot.entries);
      } catch {
        // Non-critical: the next change event or reconnect will resynchronise.
      }
    };

    const subscribe = async () => {
      const stopChanges = await listen<unknown>(DIFF_STATS_CHANGED_EVENT, (event) => {
        // The payload crosses a process boundary and is the only thing driving
        // the badge, so it is validated rather than trusted.
        if (!isEnvironmentDiffStatsChange(event.payload)) return;
        applyChange(event.payload as EnvironmentDiffStatsChange);
      });
      const stopReconnects = await listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
        void rehydrate();
      });

      if (disposed) {
        stopChanges();
        stopReconnects();
        return;
      }
      unlisteners.push(stopChanges, stopReconnects);
    };

    void subscribe();
    void rehydrate();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applySnapshot, applyChange]);
}
