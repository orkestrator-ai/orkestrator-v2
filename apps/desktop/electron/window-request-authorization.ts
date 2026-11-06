import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import type { ConnectionManager } from "./connection-manager.js";

/** Request hooks can outlive their window; a released scope authorizes nothing. */
export function createWindowRequestAuthorization(
  manager: Pick<ConnectionManager, "getRendererRequestAuthorization" | "getBoundConnectionId">,
  scope: string,
  localAuthorization: ((url: string) => string | null) | null,
): {
  authorization: (url: string) => string | null;
  requestOrigin: (url: string) => string | null;
} {
  const local = (url: string): string | null =>
    localAuthorization && manager.getBoundConnectionId(scope) === LOCAL_CONNECTION_ID
      ? localAuthorization(url)
      : null;
  return {
    authorization: (url) => manager.getRendererRequestAuthorization(url, scope) ?? local(url),
    requestOrigin: (url) => (local(url) ? new URL(url).origin : null),
  };
}
