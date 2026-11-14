import {
  isResourceChange,
  isResourceManifestKind,
  isScopedResourceRevisionManifest,
  isScopedResourceSnapshotBatch,
  type ResourceChange,
  type ResourceKind,
  type ResourceManifestKind,
  type ResourceRevisionMap,
  type ScopedResourceRevisionManifest,
  type ScopedResourceSnapshotBatch,
} from "@orkestrator/protocol/resource-events";
import { resourceChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, listenInScope } from "@/lib/node-scope-slots";
import { notifyReadCoordinatorReconnected } from "@/lib/read-coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { nativeSessionInvalidationNamesDiscovery } from "@orkestrator/protocol/native-agent-observation";

const log = createLogger("web.resource-sync");

/**
 * Client half of the backend change feed.
 *
 * The backend announces every committed mutation; subscribers here refetch the
 * named resource through the normal command surface. Nothing in this module
 * applies a payload directly — the announcement carries no body precisely so
 * that a client never has to trust a snapshot delivered out of band.
 *
 * **Self-echo is expected and harmless.** A client that writes hears its own
 * change back and refetches. That cannot loop, because every subscriber here
 * only *reads*: the store that writes back to the backend (pane layout)
 * compares against what it last persisted before enqueuing, so re-applying an
 * identical snapshot enqueues nothing.
 *
 * Pane/tab snapshots are included in the subscriber set. Their active-pane and
 * active-tab pointers are authoritative too, so the most recently selected tab
 * is restored consistently across mobile, web, and desktop reconnects.
 *
 * **Per node (plan item 3014).** Each node scope has its own feed: its
 * handlers, its coalescing timers and its transport. Every function here takes
 * an optional trailing `scope`; without one it acts on the command scope's
 * feed, which is today's single backend. The transport runs as the scoped
 * service `resourceSyncService` (`scope-services.ts`), so a node's change feed
 * lives exactly as long as its scope runs it, and a disposed scope drops its
 * handlers and coalescing timers.
 */

type ResourceHandler = (change: ResourceChange) => unknown | Promise<unknown>;
export interface ResourceResyncRequest {
  /** `null` is the deliberately retained diagnostic/full-recovery path. */
  resources: ReadonlySet<ResourceManifestKind> | null;
  reason: "explicit" | "manifest";
}

type ResourceResyncHandler = (request: ResourceResyncRequest) => void | Promise<void>;

export interface ResourceSyncOptions {
  loadScopedManifest?: (
    knownGeneration: string | undefined,
    cursor: number,
    knownRevisions: Partial<ResourceRevisionMap>,
    highWater?: number,
  ) => Promise<ScopedResourceRevisionManifest>;
  loadScopedSnapshots?: (changes: ResourceChange[]) => Promise<ScopedResourceSnapshotBatch>;
}

/**
 * Safety net for native/local transports that cannot surface a reconnect.
 * Reconnect notifications and revision-gap detection are the primary path.
 */
export const RESOURCE_MANIFEST_INTERVAL_MS = 5 * 60_000;
/** @deprecated Prefer the accurately named manifest interval. */
export const RESOURCE_RESYNC_INTERVAL_MS = RESOURCE_MANIFEST_INTERVAL_MS;

/** Coalescing window for bursts. Reorders announce once per moved record. */
export const RESOURCE_COALESCE_MS = 50;

/**
 * How long the attach-time resync covers a connection announcement that lands
 * beside it.
 *
 * This must be a *window*, not a permanent flag. The transport announcement can
 * be emitted before this module subscribes — the desktop supervisor raises it
 * while the backend starts, long before the renderer tree mounts — so a
 * closure that has never observed one is not necessarily at boot. Treating the
 * first announcement it ever sees as "the boot connect" would suppress the
 * refetch for what is, under the replay protocol, a confirmed replay miss.
 */
export const BOOT_ANNOUNCE_COALESCE_MS = 1_000;

