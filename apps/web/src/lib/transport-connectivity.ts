import { useSyncExternalStore } from "react";
import { LOCAL_CONNECTION_ID, type ConnectionList } from "@orkestrator/protocol/connections";
import type { NodeConnectionState } from "@orkestrator/protocol/node-client";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { commandEventStreamConnection } from "@/lib/node-scope/command-client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedService } from "@/lib/node-scope/scoped-service";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import type { GatewayEventStreamConnectionState } from "@/lib/native/web-gateway";
import { readCoordinatorFor } from "@/lib/read-coordinator";

/**
 * Whether a node's transport is known to be down, per node scope, plus the
 * window aggregate the title bar and banner show (plan item 3014, report
 * §7.4).
 *
 * Two owners can say so for a node, and each reports only what it observes:
 *
 * - `gateway-event-stream`: the node's authoritative main stream (for the
 *   command scope the browser gateway's, in the browser and on iOS; for any
 *   other scope its client's
 *   `connection`);
 * - `desktop-connection`: Electron's connection list, for the window's active
 *   connection (a remote transport `reconnecting` or `unreachable`, or the
 *   Local backend having stopped). Only the command scope has one.
 *
 * A node counts as disconnected while any of its owners says so. That node's
 * read coordinator hears every change through `setDisconnected`, so its
 * automatic presentation reads pause during the outage and reconcile once
 * when it ends; other nodes' reads carry on.
 *
 * The window aggregate is disconnected while any open node is, since the
 * earliest outage began.
 *
 * Browser `offline` is deliberately not an owner: a local desktop backend
 * stays reachable without internet.
 */
export type TransportConnectivitySource = "gateway-event-stream" | "desktop-connection";

export interface TransportConnectivity {
  disconnected: boolean;
  /** Wall-clock ms when the current outage began; null while connected. */
  since: number | null;
}

const CONNECTED: TransportConnectivity = { disconnected: false, since: null };

interface NodeConnectivity {
  readonly disconnectedSince: Map<TransportConnectivitySource, number>;
  readonly listeners: Set<() => void>;
  snapshot: TransportConnectivity;
}

/** Window-level: the clock, and the aggregate's listeners and last snapshot. */
const windowListeners = new Set<() => void>();
let windowSnapshot: TransportConnectivity = CONNECTED;
let now: () => number = Date.now;

const nodeConnectivity = defineScopedStore<NodeConnectivity>("transport-connectivity", (scope) => {
  const state: NodeConnectivity = {
    disconnectedSince: new Map(),
    listeners: new Set(),
    snapshot: CONNECTED,
  };
  // A closing node no longer counts towards the window's outage.
  scope.onDispose("transport-connectivity", () => {
    const wasDisconnected = state.snapshot.disconnected;
    state.disconnectedSince.clear();
    state.snapshot = CONNECTED;
    state.listeners.clear();
    if (wasDisconnected) notifyWindow();
  });
  return () => state;
});

function appCommandScope(): NodeScope {
  return getWindowScope().commandScope();
}

function connectivityOf(scope: NodeScope): NodeConnectivity {
  return scope.store(nodeConnectivity).getState();
}

function aggregate(): TransportConnectivity {
  let since: number | null = null;
  for (const scope of getWindowScope().nodeScopes.get()) {
    if (scope.disposed) continue;
    const node = connectivityOf(scope).snapshot;
    if (node.since !== null && (since === null || node.since < since)) since = node.since;
  }
  return since === null ? CONNECTED : { disconnected: true, since };
}

function notifyWindow(): void {
  const next = aggregate();
  if (next.disconnected === windowSnapshot.disconnected && next.since === windowSnapshot.since) {
    return;
  }
  windowSnapshot = next;
  for (const listener of Array.from(windowListeners)) listener();
}

function recompute(scope: NodeScope, state: NodeConnectivity): void {
  const values = Array.from(state.disconnectedSince.values());
  const since = values.length > 0 ? Math.min(...values) : null;
  const next: TransportConnectivity = since === null ? CONNECTED : { disconnected: true, since };
  const previous = state.snapshot;
  if (next.disconnected === previous.disconnected && next.since === previous.since) return;
  state.snapshot = next;
  if (next.disconnected !== previous.disconnected) {
    readCoordinatorFor(scope).setDisconnected(next.disconnected);
  }
  for (const listener of Array.from(state.listeners)) listener();
  notifyWindow();
}

/**
 * Records what one owner currently observes for `scope`'s node (the command
 * scope by default). Repeated reports, and reports for a disposed scope, are
 * no-ops.
 */
