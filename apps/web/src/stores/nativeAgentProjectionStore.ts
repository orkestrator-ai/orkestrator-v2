import { create } from "zustand";
import type {
  NativeAgentDiscoveryView,
  NativeAgentSessionProjection,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";

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

export interface NativeAgentProgressiveCacheEntry {
  identity?: NativeAgentViewIdentity;
  transcriptToken?: string;
  /**
   * The history epoch of the last transcript view installed for this session.
   *
   * A remount reads the cached projection but constructs fresh refs, so
   * without this the epoch a rotation has to be compared against is gone and
   * every rotation looks like an unchanged history. Cached here because it
   * describes the messages the cache is holding, not the mount that read them.
   */
  transcriptHistoryEpoch?: string;
  stateToken?: string;
  discoveryToken?: string;
  transcriptAvailability: "unavailable" | "cached" | "current" | "empty";
  transcriptRefreshing: boolean;
  transcriptError?: string;
  stateAvailability: "unavailable" | "refreshing" | "current";
  stateError?: string;
  discovery?: NativeAgentDiscoveryView;
}

interface NativeAgentProjectionState {
  projections: ReadonlyMap<string, NativeAgentSessionProjection>;
  projectionBytes: ReadonlyMap<string, number>;
  syncCaches: ReadonlyMap<string, NativeAgentSyncCacheEntry>;
  progressiveCaches: ReadonlyMap<string, NativeAgentProgressiveCacheEntry>;
  progressiveCacheBytes: ReadonlyMap<string, number>;
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
  setProgressiveCache: (sessionKey: string, cache: NativeAgentProgressiveCacheEntry | null) => void;
  markTurnStopped: (sessionKey: string, sessionId: string) => void;
  clearTurnStopped: (sessionKey: string) => void;
  reset: () => void;
}

/** Renderer cache only; the backend projection remains authoritative. */
export const useNativeAgentProjectionStore = create<NativeAgentProjectionState>((set) => ({
  projections: new Map(),
  projectionBytes: new Map(),
  syncCaches: new Map(),
  progressiveCaches: new Map(),
  progressiveCacheBytes: new Map(),
  historyEvictions: new Map(),
  turnStopMarkers: new Map(),
  setProjection: (sessionKey, projection, syncCache) =>
    set((state) => {
      const next = new Map(state.projections);
      const nextBytes = new Map(state.projectionBytes);
      const nextSync = new Map(state.syncCaches);
      if (projection) {
        const previous = state.projections.get(sessionKey);
        next.set(sessionKey, projection);
        nextBytes.set(
          sessionKey,
          previous?.messages === projection.messages
            ? (state.projectionBytes.get(sessionKey) ?? 0)
            : new TextEncoder().encode(JSON.stringify(projection.messages)).byteLength,
        );
      } else {
        next.delete(sessionKey);
        nextBytes.delete(sessionKey);
        nextSync.delete(sessionKey);
        // Nothing retains this session's history any more, so its eviction
        // counter has no reader left to compare against. Dropping it keeps the
        // map bounded by live sessions rather than by session-key churn.
        if (state.historyEvictions.has(sessionKey)) {
          const nextEvictions = new Map(state.historyEvictions);
          nextEvictions.delete(sessionKey);
          return {
            projections: next,
            projectionBytes: nextBytes,
            syncCaches: nextSync,
            historyEvictions: nextEvictions,
          };
        }
      }
      if (syncCache === null) nextSync.delete(sessionKey);
      else if (syncCache !== undefined) nextSync.set(sessionKey, syncCache);
      // Display caches are shared by identity, never by mounted tab lifetime.
      // Keep both a count and a byte ceiling so tab churn converges.
      if (projection) {
        next.delete(sessionKey);
        next.set(sessionKey, projection);
      }
      let liveBytes = Array.from(nextBytes.values()).reduce((total, bytes) => total + bytes, 0);
      while (next.size > 128 || liveBytes > 32 * 1024 * 1024) {
        const oldest = next.keys().next().value as string | undefined;
        if (!oldest || oldest === sessionKey) break;
        liveBytes -= nextBytes.get(oldest) ?? 0;
        next.delete(oldest);
        nextBytes.delete(oldest);
        nextSync.delete(oldest);
      }
      return { projections: next, projectionBytes: nextBytes, syncCaches: nextSync };
    }),
  setProgressiveCache: (sessionKey, cache) =>
    set((state) => {
      const next = new Map(state.progressiveCaches);
      const nextBytes = new Map(state.progressiveCacheBytes);
      next.delete(sessionKey);
      nextBytes.delete(sessionKey);
      if (cache) {
        next.set(sessionKey, cache);
        nextBytes.set(
          sessionKey,
          new TextEncoder().encode(JSON.stringify(cache.discovery ?? null)).byteLength + 4_096,
        );
      }
      let retainedBytes = Array.from(nextBytes.values()).reduce((total, bytes) => total + bytes, 0);
      while (next.size > 128 || retainedBytes > 16 * 1024 * 1024) {
        const oldest = next.keys().next().value as string | undefined;
        if (!oldest || oldest === sessionKey) break;
        retainedBytes -= nextBytes.get(oldest) ?? 0;
        next.delete(oldest);
        nextBytes.delete(oldest);
      }
      return { progressiveCaches: next, progressiveCacheBytes: nextBytes };
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
      projectionBytes: new Map(),
      syncCaches: new Map(),
      progressiveCaches: new Map(),
      progressiveCacheBytes: new Map(),
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
