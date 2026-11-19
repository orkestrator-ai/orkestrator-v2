import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  PushSubscriptionClient,
  type PushKeyChange,
  type PushClientDiagnostics,
} from "@orkestrator/protocol/push-client";
import {
  PUSH_CHANGED_EVENT,
  PUSH_RESYNC_EVENT,
  PUSH_STREAM_STATE_EVENT,
  parsePushStreamState,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, listenInScope } from "@/lib/node-scope-slots";

const log = createLogger("web.push");

/**
 * The window's push subscriptions to one node (docs/architecture/push-events.md).
 *
 * One {@link PushSubscriptionClient} per node scope, created when the first
 * view subscribes. It hears the transport's `push-stream-state` (what each
 * `gateway.connected` offered, and when the stream drops) and the stream's
 * `push.changed` / `push.resync` frames, and sends the window's whole set with
 * `push_set_subscriptions`.
 *
 * While the document is hidden the set sent is empty, so the backend observes
 * nothing for this window; returning sends it again, and the answer's stamps
 * say what moved meanwhile. A node that offers no push (an older backend, the
 * Electron main-process stream) leaves every key unhealthy, and views keep
 * their polling cadence.
 */
interface PushSlot {
  client: PushSubscriptionClient | null;
  stops: Array<() => void>;
}

const pushSlot = defineScopedSlot<PushSlot>("push-subscriptions", (scope) => {
  const slot: PushSlot = { client: null, stops: [] };
  scope.onDispose("push-subscriptions", () => {
    for (const stop of slot.stops.splice(0)) stop();
    slot.client?.dispose();
    slot.client = null;
  });
  return slot;
});

function attach(scope: NodeScope, slot: PushSlot): PushSubscriptionClient {
  const client = new PushSubscriptionClient({
    setSubscriptions: (args, signal) => backendForScope(scope).setPushSubscriptions(args, signal),
    onListenerError: (error) => log.error("listener.failed", { error: formatLogError(error) }),
  });
  slot.client = client;
  const listenFor = (event: string, handler: (payload: unknown) => void) => {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void listenInScope<unknown>(scope, event, handler)
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        log.error("subscribe.failed", { error: formatLogError(error) });
      });
    slot.stops.push(() => {
      stopped = true;
      unlisten?.();
    });
  };
  listenFor(PUSH_STREAM_STATE_EVENT, (payload) => {
    const state = parsePushStreamState(payload);
    if (!state) return;
    if (state.state === "connected") client.streamConnected(state.offer);
    else client.streamDisconnected();
  });
  listenFor(PUSH_CHANGED_EVENT, (payload) => client.accept(PUSH_CHANGED_EVENT, payload));
  listenFor(PUSH_RESYNC_EVENT, (payload) => client.accept(PUSH_RESYNC_EVENT, payload));
  if (typeof document !== "undefined") {
    const onVisibility = () => client.setPaused(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    slot.stops.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  return client;
}

/** The node's push client, attached on first use. */
export function pushClientFor(scope: NodeScope = appCommandScope()): PushSubscriptionClient {
  const slot = pushSlot(scope);
  return slot.client ?? attach(scope, slot);
}

/** Content-free counters for diagnostics; `null` before any view subscribed. */
export function pushDiagnostics(
  scope: NodeScope = appCommandScope(),
): PushClientDiagnostics | null {
  return pushSlot(scope).client?.diagnostics() ?? null;
}

/** Tests: drop the node's client and its listeners. */
export function resetPushSubscriptionsForTests(scope: NodeScope = appCommandScope()): void {
  const slot = pushSlot(scope);
  for (const stop of slot.stops.splice(0)) stop();
  slot.client?.dispose();
  slot.client = null;
}

const noop = () => undefined;
type SubscriptionState = "healthy" | "recovering" | "polling";
const polling = (): SubscriptionState => "polling";

/**
 * Subscribes a mounted view to one topic key while `enabled`, calling
 * `onChange` for every change the node announces, and answers whether the
 * subscription is healthy: while it is, the view may slow its own polling to
 * the recovery cadence; while it is not, it keeps its old cadence.
 *
 * Unmounting or disabling releases the subscription and nothing else: the
 * work the view was showing goes on (invariant 2).
 */
export function usePushSubscription(
  scope: NodeScope,
  topic: string,
  key: string,
  enabled: boolean,
  onChange: (change: PushKeyChange) => void,
): SubscriptionState {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (!enabled) return;
    return pushClientFor(scope).subscribe(topic, key, (change) => onChangeRef.current(change));
  }, [enabled, key, scope, topic]);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? pushClientFor(scope).onHealthChange(listener) : noop),
    [enabled, scope],
  );
  const state = useCallback((): SubscriptionState => {
    const client = enabled ? pushSlot(scope).client : null;
    if (client?.isHealthy(topic, key)) return "healthy";
    return client?.state() === "recovering" ? "recovering" : "polling";
  }, [enabled, key, scope, topic]);
  return useSyncExternalStore(subscribe, state, polling);
}
