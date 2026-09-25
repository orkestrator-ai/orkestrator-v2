/**
 * Snapshot + hint synchronization for the web annotation cache (plan step 03).
 *
 * Per environment:
 * 1. Subscribe to `web-annotations-changed` BEFORE fetching the snapshot and
 *    buffer hints while it loads.
 * 2. Install the snapshot at its committed revision, then apply only buffered
 *    or later hints, by refetching the affected resources (never by patching
 *    optimistic content).
 * 3. Detect gaps via generation/revision and repair them with
 *    `web_annotations_changes`; `resetRequired` means a full refetch.
 * 4. Fetch on mount, activation and gateway reconnect. While visible,
 *    reconcile every `reconcileIntervalMs` to recover a lost final hint; stop
 *    polling when hidden. Concurrent refreshes are coalesced, and responses
 *    from an older environment epoch are discarded.
 *
 * Unmounting does not cancel backend work: it only stops this client's
 * observation. Remounting rehydrates from a fresh snapshot.
 */
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  type WebAnnotationChangeHint,
  type WebAnnotationListResult,
} from "@orkestrator/protocol/web-annotations";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import {
  getWebAnnotationCache,
  listQueryKey,
  useWebAnnotationStore,
  type ListQuery,
} from "@/stores/webAnnotationStore";
import {
  classifyWebAnnotationError,
  describeWebAnnotationError,
  fetchWebAnnotationCapabilities,
  isTransientWebAnnotationError,
  webAnnotationCommand,
  webAnnotationErrorDetail,
} from "./client";

interface Work {
  full: boolean;
  capabilities: boolean;
  reconcile: boolean;
  allLists: boolean;
  lists: Set<string>;
  annotationIds: Set<string>;
  requestIds: Set<string>;
  targetRevision: number | null;
}

function emptyWork(): Work {
  return {
    full: false,
    capabilities: false,
    reconcile: false,
    allLists: false,
    lists: new Set(),
    annotationIds: new Set(),
    requestIds: new Set(),
    targetRevision: null,
  };
}

function hasWork(work: Work): boolean {
  return (
    work.full ||
    work.capabilities ||
    work.reconcile ||
    work.allLists ||
    work.lists.size > 0 ||
    work.annotationIds.size > 0 ||
    work.requestIds.size > 0 ||
    work.targetRevision !== null
  );
}

export interface WorkRequest {
  full?: boolean;
  /** Re-read capabilities now (e.g. after a rollout change). */
  capabilities?: boolean;
  reconcile?: boolean;
  allLists?: boolean;
  lists?: Iterable<string>;
  annotationIds?: Iterable<string>;
  requestIds?: Iterable<string>;
  targetRevision?: number;
}

/** Capabilities are re-read at most this often, so a rollout change is noticed. */
const CAPABILITY_REFRESH_MS = 30_000;
/** Bounded pre-snapshot buffer; overflow degrades to a full refetch. */
const MAX_BUFFERED_HINTS = WEB_ANNOTATION_LIMITS.hintRingEntries;
const MAX_REQUEST_REFETCH = WEB_ANNOTATION_LIMITS.requestRecoveryBatch;
const THREAD_ENTRY_LIMIT = WEB_ANNOTATION_LIMITS.entryPageItems;

/** Batches per migration run; the backend imports at most 25 drafts per call. */
const MIGRATION_MAX_BATCHES = 40;
/** Pause between batches so a large import does not monopolize the backend. */
const MIGRATION_BATCH_DELAY_MS = 200;
/** Deferred, stalled, or failed imports are retried on a later reconcile. */
const MIGRATION_RETRY_MS = 60_000;

/**
 * Per-environment legacy migration progress for this renderer session:
 * `running` while batches are in flight, then either finished (`retryAt`
 * null) or eligible again once `retryAt` has passed.
 */
const migrations = new Map<string, { running: boolean; retryAt: number | null }>();

