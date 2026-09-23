/**
 * Header policy for full-origin preview forwarding, shared by the backend's
 * published-origin proxy and Electron's local ingress.
 *
 * - Upstream sees its private authority (`Host: localhost:<appPort>`), so dev
 *   servers' host checks pass without permissive allowlists. The public origin
 *   travels in a rebuilt, trusted `X-Forwarded-*` set; inbound forwarding
 *   headers are always discarded.
 * - Application `Authorization` and non-reserved cookies pass through
 *   untouched. Transport credentials, reserved cookies, and every
 *   `x-orkestrator-*` header are stripped.
 * - Responses are not rewritten except for hop-by-hop removal, reserved
 *   cookie refusal, host-only cookies, and same-service absolute redirects.
 */
import { isReservedPreviewCookieName } from "./preview-access.js";
import type { HeaderList } from "./preview-http1.js";
import { PREVIEW_LIMITS, type PreviewErrorCategory } from "./preview-services.js";

export interface PreviewHeaderPolicy {
  /** `localhost:<applicationPort>` */
  privateAuthority: string;
  /** Origins the application believes it is served from. The first is canonical. */
  privateOrigins: string[];
  /** Origin the browser actually uses (preview host or local ingress). */
  publicOrigin: string;
  /** Client address for `X-Forwarded-For`, when known. */
  forwardedFor?: string;
  /** Additional request headers to strip (e.g. the local ingress credential). */
  stripRequestHeaders?: readonly string[];
}

const REQUEST_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "host",
  "forwarded",
  "x-real-ip",
]);

const RESPONSE_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "alt-svc",
]);

const UPGRADE_KEEP = new Set([
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

export function pairsFromRaw(rawHeaders: readonly string[]): HeaderList {
  const pairs: HeaderList = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2)
    pairs.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  return pairs;
}

function nominated(headers: HeaderList): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed) names.add(trimmed);
    }
  }
  return names;
}

/** Bounds from step 02: header count and total bytes on each hop. */
export function requestHeaderViolation(
  rawHeaders: readonly string[],
  limits: { headerMaxBytes: number; headerMaxFields: number } = PREVIEW_LIMITS,
): PreviewErrorCategory | null {
  if (rawHeaders.length / 2 > limits.headerMaxFields) return "invalid-request";
  let bytes = 0;
  for (const value of rawHeaders) bytes += value.length + 2;
  if (bytes > limits.headerMaxBytes) return "invalid-request";
  const pairs = pairsFromRaw(rawHeaders);
  const hosts = pairs.filter(([name]) => name.toLowerCase() === "host");
  if (hosts.length > 1) return "invalid-request";
  const hasLength = pairs.some(([name]) => name.toLowerCase() === "content-length");
  const hasEncoding = pairs.some(([name]) => name.toLowerCase() === "transfer-encoding");
  if (hasLength && hasEncoding) return "invalid-request";
  return null;
}

/** Remove reserved transport cookies from a `Cookie` header value. */
export function filterCookieHeader(value: string): string | null {
  const kept = value
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const eq = pair.indexOf("=");
      const name = eq < 0 ? pair : pair.slice(0, eq);
      return !isReservedPreviewCookieName(name);
    });
  return kept.length ? kept.join("; ") : null;
}

/** Read one cookie by exact name from `Cookie` headers. Duplicate names are ambiguous: return null. */
export function readCookie(headers: HeaderList, name: string): string | null {
  const found: string[] = [];
  for (const [header, value] of headers) {
    if (header.toLowerCase() !== "cookie") continue;
    for (const pair of value.split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq > 0 && trimmed.slice(0, eq) === name) found.push(trimmed.slice(eq + 1));
    }
  }
  return found.length === 1 ? found[0]! : null;
}

function mapOrigin(value: string, from: string, to: string): string | null {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return null;
}

