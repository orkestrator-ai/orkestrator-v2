import { create } from "zustand";
import type { PrMonitorEnvironmentState, PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";

export type { PrMonitorEnvironmentState };

/**
 * Read-through mirror of the backend's PR monitor.
 *
 * The polling loop, mode timeouts, error backoff, and kanban side effects all
 * live in the backend (`apps/backend/src/core/pr-monitor.ts`); this store only
 * holds the last announced state per environment so UI (detection spinners,
 * mode badges) can render it. It is rehydrated from the `get_pr_monitor_state`
 * snapshot on mount and reconnect, and patched by `pr-monitor-changed` events
 * in between — the same snapshot+incremental shape as environmentDiffStore.
 */
interface PrMonitorStoreState {
  /** Monitor state keyed by environment ID. */
  states: Map<string, PrMonitorEnvironmentState>;

  /**
   * Replaces the whole map from an authoritative backend snapshot.
   *
   * Whole-map replacement rather than a merge, because the snapshot is the
   * complete truth: an environment absent from it is not monitored, and
   * merging would let one untracked between two rehydrations linger forever.
   */
  applySnapshot: (entries: PrMonitorEnvironmentState[]) => void;
  /** Applies one incremental update or removal announced by the backend. */
  applyEvent: (event: PrMonitorEvent) => void;
  /** Monitor state for one environment, or null when it is not monitored. */
  getMonitoringState: (environmentId: string) => PrMonitorEnvironmentState | null;
}

function isSameState(a: PrMonitorEnvironmentState, b: PrMonitorEnvironmentState): boolean {
  return (
    a.mode === b.mode &&
    a.checkInProgress === b.checkInProgress &&
    a.consecutiveErrors === b.consecutiveErrors &&
    a.lastCheckAt === b.lastCheckAt &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.hasMergeConflicts === b.hasMergeConflicts
  );
}

export const usePrMonitorStore = create<PrMonitorStoreState>()((set, get) => ({
  states: new Map(),

  applySnapshot: (entries) =>
    set((state) => {
      const next = new Map<string, PrMonitorEnvironmentState>();
      for (const entry of entries) next.set(entry.environmentId, entry);

      // Skip the update when nothing moved, so a rehydrate on every reconnect
      // does not re-render every subscriber for an identical map.
      if (next.size === state.states.size) {
        let identical = true;
        for (const [environmentId, entry] of next) {
          const existing = state.states.get(environmentId);
          if (!existing || !isSameState(existing, entry)) {
            identical = false;
            break;
          }
        }
        if (identical) return state;
      }
      return { states: next };
    }),

  applyEvent: (event) =>
    set((state) => {
      if ("removed" in event) {
        if (!state.states.has(event.environmentId)) return state;
        const next = new Map(state.states);
        next.delete(event.environmentId);
        return { states: next };
      }

      const existing = state.states.get(event.environmentId);
      if (existing && isSameState(existing, event.state)) return state;
      const next = new Map(state.states);
      next.set(event.environmentId, event.state);
      return { states: next };
    }),

  getMonitoringState: (environmentId) => get().states.get(environmentId) ?? null,
}));
