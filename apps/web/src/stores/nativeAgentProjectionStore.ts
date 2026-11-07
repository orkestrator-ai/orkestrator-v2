import type { StoreApi } from "zustand/vanilla";
import type {
  NativeAgentDiscoveryView,
  NativeAgentSessionProjection,
  NativeAgentTranscriptView,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { encodedArrayBytes, encodedValueBytes } from "@/lib/native-history-accounting";
import { appCommandScope } from "@/lib/node-scope-slots";
import type { ByteBudget } from "@/lib/node-scope/byte-budget";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";

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
   * writer from the messages themselves. The entry reserves exactly this
   * from the window `transcripts` budget, so a write must keep it consistent
   * with the array.
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

export interface NativeAgentProjectionState {
  projections: ReadonlyMap<string, NativeAgentSessionProjection>;
  projectionBytes: ReadonlyMap<string, number>;
  /**
   * Running totals of the byte maps, kept in step with every write rather
   * than re-summed per update. Anything that replaces one of the maps must
   * adjust its total in the same `set`: see the actions below.
   */
  projectionBytesTotal: number;
  /**
   * Each entry with retained history (`historyBytes > 0`) holds a
   * reservation of that size in the window's `transcripts` budget, which
   * every node scope shares (report §7.4, invariant 11). The store keeps the
   * reservations in step with this Map itself, whoever writes it.
   */
  syncCaches: ReadonlyMap<string, NativeAgentSyncCacheEntry>;
  progressiveCaches: ReadonlyMap<string, NativeAgentProgressiveCacheEntry>;
  progressiveCacheBytes: ReadonlyMap<string, number>;
  progressiveCacheBytesTotal: number;
  /**
   * How many times each session's retained history has been evicted here.
   *
   * The store is not the only owner of those messages: the mounted hook holds
   * the same pages in refs and republishes them on its next materialization.
   * A mounted reader compares this counter against the one it last observed
   * and drops its own copy, so the window-wide history budget is actually
   * released rather than reinstated by the next poll. An eviction can come
   * from another node: its reservation made room in the shared budget.
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

/** Prefixes this store's reservations in the shared `transcripts` budget. */
const HISTORY_RESERVATION_PREFIX = "native-agent-history\u0000";

function historyReservationKey(sessionKey: string): string {
  return `${HISTORY_RESERVATION_PREFIX}${sessionKey}`;
}

/**
 * The node's retained-history reservations, kept in step with `syncCaches`.
 *
 * A listener on the store's own instance diffs every published `syncCaches`
 * against the last one, so any writer (the actions, a test's `setState`)
 * keeps the window budget exact. Reserving marks the entry most recently
 * used; a refusal or a later eviction drops the history from this node's
 * store, as `dropHistory` describes.
 */
function bindHistoryReservations(scope: NodeScope, api: StoreApi<NativeAgentProjectionState>) {
  const budget = (): ByteBudget => scope.budgets.transcripts;

  /**
   * Releases one session's retained pages. The live projection stays
   * visible; dropping the sync token makes the next mount recover a fresh
   * cursor from an authoritative snapshot before it can page again. Every map
   * and running total this touches is replaced in one `setState`, so a
   * mounted hook comparing eviction generations never sees released history
   * alongside stale byte totals.
   */
  const dropHistory = (sessionKey: string) => {
    const state = api.getState();
    const cache = state.syncCaches.get(sessionKey);
    if (!cache || cache.historyBytes === 0) return;
    const syncCaches = new Map(state.syncCaches);
    syncCaches.delete(sessionKey);
    // The display entry falls back to the bounded live tail, so its byte
    // accounting falls back with it. Keeping the materialized size would go on
    // charging the released history against the display budget.
    const liveBytes = encodedArrayBytes(cache.liveProjection.messages);
    const projections = new Map(state.projections);
    const projectionBytes = new Map(state.projectionBytes);
    const projectionBytesTotal =
      state.projectionBytesTotal + liveBytes - (state.projectionBytes.get(sessionKey) ?? 0);
    projections.set(sessionKey, cache.liveProjection);
    projectionBytes.set(sessionKey, liveBytes);
    const historyEvictions = new Map(state.historyEvictions);
    historyEvictions.set(sessionKey, (state.historyEvictions.get(sessionKey) ?? 0) + 1);
    api.setState({
      projections,
      projectionBytes,
      projectionBytesTotal,
      syncCaches,
      historyEvictions,
    });
  };

  const reconcile = (
    next: ReadonlyMap<string, NativeAgentSyncCacheEntry>,
    previous: ReadonlyMap<string, NativeAgentSyncCacheEntry>,
  ) => {
    if (next === previous || scope.disposed) return;
    for (const [sessionKey, entry] of previous) {
      if (!next.has(sessionKey) && entry.historyBytes > 0) {
        budget().release(scope.nodeId, historyReservationKey(sessionKey));
      }
    }
    for (const [sessionKey, entry] of next) {
      if (previous.get(sessionKey) === entry) continue;
      // An eviction this loop caused (a reservation below made room) may
      // already have replaced the entry; reserve only what is still held.
      if (api.getState().syncCaches.get(sessionKey) !== entry) continue;
      const key = historyReservationKey(sessionKey);
      if (entry.historyBytes === 0) {
        budget().release(scope.nodeId, key);
        continue;
      }
      const result = budget().reserve(scope.nodeId, key, entry.historyBytes, {
        onEvict: () => dropHistory(sessionKey),
      });
      // The shown node (or this one's own newer history) holds the whole
      // budget: this node keeps the live tail only.
      if (!result.granted) dropHistory(sessionKey);
    }
  };

  api.subscribe((state, previous) => reconcile(state.syncCaches, previous.syncCaches));

  return {
    /** The session's reservation, if it holds one, is the most recently used. */
    touch: (sessionKey: string) => {
      if (!scope.disposed) budget().touch(scope.nodeId, historyReservationKey(sessionKey));
    },
  };
}

/**
 * Renderer cache only; the backend projection remains authoritative. One
 * instance per node scope; the retained history of every instance in a
 * window shares that window's `transcripts` budget.
 */
export const nativeAgentProjectionStore = defineScopedStore<NativeAgentProjectionState>(
  "native-agent-projection",
  (scope) => (set, _get, api) => {
    const history = bindHistoryReservations(scope, api);
    return createNativeAgentProjectionState(set, history.touch);
  },
);

/**
 * Reads the nearest node scope's projections; other code uses
 * `scope.store(nativeAgentProjectionStore)`.
 */
export const useNativeAgentProjectionStore = scopedStoreHook(nativeAgentProjectionStore);

function createNativeAgentProjectionState(
  set: StoreApi<NativeAgentProjectionState>["setState"],
  touchHistory: (sessionKey: string) => void,
): NativeAgentProjectionState {
  return {
    projections: new Map(),
    projectionBytes: new Map(),
    projectionBytesTotal: 0,
    syncCaches: new Map(),
    progressiveCaches: new Map(),
    progressiveCacheBytes: new Map(),
    progressiveCacheBytesTotal: 0,
    historyEvictions: new Map(),
    turnStopMarkers: new Map(),
    setProjection: (sessionKey, projection, syncCache) => {
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
        const dropProjection = (key: string) => {
          if (next.current.has(key)) next.write().delete(key);
          const bytes = nextBytes.current.get(key);
          if (bytes === undefined) return;
          liveBytes -= bytes;
          nextBytes.write().delete(key);
        };
        const dropSync = (key: string) => {
          if (nextSync.current.has(key)) nextSync.write().delete(key);
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
          progressiveCaches: nextProgressive.current,
          ...(nextEvictions ? { historyEvictions: nextEvictions } : {}),
        };
      });
      // Shown again: its retained history is the last the shared budget evicts.
      if (projection) touchHistory(sessionKey);
    },
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
          const bytes =
            encodedValueBytes(cache.discovery ?? null) + PROGRESSIVE_ENTRY_OVERHEAD_BYTES;
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
        progressiveCaches: new Map(),
        progressiveCacheBytes: new Map(),
        progressiveCacheBytesTotal: 0,
        historyEvictions: new Map(),
        turnStopMarkers: new Map(),
      }),
  };
}

