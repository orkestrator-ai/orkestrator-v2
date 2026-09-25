/**
 * Renderer projection of backend-owned web annotations.
 *
 * One bounded, normalized cache per environment. The backend is the authority:
 * entries here are replaced wholesale by fetched snapshots, never patched with
 * optimistic content. Fetch/transport state (`sync`) is kept separate from
 * domain status so an offline badge cannot turn a running request into a
 * failed one or an open note into a resolved one.
 *
 * Synchronization (subscriptions, reconciliation, stale-response discard)
 * lives in `lib/web-annotations/sync.ts`; this module only stores results.
 */
import { create } from "zustand";
import type {
  WebAnnotationCapabilities,
  WebAnnotationCapture,
  WebAnnotationGetResult,
  WebAnnotationListInput,
  WebAnnotationMigrationStatus,
  WebAnnotationRequest,
  WebAnnotationResult,
  WebAnnotationSummary,
} from "@orkestrator/protocol/web-annotations";

/** Explicit cache bounds (step 03: evict inactive pages and object URLs). */
export const WEB_ANNOTATION_CACHE_LIMITS = Object.freeze({
  environments: 6,
  summaries: 500,
  threads: 24,
  captures: 120,
  assets: 48,
  lists: 16,
  /** Requests and results outside cached threads are evicted oldest first. */
  requests: 200,
  results: 200,
});

export type ListFilter = NonNullable<WebAnnotationListInput["filter"]>;

export interface ListQuery {
  filter: ListFilter;
  cursor: string | null;
  limit: number;
}

export interface ListState {
  ids: string[];
  total: number;
  openOnPage: number | null;
  nextCursor: string | null;
  revision: number;
  status: "loading" | "ready" | "error";
  error: string | null;
}

export interface ThreadState {
  data: WebAnnotationGetResult | null;
  status: "loading" | "ready" | "error" | "missing";
  error: string | null;
}

export interface AssetState {
  /** Object URL (or data URL fallback); revoked on eviction. */
  url: string | null;
  status: "loading" | "ready" | "missing" | "error";
  error: string | null;
  usedAt: number;
  /** Stored size, once the asset record has been read. */
  bytes?: number;
}

export type CapabilityStatus = "unknown" | "loading" | "available" | "unavailable" | "error";

export interface SyncState {
  status: "idle" | "loading" | "ready" | "error";
  /** Transport/fetch failure only. Never a domain state. */
  error: string | null;
  lastSyncedAt: number | null;
}

export interface WebAnnotationEnvironmentCache {
  capabilities: WebAnnotationCapabilities | null;
  capabilityStatus: CapabilityStatus;
  capabilityReason: string | null;
  generation: string | null;
  revision: number;
  sync: SyncState;
  summaries: Map<string, WebAnnotationSummary>;
  lists: Map<string, ListState>;
  threads: Map<string, ThreadState>;
  captures: Map<string, WebAnnotationCapture>;
  requests: Map<string, WebAnnotationRequest>;
  results: Map<string, WebAnnotationResult>;
  assets: Map<string, AssetState>;
  migration: WebAnnotationMigrationStatus | null;
  touchedAt: number;
}

export function emptyWebAnnotationCache(): WebAnnotationEnvironmentCache {
  return {
    capabilities: null,
    capabilityStatus: "unknown",
    capabilityReason: null,
    generation: null,
    revision: -1,
    sync: { status: "idle", error: null, lastSyncedAt: null },
    summaries: new Map(),
    lists: new Map(),
    threads: new Map(),
    captures: new Map(),
    requests: new Map(),
    results: new Map(),
    assets: new Map(),
    migration: null,
    touchedAt: Date.now(),
  };
}

/** Stable empty snapshot for selectors (a fresh object would re-render forever). */
export const EMPTY_WEB_ANNOTATION_CACHE: WebAnnotationEnvironmentCache = Object.freeze(
  emptyWebAnnotationCache(),
) as WebAnnotationEnvironmentCache;

export function listQueryKey(query: ListQuery): string {
  const filter = query.filter;
  return JSON.stringify([
    filter.pageKey ?? null,
    filter.state ?? "open",
    filter.destinationTabId ?? null,
    filter.includeHidden ?? false,
    filter.importedOnly ?? false,
    filter.includeArchived ?? false,
    query.cursor,
    query.limit,
  ]);
}

function revokeUrl(url: string | null) {
  if (!url || !url.startsWith("blob:")) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Revocation is best-effort; an already-revoked URL is harmless.
  }
}

function revokeAll(cache: WebAnnotationEnvironmentCache) {
  for (const asset of cache.assets.values()) revokeUrl(asset.url);
}

