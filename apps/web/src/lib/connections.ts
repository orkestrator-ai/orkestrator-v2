import type { ConnectionList } from "@orkestrator/protocol/connections";

const CONNECTIONS_CHANGED_EVENT = "orkestrator:connections-changed";

export function publishConnections(list: ConnectionList): void {
  window.dispatchEvent(
    new CustomEvent<ConnectionList>(CONNECTIONS_CHANGED_EVENT, { detail: list }),
  );
}

export function subscribeToConnections(callback: (list: ConnectionList) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<ConnectionList>).detail);
  window.addEventListener(CONNECTIONS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(CONNECTIONS_CHANGED_EVENT, listener);
}