async function runLegacyMigration(environmentId: string) {
  let previous: number | null = null;
  let retryAt: number | null = null;
  try {
    for (let batch = 0; ; batch += 1) {
      const status = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.migrate, {
        environmentId,
      });
      if (!status || typeof status !== "object") break;
      useWebAnnotationStore.getState().update(environmentId, () => ({ migration: status }));
      const remaining = status.pendingDrafts;
      // Keep importing while drafts remain and each batch makes progress.
      if (remaining > 0 && (previous === null || remaining < previous)) {
        if (batch + 1 >= MIGRATION_MAX_BATCHES) {
          retryAt = Date.now() + MIGRATION_RETRY_MS;
          break;
        }
        previous = remaining;
        await new Promise((resolve) => setTimeout(resolve, MIGRATION_BATCH_DELAY_MS));
        continue;
      }
      // Drafts with a pending dispatch, or ones that stopped shrinking, are
      // left for a later pass rather than retried in a tight loop.
      if (remaining > 0 || status.deferredDrafts > 0) retryAt = Date.now() + MIGRATION_RETRY_MS;
      break;
    }
  } catch {
    // A failed migration leaves legacy drafts untouched; allow a later retry.
    retryAt = Date.now() + MIGRATION_RETRY_MS;
  }
  const state = migrations.get(environmentId);
  if (state) {
    state.running = false;
    state.retryAt = retryAt;
  }
}

function isNotFound(error: unknown): boolean {
  if (classifyWebAnnotationError(error) === "not-found") return true;
  return /not found|no such|does not exist|unknown annotation|missing/i.test(
    webAnnotationErrorDetail(error).message,
  );
}

function listen<T>(event: string, callback: (payload: T) => void): (() => void) | undefined {
  const api = window.orkestrator;
  if (!api || typeof api.listen !== "function") return undefined;
  try {
    return api.listen<T>(event, callback);
  } catch {
    return undefined;
  }
}

class EnvironmentSync {
  refs = 0;
  visibleRefs = 0;
  epoch = 0;
  phase: "stopped" | "loading" | "ready" = "stopped";
  private buffered: WebAnnotationChangeHint[] = [];
  private bufferOverflow = false;
  private seenRevision = -1;
  private pending = emptyWork();
  private runningEpoch: number | null = null;
  private unlisteners: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly listQueries = new Map<string, { query: ListQuery; refs: number }>();
  readonly threadInterest = new Map<string, number>();
  private threadSeq = new Map<string, number>();

  constructor(readonly environmentId: string) {}

