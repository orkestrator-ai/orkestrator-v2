import { useSyncExternalStore } from "react";
import { LOCAL_CONNECTION_ID, type ConnectionList } from "@orkestrator/protocol/connections";
import { getReadCoordinator } from "@/lib/read-coordinator";
import type { GatewayEventStreamConnectionState } from "@/lib/native/web-gateway";

/**
 * Whether the renderer's transport to its backend is known to be down.
 *
 * Two owners can say so, and each reports only what it observes:
 *
 * - `gateway-event-stream`: the browser gateway's authoritative main stream
 *   (browser, iOS, and a workspace realm on another node);
 * - `desktop-connection`: Electron's connection list, for the window's active
 *   connection (a remote transport `reconnecting` or `unreachable`, or the
 *   Local backend having stopped).
 *
 * The transport counts as disconnected while any owner says so. The read
 * coordinator hears every change through `setDisconnected`, so automatic
 * presentation reads pause during the outage and reconcile once when it ends.
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

const disconnectedSince = new Map<TransportConnectivitySource, number>();
const listeners = new Set<() => void>();
let snapshot: TransportConnectivity = CONNECTED;
let now: () => number = Date.now;

function recompute(): void {
  const since = disconnectedSince.size > 0 ? Math.min(...disconnectedSince.values()) : null;
  const next: TransportConnectivity = since === null ? CONNECTED : { disconnected: true, since };
  if (next.disconnected === snapshot.disconnected && next.since === snapshot.since) return;
  const changedConnectivity = next.disconnected !== snapshot.disconnected;
  snapshot = next;
  if (changedConnectivity) getReadCoordinator().setDisconnected(next.disconnected);
  for (const listener of Array.from(listeners)) listener();
}

/** Records what one owner currently observes. Repeated reports are no-ops. */
export function setTransportDisconnected(
  source: TransportConnectivitySource,
  disconnected: boolean,
): void {
  if (disconnected === disconnectedSince.has(source)) return;
  if (disconnected) disconnectedSince.set(source, now());
  else disconnectedSince.delete(source);
  recompute();
}

export function getTransportConnectivity(): TransportConnectivity {
  return snapshot;
}

export function subscribeTransportConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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

/**
 * Follows the browser gateway's main stream. Electron has no
 * `eventStreamConnection`; its owner is the connection list (see `App`).
 */
export function startTransportConnectivity(
  source: EventStreamConnectionSource | undefined = typeof window === "undefined"
    ? undefined
    : window.orkestrator,
): () => void {
  const connection = source?.eventStreamConnection;
  if (!connection) return () => undefined;
  const apply = (state: GatewayEventStreamConnectionState) =>
    setTransportDisconnected("gateway-event-stream", state === "disconnected");
  const unsubscribe = connection.subscribe(apply);
  apply(connection.state());
  return () => {
    unsubscribe();
    setTransportDisconnected("gateway-event-stream", false);
  };
}

/** Test seam: forgets every owner's report and restores the real clock. */
export function resetTransportConnectivityForTests(clock: () => number = Date.now): void {
  disconnectedSince.clear();
  snapshot = CONNECTED;
  now = clock;
  listeners.clear();
}
