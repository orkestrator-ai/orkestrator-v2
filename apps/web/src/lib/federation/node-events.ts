/**
 * Another node's events, for portal views (`@orkestrator/protocol/node-events`).
 *
 * Reads of another node go through the command node (`invoke_on_node`); this
 * is the matching subscription. A view names a node and the events it
 * applies, and is told when to read:
 *
 * - `onResync` runs once the subscription is in place, and again whenever
 *   events from that node may have been missed. Read (or re-read) everything
 *   shown from that node then. Nothing else should trigger the first read, so
 *   a read can never precede the subscription it is an increment base for.
 * - `onEvent` delivers each named event afterwards.
 *
 * One lease per node covers every view's events; it is renewed while any view
 * still subscribes and dropped with the last one. The command node's own
 * resources (shown from its self summary) need no relay and are subscribed
 * on the portal channel directly.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import {
  isRelayedNodeEvent,
  NODE_EVENT_WATCH_RENEW_MS,
  RELAYED_NODE_EVENT,
  type NodeEventWatchResult,
} from "@orkestrator/protocol/node-events";
import { portalStore } from "@/lib/portal/portal-store";
import { portalInvoke, portalListenAuthoritative } from "@/lib/portal/portal-transport";

export interface NodeEventSubscriber {
  /** Exact event names. */
  events: readonly string[];
  onEvent: (event: string, payload: unknown) => void;
  onResync: () => void;
}

interface NodeWatch {
  nodeId: BackendId;
  subscribers: Set<NodeEventSubscriber>;
  /** Chosen here, so a renewal after a lost answer names the same lease. */
  watchId: string;
  /** The events the command node last confirmed watching, joined. */
  confirmedKey: string | null;
  /** Subscribers that have not had their first resync yet. */
  unsynced: Set<NodeEventSubscriber>;
  syncing: boolean;
  /** Invalidates a pending confirmation after renewal or command reconnect. */
  revision: number;
  dirty: boolean;
  renewTimer: ReturnType<typeof setInterval> | null;
}

const watches = new Map<BackendId, NodeWatch>();
let listening: Promise<void> | null = null;

function resync(subscribers: Iterable<NodeEventSubscriber>): void {
  for (const subscriber of subscribers) {
    try {
      subscriber.onResync();
    } catch (error) {
      console.error("[node-events] A resync handler failed:", error);
    }
  }
}

function ensureListening(): Promise<void> {
  listening ??= portalListenAuthoritative<unknown>(
    RELAYED_NODE_EVENT,
    ({ payload }) => {
      if (!isRelayedNodeEvent(payload)) return;
      const watch = watches.get(payload.nodeId);
      if (!watch) return;
      if (payload.kind === "resync") {
        resync(watch.subscribers);
        return;
      }
      for (const subscriber of watch.subscribers) {
        if (!subscriber.events.includes(payload.event)) continue;
        try {
          subscriber.onEvent(payload.event, payload.payload);
        } catch (error) {
          console.error("[node-events] An event handler failed:", error);
        }
      }
    },
    {
      // The command node's own stream reconnected: it may have restarted and
      // lost every lease, and relayed events may have been missed.
      onResync: () => {
        for (const watch of watches.values()) {
          watch.revision++;
          watch.confirmedKey = null;
          for (const subscriber of watch.subscribers) watch.unsynced.add(subscriber);
          void syncWatch(watch);
        }
      },
    },
  ).then(
    () => undefined,
    (error: unknown) => {
      listening = null;
      throw error;
    },
  );
  return listening;
}

function eventsKey(watch: NodeWatch): string {
  const events = new Set<string>();
  for (const subscriber of watch.subscribers)
    for (const event of subscriber.events) events.add(event);
  return [...events].sort().join(",");
}