  start() {
    this.epoch += 1;
    this.phase = "loading";
    this.buffered = [];
    this.bufferOverflow = false;
    this.pending = emptyWork();
    // Subscribe first: any change committed while the snapshot is in flight
    // arrives as a buffered hint rather than being lost.
    const hint = listen<WebAnnotationChangeHint>(WEB_ANNOTATIONS_CHANGED_EVENT, (payload) =>
      this.onHint(payload),
    );
    const reconnect = listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      useWebAnnotationStore
        .getState()
        .update(this.environmentId, (cache) =>
          cache.capabilityStatus === "available" ? {} : { capabilityStatus: "unknown" },
        );
      this.phase = this.phase === "stopped" ? "stopped" : "loading";
      this.schedule({ full: true });
    });
    this.unlisteners = [hint, reconnect].filter((value): value is () => void => Boolean(value));
    useWebAnnotationStore.getState().update(this.environmentId, (cache) => ({
      sync: { ...cache.sync, status: "loading" },
    }));
    this.schedule({ full: true });
    this.updateTimer();
  }

  stop() {
    this.epoch += 1;
    this.phase = "stopped";
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    this.buffered = [];
    this.pending = emptyWork();
    this.runningEpoch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  updateTimer() {
    const shouldPoll = this.phase !== "stopped" && this.visibleRefs > 0;
    if (shouldPoll && !this.timer) {
      this.timer = setInterval(() => this.tick(), WEB_ANNOTATION_LIMITS.reconcileIntervalMs);
    } else if (!shouldPoll && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Became visible: reconcile, or retry a snapshot that previously failed. */
  activate() {
    if (this.phase === "ready") this.schedule({ reconcile: true });
    else if (this.phase === "loading" && this.runningEpoch !== this.epoch) {
      this.schedule({ full: true });
    }
  }

  tick() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (this.phase === "loading") this.schedule({ full: true });
    else if (this.phase === "ready") this.schedule({ reconcile: true });
  }

  onHint(hint: WebAnnotationChangeHint) {
    if (!hint || hint.environmentId !== this.environmentId || this.phase === "stopped") return;
    if (this.phase === "loading") {
      if (this.buffered.length >= MAX_BUFFERED_HINTS) this.bufferOverflow = true;
      else this.buffered.push(hint);
      return;
    }
    this.handleHint(hint);
  }

  private handleHint(hint: WebAnnotationChangeHint) {
    const cache = getWebAnnotationCache(this.environmentId);
    if (hint.reset || cache.generation === null || hint.generation !== cache.generation) {
      this.phase = "loading";
      this.schedule({ full: true });
      return;
    }
    if (hint.revision <= this.seenRevision) return;
    if (hint.revision === this.seenRevision + 1) {
      this.seenRevision = hint.revision;
      this.schedule({
        allLists: true,
        annotationIds: hint.annotationIds,
        requestIds: hint.requestIds,
        targetRevision: hint.revision,
      });
      return;
    }
    // A missing revision: ask the backend what changed instead of guessing.
    this.schedule({ reconcile: true });
  }

  schedule(request: WorkRequest) {
    if (this.phase === "stopped") return;
    const work = this.pending;
    if (request.full) work.full = true;
    if (request.capabilities) work.capabilities = true;
    if (request.reconcile) work.reconcile = true;
    if (request.allLists) work.allLists = true;
    for (const key of request.lists ?? []) work.lists.add(key);
    for (const id of request.annotationIds ?? []) work.annotationIds.add(id);
    for (const id of request.requestIds ?? []) work.requestIds.add(id);
    if (request.targetRevision !== undefined) {
      work.targetRevision = Math.max(work.targetRevision ?? -1, request.targetRevision);
    }
    if (this.runningEpoch !== this.epoch) void this.drain();
  }

  private async drain() {
    const epoch = this.epoch;
    this.runningEpoch = epoch;
    try {
      while (hasWork(this.pending) && epoch === this.epoch) {
        const work = this.pending;
        this.pending = emptyWork();
        await this.run(work, epoch);
      }
    } finally {
      if (this.runningEpoch === epoch) this.runningEpoch = null;
    }
  }

  private current(epoch: number) {
    return epoch === this.epoch;
  }

  private setSync(status: "loading" | "ready" | "error", error: string | null = null) {
    useWebAnnotationStore.getState().update(this.environmentId, (cache) => ({
      sync: {
        status,
        error,
        lastSyncedAt: status === "ready" ? Date.now() : cache.sync.lastSyncedAt,
      },
    }));
  }

  /** When capabilities were last fetched; a rollout change is picked up on reconcile. */
  private capabilitiesAt = 0;
  /** Whether the last capability check allowed reads. */
  private readable = false;

  private async ensureCapabilities(epoch: number, refresh = false): Promise<boolean> {
    const cache = getWebAnnotationCache(this.environmentId);
    const stale = refresh || Date.now() - this.capabilitiesAt > CAPABILITY_REFRESH_MS;
    if (cache.capabilityStatus === "available" && !stale) {
      return cache.capabilities?.operations.read ?? false;
    }
    if (cache.capabilityStatus === "unavailable" && !refresh) return false;
    if (cache.capabilityStatus !== "available") {
      useWebAnnotationStore.getState().update(this.environmentId, () => ({
        capabilityStatus: "loading",
      }));
    }
    const result = await fetchWebAnnotationCapabilities(this.environmentId);
    if (!this.current(epoch)) return false;
    this.capabilitiesAt = Date.now();
    if (result.status === "available") {
      useWebAnnotationStore.getState().update(this.environmentId, () => ({
        capabilities: result.capabilities,
        capabilityStatus: "available",
        capabilityReason:
          result.capabilities.storage === "ready"
            ? null
            : (result.capabilities.degradedReason ?? null),
      }));
      this.maybeMigrate(result.capabilities.operations.migration);
      return result.capabilities.operations.read;
    }
    if (result.status === "unavailable") {
      useWebAnnotationStore.getState().update(this.environmentId, () => ({
        capabilities: null,
        capabilityStatus: "unavailable",
        capabilityReason: result.reason,
      }));
      return false;
    }
    // A failed periodic refresh keeps the last known capabilities: being
    // offline is a sync error, not a capability change.
    if (cache.capabilityStatus !== "available") {
      useWebAnnotationStore.getState().update(this.environmentId, () => ({
        capabilityStatus: "error",
        capabilityReason: result.error,
      }));
    }
    throw new Error(result.error);
  }

  /**
   * Legacy import runs server-side in bounded batches. It runs once per
   * environment per session until nothing remains; deferred or failed drafts
   * become eligible again on a reconcile after a retry delay.
   */
  private maybeMigrate(enabled: boolean) {
    if (!enabled) return;
    const state = migrations.get(this.environmentId);
    if (state && (state.running || state.retryAt === null || Date.now() < state.retryAt)) return;
    migrations.set(this.environmentId, { running: true, retryAt: null });
    void runLegacyMigration(this.environmentId);
  }

  private async fetchList(
    key: string,
    query: ListQuery,
    epoch: number,
    options: { install?: boolean } = {},
  ) {
    const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.list, {
      environmentId: this.environmentId,
      filter: query.filter,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    if (!this.current(epoch) || (!options.install && !this.listQueries.has(key))) return null;
    useWebAnnotationStore.getState().installList(
      this.environmentId,
      key,
      {
        total: result.total,
        openOnPage: result.openOnPage ?? null,
        nextCursor: result.nextCursor,
        revision: result.revision,
      },
      result.items,
    );
    return result;
  }

  private async fetchLists(keys: Iterable<string>, epoch: number) {
    const entries = Array.from(keys)
      .map((key) => [key, this.listQueries.get(key)?.query] as const)
      .filter((entry): entry is readonly [string, ListQuery] => Boolean(entry[1]));
    const results = await Promise.all(
      entries.map(([key, query]) =>
        this.fetchList(key, query, epoch).catch(async (error: unknown) => {
          // A cursor tagged with an older snapshot can be rejected after
          // concurrent changes: refetch the first page instead of skipping or
          // duplicating entries, then tell the view to restart there.
          // Only a rejected cursor restarts; a transport failure keeps the
          // page the user is on and surfaces as connection state.
          if (!query.cursor || isTransientWebAnnotationError(error)) throw error;
          const firstPage: ListQuery = { ...query, cursor: null };
          const refreshed = await this.fetchList(listQueryKey(firstPage), firstPage, epoch, {
            install: true,
          });
          if (!this.current(epoch)) return null;
          useWebAnnotationStore.getState().update(this.environmentId, (cache) => {
            const lists = new Map(cache.lists);
            const current = lists.get(key);
            lists.set(key, {
              ids: current?.ids ?? [],
              total: current?.total ?? 0,
              openOnPage: current?.openOnPage ?? null,
              nextCursor: current?.nextCursor ?? null,
              revision: current?.revision ?? -1,
              status: "error",
              error: "stale-cursor",
            });
            return { lists };
          });
          return refreshed;
        }),
      ),
    );
    return results.filter((value): value is WebAnnotationListResult => value !== null);
  }

  async fetchThread(annotationId: string, epoch = this.epoch) {
    const seq = (this.threadSeq.get(annotationId) ?? 0) + 1;
    this.threadSeq.set(annotationId, seq);
    const store = useWebAnnotationStore.getState();
    const existing = getWebAnnotationCache(this.environmentId).threads.get(annotationId);
    if (!existing) {
      store.installThread(this.environmentId, annotationId, {
        data: null,
        status: "loading",
        error: null,
      });
    }
    try {
      const data = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.get, {
        environmentId: this.environmentId,
        annotationId,
        entryLimit: THREAD_ENTRY_LIMIT,
        // The newest page; older history is paged with `beforeSequence`.
        entryWindow: "latest",
      });
      if (!this.current(epoch) || this.threadSeq.get(annotationId) !== seq) return;
      store.installThread(this.environmentId, annotationId, {
        data,
        status: "ready",
        error: null,
      });
    } catch (error) {
      if (!this.current(epoch) || this.threadSeq.get(annotationId) !== seq) return;
      const message = describeWebAnnotationError(error);
      const missing = isNotFound(error);
      const previous = getWebAnnotationCache(this.environmentId).threads.get(annotationId);
      store.installThread(this.environmentId, annotationId, {
        // Keep the last good snapshot readable while offline.
        data: previous?.data ?? null,
        status: missing ? "missing" : "error",
        error: message,
      });
      if (!missing) throw error;
    }
  }

  private async fetchRequests(ids: Iterable<string>, epoch: number) {
    const cache = getWebAnnotationCache(this.environmentId);
    const wanted = Array.from(ids)
      .filter((id) => cache.requests.has(id))
      .slice(0, MAX_REQUEST_REFETCH);
    await Promise.all(
      wanted.map(async (requestId) => {
        const result = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.requestGet, {
          environmentId: this.environmentId,
          requestId,
        });
        if (!this.current(epoch)) return;
        useWebAnnotationStore
          .getState()
          .installRequests(this.environmentId, [result.request], result.results);
      }),
    );
  }

  private async run(work: Work, epoch: number) {
    try {
      const wasReadable = this.readable;
      const readable = await this.ensureCapabilities(epoch, work.capabilities);
      if (!this.current(epoch)) return;
      this.readable = readable;
      if (!readable) {
        this.phase = "ready";
        this.setSync("ready");
        return;
      }
      // Reads just became possible (rollout re-enabled): take a fresh snapshot.
      if (work.full || !wasReadable) {
        await this.fullSnapshot(epoch);
        return;
      }
      if (work.reconcile) {
        this.maybeMigrate(
          getWebAnnotationCache(this.environmentId).capabilities?.operations.migration ?? false,
        );
      }
      let allLists = work.allLists;
      const annotationIds = new Set(work.annotationIds);
      const requestIds = new Set(work.requestIds);
      let target = work.targetRevision;
      if (work.reconcile) {
        const cache = getWebAnnotationCache(this.environmentId);
        const changes = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.changes, {
          environmentId: this.environmentId,
          ...(cache.generation ? { generation: cache.generation } : {}),
          after: Math.max(0, cache.revision),
        });
        if (!this.current(epoch)) return;
        if (changes.resetRequired || changes.generation !== cache.generation) {
          this.phase = "loading";
          await this.fullSnapshot(epoch);
          return;
        }
        if (changes.revision > cache.revision) {
          allLists = true;
          for (const change of changes.changes) {
            for (const id of change.annotationIds) annotationIds.add(id);
            for (const id of change.requestIds) requestIds.add(id);
          }
          target = Math.max(target ?? -1, changes.revision);
        }
      }
      const listKeys = allLists ? Array.from(this.listQueries.keys()) : Array.from(work.lists);
      const threads = Array.from(annotationIds).filter((id) => this.threadInterest.has(id));
      // Requests referenced by a changed annotation's thread come back with
      // the thread snapshot; standalone ones are refetched individually.
      await Promise.all([
        this.fetchLists(listKeys, epoch),
        ...threads.map((id) => this.fetchThread(id, epoch)),
        this.fetchRequests(requestIds, epoch),
      ]);
      if (!this.current(epoch)) return;
      if (target !== null) {
        useWebAnnotationStore.getState().update(this.environmentId, (cache) => ({
          revision: Math.max(cache.revision, target ?? -1),
        }));
        this.seenRevision = Math.max(this.seenRevision, target);
      }
      this.setSync("ready");
    } catch (error) {
      if (!this.current(epoch)) return;
      // Transport failure only: cached domain state stays as it was.
      this.setSync("error", describeWebAnnotationError(error));
    }
  }

  private async fullSnapshot(epoch: number) {
    this.setSync("loading", getWebAnnotationCache(this.environmentId).sync.error);
    const keys = Array.from(this.listQueries.keys());
    let results = await this.fetchLists(keys, epoch);
    if (!this.current(epoch)) return;
    if (results.length === 0) {
      const baseline = await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.list, {
        environmentId: this.environmentId,
        filter: { state: "open" },
        limit: 1,
      });
      if (!this.current(epoch)) return;
      results = [baseline];
    }
    const threads = Array.from(this.threadInterest.keys());
    await Promise.all(threads.map((id) => this.fetchThread(id, epoch)));
    if (!this.current(epoch)) return;
    const generations = new Set(results.map((result) => result.generation));
    const revision = Math.min(...results.map((result) => result.revision));
    const generation = results[0]!.generation;
    useWebAnnotationStore.getState().update(this.environmentId, () => ({ generation, revision }));
    this.seenRevision = revision;
    this.phase = "ready";
    this.setSync("ready");
    const buffered = this.buffered;
    const overflow = this.bufferOverflow;
    this.buffered = [];
    this.bufferOverflow = false;
    if (generations.size > 1 || overflow) {
      this.phase = "loading";
      this.schedule({ full: true });
      return;
    }
    for (const hint of buffered.sort((a, b) => a.revision - b.revision)) this.handleHint(hint);
  }
}

