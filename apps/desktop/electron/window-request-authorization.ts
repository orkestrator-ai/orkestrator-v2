import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import type { ConnectionManager } from "./connection-manager.js";

/** The part of `ConnectionManager` request authorization uses. */
export type RequestAuthorizationManager = Pick<
  ConnectionManager,
  "getRendererRequestAuthorization" | "getBoundConnectionId" | "getGatewayBaseUrl"
>;

/**
 * A window's scopes as its renderer's requests see them: the command scope
 * and its node scopes (`node-scopes.ts`). Read on every request, so a scope
 * opened or released later is matched, or not, from then on.
 */
export interface RequestAuthorizationWindow {
  scope: string;
  nodes: ReadonlyMap<string, { scope: string }>;
}

/**
 * Length of the gateway path a scope's bearer is confined to
 * (`<base path>/__orkestrator/`, as `getRendererRequestAuthorization` checks),
 * or -1 when the scope has no gateway now.
 */
function gatewayPrefixLength(manager: RequestAuthorizationManager, scope: string): number {
  try {
    const baseUrl = manager.getGatewayBaseUrl(scope);
    if (!baseUrl) return -1;
    return `${new URL(baseUrl).pathname.replace(/\/$/, "")}/__orkestrator/`.length;
  } catch {
    return -1;
  }
}

/**
 * The bearer for a request from the window's renderer: the scope whose
 * `(origin, path prefix)` matches the URL with the longest prefix. A relay
 * node scope lives under the command scope's own prefix
 * (`/__orkestrator/nodes/<id>/__orkestrator/` inside `/__orkestrator/`), so
 * the first match would hand the command bearer to the leaf's paths. On a
 * tie the command scope wins.
 */
export function resolveWindowRequestAuthorization(
  manager: RequestAuthorizationManager,
  context: RequestAuthorizationWindow,
  url: string,
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  const scopes = [context.scope, ...Array.from(context.nodes.values(), (record) => record.scope)];
  for (const scope of scopes) {
    const authorization = manager.getRendererRequestAuthorization(url, scope);
    if (!authorization) continue;
    const length = gatewayPrefixLength(manager, scope);
    if (best === null || length > bestLength) {
      best = authorization;
      bestLength = length;
    }
  }
  return best;
}

/**
 * One request authorizer per window, over its command scope and every node
 * scope. Request hooks can outlive their window; a released scope authorizes
 * nothing.
 */
export function createWindowRequestAuthorization(
  manager: RequestAuthorizationManager,
  context: RequestAuthorizationWindow,
  localAuthorization: ((url: string) => string | null) | null,
): {
  authorization: (url: string) => string | null;
  requestOrigin: (url: string) => string | null;
} {
  const local = (url: string): string | null =>
    localAuthorization && manager.getBoundConnectionId(context.scope) === LOCAL_CONNECTION_ID
      ? localAuthorization(url)
      : null;
  return {
    authorization: (url) => resolveWindowRequestAuthorization(manager, context, url) ?? local(url),
    requestOrigin: (url) => (local(url) ? new URL(url).origin : null),
  };
}