/** Drop least-recently-used entries past `limit`, keeping `keep`. */
function boundMap<V>(
  map: Map<string, V>,
  limit: number,
  keep: ReadonlySet<string>,
  onEvict?: (value: V) => void,
): Map<string, V> {
  if (map.size <= limit) return map;
  const next = new Map(map);
  for (const key of Array.from(next.keys())) {
    if (next.size <= limit) break;
    if (keep.has(key)) continue;
    onEvict?.(next.get(key)!);
    next.delete(key);
  }
  return next;
}

/**
 * Requests/results referenced by a cached thread or an active summary are
 * never evicted: an open thread must not lose its request cards.
 */
function referencedExecution(
  threads: ReadonlyMap<string, ThreadState>,
  summaries: ReadonlyMap<string, WebAnnotationSummary>,
  extra: { requests?: Iterable<string>; results?: Iterable<string> } = {},
) {
  const requests = new Set<string>(extra.requests ?? []);
  const results = new Set<string>(extra.results ?? []);
  for (const thread of threads.values()) {
    for (const request of thread.data?.requests ?? []) requests.add(request.id);
    for (const result of thread.data?.results ?? []) results.add(result.id);
  }
  for (const summary of summaries.values()) {
    if (summary.activeRequestId) requests.add(summary.activeRequestId);
  }
  return { requests, results };
}

function boundExecution(
  requests: Map<string, WebAnnotationRequest>,
  results: Map<string, WebAnnotationResult>,
  keep: { requests: ReadonlySet<string>; results: ReadonlySet<string> },
) {
  return {
    requests: boundMap(requests, WEB_ANNOTATION_CACHE_LIMITS.requests, keep.requests),
    results: boundMap(results, WEB_ANNOTATION_CACHE_LIMITS.results, keep.results),
  };
}

/**
 * Mirror a fetched thread's annotation into its summary so revision-checked
 * commands started from the list see the same content revision as the open
 * thread. An older snapshot never regresses a newer summary.
 */
function summaryFromThread(
  data: WebAnnotationGetResult,
  existing: WebAnnotationSummary | undefined,
): WebAnnotationSummary | null {
  const annotation = data.annotation;
  if (existing && existing.metadataRevision > annotation.metadataRevision) return null;
  const active = annotation.activeRequestId
    ? data.requests.find((request) => request.id === annotation.activeRequestId)
    : undefined;
  const activeRequest = active
    ? {
        id: active.id,
        state: active.state,
        operation: active.operation,
        blockedReason: active.blockedReason,
        destination: active.destination,
      }
    : existing?.activeRequest?.id === annotation.activeRequestId
      ? (existing?.activeRequest ?? null)
      : null;
  return { ...annotation, activeRequest };
}

interface WebAnnotationStoreState {
  environments: Map<string, WebAnnotationEnvironmentCache>;
  update: (
    environmentId: string,
    updater: (cache: WebAnnotationEnvironmentCache) => Partial<WebAnnotationEnvironmentCache>,
  ) => void;
  installList: (
    environmentId: string,
    key: string,
    list: Omit<ListState, "ids" | "status" | "error">,
    items: WebAnnotationSummary[],
  ) => void;
  installThread: (environmentId: string, annotationId: string, thread: ThreadState) => void;
  installRequests: (
    environmentId: string,
    requests: WebAnnotationRequest[],
    results?: WebAnnotationResult[],
  ) => void;
  installCapture: (environmentId: string, capture: WebAnnotationCapture) => void;
  setAsset: (environmentId: string, assetId: string, asset: AssetState) => void;
  /** Evict whole environments not in `active`, beyond the environment bound. */
  evictInactive: (active: ReadonlySet<string>) => void;
  reset: () => void;
}

