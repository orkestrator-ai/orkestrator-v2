import type { KeyObject } from "node:crypto";
import {
  BRIDGE_AUTHORITY_HEADER,
  bridgeAuthorityPrivateKey,
  bridgeRequestNeedsAuthority,
  isBridgeAuthorityKey,
  signBridgeRequest,
} from "@orkestrator/protocol/node/bridge-authority";

/**
 * The private half of each bridge's authority key, by the token that bridge
 * takes (`bridge-authority.ts`).
 *
 * Keyed by token so the many places that already hold a bridge's token sign
 * with the same lookup, rather than each carrying a second secret alongside it.
 * Filled where a token is minted or read back: a host bridge's start, and a
 * container's root-only credential file. A bridge given no key has no entry,
 * and its requests go unsigned, which is what it expects. A host bridge's key
 * is retained by `LocalServerRuntime` until its token leaves. Only recoverable
 * container keys participate in the bounded least-recently-used cache.
 */
const MAX_KEYS = 1_024;
const keys = new Map<string, KeyObject>();
// Entries are owned by live host runtimes, never evicted by container churn.
const hostKeys = new Map<string, KeyObject>();

export function retainHostBridgeAuthorityKey(token: string): void {
  const key = keys.get(token);
  if (!key) return;
  hostKeys.set(token, key);
  keys.delete(token);
}

export function rememberBridgeAuthorityKey(token: string, privateKey: string): void {
  if (!token || !isBridgeAuthorityKey(privateKey)) return;
  let key: KeyObject;
  try {
    key = bridgeAuthorityPrivateKey(privateKey);
  } catch {
    return;
  }
  keys.delete(token);
  keys.set(token, key);
  while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value!);
}

export function forgetBridgeAuthorityKey(token: string | null | undefined): void {
  if (token) {
    keys.delete(token);
    hostKeys.delete(token);
  }
}

export function hasBridgeAuthorityKey(token: string): boolean {
  return hostKeys.has(token) || keys.has(token);
}

/**
 * The signature header for one request to the bridge taking `token`, or none
 * when that bridge has no key or the request needs none. Only a string body
 * can be signed; every bridge request the backend makes sends JSON text.
 */
export function bridgeAuthorityHeaders(
  token: string,
  method: string | undefined,
  url: string,
  body: unknown,
): Record<string, string> {
  const verb = (method ?? "GET").toUpperCase();
  const key = hostKeys.get(token) ?? keys.get(token);
  if (!key || !bridgeRequestNeedsAuthority(verb, url)) return {};
  // Touch only recoverable cache entries; host keys keep their runtime lifetime.
  if (keys.has(token)) {
    keys.delete(token);
    keys.set(token, key);
  }
  if (body !== undefined && body !== null && typeof body !== "string") return {};
  return {
    [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(key, { method: verb, url, body: body ?? "" }),
  };
}
