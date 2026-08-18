/**
 * PR Monitor subscriber hook. Mount once at the app root.
 *
 * The polling loop used to live here: a 1-second tick that only ever watched
 * the active environment, with mode requests in a renderer store that a reload
 * erased. The backend owns all of that now (`apps/backend/src/core/pr-monitor.ts`)
 * — it monitors every environment with a PR or a pending mode request, performs
 * the kanban side effects, and persists PR state. This hook only mirrors the
 * monitor into the store and raises user-facing notifications for transitions.
 *
 * Snapshot + incremental, like useEnvironmentDiffStats: the event stream has no
 * replay buffer, so the authoritative `get_pr_monitor_state` snapshot is read
 * after subscribing on mount and again on every reconnect, with live events
 * buffered while a snapshot is in flight.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import {
  PR_MONITOR_CHANGED_EVENT,
  isPrMonitorEvent,
  isPrMonitorSnapshot,
  type PrMonitorEvent,
} from "@orkestrator/protocol/pr-monitor";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { useEnvironmentStore } from "@/stores";
import * as backend from "@/lib/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";

export function usePrMonitorService(): void {
  const applySnapshot = usePrMonitorStore((s) => s.applySnapshot);
  const applyEvent = usePrMonitorStore((s) => s.applyEvent);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    let stopChanges: UnlistenFn | null = null;
    let changeSubscriptionPending = false;
    let rehydrating = false;
    let rehydrateRequested = false;
    let bufferedEvents: PrMonitorEvent[] = [];
    // Transitions already announced to the user. Effect-lifetime rather than
    // per-event because the backend may legitimately re-emit a transition (it
    // announces before persisting, and a persist failure retries), and the
    // same merge must not toast twice.
    const notifiedTransitions = new Set<string>();

    const handleEvent = (event: PrMonitorEvent) => {
      applyEvent(event);
      if ("removed" in event) return;
      const transition = event.transition;
      if (!transition || transition.state !== "merged") return;
      const key = [event.environmentId, transition.url, transition.state].join("\0");
      if (notifiedTransitions.has(key)) return;
      notifiedTransitions.add(key);
      const environment = useEnvironmentStore.getState().getEnvironmentById(event.environmentId);
      toast.success("Branch merged", {
        description: environment?.branch,
        id: `branch-merged-${event.environmentId}`,
      });
    };

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
              const snapshot: unknown = await backend.getPrMonitorState();
              if (!disposed && isPrMonitorSnapshot(snapshot)) {
                applySnapshot(snapshot.entries);
              }
            } catch {
              // Non-critical: buffered changes still apply below, and the next
              // reconnect will request another authoritative snapshot.
            }

            if (disposed) return;
            const pending = bufferedEvents;
            bufferedEvents = [];
            // Replayed over the snapshot so an update that raced the request
            // is not overwritten — and so a transition that arrived mid-flight
            // still notifies.
            for (const event of pending) handleEvent(event);
          }
        } finally {
          rehydrating = false;
        }
      })();
    };

    const ensureChangeSubscription = async () => {
      if (disposed || stopChanges || changeSubscriptionPending) return;
      changeSubscriptionPending = true;
      try {
        const stop = await listen<unknown>(PR_MONITOR_CHANGED_EVENT, (event) => {
          // The payload crosses a process boundary; validate rather than trust.
          if (!isPrMonitorEvent(event.payload)) return;
          if (rehydrating) {
            bufferedEvents.push(event.payload);
          } else {
            handleEvent(event.payload);
          }
        });
        if (disposed) stop();
        else stopChanges = stop;
      } catch {
        // A snapshot remains useful when native event subscription is
        // temporarily unavailable. Reconnect will retry this listener.
      } finally {
        changeSubscriptionPending = false;
      }
    };

    const subscribe = async () => {
      await ensureChangeSubscription();

      if (disposed) return;

      try {
        const stopReconnects = await listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
          void ensureChangeSubscription();
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
      stopChanges?.();
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applySnapshot, applyEvent]);
}
