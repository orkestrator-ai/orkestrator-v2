import { create } from "zustand";
import type {
  EnvironmentDiffStats,
  EnvironmentDiffStatsChange,
  EnvironmentDiffStatsEvent,
} from "@orkestrator/protocol/diff-stats";

export type { EnvironmentDiffStats };

interface EnvironmentDiffState {
  /** Diff stats keyed by environment ID */
  stats: Map<string, EnvironmentDiffStats>;

  /**
   * Replaces the whole map from an authoritative backend snapshot.
   *
   * Whole-map replacement rather than a merge, because the snapshot is the
   * complete truth: an environment absent from it has no counts, and merging
   * would let one deleted between two rehydrations linger forever.
   */
  applySnapshot: (entries: EnvironmentDiffStatsChange[]) => void;
  /** Applies one incremental update or invalidation announced by the backend. */
  applyChange: (change: EnvironmentDiffStatsEvent) => void;
}

function isSameStats(a: EnvironmentDiffStats, b: EnvironmentDiffStats): boolean {
  return (
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.filesChanged === b.filesChanged &&
    a.truncated === b.truncated
  );
}

export const useEnvironmentDiffStore = create<EnvironmentDiffState>()((set) => ({
  stats: new Map(),

  applySnapshot: (entries) =>
    set((state) => {
      const next = new Map<string, EnvironmentDiffStats>();
      for (const entry of entries) next.set(entry.environmentId, entry.stats);

      // Skip the update when nothing moved, so a rehydrate on every reconnect
      // does not re-render every environment row for an identical map.
      if (next.size === state.stats.size) {
        let identical = true;
        for (const [environmentId, stats] of next) {
          const existing = state.stats.get(environmentId);
          if (!existing || !isSameStats(existing, stats)) {
            identical = false;
            break;
          }
        }
        if (identical) return state;
      }
      return { stats: next };
    }),

  applyChange: (change) =>
    set((state) => {
      if ("removed" in change) {
        if (!state.stats.has(change.environmentId)) return state;
        const next = new Map(state.stats);
        next.delete(change.environmentId);
        return { stats: next };
      }

      const existing = state.stats.get(change.environmentId);
      if (existing && isSameStats(existing, change.stats)) return state;
      const next = new Map(state.stats);
      next.set(change.environmentId, change.stats);
      return { stats: next };
    }),
}));