export const useWebAnnotationStore = create<WebAnnotationStoreState>()((set) => ({
  environments: new Map(),
  update: (environmentId, updater) =>
    set((state) => {
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const environments = new Map(state.environments);
      environments.set(environmentId, { ...current, ...updater(current), touchedAt: Date.now() });
      return { environments };
    }),
  installList: (environmentId, key, list, items) =>
    set((state) => {
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const summaries = new Map(current.summaries);
      for (const item of items) {
        summaries.delete(item.id);
        summaries.set(item.id, item);
      }
      const lists = new Map(current.lists);
      lists.delete(key);
      lists.set(key, {
        ...list,
        ids: items.map((item) => item.id),
        status: "ready",
        error: null,
      });
      const boundedLists = boundMap(lists, WEB_ANNOTATION_CACHE_LIMITS.lists, new Set([key]));
      const referenced = new Set<string>();
      for (const entry of boundedLists.values()) for (const id of entry.ids) referenced.add(id);
      for (const id of current.threads.keys()) referenced.add(id);
      const environments = new Map(state.environments);
      environments.set(environmentId, {
        ...current,
        summaries: boundMap(summaries, WEB_ANNOTATION_CACHE_LIMITS.summaries, referenced),
        lists: boundedLists,
        touchedAt: Date.now(),
      });
      return { environments };
    }),
  installThread: (environmentId, annotationId, thread) =>
    set((state) => {
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const threads = new Map(current.threads);
      threads.delete(annotationId);
      threads.set(annotationId, thread);
      const requests = new Map(current.requests);
      const results = new Map(current.results);
      const captures = new Map(current.captures);
      let summaries = current.summaries;
      if (thread.data) {
        for (const request of thread.data.requests) {
          const existing = requests.get(request.id);
          if (!existing || existing.revision <= request.revision) {
            requests.delete(request.id);
            requests.set(request.id, request);
          }
        }
        for (const result of thread.data.results) {
          results.delete(result.id);
          results.set(result.id, result);
        }
        if (thread.data.capture) captures.set(thread.data.capture.id, thread.data.capture);
        const summary = summaryFromThread(thread.data, current.summaries.get(annotationId));
        if (summary) {
          summaries = new Map(current.summaries);
          summaries.set(annotationId, summary);
        }
      }
      const boundedThreads = boundMap(
        threads,
        WEB_ANNOTATION_CACHE_LIMITS.threads,
        new Set([annotationId]),
      );
      const execution = boundExecution(
        requests,
        results,
        referencedExecution(boundedThreads, summaries),
      );
      const environments = new Map(state.environments);
      environments.set(environmentId, {
        ...current,
        summaries,
        threads: boundedThreads,
        requests: execution.requests,
        results: execution.results,
        captures: boundMap(captures, WEB_ANNOTATION_CACHE_LIMITS.captures, new Set()),
        touchedAt: Date.now(),
      });
      return { environments };
    }),
  installRequests: (environmentId, incoming, incomingResults = []) =>
    set((state) => {
      if (incoming.length === 0 && incomingResults.length === 0) return state;
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const results = new Map(current.results);
      for (const result of incomingResults) {
        const existing = results.get(result.id);
        if (!existing || existing.revision <= result.revision) {
          results.delete(result.id);
          results.set(result.id, result);
        }
      }
      const requests = new Map(current.requests);
      for (const request of incoming) {
        const existing = requests.get(request.id);
        // Out-of-order responses never regress a request's revision.
        if (existing && existing.revision > request.revision) continue;
        requests.delete(request.id);
        requests.set(request.id, request);
      }
      const execution = boundExecution(
        requests,
        results,
        // Incoming entries were just moved to the newest end, so eviction
        // takes the oldest unreferenced ones first.
        referencedExecution(current.threads, current.summaries),
      );
      const environments = new Map(state.environments);
      environments.set(environmentId, { ...current, ...execution, touchedAt: Date.now() });
      return { environments };
    }),
  installCapture: (environmentId, capture) =>
    set((state) => {
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const captures = new Map(current.captures);
      captures.delete(capture.id);
      captures.set(capture.id, capture);
      const environments = new Map(state.environments);
      environments.set(environmentId, {
        ...current,
        captures: boundMap(captures, WEB_ANNOTATION_CACHE_LIMITS.captures, new Set([capture.id])),
      });
      return { environments };
    }),
  setAsset: (environmentId, assetId, asset) =>
    set((state) => {
      const current = state.environments.get(environmentId) ?? emptyWebAnnotationCache();
      const assets = new Map(current.assets);
      const previous = assets.get(assetId);
      if (previous && previous.url !== asset.url) revokeUrl(previous.url);
      assets.delete(assetId);
      assets.set(assetId, asset);
      const environments = new Map(state.environments);
      environments.set(environmentId, {
        ...current,
        assets: boundMap(
          assets,
          WEB_ANNOTATION_CACHE_LIMITS.assets,
          new Set([assetId]),
          (evicted) => revokeUrl(evicted.url),
        ),
      });
      return { environments };
    }),
  evictInactive: (active) =>
    set((state) => {
      if (state.environments.size <= WEB_ANNOTATION_CACHE_LIMITS.environments) return state;
      const ordered = Array.from(state.environments.entries()).sort(
        (a, b) => a[1].touchedAt - b[1].touchedAt,
      );
      const environments = new Map(state.environments);
      for (const [environmentId, cache] of ordered) {
        if (environments.size <= WEB_ANNOTATION_CACHE_LIMITS.environments) break;
        if (active.has(environmentId)) continue;
        revokeAll(cache);
        environments.delete(environmentId);
      }
      return { environments };
    }),
  reset: () =>
    set((state) => {
      for (const cache of state.environments.values()) revokeAll(cache);
      return { environments: new Map() };
    }),
}));

export function getWebAnnotationCache(environmentId: string): WebAnnotationEnvironmentCache {
  return (
    useWebAnnotationStore.getState().environments.get(environmentId) ?? emptyWebAnnotationCache()
  );
}