const engines = new Map<string, EnvironmentSync>();

function engine(environmentId: string): EnvironmentSync {
  let current = engines.get(environmentId);
  if (!current) {
    current = new EnvironmentSync(environmentId);
    engines.set(environmentId, current);
  }
  return current;
}

export interface WebAnnotationSyncHandle {
  setVisible(visible: boolean): void;
  release(): void;
}

/**
 * Observe one environment. The first handle subscribes and fetches; the last
 * release stops observation (never backend work). Visible handles poll.
 */
export function acquireWebAnnotationSync(
  environmentId: string,
  options: { visible: boolean },
): WebAnnotationSyncHandle {
  const sync = engine(environmentId);
  let visible = false;
  let released = false;
  sync.refs += 1;
  if (sync.refs === 1) sync.start();
  const setVisible = (next: boolean) => {
    if (released || next === visible) return;
    visible = next;
    sync.visibleRefs += next ? 1 : -1;
    sync.updateTimer();
    // Activation catches up with anything missed while hidden.
    if (next) sync.activate();
  };
  setVisible(options.visible);
  const active = new Set(
    Array.from(engines.values())
      .filter((candidate) => candidate.refs > 0)
      .map((candidate) => candidate.environmentId),
  );
  useWebAnnotationStore.getState().evictInactive(active);
  return {
    setVisible,
    release() {
      if (released) return;
      setVisible(false);
      released = true;
      sync.refs -= 1;
      if (sync.refs === 0) sync.stop();
    },
  };
}

