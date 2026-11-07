/**
 * Snapshot + hint synchronization for the web annotation cache
 * ("Synchronization" in docs/architecture/web-page-annotations.md).
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
 *
 * Per node (plan item 3012): environment ids are only unique on their node,
 * so each node scope runs its own engines (one per environment), migration
 * bookkeeping and listeners, writes its own `webAnnotationStore`, and sends
 * its reads to its own node. Every export takes an optional trailing `scope`,
 * the app's command scope when omitted; disposing a scope stops its engines.
 */
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationChangeHint,
  type WebAnnotationListResult,
} from "@orkestrator/protocol/web-annotations";
import { webAnnotationsChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { AnyEventDef, PayloadOf } from "@orkestrator/protocol/contract/event";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import {
  getWebAnnotationCache,
  listQueryKey,
  webAnnotationStore,
  type ListQuery,
  type WebAnnotationEnvironmentCache,
  type WebAnnotationStoreState,
} from "@/stores/webAnnotationStore";
import type { StoreApi } from "zustand/vanilla";
import {
  classifyWebAnnotationError,
  describeWebAnnotationError,
  fetchWebAnnotationCapabilities,
  isTransientWebAnnotationError,
  webAnnotationCommand,
  webAnnotationErrorDetail,
  type WebAnnotationCommandName,
} from "./client";
import type {
  WebAnnotationCommandArgs,
  WebAnnotationCommandResults,
} from "@orkestrator/protocol/web-annotations";

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
type Migrations = Map<string, { running: boolean; retryAt: number | null }>;

/** What an engine needs of its node: the scope, its store and its commands. */
interface SyncNode {
  scope: NodeScope;
  store: StoreApi<WebAnnotationStoreState>;
  migrations: Migrations;
  command<K extends WebAnnotationCommandName>(
    command: K,
    args: WebAnnotationCommandArgs[K],
  ): Promise<WebAnnotationCommandResults[K]>;
}

async function runLegacyMigration(node: SyncNode, environmentId: string) {
  let previous: number | null = null;
  let retryAt: number | null = null;
  try {
    for (let batch = 0; ; batch += 1) {
      const status = await node.command(WEB_ANNOTATION_COMMANDS.migrate, {
        environmentId,
      });
      if (!status || typeof status !== "object" || node.scope.disposed) break;
      node.store.getState().update(environmentId, () => ({ migration: status }));
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
  const state = node.migrations.get(environmentId);
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

/**
 * Listens on `scope`'s client: a defined event by its definition (plan item
 * 7011, typed and decoded), the client's own reconnect notice by name.
 */
function listen<E extends AnyEventDef>(
  scope: NodeScope,
  event: E | typeof NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  callback: (payload: PayloadOf<E>) => void,
): (() => void) | undefined {
  try {
    return typeof event === "string"
      ? scope.client.listenRaw(event, callback as (payload: unknown) => void)
      : scope.client.listen(event, callback);
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

  constructor(
    private readonly node: SyncNode,
    readonly environmentId: string,
  ) {}

  /** This environment's cache on the engine's node. */
  private cache(): WebAnnotationEnvironmentCache {
    return getWebAnnotationCache(this.environmentId, this.node.scope);
  }

  start() {
    this.epoch += 1;
    this.phase = "loading";
    this.buffered = [];
    this.bufferOverflow = false;
    this.pending = emptyWork();
    // Subscribe first: any change committed while the snapshot is in flight
    // arrives as a buffered hint rather than being lost.
    const hint = listen(this.node.scope, webAnnotationsChangedEvent, (payload) =>
      this.onHint(payload as WebAnnotationChangeHint),
    );
    const reconnect = listen(this.node.scope, NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
      this.node.store
        .getState()
        .update(this.environmentId, (cache) =>
          cache.capabilityStatus === "available" ? {} : { capabilityStatus: "unknown" },
        );
      this.phase = this.phase === "stopped" ? "stopped" : "loading";
      this.schedule({ full: true });
    });
    this.unlisteners = [hint, reconnect].filter((value): value is () => void => Boolean(value));
    this.node.store.getState().update(this.environmentId, (cache) => ({
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
    const cache = this.cache();
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
    this.node.store.getState().update(this.environmentId, (cache) => ({
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
    const cache = this.cache();
    const stale = refresh || Date.now() - this.capabilitiesAt > CAPABILITY_REFRESH_MS;
    if (cache.capabilityStatus === "available" && !stale) {
      return cache.capabilities?.operations.read ?? false;
    }
    if (cache.capabilityStatus === "unavailable" && !refresh) return false;
    if (cache.capabilityStatus !== "available") {
      this.node.store.getState().update(this.environmentId, () => ({
        capabilityStatus: "loading",
      }));
    }
    const result = await fetchWebAnnotationCapabilities(this.environmentId, this.node.scope);
    if (!this.current(epoch)) return false;
    this.capabilitiesAt = Date.now();
    if (result.status === "available") {
      this.node.store.getState().update(this.environmentId, () => ({
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
      this.node.store.getState().update(this.environmentId, () => ({
        capabilities: null,
        capabilityStatus: "unavailable",
        capabilityReason: result.reason,
      }));
      return false;
    }
    // A failed periodic refresh keeps the last known capabilities: being
    // offline is a sync error, not a capability change.
    if (cache.capabilityStatus !== "available") {
      this.node.store.getState().update(this.environmentId, () => ({
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
    const state = this.node.migrations.get(this.environmentId);
    if (state && (state.running || state.retryAt === null || Date.now() < state.retryAt)) return;
    this.node.migrations.set(this.environmentId, { running: true, retryAt: null });
    void runLegacyMigration(this.node, this.environmentId);
  }

  private async fetchList(
    key: string,
    query: ListQuery,
    epoch: number,
    options: { install?: boolean } = {},
  ) {
    const result = await this.node.command(WEB_ANNOTATION_COMMANDS.list, {
      environmentId: this.environmentId,
      filter: query.filter,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    if (!this.current(epoch) || (!options.install && !this.listQueries.has(key))) return null;
    this.node.store.getState().installList(
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
          this.node.store.getState().update(this.environmentId, (cache) => {
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
    const store = this.node.store.getState();
    const existing = this.cache().threads.get(annotationId);
    if (!existing) {
      store.installThread(this.environmentId, annotationId, {
        data: null,
        status: "loading",
        error: null,
      });
    }
    try {
      const data = await this.node.command(WEB_ANNOTATION_COMMANDS.get, {
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
      const previous = this.cache().threads.get(annotationId);
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
    const cache = this.cache();
    const wanted = Array.from(ids)
      .filter((id) => cache.requests.has(id))
      .slice(0, MAX_REQUEST_REFETCH);
    await Promise.all(
      wanted.map(async (requestId) => {
        const result = await this.node.command(WEB_ANNOTATION_COMMANDS.requestGet, {
          environmentId: this.environmentId,
          requestId,
        });
        if (!this.current(epoch)) return;
        this.node.store
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
        this.maybeMigrate(this.cache().capabilities?.operations.migration ?? false);
      }
      let allLists = work.allLists;
      const annotationIds = new Set(work.annotationIds);
      const requestIds = new Set(work.requestIds);
      let target = work.targetRevision;
      if (work.reconcile) {
        const cache = this.cache();
        const changes = await this.node.command(WEB_ANNOTATION_COMMANDS.changes, {
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
        this.node.store.getState().update(this.environmentId, (cache) => ({
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
    this.setSync("loading", this.cache().sync.error);
    const keys = Array.from(this.listQueries.keys());
    let results = await this.fetchLists(keys, epoch);
    if (!this.current(epoch)) return;
    if (results.length === 0) {
      const baseline = await this.node.command(WEB_ANNOTATION_COMMANDS.list, {
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
    this.node.store.getState().update(this.environmentId, () => ({ generation, revision }));
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

/** One node's engines and migration progress; disposing the scope stops the engines. */
interface WebAnnotationSyncNode extends SyncNode {
  engines: Map<string, EnvironmentSync>;
}

const syncNodes = defineScopedSlot<WebAnnotationSyncNode>("web-annotation-sync", (scope) => {
  const node: WebAnnotationSyncNode = {
    scope,
    store: scope.store(webAnnotationStore),
    migrations: new Map(),
    engines: new Map(),
    command: (command, args) => webAnnotationCommand(command, args, undefined, scope),
  };
  scope.onDispose("web-annotation-sync", () => {
    for (const sync of node.engines.values()) sync.stop();
    node.engines.clear();
  });
  return node;
});

function engine(node: WebAnnotationSyncNode, environmentId: string): EnvironmentSync {
  let current = node.engines.get(environmentId);
  if (!current) {
    current = new EnvironmentSync(node, environmentId);
    node.engines.set(environmentId, current);
  }
  return current;
}

export interface WebAnnotationSyncHandle {
  setVisible(visible: boolean): void;
  release(): void;
}

/**
 * Observe one environment on `scope`'s node. The first handle subscribes and
 * fetches; the last release stops observation (never backend work). Visible
 * handles poll.
 */
export function acquireWebAnnotationSync(
  environmentId: string,
  options: { visible: boolean },
  scope: NodeScope = appCommandScope(),
): WebAnnotationSyncHandle {
  const node = syncNodes(scope);
  const sync = engine(node, environmentId);
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
    Array.from(node.engines.values())
      .filter((candidate) => candidate.refs > 0)
      .map((candidate) => candidate.environmentId),
  );
  node.store.getState().evictInactive(active);
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
  scope: NodeScope = appCommandScope(),
): { key: string; release: () => void } {
  const sync = engine(syncNodes(scope), environmentId);
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
export function registerWebAnnotationThread(
  environmentId: string,
  annotationId: string,
  scope: NodeScope = appCommandScope(),
) {
  const sync = engine(syncNodes(scope), environmentId);
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
export function refreshWebAnnotations(
  environmentId: string,
  request: WorkRequest = {},
  scope: NodeScope = appCommandScope(),
) {
  if (scope.disposed) return;
  const sync = syncNodes(scope).engines.get(environmentId);
  if (!sync || sync.phase === "stopped") return;
  sync.schedule({ allLists: true, ...request });
}

/** Re-read capabilities for every observed environment of `scope`'s node (after a rollout change). */
export function refreshAllWebAnnotationCapabilities(scope: NodeScope = appCommandScope()) {
  if (scope.disposed) return;
  for (const sync of syncNodes(scope).engines.values()) {
    if (sync.phase !== "stopped") sync.schedule({ capabilities: true, reconcile: true });
  }
}

/** Test seam: stops `scope`'s engines and empties its cache (the app's command scope when omitted). */
export function resetWebAnnotationSyncForTests(scope: NodeScope = appCommandScope()) {
  const node = syncNodes(scope);
  for (const sync of node.engines.values()) sync.stop();
  node.engines.clear();
  node.migrations.clear();
  node.store.getState().reset();
}
