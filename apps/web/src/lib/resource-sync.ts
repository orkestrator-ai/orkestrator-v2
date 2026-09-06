import {
  isResourceChange,
  isResourceManifestKind,
  isResourceRevisionManifest,
  isScopedResourceRevisionManifest,
  isScopedResourceSnapshotBatch,
  RESOURCE_MANIFEST_KINDS,
  RESOURCE_CHANGED_EVENT,
  type ResourceChange,
  type ResourceKind,
  type ResourceManifestKind,
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
  type ScopedResourceRevisionManifest,
  type ScopedResourceSnapshotBatch,
} from "@orkestrator/protocol/resource-events";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";
import { primePrefetchedCommandResponses } from "@/lib/prefetched-command-responses";

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
 * only *reads*: the two stores that write back to the backend (pane layout and
 * looped review) both compare against what they last persisted before
 * enqueuing, so re-applying an identical snapshot enqueues nothing.
 *
 * Pane/tab snapshots are included in the subscriber set. Their active-pane and
 * active-tab pointers are authoritative too, so the most recently selected tab
 * is restored consistently across mobile, web, and desktop reconnects.
 */

type ResourceHandler = (change: ResourceChange) => unknown | Promise<unknown>;
export interface ResourceResyncRequest {
  /** `null` is the deliberately retained diagnostic/full-recovery path. */
  resources: ReadonlySet<ResourceManifestKind> | null;
  reason: "explicit" | "manifest";
}

type ResourceResyncHandler = (request: ResourceResyncRequest) => void | Promise<void>;

export interface ResourceSyncOptions {
  loadManifest?: (
    knownGeneration?: string,
    knownRevisions?: Partial<ResourceRevisionMap>,
  ) => Promise<ResourceRevisionManifest>;
  loadScopedManifest?: (
    knownGeneration: string | undefined,
    cursor: number,
    knownRevisions: Partial<ResourceRevisionMap>,
    highWater?: number,
  ) => Promise<ScopedResourceRevisionManifest>;
  loadScopedSnapshots?: (changes: ResourceChange[]) => Promise<ScopedResourceSnapshotBatch>;
}

const handlers = new Map<ResourceKind, Set<ResourceHandler>>();
const resyncHandlers = new Set<ResourceResyncHandler>();

/**
 * Safety net for native/local transports that cannot surface a reconnect.
 * Reconnect notifications and revision-gap detection are the primary path.
 */
export const RESOURCE_MANIFEST_INTERVAL_MS = 5 * 60_000;
/** @deprecated Prefer the accurately named manifest interval. */
export const RESOURCE_RESYNC_INTERVAL_MS = RESOURCE_MANIFEST_INTERVAL_MS;

/** Coalescing window for bursts. Reorders announce once per moved record. */
const COALESCE_MS = 50;

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
  change: ResourceChange;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingDispatch>();
const activeTransportStops = new Set<() => void>();

function coalesceKey(change: ResourceChange): string {
  return `${change.resource}\u0000${change.id}\u0000${change.agent ?? ""}\u0000${change.logicalSessionKey ?? ""}`;
}

/**
 * Subscribes to one resource kind. Returns an unsubscribe function; callers in
 * React must call it on cleanup or a remounted component double-refetches.
 */
export function onResourceChanged(resource: ResourceKind, handler: ResourceHandler): () => void {
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
export function onResourceResync(handler: ResourceResyncHandler): () => void {
  resyncHandlers.add(handler);
  return () => {
    resyncHandlers.delete(handler);
  };
}

async function deliverResourceResync(request: ResourceResyncRequest): Promise<boolean> {
  let succeeded = true;
  const pending: Promise<void>[] = [];
  for (const handler of Array.from(resyncHandlers)) {
    try {
      pending.push(
        Promise.resolve(handler(request)).catch((error) => {
          succeeded = false;
          console.error("[resource-sync] Resync handler threw:", error);
        }),
      );
    } catch (error) {
      succeeded = false;
      console.error("[resource-sync] Resync handler threw:", error);
    }
  }
  await Promise.all(pending);
  return succeeded;
}

/** Explicit, intentionally broad diagnostic and last-resort recovery action. */
export function requestResourceResync(): void {
  void deliverResourceResync({ resources: null, reason: "explicit" });
}

async function deliver(change: ResourceChange): Promise<boolean> {
  const set = handlers.get(change.resource);
  if (!set) return true;
  let succeeded = true;
  const deliveries: Promise<unknown>[] = [];
  // Snapshot before iterating: a handler may unsubscribe itself.
  for (const handler of Array.from(set)) {
    try {
      deliveries.push(
        Promise.resolve(handler(change)).catch((error) => {
          succeeded = false;
          console.error(`[resource-sync] Handler for ${change.resource} threw:`, error);
        }),
      );
    } catch (error) {
      succeeded = false;
      console.error(`[resource-sync] Handler for ${change.resource} threw:`, error);
    }
  }
  await Promise.all(deliveries);
  return succeeded;
}

/**
 * Routes one change to its subscribers, coalescing repeats for the same
 * resource id. Exported for tests and for the transport below.
 */
export function dispatchResourceChange(change: ResourceChange): void {
  const key = coalesceKey(change);
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    // Keep the highest revision seen so handlers observe the latest ordering.
    if (change.revision < existing.change.revision) change = existing.change;
  }
  const timer = setTimeout(() => {
    pending.delete(key);
    void deliver(change);
  }, COALESCE_MS);
  pending.set(key, { change, timer });
}