interface PendingDispatch {
  latest: ResourceChange;
  /** Null while only the leading delivery has happened in this window. */
  change: ResourceChange | null;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Delivered on the first announcement rather than after the window: a launch
 * writes its tab early and again when ready, and a trailing timer that every
 * write restarts is what the user waits on to see the tab. Repeats still
 * coalesce into one trailing delivery.
 */
const LEADING_EDGE_RESOURCES: ReadonlySet<ResourceKind> = new Set(["pane-layout"]);

export type ViewSafetyCheckReason = "interval" | "resource-gap";
type ViewSafetyCheckHandler = (reason: ViewSafetyCheckReason) => void;

/** One node's change feed. */
interface ResourceFeed {
  readonly handlers: Map<ResourceKind, Set<ResourceHandler>>;
  readonly resyncHandlers: Set<ResourceResyncHandler>;
  readonly viewSafetyCheckHandlers: Set<ViewSafetyCheckHandler>;
  readonly pending: Map<string, PendingDispatch>;
  readonly transportStops: Set<() => void>;
}

function clearFeed(feed: ResourceFeed): void {
  for (const stop of Array.from(feed.transportStops)) stop();
  for (const { timer } of feed.pending.values()) clearTimeout(timer);
  feed.pending.clear();
  feed.handlers.clear();
  feed.resyncHandlers.clear();
  feed.viewSafetyCheckHandlers.clear();
}

const resourceFeed = defineScopedSlot<ResourceFeed>("resource-feed", (scope) => {
  const feed: ResourceFeed = {
    handlers: new Map(),
    resyncHandlers: new Set(),
    viewSafetyCheckHandlers: new Set(),
    pending: new Map(),
    transportStops: new Set(),
  };
  // No coalescing timer or transport outlives its node (invariant 15).
  scope.onDispose("resource-feed", () => clearFeed(feed));
  return feed;
});

function coalesceKey(change: ResourceChange): string {
  return `${change.resource}\u0000${change.id}\u0000${change.agent ?? ""}\u0000${change.logicalSessionKey ?? ""}`;
}

/**
 * Coalescing keeps the newer change, but a session change's cause can decide
 * what a view reads: a later projection change in the same window must not hide
 * that discovery moved.
 */
function coalesceChanges(older: ResourceChange, newer: ResourceChange): ResourceChange {
  return newer.resource === "native-agent-session" &&
    nativeSessionInvalidationNamesDiscovery(older.cause) &&
    !nativeSessionInvalidationNamesDiscovery(newer.cause)
    ? { ...newer, cause: older.cause }
    : newer;
}

/**
 * Subscribes to one resource kind. Returns an unsubscribe function; callers in
 * React must call it on cleanup or a remounted component double-refetches.
 */
export function onResourceChanged(
  resource: ResourceKind,
  handler: ResourceHandler,
  scope?: NodeScope,
): () => void {
  const { handlers } = resourceFeed(scope);
  let set = handlers.get(resource);
  if (!set) {
    set = new Set();
    handlers.set(resource, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(resource);
  };
}

/**
 * Subscribes to authoritative resync requests. These are raised after the
 * event transport attaches/reconnects, when a sequence gap/reset is detected,
 * and periodically as a last-resort recovery path.
 */
export function onResourceResync(handler: ResourceResyncHandler, scope?: NodeScope): () => void {
  const { resyncHandlers } = resourceFeed(scope);
  resyncHandlers.add(handler);
  return () => {
    resyncHandlers.delete(handler);
  };
}

async function deliverResourceResyncIn(
  feed: ResourceFeed,
  request: ResourceResyncRequest,
): Promise<boolean> {
  let succeeded = true;
  const pending: Promise<void>[] = [];
  for (const handler of Array.from(feed.resyncHandlers)) {
    try {
      pending.push(
        Promise.resolve(handler(request)).catch((error) => {
          succeeded = false;
          log.error("resync-handler.threw", { error: formatLogError(error) });
        }),
      );
    } catch (error) {
      succeeded = false;
      log.error("resync-handler.threw", { error: formatLogError(error) });
    }
  }
  await Promise.all(pending);
  return succeeded;
}

/**
 * Subscribes an ephemeral event-led view (PR monitor, diff statistics, later
 * file/tree/coordinator views) to the existing low-frequency safety cadence.
 *
 * These views are owned by in-memory backend services whose generation and
 * revision semantics differ from the persistent-resource manifest, so they are
 * not added to it. Instead each view runs its own compact conditional read
 * (normally an `unchanged` answer without a body) on the manifest's interval
 * and whenever the resource stream shows a gap — evidence that the transport
 * may also have lost this view's events. No new high-frequency timer exists
 * per feature. Reconnects are handled by each view's own connection listener.
 */
export function onViewSafetyCheck(handler: ViewSafetyCheckHandler, scope?: NodeScope): () => void {
  const { viewSafetyCheckHandlers } = resourceFeed(scope);
  viewSafetyCheckHandlers.add(handler);
  return () => {
    viewSafetyCheckHandlers.delete(handler);
  };
}

/** Runs every registered view safety check. Exported for tests. */
export function requestViewSafetyChecks(reason: ViewSafetyCheckReason, scope?: NodeScope): void {
  runViewSafetyChecks(resourceFeed(scope), reason);
}

function runViewSafetyChecks(feed: ResourceFeed, reason: ViewSafetyCheckReason): void {
  for (const handler of Array.from(feed.viewSafetyCheckHandlers)) {
    try {
      handler(reason);
    } catch (error) {
      log.error("view-safety-check.threw", { reason, error: formatLogError(error) });
    }
  }
}

/** Explicit, intentionally broad diagnostic and last-resort recovery action. */
export function requestResourceResync(scope?: NodeScope): void {
  void deliverResourceResyncIn(resourceFeed(scope), { resources: null, reason: "explicit" });
}

async function deliverIn(feed: ResourceFeed, change: ResourceChange): Promise<boolean> {
  const set = feed.handlers.get(change.resource);
  if (!set) return true;
  let succeeded = true;
  const deliveries: Promise<unknown>[] = [];
  // Snapshot before iterating: a handler may unsubscribe itself.
  for (const handler of Array.from(set)) {
    try {
      deliveries.push(
        Promise.resolve(handler(change)).catch((error) => {
          succeeded = false;
          log.error("handler.threw", { resource: change.resource, error: formatLogError(error) });
        }),
      );
    } catch (error) {
      succeeded = false;
      log.error("handler.threw", { resource: change.resource, error: formatLogError(error) });
    }
  }
  await Promise.all(deliveries);
  return succeeded;
}

/**
 * Routes one change to its subscribers, coalescing repeats for the same
 * resource id. Exported for tests and for the transport below.
 */
export function dispatchResourceChange(change: ResourceChange, scope?: NodeScope): void {
  dispatchInFeed(resourceFeed(scope), change);
}

function dispatchInFeed(feed: ResourceFeed, change: ResourceChange): void {
  const { pending } = feed;
  const key = coalesceKey(change);
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    // Keep the highest revision seen so handlers observe the latest ordering.
    change =
      change.revision < existing.latest.revision
        ? coalesceChanges(change, existing.latest)
        : coalesceChanges(existing.latest, change);
  }
  const leading = !existing && LEADING_EDGE_RESOURCES.has(change.resource);
  if (leading) void deliverIn(feed, change);
  const trailing = leading ? null : change;
  const timer = setTimeout(() => {
    pending.delete(key);
    if (trailing) void deliverIn(feed, trailing);
  }, RESOURCE_COALESCE_MS);
  pending.set(key, { change: trailing, latest: change, timer });
}

/**
 * Stops the feed's transports and drops its handlers and queued dispatches
 * (the command scope's by default). Tests use this to avoid cross-file bleed.
 */
export function resetResourceSync(scope?: NodeScope): void {
  clearFeed(resourceFeed(scope));
}

/**
 * Installs `scope`'s backend event listener (the command scope's by default).
 * Production starts it through `resourceSyncService` (`scope-services.ts`),
 * which passes the node's manifest reads; the returned function
 * detaches it.
 */
export function startResourceSync(
  options: ResourceSyncOptions = {},
  scope: NodeScope = appCommandScope(),
): () => void {
  const feed = resourceFeed(scope);
  const deliver = (change: ResourceChange) => deliverIn(feed, change);
  const deliverResourceResync = (request: ResourceResyncRequest) =>
    deliverResourceResyncIn(feed, request);
  const requestResourceResync = () => {
    void deliverResourceResync({ resources: null, reason: "explicit" });
  };
  const requestViewSafetyChecks = (reason: ViewSafetyCheckReason) =>
    runViewSafetyChecks(feed, reason);
  const loadScopedManifest = options.loadScopedManifest;
  const loadScopedSnapshots = options.loadScopedSnapshots;
  const unlistens: UnlistenFn[] = [];
  let disposed = false;
  let lastRevision: number | null = null;
  let attachedListeners = 0;
  let connectionAnnounced = false;
  let bootResyncAt: number | null = null;
  let knownGeneration: string | undefined;
  let knownRevisions: Partial<ResourceRevisionMap> = {};
  let scopedCursor = 0;
  let manifestRunning = false;
  let manifestRequested = false;

  const deliverChangedResources = async (
    changed: ReadonlySet<ResourceManifestKind>,
  ): Promise<boolean> => {
    let succeeded = true;
    if (changed.has("project")) {
      succeeded = await deliverResourceResync({
        resources: new Set(["project"]),
        reason: "manifest",
      });
    }
    if (succeeded && changed.has("environment")) {
      succeeded = await deliverResourceResync({
        resources: new Set(["environment"]),
        reason: "manifest",
      });
    }
    const dependent = new Set(changed);
    dependent.delete("project");
    dependent.delete("environment");
    if (succeeded && dependent.size > 0) {
      succeeded = await deliverResourceResync({ resources: dependent, reason: "manifest" });
    }
    return succeeded;
  };

  const deliverScopedChanges = async (changes: ResourceChange[]): Promise<boolean> => {
    const latest = new Map<string, ResourceChange>();
    for (const change of changes) {
      const key = coalesceKey(change);
      const previous = latest.get(key);
      if (!previous) latest.set(key, change);
      else if (previous.revision < change.revision)
        latest.set(key, coalesceChanges(previous, change));
      else latest.set(key, coalesceChanges(change, previous));
    }
    const ordered = Array.from(latest.values()).sort((a, b) => a.revision - b.revision);
    let clearPrefetched: () => void = () => {};
    if (loadScopedSnapshots && ordered.length > 0) {
      const prefetched: Array<{
        command: string;
        args: Record<string, unknown>;
        snapshot: unknown;
      }> = [];
      for (let offset = 0; offset < ordered.length; offset += 32) {
        try {
          const batch = await loadScopedSnapshots(ordered.slice(offset, offset + 32));
          if (!isScopedResourceSnapshotBatch(batch)) {
            throw new Error("Invalid scoped resource snapshot batch");
          }
          prefetched.push(
            ...batch.entries.filter(
              (entry): entry is Extract<(typeof batch.entries)[number], { status: "ok" }> =>
                entry.status === "ok",
            ),
          );
        } catch (error) {
          log.warn("snapshots.batch-failed", { error: formatLogError(error) });
        }
      }
      clearPrefetched = scope.prefetched.prime(prefetched);
    }
    const deliverSerial = async (items: ResourceChange[]): Promise<boolean> => {
      for (const change of items) {
        if (!(await deliver(change))) return false;
      }
      return true;
    };
    const deliverConcurrent = async (items: ResourceChange[]): Promise<boolean> => {
      let index = 0;
      let succeeded = true;
      const worker = async (): Promise<void> => {
        while (succeeded && index < items.length) {
          const change = items[index++]!;
          if (!(await deliver(change))) succeeded = false;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
      return succeeded;
    };
    try {
      const projectChanges = ordered.filter((change) => change.resource === "project");
      const environmentChanges = ordered.filter((change) => change.resource === "environment");
      const dependentChanges = ordered.filter(
        (change) => change.resource !== "project" && change.resource !== "environment",
      );
      return (
        (await deliverSerial(projectChanges)) &&
        (await deliverSerial(environmentChanges)) &&
        (await deliverConcurrent(dependentChanges))
      );
    } finally {
      clearPrefetched();
    }
  };

  const requestManifestResync = (): void => {
    if (disposed) return;
    if (!loadScopedManifest) {
      requestResourceResync();
      return;
    }
    manifestRequested = true;
    if (manifestRunning) return;
    manifestRunning = true;
    void (async () => {
      try {
        do {
          manifestRequested = false;
          try {
            let highWater: number | undefined;
            do {
              const scoped = await loadScopedManifest(
                knownGeneration,
                scopedCursor,
                knownRevisions,
                highWater,
              );
              if (disposed) break;
              if (!isScopedResourceRevisionManifest(scoped)) {
                throw new Error("Invalid scoped resource revision manifest");
              }
              highWater ??= scoped.highWater;
              const resetResources = new Set(scoped.resetResources);
              if (scoped.reset || knownGeneration !== scoped.generation) {
                knownRevisions = {};
                scopedCursor = 0;
              }
              /*
               * Only the final page reports project/environment through
               * `resetResources`, and it reports them relative to the
               * revisions this client has already acknowledged. An owner
               * change carried by an intermediate page would therefore be
               * delivered to `onResourceChanged` subscribers alone — which no
               * unmounted UI has — and then acknowledged, so the
               * always-mounted stores would never see it at all. Promote
               * those to the same authoritative resync the final page uses.
               */
              const authoritative = new Set(resetResources);
              if (scoped.hasMore) {
                for (const change of scoped.changes) {
                  if (change.resource === "project" || change.resource === "environment") {
                    authoritative.add(change.resource);
                  }
                }
              }
              let pageSucceeded = true;
              if (authoritative.size > 0) {
                pageSucceeded = await deliverChangedResources(authoritative);
              }
              if (pageSucceeded) {
                pageSucceeded = await deliverScopedChanges(
                  scoped.changes.filter(
                    (change) =>
                      !isResourceManifestKind(change.resource) ||
                      !authoritative.has(change.resource),
                  ),
                );
              }
              if (!pageSucceeded) break;
              knownGeneration = scoped.generation;
              scopedCursor = scoped.cursor;
              for (const [resource, revision] of Object.entries(scoped.revisions)) {
                knownRevisions[resource as ResourceManifestKind] = revision;
              }
              if (!scoped.hasMore) break;
            } while (!disposed);
          } catch (error) {
            if (disposed) break;
            log.warn("manifest.scoped-check-failed", { error: formatLogError(error) });
            await deliverResourceResync({ resources: null, reason: "explicit" });
          }
        } while (!disposed && manifestRequested);
      } finally {
        manifestRunning = false;
      }
    })();
  };

  const attach = (
    event: typeof resourceChangedEvent | typeof NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    handler: (event: { payload: unknown }) => void,
  ): void => {
    // `resource-changed` by its definition (plan item 7011): a payload that
    // does not decode is dropped and logged by name before it gets here.
    const eventName = typeof event === "string" ? event : event.name;
    const listening =
      typeof event === "string"
        ? listenInScope<unknown>(scope, event, (payload) => handler({ payload }))
        : listenInScope(scope, event, (payload) => handler({ payload }));
    void listening
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlistens.push(stop);
        attachedListeners += 1;
        // Wait until both subscriptions exist so the connection notification
        // cannot race past its own listener. The zero-delay task also lets store
        // and hook subscribers mounted in the same React commit attach first.
        if (attachedListeners === 2) {
          setTimeout(() => {
            if (!disposed && !connectionAnnounced) {
              bootResyncAt = Date.now();
              requestManifestResync();
            }
          }, 0);
        }
      })
      .catch((error) => {
        log.error("subscribe.failed", { eventName, error: formatLogError(error) });
      });
  };

  attach(resourceChangedEvent, (event) => {
    if (!isResourceChange(event.payload)) {
      // Shape facts only: the payload itself is never logged.
      log.warn("change.malformed", {
        payloadType: typeof event.payload,
        hasResource:
          typeof event.payload === "object" &&
          event.payload !== null &&
          "resource" in event.payload,
      });
      return;
    }
    const revision = event.payload.revision;
    if (lastRevision !== null && (revision <= lastRevision || revision > lastRevision + 1)) {
      requestManifestResync();
      requestViewSafetyChecks("resource-gap");
    }
    lastRevision = revision;
    dispatchInFeed(feed, event.payload);
  });

  attach(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
    // The web gateway raises this only for a fresh stream or an explicit
    // replay miss/generation change. Retained reconnect gaps are delivered
    // without this notification, so they do not trigger a broad refetch.
    lastRevision = null;
    connectionAnnounced = true;
    // Only the attach-time resync's own window is suppressed. Anything later is
    // a confirmed miss and must refetch even if this closure never saw a boot
    // announcement — see BOOT_ANNOUNCE_COALESCE_MS.
    if (bootResyncAt !== null && Date.now() - bootResyncAt < BOOT_ANNOUNCE_COALESCE_MS) {
      bootResyncAt = null;
      return;
    }
    // Presentation reads reconcile on the same confirmed-miss signal: the
    // coordinator resets read backoff and re-reads active keys, critical first.
    notifyReadCoordinatorReconnected(scope);
    requestManifestResync();
  });

  const intervalId = setInterval(() => {
    requestManifestResync();
    requestViewSafetyChecks("interval");
  }, RESOURCE_MANIFEST_INTERVAL_MS);

  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(intervalId);
    for (const unlisten of unlistens.splice(0)) unlisten();
    feed.transportStops.delete(stop);
  };
  feed.transportStops.add(stop);
  return stop;
}
