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
 * Snapshot + incremental through the bounded hydration controller
 * (`@/lib/bounded-hydration`): subscribe first, then hydrate; updates that land
 * while a snapshot is in flight are held per environment within fixed bounds
 * and applied only when newer than the snapshot's revision. Reconnects fence
 * in-flight reads, and the resource-sync safety cadence runs a compact
 * conditional check that normally answers `unchanged` without a body.
 *
 * State convergence and notifications are separate contracts. The store always
 * converges to the backend's announced state. The "Branch merged" toast is
 * best-effort: it is raised for merged transitions this client observes, after
 * their state is applied, deduplicated per (environment, PR URL, state) in a
 * bounded set so a re-delivered or retried transition never toasts twice and a
 * replacement PR (new URL) still does. Transitions announced while this client
 * was disconnected are not replayed; the current PR state still is.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { prMonitorChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  isPrMonitorEvent,
  isPrMonitorSnapshot,
  type PrMonitorEnvironmentState,
  type PrMonitorEvent,
  type PrMonitorSnapshot,
} from "@orkestrator/protocol/pr-monitor";
import { readViewRevisionStamp, type ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { environmentStore } from "@/stores";
import * as backend from "@/lib/backend";
import {
  BoundedKeySet,
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
import { playConfiguredNotificationSound } from "@/lib/notification-sounds";

/** Merged-transition keys remembered for deduplication. */
export const PR_TRANSITION_DEDUPE_LIMIT = 256;

export interface PrMonitorServiceOptions {
  /** Test seams; production uses real timers and default bounds. */
  clock?: HydrationClock;
  limits?: Partial<BoundedHydrationLimits>;
}

function toEntries(snapshot: PrMonitorSnapshot): HydrationEntry<PrMonitorEnvironmentState>[] {
  return snapshot.entries.map((entry) => ({ key: entry.environmentId, value: entry }));
}

/**
 * Reads `scope`'s PR monitor view, conditionally when a revisioned position is
 * known. The app's command scope keeps the `@/lib/backend` read suites spy on.
 */
export function fetchPrMonitorView(
  known: ViewRevisionStamp | null,
  scope: NodeScope = appCommandScope(),
) {
  return readViewSnapshot(
    "get_pr_monitor_state",
    () =>
      backendApiForScope(scope, createFilesSessionsApi, {
        getPrMonitorState: backend.getPrMonitorState,
      }).getPrMonitorState(known ?? undefined),
    isPrMonitorSnapshot,
    toEntries,
  );
}

export function toPrMonitorUpdate(
  event: PrMonitorEvent,
): HydrationUpdate<PrMonitorEnvironmentState> {
  const stamp = readViewRevisionStamp(event, "event");
  return {
    key: event.environmentId,
    value: "removed" in event ? null : event.state,
    // Validated by isPrMonitorEvent, so never "invalid" here.
    stamp: stamp === "invalid" ? null : stamp,
  };
}

export function usePrMonitorService(options: PrMonitorServiceOptions = {}): void {
  const applySnapshot = usePrMonitorStore((s) => s.applySnapshot);
  const applyEvent = usePrMonitorStore((s) => s.applyEvent);
  const setSyncStatus = usePrMonitorStore((s) => s.setSyncStatus);
  const { clock, limits } = options;
  // The node whose monitor this mirrors, read and followed through its own
  // client, and whose environments name the merged branches (plan item 3003).
  const scope = useNodeScope();

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    let stopChanges: UnlistenFn | null = null;
    let changeSubscriptionPending = false;
    // Effect-lifetime rather than per-event because an event can be delivered
    // twice (replay plus live, or a transition re-announced after a failed
    // persist), and the same merge must not toast twice. Bounded: old keys are
    // evicted first, and a PR URL is merged at most once in practice.
    const notifiedTransitions = new BoundedKeySet(PR_TRANSITION_DEDUPE_LIMIT);

    const hydration = createBoundedHydration<PrMonitorEnvironmentState>({
      name: "pr-monitor",
      fetchSnapshot: ({ known }) => fetchPrMonitorView(known, scope),
      replaceAll: (entries) => applySnapshot(entries.map((entry) => entry.value)),
      applyUpdate: (environmentId, state) =>
        applyEvent(state ? { environmentId, state } : { environmentId, removed: true }),
      onStatusChange: setSyncStatus,
      clock,
      limits,
    });

    const announceMerge = (event: PrMonitorEvent) => {
      if ("removed" in event) return;
      const transition = event.transition;
      if (!transition || transition.state !== "merged") return;
      const key = [event.environmentId, transition.url, transition.state].join("\0");
      if (!notifiedTransitions.add(key)) return;
      const environment = scope
        .store(environmentStore)
        .getState()
        .getEnvironmentById(event.environmentId);
      toast.success("Branch merged", {
        description: environment?.branch,
        id: `branch-merged-${event.environmentId}`,
      });
      void playConfiguredNotificationSound("pr-merged");
    };

    const ensureChangeSubscription = async () => {
      if (disposed || stopChanges || changeSubscriptionPending) return;
      changeSubscriptionPending = true;
      try {
        const stop = await listenInScope(scope, prMonitorChangedEvent, (event) => {
          // The payload crosses a process boundary; validate rather than trust.
          if (!isPrMonitorEvent(event)) return;
          const payload = event;
          const hasMerge = !("removed" in payload) && payload.transition?.state === "merged";
          hydration.receive(
            toPrMonitorUpdate(payload),
            hasMerge ? () => announceMerge(payload) : undefined,
          );
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
      // Subscribe before the snapshot so nothing announced after its capture
      // can fall between the two.
      await ensureChangeSubscription();

      if (disposed) return;

      try {
        const stopReconnects = await onReconnectInScope(scope, () => {
          void ensureChangeSubscription();
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
      stopChanges?.();
      for (const unlisten of unlisteners) unlisten();
    };
  }, [applySnapshot, applyEvent, setSyncStatus, clock, limits, scope]);
}
