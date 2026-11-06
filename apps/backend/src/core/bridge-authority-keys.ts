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
 * leaves with its token (`LocalServerRuntime`); the bound is a backstop, and it
 * evicts the key used least recently.
 */
const MAX_KEYS = 1_024;
const keys = new Map<string, KeyObject>();

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
  if (token) keys.delete(token);
}

export function hasBridgeAuthorityKey(token: string): boolean {
  return keys.has(token);
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
  const key = keys.get(token);
  if (!key || !bridgeRequestNeedsAuthority(verb, url)) return {};
  // Most recently used last, so the bound evicts a key no live bridge is using.
  keys.delete(token);
  keys.set(token, key);
  if (body !== undefined && body !== null && typeof body !== "string") return {};
  return {
    [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(key, { method: verb, url, body: body ?? "" }),
  };
}