/**
 * Releases retained history pages until `requiredBytes` more fit beside what
 * the window already retains, within `maximumBytes` (the window's
 * `transcripts` total when larger). Pages go by the shared budget's policy:
 * other nodes' least recently shown sessions first, then this node's, never
 * `exceptSessionKey` on `scope`'s node and never the shown node. Each evicted
 * session keeps its live projection (see `dropHistory`).
 */
export function evictNativeAgentHistoryCaches(
  exceptSessionKey: string,
  requiredBytes: number,
  maximumBytes: number,
  scope: NodeScope = appCommandScope(),
): void {
  const budget = scope.budgets.transcripts;
  const target = Math.min(maximumBytes, budget.totalBytes) - requiredBytes;
  budget.evictUntil(scope.nodeId, historyReservationKey(exceptSessionKey), Math.max(0, target));
}

/** History bytes every other session in the window retains, `scope`'s own excepted. */
export function nativeAgentHistoryBytesExcept(
  sessionKey: string,
  scope: NodeScope = appCommandScope(),
): number {
  const budget = scope.budgets.transcripts;
  const own = scope.store(nativeAgentProjectionStore).getState().syncCaches.get(sessionKey);
  const reserved =
    own && budget.has(scope.nodeId, historyReservationKey(sessionKey)) ? own.historyBytes : 0;
  return budget.usedBytes - reserved;
}

/** The window-wide retained-history bound every node's sessions share. */
export function nativeAgentHistoryBudgetBytes(scope: NodeScope = appCommandScope()): number {
  return scope.budgets.transcripts.totalBytes;
}

/**
 * Slow reference totals recomputed from the maps. Tests compare the running
 * totals (and the node's budget reservations, for history) against these
 * after every operation sequence.
 */
export function recomputeNativeAgentProjectionTotals(
  state: Pick<
    NativeAgentProjectionState,
    "projectionBytes" | "syncCaches" | "progressiveCacheBytes"
  > = appCommandScope().store(nativeAgentProjectionStore).getState(),
): { projectionBytesTotal: number; historyBytesTotal: number; progressiveCacheBytesTotal: number } {
  let projectionBytesTotal = 0;
  for (const bytes of state.projectionBytes.values()) projectionBytesTotal += bytes;
  let historyBytesTotal = 0;
  for (const cache of state.syncCaches.values()) historyBytesTotal += cache.historyBytes;
  let progressiveCacheBytesTotal = 0;
  for (const bytes of state.progressiveCacheBytes.values()) progressiveCacheBytesTotal += bytes;
  return { projectionBytesTotal, historyBytesTotal, progressiveCacheBytesTotal };
}
