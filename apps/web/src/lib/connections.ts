import type { ConnectionList } from "@orkestrator/protocol/connections";

const CONNECTIONS_CHANGED_EVENT = "orkestrator:connections-changed";
const DESKTOP_CONNECTIONS_CHANGED_EVENT = "desktop-connections-changed";

export function publishConnections(list: ConnectionList): void {
  window.dispatchEvent(
    new CustomEvent<ConnectionList>(CONNECTIONS_CHANGED_EVENT, { detail: list }),
  );
}

export function subscribeToConnections(callback: (list: ConnectionList) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<ConnectionList>).detail);
  window.addEventListener(CONNECTIONS_CHANGED_EVENT, listener);
  const listenDesktop = window.orkestrator?.listen;
  const unlistenDesktop =
    typeof listenDesktop === "function"
      ? listenDesktop<ConnectionList>(DESKTOP_CONNECTIONS_CHANGED_EVENT, callback)
      : undefined;
  return () => {
    window.removeEventListener(CONNECTIONS_CHANGED_EVENT, listener);
    unlistenDesktop?.();
  };
}
