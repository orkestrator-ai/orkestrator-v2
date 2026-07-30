import {
  isResourceChange,
  RESOURCE_CHANGED_EVENT,
  type ResourceChange,
  type ResourceKind,
} from "@orkestrator/protocol/resource-events";
import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  type UnlistenFn,
} from "@/lib/native/events";

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
 * active-tab pointers are preserved locally by the pane-layout binding, so a
 * tab created on mobile appears on desktop without stealing desktop focus.
 */

type ResourceHandler = (change: ResourceChange) => void;
type ResourceResyncHandler = () => void;

const handlers = new Map<ResourceKind, Set<ResourceHandler>>();
const resyncHandlers = new Set<ResourceResyncHandler>();

/**
 * Safety net for native/local transports that cannot surface a reconnect.
 * Reconnect notifications and revision-gap detection are the primary path.
 */
export const RESOURCE_RESYNC_INTERVAL_MS = 60_000;

/** Coalescing window for bursts. Reorders announce once per moved record. */
const COALESCE_MS = 50;

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
export function onResourceChanged(
  resource: ResourceKind,
  handler: ResourceHandler,
): () => void {
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

export function requestResourceResync(): void {
  for (const handler of [...resyncHandlers]) {
    try {
      handler();
    } catch (error) {
      console.error("[resource-sync] Resync handler threw:", error);
    }
  }
}

function deliver(change: ResourceChange): void {
  const set = handlers.get(change.resource);
  if (!set) return;
  // Snapshot before iterating: a handler may unsubscribe itself.
  for (const handler of [...set]) {
    try {
      handler(change);
    } catch (error) {
      console.error(
        `[resource-sync] Handler for ${change.resource} threw:`,
        error,
      );
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
export function startResourceSync(): () => void {
  const unlistens: UnlistenFn[] = [];
  let disposed = false;
  let lastRevision: number | null = null;
  let attachedListeners = 0;
  let connectionAnnounced = false;
  let initialResyncRequested = false;

  const attach = (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): void => {
    void listen<unknown>(event, handler).then((stop) => {
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
            initialResyncRequested = true;
            requestResourceResync();
          }
        }, 0);
      }
    }).catch((error) => {
      console.error(
        `[resource-sync] Failed to subscribe to ${event}:`,
        error,
      );
    });
  };

  attach(RESOURCE_CHANGED_EVENT, (event) => {
    if (!isResourceChange(event.payload)) {
      console.warn(
        "[resource-sync] Dropping malformed resource-changed payload:",
        event.payload,
      );
      return;
    }
    const revision = event.payload.revision;
    if (
      lastRevision !== null
      && (revision <= lastRevision || revision > lastRevision + 1)
    ) {
      requestResourceResync();
    }
    lastRevision = revision;
    dispatchResourceChange(event.payload);
  });

  attach(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
    // The web gateway raises this only for a fresh stream or an explicit
    // replay miss/generation change. Retained reconnect gaps are delivered
    // without this notification, so they do not trigger a broad refetch.
    const isReconnect = connectionAnnounced;
    lastRevision = null;
    connectionAnnounced = true;
    if (isReconnect || !initialResyncRequested) {
      initialResyncRequested = true;
      requestResourceResync();
    }
  });

  const intervalId = setInterval(() => {
    requestResourceResync();
  }, RESOURCE_RESYNC_INTERVAL_MS);

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
