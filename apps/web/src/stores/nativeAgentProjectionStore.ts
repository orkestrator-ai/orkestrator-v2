import { create } from "zustand";
import type {
  NativeAgentDiscoveryView,
  NativeAgentSessionProjection,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { encodedArrayBytes, encodedValueBytes } from "@/lib/native-history-accounting";

export interface NativeAgentSyncCacheEntry {
  /**
   * The joined projection token this entry was built from.
   *
   * Absent when the live tail came from the progressive transcript instead:
   * that surface mints its own token in a different namespace, and replaying
   * it as `knownToken` on the joined endpoint would describe a base revision
   * the backend never held.
   */
  token?: string;
  liveProjection: NativeAgentSessionProjection;
  /**
   * The backend's history-paging epoch, not the transcript's content epoch.
   *
   * Only the joined projection and message-page surfaces mint it, so it is
   * absent until this tab has read one of them.
   */
  historyEpoch?: string;
  historyCursor?: string;
  /** Server-reported boundary between retained history and the live tail. */
  historyBoundaryCursor?: string;
  /**
   * True when the transcript reports earlier messages but no cursor exists yet,
   * so a click still has to mint one through the joined snapshot. Cached so a
   * remount can act on the control it paints from this entry.
   */
  historyBootstrap?: boolean;
  /**
   * True after a joined-snapshot bootstrap proved this client cannot mint a
   * cursor or recover more content. Sticky across polls so an incomplete
   * server window cannot put an inert control back on screen.
   */
  historyUnpageable?: boolean;
  historyComplete: boolean;
  historyMessages: unknown[];
  /**
   * Encoded bytes of `historyMessages` (zero when empty), measured by the
   * writer from the messages themselves. `historyBytesTotal` is maintained
   * from these values, so a write must keep it consistent with the array.
   */
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
  /** Direct paging and reconciliation survive an unchanged first remount read. */
  transcriptHistoryMetadata?: Pick<
    NativeAgentTranscriptView,
    "historyCursor" | "historyPaging" | "historyComplete" | "historyReconciliationToken"
  >;
  /** Rows before the live tail still await a re-read; a remount owes it too. */
  heldHistoryReconcileOwed?: boolean;
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
  /**
   * Running totals of the byte maps, kept in step with every write rather
   * than re-summed per update. Anything that replaces one of the maps must
   * adjust its total in the same `set` — see the actions below and
   * `evictNativeAgentHistoryCaches`.
   */
  projectionBytesTotal: number;
  syncCaches: ReadonlyMap<string, NativeAgentSyncCacheEntry>;
  /** Sum of `historyBytes` across `syncCaches`: the process-wide history budget. */
  historyBytesTotal: number;
  progressiveCaches: ReadonlyMap<string, NativeAgentProgressiveCacheEntry>;
  progressiveCacheBytes: ReadonlyMap<string, number>;
  progressiveCacheBytesTotal: number;
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

/**
 * A Map copied the first time a store write has to change it. `current` keeps
 * the original's identity until then, so one write publishes a new object only
 * for the Maps it actually changed.
 */
interface CopyOnWriteMap<V> {
  readonly current: ReadonlyMap<string, V>;
  write(): Map<string, V>;
}

function copyOnWrite<V>(source: ReadonlyMap<string, V>): CopyOnWriteMap<V> {
  let copy: Map<string, V> | null = null;
  return {
    get current() {
      return copy ?? source;
    },
    write() {
      return (copy ??= new Map(source));
    },
  };
}

function isMostRecent(map: ReadonlyMap<string, unknown>, key: string): boolean {
  let last: string | undefined;
  for (const candidate of map.keys()) last = candidate;
  return last === key;
}

function dropProgressiveTranscriptToken(
  caches: CopyOnWriteMap<NativeAgentProgressiveCacheEntry>,
  sessionKey: string,
): void {
  const entry = caches.current.get(sessionKey);
  if (
    !entry ||
    (entry.transcriptToken === undefined && entry.transcriptHistoryEpoch === undefined)
  ) {
    return;
  }
  caches.write().set(sessionKey, {
    ...entry,
    transcriptToken: undefined,
    transcriptHistoryEpoch: undefined,
    transcriptHistoryMetadata: undefined,
  });
}

/** Fixed allowance for a progressive entry's tokens, flags and identity. */
const PROGRESSIVE_ENTRY_OVERHEAD_BYTES = 4_096;

/**
 * Whether a progressive patch left the entry exactly as it was.
 *
 * Idle polls and refresh-flag toggles rebuild the entry from the previous one
 * with nothing actually different; publishing that would notify every
 * subscriber for no change. Missing and `undefined` fields compare equal, as
 * they do for every reader of the entry.
 */
function sameProgressiveEntry(
  previous: NativeAgentProgressiveCacheEntry,
  next: NativeAgentProgressiveCacheEntry,
): boolean {
  const left = previous as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(right)) if (!Object.is(left[key], right[key])) return false;
  for (const key of Object.keys(left)) if (!Object.is(left[key], right[key])) return false;
  return true;
}

/** Renderer cache only; the backend projection remains authoritative. */
export const useNativeAgentProjectionStore = create<NativeAgentProjectionState>((set) => ({
  projections: new Map(),
  projectionBytes: new Map(),
  projectionBytesTotal: 0,
  syncCaches: new Map(),
  historyBytesTotal: 0,
  progressiveCaches: new Map(),
  progressiveCacheBytes: new Map(),
  progressiveCacheBytesTotal: 0,
  historyEvictions: new Map(),
  turnStopMarkers: new Map(),
  setProjection: (sessionKey, projection, syncCache) =>
    set((state) => {
      // Rewriting what is already held, at the most-recent end of the LRU,
      // changes nothing a subscriber could observe.
      if (
        projection &&
        state.projections.get(sessionKey) === projection &&
        (syncCache === undefined ||
          (syncCache && state.syncCaches.get(sessionKey) === syncCache)) &&
        isMostRecent(state.projections, sessionKey)
      ) {
        return state;
      }
      const next = copyOnWrite(state.projections);
      const nextBytes = copyOnWrite(state.projectionBytes);
      const nextSync = copyOnWrite(state.syncCaches);
      const nextProgressive = copyOnWrite(state.progressiveCaches);
      let liveBytes = state.projectionBytesTotal;
      let historyBytes = state.historyBytesTotal;
      const dropProjection = (key: string) => {
        if (next.current.has(key)) next.write().delete(key);
        const bytes = nextBytes.current.get(key);
        if (bytes === undefined) return;
        liveBytes -= bytes;
        nextBytes.write().delete(key);
      };
      const dropSync = (key: string) => {
        const entry = nextSync.current.get(key);
        if (!entry) return;
        historyBytes -= entry.historyBytes;
        nextSync.write().delete(key);
      };
      let nextEvictions: Map<string, number> | undefined;
      if (projection) {
        const previousBytes = state.projectionBytes.get(sessionKey);
        const bytes =
          previousBytes !== undefined &&
          state.projections.get(sessionKey)?.messages === projection.messages
            ? previousBytes
            : // Summed from per-message sizes: only messages this renderer has
              // not measured before are serialized, never the whole joined
              // array — the retained history in it is unchanged.
              encodedArrayBytes(projection.messages);
        liveBytes += bytes - (previousBytes ?? 0);
        // Re-inserting moves the session to the most-recent end of the LRU.
        const projections = next.write();
        projections.delete(sessionKey);
        projections.set(sessionKey, projection);
        if (bytes !== previousBytes) nextBytes.write().set(sessionKey, bytes);
      } else {
        dropProjection(sessionKey);
        dropSync(sessionKey);
        dropProgressiveTranscriptToken(nextProgressive, sessionKey);
        // Nothing retains this session's history any more, so its eviction
        // counter has no reader left to compare against. Dropping it keeps the
        // map bounded by live sessions rather than by session-key churn.
        if (state.historyEvictions.has(sessionKey)) {
          nextEvictions = new Map(state.historyEvictions);
          nextEvictions.delete(sessionKey);
        }
      }
      if (syncCache === null) dropSync(sessionKey);
      else if (syncCache !== undefined && nextSync.current.get(sessionKey) !== syncCache) {
        historyBytes +=
          syncCache.historyBytes - (nextSync.current.get(sessionKey)?.historyBytes ?? 0);
        nextSync.write().set(sessionKey, syncCache);
      }
      // Display caches are shared by identity, never by mounted tab lifetime.
      // Keep both a count and a byte ceiling so tab churn converges.
      while (next.current.size > 128 || liveBytes > 32 * 1024 * 1024) {
        const oldest = next.current.keys().next().value as string | undefined;
        if (!oldest || oldest === sessionKey) break;
        dropProjection(oldest);
        dropSync(oldest);
        dropProgressiveTranscriptToken(nextProgressive, oldest);
      }
      return {
        projections: next.current,
        projectionBytes: nextBytes.current,
        projectionBytesTotal: liveBytes,
        syncCaches: nextSync.current,
        historyBytesTotal: historyBytes,
        progressiveCaches: nextProgressive.current,
        ...(nextEvictions ? { historyEvictions: nextEvictions } : {}),
      };
    }),
  setProgressiveCache: (sessionKey, cache) =>
    set((state) => {
      const previous = state.progressiveCaches.get(sessionKey);
      if (!cache && !previous) return state;
      // No recency requirement: two visible sessions take turns being the last
      // key written, so requiring it would republish every unchanged poll.
      if (cache && previous && sameProgressiveEntry(previous, cache)) return state;
      const next = new Map(state.progressiveCaches);
      const nextBytes = copyOnWrite(state.progressiveCacheBytes);
      const previousBytes = nextBytes.current.get(sessionKey);
      let retainedBytes = state.progressiveCacheBytesTotal - (previousBytes ?? 0);
      next.delete(sessionKey);
      if (cache) {
        // Measured once per discovery object: a patch that only flips
        // availability or a refresh flag carries the same discovery forward
        // and must not serialize it again.
        const bytes = encodedValueBytes(cache.discovery ?? null) + PROGRESSIVE_ENTRY_OVERHEAD_BYTES;
        next.set(sessionKey, cache);
        if (bytes !== previousBytes) nextBytes.write().set(sessionKey, bytes);
        retainedBytes += bytes;
      } else if (previousBytes !== undefined) {
        nextBytes.write().delete(sessionKey);
      }
      while (next.size > 128 || retainedBytes > 16 * 1024 * 1024) {
        const oldest = next.keys().next().value as string | undefined;
        if (!oldest || oldest === sessionKey) break;
        retainedBytes -= nextBytes.current.get(oldest) ?? 0;
        next.delete(oldest);
        nextBytes.write().delete(oldest);
      }
      return {
        progressiveCaches: next,
        progressiveCacheBytes: nextBytes.current,
        progressiveCacheBytesTotal: retainedBytes,
      };
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
      projectionBytesTotal: 0,
      syncCaches: new Map(),
      historyBytesTotal: 0,
      progressiveCaches: new Map(),
      progressiveCacheBytes: new Map(),
      progressiveCacheBytesTotal: 0,
      historyEvictions: new Map(),
      turnStopMarkers: new Map(),
    }),
}));

/**
 * Releases historical pages from inactive identities until `requiredBytes`
 * fits under the process-wide renderer budget. Their live projections remain
 * visible; dropping the sync token makes the next mount recover a fresh cursor
 * from an authoritative snapshot before it can page again.
 *
 * Every map and running total this touches is replaced in one `setState`, so
 * no reader — including a mounted hook comparing eviction generations — can
 * observe released history alongside stale byte totals.
 */
export function evictNativeAgentHistoryCaches(
  exceptSessionKey: string,
  requiredBytes: number,
  maximumBytes: number,
): void {
  const state = useNativeAgentProjectionStore.getState();
  let retainedBytes = state.historyBytesTotal;
  if (retainedBytes + requiredBytes <= maximumBytes) return;
  const projections = copyOnWrite(state.projections);
  const projectionBytes = copyOnWrite(state.projectionBytes);
  let projectionBytesTotal = state.projectionBytesTotal;
  const syncCaches = copyOnWrite(state.syncCaches);
  const historyEvictions = copyOnWrite(state.historyEvictions);
  for (const [sessionKey, cache] of state.syncCaches) {
    if (sessionKey === exceptSessionKey || cache.historyBytes === 0) continue;
    retainedBytes -= cache.historyBytes;
    syncCaches.write().delete(sessionKey);
    // The display entry falls back to the bounded live tail, so its byte
    // accounting falls back with it. Keeping the materialized size would go on
    // charging the released history against the display budget.
    const liveBytes = encodedArrayBytes(cache.liveProjection.messages);
    projectionBytesTotal += liveBytes - (projectionBytes.current.get(sessionKey) ?? 0);
    projections.write().set(sessionKey, cache.liveProjection);
    projectionBytes.write().set(sessionKey, liveBytes);
    historyEvictions.write().set(sessionKey, (historyEvictions.current.get(sessionKey) ?? 0) + 1);
    if (retainedBytes + requiredBytes <= maximumBytes) break;
  }
  // Only this session's history is held: nothing to release, nothing to publish.
  if (syncCaches.current === state.syncCaches) return;
  useNativeAgentProjectionStore.setState({
    projections: projections.current,
    projectionBytes: projectionBytes.current,
    projectionBytesTotal,
    syncCaches: syncCaches.current,
    historyBytesTotal: retainedBytes,
    historyEvictions: historyEvictions.current,
  });
}

/** History bytes every other session retains, from the running total. */
export function nativeAgentHistoryBytesExcept(sessionKey: string): number {
  const state = useNativeAgentProjectionStore.getState();
  return state.historyBytesTotal - (state.syncCaches.get(sessionKey)?.historyBytes ?? 0);
}

/**
 * Slow reference totals recomputed from the maps. Tests compare the running
 * totals against these after every operation sequence.
 */
export function recomputeNativeAgentProjectionTotals(
  state: Pick<
    NativeAgentProjectionState,
    "projectionBytes" | "syncCaches" | "progressiveCacheBytes"
  > = useNativeAgentProjectionStore.getState(),
): { projectionBytesTotal: number; historyBytesTotal: number; progressiveCacheBytesTotal: number } {
  let projectionBytesTotal = 0;
  for (const bytes of state.projectionBytes.values()) projectionBytesTotal += bytes;
  let historyBytesTotal = 0;
  for (const cache of state.syncCaches.values()) historyBytesTotal += cache.historyBytes;
  let progressiveCacheBytesTotal = 0;
  for (const bytes of state.progressiveCacheBytes.values()) progressiveCacheBytesTotal += bytes;
  return { projectionBytesTotal, historyBytesTotal, progressiveCacheBytesTotal };
}