/** Keep a list query fresh while registered; returns its cache key. */
export function registerWebAnnotationList(
  environmentId: string,
  query: ListQuery,
): { key: string; release: () => void } {
  const sync = engine(environmentId);
  const key = listQueryKey(query);
  const existing = sync.listQueries.get(key);
  if (existing) existing.refs += 1;
  else sync.listQueries.set(key, { query, refs: 1 });
  if (sync.phase !== "stopped" && !existing) sync.schedule({ lists: [key] });
  return {
    key,
    release() {
      const entry = sync.listQueries.get(key);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs <= 0) sync.listQueries.delete(key);
    },
  };
}

/** Keep an annotation's thread snapshot fresh while it is open. */
export function registerWebAnnotationThread(environmentId: string, annotationId: string) {
  const sync = engine(environmentId);
  const count = sync.threadInterest.get(annotationId) ?? 0;
  sync.threadInterest.set(annotationId, count + 1);
  if (sync.phase !== "stopped" && count === 0) sync.schedule({ annotationIds: [annotationId] });
  return () => {
    const current = sync.threadInterest.get(annotationId) ?? 0;
    if (current <= 1) sync.threadInterest.delete(annotationId);
    else sync.threadInterest.set(annotationId, current - 1);
  };
}

/**
 * Refetch after a committed mutation. The receipt proves the write; the view
 * is still rebuilt from backend snapshots, not from the request payload.
 */
export function refreshWebAnnotations(environmentId: string, request: WorkRequest = {}) {
  const sync = engines.get(environmentId);
  if (!sync || sync.phase === "stopped") return;
  sync.schedule({ allLists: true, ...request });
}

/** Re-read capabilities for every observed environment (after a rollout change). */
export function refreshAllWebAnnotationCapabilities() {
  for (const sync of engines.values()) {
    if (sync.phase !== "stopped") sync.schedule({ capabilities: true, reconcile: true });
  }
}

export function resetWebAnnotationSyncForTests() {
  for (const sync of engines.values()) sync.stop();
  engines.clear();
  migrations.clear();
  useWebAnnotationStore.getState().reset();
}