export function upstreamRequestHeaders(
  incoming: HeaderList,
  policy: PreviewHeaderPolicy,
  options: { upgrade?: boolean } = {},
): HeaderList {
  const drop = nominated(incoming);
  const strip = new Set((policy.stripRequestHeaders ?? []).map((name) => name.toLowerCase()));
  const privateOrigin = policy.privateOrigins[0] ?? `http://${policy.privateAuthority}`;
  const publicUrl = new URL(policy.publicOrigin);
  const out: HeaderList = [["host", policy.privateAuthority]];
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (options.upgrade && (UPGRADE_KEEP.has(lower) || lower === "connection")) {
      if (lower === "connection") continue;
      out.push([name, value]);
      continue;
    }
    if (REQUEST_HOP_BY_HOP.has(lower) || drop.has(lower) || strip.has(lower)) continue;
    if (lower.startsWith("x-forwarded-") || lower.startsWith("x-orkestrator-")) continue;
    if (lower === "cookie") {
      const filtered = filterCookieHeader(value);
      if (filtered) out.push([name, filtered]);
      continue;
    }
    if (lower === "origin") {
      // Same-service origin maps to the private origin; anything else is kept
      // so the application's own cross-origin checks still apply.
      out.push([name, value === policy.publicOrigin ? privateOrigin : value]);
      continue;
    }
    if (lower === "referer") {
      out.push([name, mapOrigin(value, policy.publicOrigin, privateOrigin) ?? value]);
      continue;
    }
    out.push([name, value]);
  }
  if (options.upgrade) out.push(["connection", "Upgrade"]);
  out.push(["x-forwarded-host", publicUrl.host]);
  out.push(["x-forwarded-proto", publicUrl.protocol.replace(":", "")]);
  if (policy.forwardedFor) out.push(["x-forwarded-for", policy.forwardedFor]);
  return out;
}

/** Drop reserved cookie names; make cookies host-only rather than ever widening them. */
export function rewriteSetCookie(value: string): string | null {
  const parts = value.split(";");
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  const name = (eq < 0 ? first : first.slice(0, eq)).trim();
  if (!name || isReservedPreviewCookieName(name)) return null;
  const attributes = parts.slice(1).filter((attribute) => !/^\s*domain\s*=/i.test(attribute));
  return [first, ...attributes].join(";");
}

export function mapLocation(value: string, policy: PreviewHeaderPolicy): string {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return value; // relative: passes unchanged
  }
  if (!policy.privateOrigins.includes(target.origin)) return value;
  return `${policy.publicOrigin}${target.pathname}${target.search}${target.hash}`;
}

export function downstreamResponseHeaders(
  headers: HeaderList,
  policy: PreviewHeaderPolicy,
  options: { upgrade?: boolean } = {},
): { headers: Record<string, string | string[]>; droppedCookies: number } {
  const drop = nominated(headers);
  const out: Record<string, string | string[]> = {};
  let droppedCookies = 0;
  const add = (name: string, value: string) => {
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  };
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      options.upgrade &&
      (lower === "upgrade" || lower === "connection" || lower.startsWith("sec-websocket-"))
    ) {
      add(lower, value);
      continue;
    }
    if (RESPONSE_HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    if (lower === "set-cookie") {
      const rewritten = rewriteSetCookie(value);
      if (rewritten === null) droppedCookies += 1;
      else add("set-cookie", rewritten);
      continue;
    }
    if (lower === "location" || lower === "content-location") {
      add(lower, mapLocation(value, policy));
      continue;
    }
    add(lower, value);
  }
  return { headers: out, droppedCookies };
}

/**
 * Cross-site defense for cookie-authenticated preview traffic. Unsafe methods
 * and upgrades must come from the service's own origin. A request without an
 * `Origin` from a non-browser client is allowed; `Sec-Fetch-Site: cross-site`
 * is not. `Origin: null` is never accepted for writes.
 */
export function crossSiteViolation(
  method: string,
  headers: HeaderList,
  publicOrigin: string,
  upgrade: boolean,
): boolean {
  const safe = !upgrade && (method === "GET" || method === "HEAD" || method === "OPTIONS");
  if (safe) return false;
  const origins = headers
    .filter(([name]) => name.toLowerCase() === "origin")
    .map(([, value]) => value);
  if (origins.length > 1) return true;
  if (origins.length === 1) return origins[0] !== publicOrigin;
  const fetchSite = headers.find(([name]) => name.toLowerCase() === "sec-fetch-site")?.[1];
  return fetchSite === "cross-site" || fetchSite === "same-site";
}
