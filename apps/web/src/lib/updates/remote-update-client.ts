import type { GatewayStatusPayload } from "@orkestrator/protocol/updates";
import type { UpdateTransport } from "./update-client";

/** How often an open remote's update panel re-reads its status; jobs poll faster. */
export const REMOTE_STATUS_POLL_MS = 15_000;

/**
 * Update commands on a saved remote connection, whichever connection this
 * window is bound to. Desktop main sends them with that connection's token;
 * there is no event stream for a connection this window does not use, so
 * the panel polls (and polls faster while a job runs, see `useUpdateTarget`).
 */
export function connectionUpdateTransport(connectionId: string): UpdateTransport {
  return {
    key: `connection:${connectionId}`,
    invoke(command, args = {}) {
      const invokeUpdate = window.orkestrator?.connections?.invokeUpdate;
      if (!invokeUpdate) {
        return Promise.reject(new Error("This app cannot update other machines"));
      }
      return invokeUpdate(connectionId, command, args);
    },
    async subscribe(_onStatus, onResync) {
      const timer = setInterval(onResync, REMOTE_STATUS_POLL_MS);
      return () => clearInterval(timer);
    },
  };
}

/** A remote's `/status` handshake; null when it is unreachable or predates it. */
export async function remoteConnectionStatus(
  connectionId: string,
): Promise<GatewayStatusPayload | null> {
  const status = window.orkestrator?.connections?.status;
  if (!status) return null;
  try {
    return await status(connectionId);
  } catch {
    return null;
  }
}
