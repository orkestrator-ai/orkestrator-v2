import {
  isResourceChange,
  isResourceRevisionManifest,
  RESOURCE_MANIFEST_KINDS,
  RESOURCE_CHANGED_EVENT,
  type ResourceChange,
  type ResourceKind,
  type ResourceManifestKind,
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
} from "@orkestrator/protocol/resource-events";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type UnlistenFn } from "@/lib/native/events";

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

type ResourceHandler = (change: ResourceChange) => void;
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
  return `${change.resource}\u0000${change.id}`;
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
  for (const handler of [...resyncHandlers]) {
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

function deliver(change: ResourceChange): void {
  const set = handlers.get(change.resource);
  if (!set) return;
  // Snapshot before iterating: a handler may unsubscribe itself.
  for (const handler of [...set]) {
    try {
      handler(change);
    } catch (error) {
      console.error(`[resource-sync] Handler for ${change.resource} threw:`, error);
    }
  }
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
    deliver(change);
  }, COALESCE_MS);
  pending.set(key, { change, timer });
}

/** Drops queued dispatches. Tests use this to avoid cross-file bleed. */
export function resetResourceSync(): void {
  for (const stop of [...activeTransportStops]) stop();
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
  const unlistens: UnlistenFn[] = [];
  let disposed = false;
  let lastRevision: number | null = null;
  let attachedListeners = 0;
  let connectionAnnounced = false;
  let bootResyncAt: number | null = null;
  let knownGeneration: string | undefined;
  let knownRevisions: Partial<ResourceRevisionMap> = {};
  let manifestRunning = false;
  let manifestRequested = false;

  const requestManifestResync = (): void => {
    if (disposed) return;
    if (!loadManifest) {
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

          // Collection ownership is layered. Projects must exist before their
          // environment lists can be refreshed, and environments must exist
          // before session/queue/review/pane stores enumerate them. Running the
          // phases in this order is what makes a generation reset converge a
          // client that was inactive while whole scopes were added or removed.
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
            succeeded = await deliverResourceResync({
              resources: dependent,
              reason: "manifest",
            });
          }
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