/** Drops queued dispatches. Tests use this to avoid cross-file bleed. */
export function resetResourceSync(): void {
  for (const stop of Array.from(activeTransportStops)) stop();
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  handlers.clear();
  resyncHandlers.clear();
}

/**
 * Installs the backend event listener. Call once at app start; the returned
 * function detaches it.
 */
export function startResourceSync(options: ResourceSyncOptions = {}): () => void {
  const loadManifest = options.loadManifest;
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
  let scopedDisabled = false;
  let scopedSnapshotsDisabled = false;
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
      if (!previous || previous.revision < change.revision) latest.set(key, change);
    }
    const ordered = Array.from(latest.values()).sort((a, b) => a.revision - b.revision);
    let clearPrefetched: () => void = () => {};
    if (loadScopedSnapshots && !scopedSnapshotsDisabled && ordered.length > 0) {
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
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("Unknown backend command: get_scoped_resource_snapshots")) {
            scopedSnapshotsDisabled = true;
            break;
          }
          console.warn(
            "[resource-sync] Scoped snapshot batch failed; using individual reads:",
            error,
          );
        }
      }
      clearPrefetched = primePrefetchedCommandResponses(prefetched);
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
    if (!loadManifest && !loadScopedManifest) {
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
          if (loadScopedManifest && !scopedDisabled) {
            try {
              let highWater: number | undefined;
              let pageSucceeded = true;
              do {
                const scoped = await loadScopedManifest(
                  knownGeneration,
                  scopedCursor,
                  knownRevisions,
                  highWater,
                );
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
              if (pageSucceeded) continue;
              continue;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (
                message.includes("Unknown backend command: get_scoped_resource_revision_manifest")
              ) {
                scopedDisabled = true;
              } else {
                console.warn(
                  "[resource-sync] Scoped manifest check failed; using full reconciliation:",
                  error,
                );
                await deliverResourceResync({ resources: null, reason: "explicit" });
                continue;
              }
            }
          }
          if (!loadManifest) {
            await deliverResourceResync({ resources: null, reason: "explicit" });
            continue;
          }
          let manifest: ResourceRevisionManifest;
          try {
            manifest = await loadManifest(knownGeneration, knownRevisions);
            if (!isResourceRevisionManifest(manifest)) {
              throw new Error("Invalid resource revision manifest");
            }
          } catch (error) {
            if (disposed) break;
            console.warn(
              "[resource-sync] Manifest check failed; using full reconciliation:",
              error,
            );
            await deliverResourceResync({ resources: null, reason: "explicit" });
            continue;
          }
          if (disposed) break;

          const changed = new Set<ResourceManifestKind>();
          if (manifest.reset) {
            for (const resource of RESOURCE_MANIFEST_KINDS) changed.add(resource);
          }
          for (const resource of Object.keys(manifest.revisions)) {
            changed.add(resource as ResourceManifestKind);
          }

          const succeeded = await deliverChangedResources(changed);
          if (!succeeded) continue;

          if (manifest.reset || knownGeneration !== manifest.generation) {
            knownRevisions = {};
          }
          knownGeneration = manifest.generation;
          for (const [resource, revision] of Object.entries(manifest.revisions)) {
            knownRevisions[resource as ResourceManifestKind] = revision;
          }
        } while (!disposed && manifestRequested);
      } finally {
        manifestRunning = false;
      }
    })();
  };

  const attach = (event: string, handler: (event: { payload: unknown }) => void): void => {
    void listen<unknown>(event, handler)
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
        console.error(`[resource-sync] Failed to subscribe to ${event}:`, error);
      });
  };

  attach(RESOURCE_CHANGED_EVENT, (event) => {
    if (!isResourceChange(event.payload)) {
      console.warn("[resource-sync] Dropping malformed resource-changed payload:", event.payload);
      return;
    }
    const revision = event.payload.revision;
    if (lastRevision !== null && (revision <= lastRevision || revision > lastRevision + 1)) {
      requestManifestResync();
    }
    lastRevision = revision;
    dispatchResourceChange(event.payload);
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
    requestManifestResync();
  });

  const intervalId = setInterval(() => {
    requestManifestResync();
  }, RESOURCE_MANIFEST_INTERVAL_MS);

  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(intervalId);
    for (const unlisten of unlistens.splice(0)) unlisten();
    activeTransportStops.delete(stop);
  };
  activeTransportStops.add(stop);
  return stop;
}
