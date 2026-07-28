import { useEffect } from "react";
import {
  DIFF_STATS_CHANGED_EVENT,
  isEnvironmentDiffStatsEvent,
  isEnvironmentDiffStatsSnapshot,
  type EnvironmentDiffStatsEvent,
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
    let rehydrating = false;
    let rehydrateRequested = false;
    let bufferedEvents: EnvironmentDiffStatsEvent[] = [];

    // The event stream has no replay buffer, so anything that happened while
    // this client was disconnected is only recoverable from the snapshot. This
    // runs after subscribing on mount and again on every reconnect. Events are
    // buffered while a snapshot is in flight, then replayed over it: applying
    // the snapshot last could otherwise overwrite a newer live update.
    const requestRehydrate = () => {
      rehydrateRequested = true;
      if (rehydrating || disposed) return;
      rehydrating = true;

      void (async () => {
        try {
          // Reconnects may overlap a slow snapshot. Serialising requests keeps
          // an older response from landing after a newer one; a reconnect that
          // arrives mid-request causes one more pass through the loop.
          while (!disposed && rehydrateRequested) {
            rehydrateRequested = false;

            try {
              const snapshot: unknown = await backend.getEnvironmentDiffStats();
              if (!disposed && isEnvironmentDiffStatsSnapshot(snapshot)) {
                applySnapshot(snapshot.entries);
              }
            } catch {
              // Non-critical: buffered changes still apply below, and the next
              // reconnect will request another authoritative snapshot.
            }

            if (disposed) return;
            const pending = bufferedEvents;
            bufferedEvents = [];
            for (const event of pending) applyChange(event);
          }
        } finally {
          rehydrating = false;
        }
      })();
    };

    const subscribe = async () => {
      try {
        const stopChanges = await listen<unknown>(DIFF_STATS_CHANGED_EVENT, (event) => {
          // The payload crosses a process boundary and is the only thing
          // driving the badge, so it is validated rather than trusted.
          if (!isEnvironmentDiffStatsEvent(event.payload)) return;
          if (rehydrating) {
            bufferedEvents.push(event.payload);
          } else {
            applyChange(event.payload);
          }
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
          requestRehydrate();
        });
        if (disposed) stopReconnects();
        else unlisteners.push(stopReconnects);
      } catch {
        // The initial snapshot still runs. Remounting retries the listener.
      }

      if (!disposed) requestRehydrate();
    };

    void subscribe();

    return () => {
      disposed = true;
      bufferedEvents = [];
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applySnapshot, applyChange]);
}
