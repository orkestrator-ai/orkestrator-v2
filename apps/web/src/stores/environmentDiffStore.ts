import { create } from "zustand";

export interface EnvironmentDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

interface EnvironmentDiffState {
  /** Diff stats keyed by environment ID */
  stats: Map<string, EnvironmentDiffStats>;

  setStats: (environmentId: string, stats: EnvironmentDiffStats) => void;
  /** Remove stats for environment IDs not in the provided set */
  pruneStats: (activeIds: Set<string>) => void;
}

export const useEnvironmentDiffStore = create<EnvironmentDiffState>()(
  (set) => ({
    stats: new Map(),

    setStats: (environmentId, stats) =>
      set((state) => {
        const existing = state.stats.get(environmentId);
        // Skip update if values haven't changed to avoid unnecessary re-renders
        if (
          existing &&
          existing.additions === stats.additions &&
          existing.deletions === stats.deletions &&
          existing.filesChanged === stats.filesChanged
        ) {
          return state;
        }
        const newStats = new Map(state.stats);
        newStats.set(environmentId, stats);
        return { stats: newStats };
      }),

    pruneStats: (activeIds) =>
      set((state) => {
        let pruned = false;
        for (const key of state.stats.keys()) {
          if (!activeIds.has(key)) {
            pruned = true;
            break;
          }
        }
        if (!pruned) return state;
        const newStats = new Map<string, EnvironmentDiffStats>();
        for (const [key, value] of state.stats) {
          if (activeIds.has(key)) {
            newStats.set(key, value);
          }
        }
        return { stats: newStats };
      }),
  })
);