export function setTransportDisconnected(
  source: TransportConnectivitySource,
  disconnected: boolean,
  scope: NodeScope = appCommandScope(),
): void {
  if (scope.disposed) return;
  const state = connectivityOf(scope);
  if (disconnected === state.disconnectedSince.has(source)) return;
  if (disconnected) state.disconnectedSince.set(source, now());
  else state.disconnectedSince.delete(source);
  recompute(scope, state);
}

/** One node's connectivity. */
export function getNodeConnectivity(scope: NodeScope): TransportConnectivity {
  return scope.disposed ? CONNECTED : connectivityOf(scope).snapshot;
}

export function subscribeNodeConnectivity(scope: NodeScope, listener: () => void): () => void {
  if (scope.disposed) return () => undefined;
  const { listeners } = connectivityOf(scope);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The window aggregate: disconnected while any open node is. */
export function getTransportConnectivity(): TransportConnectivity {
  // Kept current by every node change; recomputed here too so a reader that
  // subscribed nothing (or a replaced window scope in tests) is never stale.
  const next = aggregate();
  if (next.disconnected !== windowSnapshot.disconnected || next.since !== windowSnapshot.since) {
    windowSnapshot = next;
  }
  return windowSnapshot;
}

export function subscribeTransportConnectivity(listener: () => void): () => void {
  windowListeners.add(listener);
  return () => {
    windowListeners.delete(listener);
  };
}

/** The window aggregate, for the title bar and the connection banner. */
export function useTransportConnectivity(): TransportConnectivity {
  return useSyncExternalStore(
    subscribeTransportConnectivity,
    getTransportConnectivity,
    getTransportConnectivity,
  );
}

/**
 * Whether Electron's connection list says this window's active connection is
 * down. `connecting` and `authenticating` are not outages (a first connect, or
 * a credential prompt the user is answering), and an authentication failure
 * is reported by the reads themselves rather than hidden behind a pause.
 */
export function connectionListDisconnected(list: ConnectionList): boolean {
  if (list.activeConnectionId === LOCAL_CONNECTION_ID) return list.localAvailable === false;
  const active = list.connections.find((connection) => connection.id === list.activeConnectionId);
  return active?.transport === "reconnecting" || active?.transport === "unreachable";
}

interface EventStreamConnectionSource {
  eventStreamConnection?: {
    state(): GatewayEventStreamConnectionState;
    subscribe(listener: (state: GatewayEventStreamConnectionState) => void): () => void;
  };
}

/** `lapsed` and `failed` are outages; `connecting` may be a first connect. */
function streamStateOf(state: NodeConnectionState): GatewayEventStreamConnectionState {
  return state === "lapsed" || state === "failed" ? "disconnected" : "connected";
}

/**
 * Where `scope`'s main-stream state comes from. The app's command scope reads
 * the browser gateway's raw state (Electron has none; its owner is the
 * connection list, see `App`); any other scope its client's `connection`.
 */
function eventStreamSourceFor(scope: NodeScope): EventStreamConnectionSource {
  if (scope === appCommandScope()) {
    return { eventStreamConnection: commandEventStreamConnection() };
  }
  const connection = scope.client.connection;
  return {
    eventStreamConnection: {
      state: () => streamStateOf(connection.get()),
      subscribe: (listener) => connection.subscribe((state) => listener(streamStateOf(state))),
    },
  };
}

/**
 * Follows a node's main stream (the command scope's by default). Returns the
 * stop, which forgets the stream's report.
 */
export function startTransportConnectivity(
  source?: EventStreamConnectionSource,
  scope: NodeScope = appCommandScope(),
): () => void {
  const connection = (source ?? eventStreamSourceFor(scope)).eventStreamConnection;
  if (!connection) return () => undefined;
  const apply = (state: GatewayEventStreamConnectionState) =>
    setTransportDisconnected("gateway-event-stream", state === "disconnected", scope);
  const unsubscribe = connection.subscribe(apply);
  apply(connection.state());
  return () => {
    unsubscribe();
    setTransportDisconnected("gateway-event-stream", false, scope);
  };
}

/** Per node: follows the scope's main stream while its scope runs it. */
export const transportConnectivityService = defineScopedService(
  "transport-connectivity",
  (scope) => ({ stop: startTransportConnectivity(undefined, scope) }),
);

/**
 * Test seam: forgets every owner's report on every open scope of the app
 * window, drops the aggregate's listeners and restores the real clock.
 */
export function resetTransportConnectivityForTests(clock: () => number = Date.now): void {
  for (const scope of getWindowScope().nodeScopes.get()) {
    if (scope.disposed) continue;
    const state = connectivityOf(scope);
    state.disconnectedSince.clear();
    state.snapshot = CONNECTED;
    state.listeners.clear();
  }
  windowSnapshot = CONNECTED;
  now = clock;
  windowListeners.clear();
}
