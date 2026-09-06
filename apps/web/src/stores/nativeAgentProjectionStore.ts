import { create } from "zustand";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

export interface NativeAgentSyncCacheEntry {
  token: string;
  liveProjection: NativeAgentSessionProjection;
  historyEpoch: string;
  historyCursor?: string;
  /** Server-reported boundary between retained history and the live tail. */
  historyBoundaryCursor?: string;
  historyComplete: boolean;
  historyMessages: unknown[];
  historyBytes: number;
}

interface NativeAgentProjectionState {
  projections: ReadonlyMap<string, NativeAgentSessionProjection>;
  syncCaches: ReadonlyMap<string, NativeAgentSyncCacheEntry>;
  /**
   * How many times each session's retained history has been evicted here.
   *
   * The store is not the only owner of those messages: the mounted hook holds
   * the same pages in refs and republishes them on its next materialization.
   * A mounted reader compares this counter against the one it last observed
   * and drops its own copy, so the process-wide history budget is actually
   * released rather than reinstated by the next poll.
   */
  historyEvictions: ReadonlyMap<string, number>;
  turnStopMarkers: ReadonlyMap<string, { sessionId: string; createdAt: string }>;
  setProjection: (
    sessionKey: string,
    projection: NativeAgentSessionProjection | null,
    syncCache?: NativeAgentSyncCacheEntry | null,
  ) => void;
  markTurnStopped: (sessionKey: string, sessionId: string) => void;
  clearTurnStopped: (sessionKey: string) => void;
  reset: () => void;
}

/** Renderer cache only; the backend projection remains authoritative. */
export const useNativeAgentProjectionStore = create<NativeAgentProjectionState>((set) => ({
  projections: new Map(),
  syncCaches: new Map(),
  historyEvictions: new Map(),
  turnStopMarkers: new Map(),
  setProjection: (sessionKey, projection, syncCache) =>
    set((state) => {
      const next = new Map(state.projections);
      const nextSync = new Map(state.syncCaches);
      if (projection) next.set(sessionKey, projection);
      else {
        next.delete(sessionKey);
        nextSync.delete(sessionKey);
        // Nothing retains this session's history any more, so its eviction
        // counter has no reader left to compare against. Dropping it keeps the
        // map bounded by live sessions rather than by session-key churn.
        if (state.historyEvictions.has(sessionKey)) {
          const nextEvictions = new Map(state.historyEvictions);
          nextEvictions.delete(sessionKey);
          return { projections: next, syncCaches: nextSync, historyEvictions: nextEvictions };
        }
      }
      if (syncCache === null) nextSync.delete(sessionKey);
      else if (syncCache !== undefined) nextSync.set(sessionKey, syncCache);
      return { projections: next, syncCaches: nextSync };
    }),
  markTurnStopped: (sessionKey, sessionId) =>
    set((state) => {
      const next = new Map(state.turnStopMarkers);
      next.set(sessionKey, { sessionId, createdAt: new Date().toISOString() });
      return { turnStopMarkers: next };
    }),
  clearTurnStopped: (sessionKey) =>
    set((state) => {
      if (!state.turnStopMarkers.has(sessionKey)) return state;
      const next = new Map(state.turnStopMarkers);
      next.delete(sessionKey);
      return { turnStopMarkers: next };
    }),
  reset: () =>
    set({
      projections: new Map(),
      syncCaches: new Map(),
      historyEvictions: new Map(),
      turnStopMarkers: new Map(),
    }),
}));

/**
 * Releases historical pages from inactive identities until `requiredBytes`
 * fits under the process-wide renderer budget. Their live projections remain
 * visible; dropping the sync token makes the next mount recover a fresh cursor
 * from an authoritative snapshot before it can page again.
 */
export function evictNativeAgentHistoryCaches(
  exceptSessionKey: string,
  requiredBytes: number,
  maximumBytes: number,
): void {
  const state = useNativeAgentProjectionStore.getState();
  let retainedBytes = Array.from(state.syncCaches.values()).reduce(
    (total, cache) => total + cache.historyBytes,
    0,
  );
  if (retainedBytes + requiredBytes <= maximumBytes) return;
  const projections = new Map(state.projections);
  const syncCaches = new Map(state.syncCaches);
  const historyEvictions = new Map(state.historyEvictions);
  for (const [sessionKey, cache] of state.syncCaches) {
    if (sessionKey === exceptSessionKey || cache.historyBytes === 0) continue;
    retainedBytes -= cache.historyBytes;
    syncCaches.delete(sessionKey);
    projections.set(sessionKey, cache.liveProjection);
    historyEvictions.set(sessionKey, (historyEvictions.get(sessionKey) ?? 0) + 1);
    if (retainedBytes + requiredBytes <= maximumBytes) break;
  }
  useNativeAgentProjectionStore.setState({ projections, syncCaches, historyEvictions });
}