/** Bring the node's lease in line with its subscribers, then resync whoever needs it. */
async function syncWatch(watch: NodeWatch): Promise<void> {
  if (watch.syncing) {
    watch.dirty = true;
    return;
  }
  watch.syncing = true;
  try {
    do {
      watch.dirty = false;
      if (watches.get(watch.nodeId) !== watch) return;
      const key = eventsKey(watch);
      const revision = watch.revision;
      let live = true;
      try {
        await ensureListening();
        if (watches.get(watch.nodeId) !== watch) return;
        if (key && key !== watch.confirmedKey) {
          const result = await portalInvoke<NodeEventWatchResult>("watch_node_events", {
            nodeId: watch.nodeId,
            prefixes: key.split(","),
            watchId: watch.watchId,
          });
          if (watches.get(watch.nodeId) !== watch) {
            await portalInvoke("unwatch_node_events", { watchId: watch.watchId }).catch(
              () => undefined,
            );
            return;
          }
          if (watch.revision !== revision) continue;
          watch.confirmedKey = key;
          // A lease the command node had lost: whatever it relayed is incomplete.
          if (!result.renewed)
            for (const subscriber of watch.subscribers) watch.unsynced.add(subscriber);
        }
      } catch {
        // An older command node, or one that is unreachable. Views still read
        // once; renewal retries the lease.
        live = false;
      }
      if (watches.get(watch.nodeId) !== watch) return;
      const confirmed = new Set(watch.confirmedKey?.split(",") ?? []);
      const pending = [...watch.unsynced].filter(
        (subscriber) =>
          watch.subscribers.has(subscriber) &&
          (!live || subscriber.events.every((event) => confirmed.has(event))),
      );
      for (const subscriber of pending) watch.unsynced.delete(subscriber);
      resync(pending);
      if (!live) watch.confirmedKey = null;
    } while (watch.dirty);
  } finally {
    watch.syncing = false;
  }
}

function startRenewing(watch: NodeWatch): void {
  watch.renewTimer = setInterval(() => {
    // Renewal resends the same lease; an expired one comes back unrenewed.
    watch.revision++;
    watch.confirmedKey = null;
    void syncWatch(watch);
  }, NODE_EVENT_WATCH_RENEW_MS);
}

function subscribeSelf(subscriber: NodeEventSubscriber): () => void {
  const stops: Array<() => void> = [];
  let released = false;
  let ready = false;
  const resyncWhenReady = () => {
    if (ready && !released) resync([subscriber]);
  };
  void Promise.allSettled(
    subscriber.events.map((event, index) =>
      portalListenAuthoritative<unknown>(
        event,
        ({ payload }) => {
          if (!released) subscriber.onEvent(event, payload);
        },
        { onResync: index === 0 ? resyncWhenReady : () => undefined },
      ).then((stop) => {
        if (released) stop();
        else stops.push(stop);
      }),
    ),
  ).then(() => {
    ready = true;
    resyncWhenReady();
  });
  return () => {
    released = true;
    for (const stop of stops) stop();
  };
}

/** Subscribe a view to the command node's own events, on the portal channel. */
export function subscribeCommandNodeEvents(subscriber: NodeEventSubscriber): () => void {
  return subscribeSelf(subscriber);
}

/** Subscribe a view to another node's events; returns the release function. */
export function subscribeNodeEvents(
  nodeId: BackendId,
  subscriber: NodeEventSubscriber,
): () => void {
  if (nodeId === portalStore.getState().selfId) return subscribeSelf(subscriber);
  let watch = watches.get(nodeId);
  if (!watch) {
    watch = {
      nodeId,
      subscribers: new Set(),
      watchId: crypto.randomUUID(),
      confirmedKey: null,
      unsynced: new Set(),
      syncing: false,
      revision: 0,
      dirty: false,
      renewTimer: null,
    };
    watches.set(nodeId, watch);
    startRenewing(watch);
  }
  const current = watch;
  current.subscribers.add(subscriber);
  current.unsynced.add(subscriber);
  void syncWatch(current);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.subscribers.delete(subscriber);
    current.unsynced.delete(subscriber);
    if (current.subscribers.size > 0) {
      void syncWatch(current);
      return;
    }
    if (current.renewTimer) clearInterval(current.renewTimer);
    watches.delete(nodeId);
    // The lease expires on its own if this is lost.
    void Promise.resolve()
      .then(() => portalInvoke("unwatch_node_events", { watchId: current.watchId }))
      .catch(() => undefined);
  };
}

/** Test seam. */
export function resetNodeEventsForTests(): void {
  for (const watch of watches.values()) if (watch.renewTimer) clearInterval(watch.renewTimer);
  watches.clear();
  listening = null;
}
