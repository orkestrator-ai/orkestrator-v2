import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  AGENT_TEST_SESSION_IDLE_TTL_MS,
  AGENT_TEST_SESSION_MAX_LIFETIME_MS,
  AUTH_COOKIE,
  GATEWAY_SESSION_IDLE_TTL_MS,
  GATEWAY_SESSION_MAX_LIFETIME_MS,
  MAX_BROWSER_SESSIONS,
  SECURE_AUTH_COOKIE,
  getBearerToken,
  getCookie,
  headerValueToString,
} from "./gateway-internals.js";

/**
 * `expiresAt` slides with explicit browser activity; `absoluteExpiresAt` never
 * moves, so a continuously used browser cannot hold a session open forever.
 */
export interface BrowserSessionRecord {
  expiresAt: number;
  absoluteExpiresAt: number;
}

/**
 * The gateway cookie's value. A browser signed in with the login form or an
 * agent-test link holds an opaque, server-side session id, never the durable
 * gateway token: cookies are scoped by host, not port, so every other service
 * on the same host (a container dev server on a published loopback port)
 * receives the cookie too. A leaked session expires, ends when the backend
 * restarts, and is revoked by token rotation and logout.
 *
 * Over HTTPS only the `__Host-` name counts. The plain name can be set by a
 * sibling host of the same registrable domain or by a plain-HTTP page, so
 * honouring it there would let either toss a browser onto a session it chose.
 * Over plain HTTP the `__Host-` name still comes first: a proxy that sends no
 * `X-Forwarded-Proto` makes later requests without an `Origin` look like HTTP
 * to a browser that signed in over HTTPS.
 */
export function getGatewayAuthCookie(
  request: Pick<IncomingMessage, "headers" | "socket">,
): string | null {
  const { headers } = request;
  const hostPrefixed = getCookie(headers, SECURE_AUTH_COOKIE);
  if (hostPrefixed !== null || requestIsHttps(request)) return hostPrefixed;
  return getCookie(headers, AUTH_COOKIE);
}

/** The credential a request presents: its bearer header, else its gateway cookie. */
export function gatewayRequestCredential(
  request: Pick<IncomingMessage, "headers" | "socket">,
): string | null {
  return getBearerToken(request.headers) ?? getGatewayAuthCookie(request);
}

/**
 * Whether the browser reached this gateway over HTTPS. TLS is normally
 * terminated in front of it (Tailscale Serve), so the forwarded protocol and a
 * same-host `Origin` count too. A request can only claim this for itself: a
 * false claim gets that browser a `__Host-` cookie it may drop and stops that
 * request's plain-name cookie counting, nothing more.
 */
export function requestIsHttps(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  if ((request.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
  const forwarded = headerValueToString(request.headers["x-forwarded-proto"]);
  if (forwarded?.split(",")[0]?.trim().toLowerCase() === "https") return true;
  const origin = headerValueToString(request.headers.origin);
  if (!origin || !request.headers.host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * A browser-session cookie, deliberately without Max-Age: the server owns the
 * sliding idle window and its absolute cap, so a fixed client-side expiry
 * would only be able to disagree with it.
 *
 * Over HTTPS it is `__Host-orkestrator_gateway_auth` with `Secure`, `Path=/`
 * and no `Domain`, the attributes the prefix requires: no sibling host and no
 * plain-HTTP page can set or overwrite it, and it stays off plain-HTTP
 * services on the same host name. Over plain HTTP a `__Host-` cookie cannot
 * be set at all, so the plain name is issued there.
 */
export function gatewaySessionCookie(session: string, secure: boolean): string {
  return secure
    ? `${SECURE_AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Secure`
    : `${AUTH_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Expires both gateway cookie names, whichever scheme the request seems to
 * use: HTTPS detection can miss a request a proxy forwarded without
 * `X-Forwarded-Proto`, and logout must not leave the browser's cookie behind
 * because of it. A browser ignores the `Secure` line on a plain-HTTP page.
 */
export function clearedGatewayCookies(): string[] {
  return [
    `${SECURE_AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Secure; Max-Age=0`,
    `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  ];
}

/**
 * Server-side browser sessions behind the gateway cookie. In memory on
 * purpose: nothing about a session outlives the backend process, so a restart
 * signs every browser out rather than leaving a credential on disk.
 */
export class BrowserSessionStore {
  readonly records = new Map<string, BrowserSessionRecord>();
  private readonly revocationListeners = new Map<string, Set<() => void>>();

  onRevoke(session: string, listener: () => void): () => void {
    let listeners = this.revocationListeners.get(session);
    if (!listeners) this.revocationListeners.set(session, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.revocationListeners.delete(session);
    };
  }

  private readonly idleTtlMs: number;
  private readonly maxLifetimeMs: number;

  constructor(agentTestMode: boolean) {
    this.idleTtlMs = agentTestMode ? AGENT_TEST_SESSION_IDLE_TTL_MS : GATEWAY_SESSION_IDLE_TTL_MS;
    this.maxLifetimeMs = agentTestMode
      ? AGENT_TEST_SESSION_MAX_LIFETIME_MS
      : GATEWAY_SESSION_MAX_LIFETIME_MS;
  }

  has(session: string): boolean {
    return this.records.has(session);
  }

  /** Whether `session` is live now; an expired one is dropped on the way. */
  matches(session: string, now = Date.now()): boolean {
    const record = this.records.get(session);
    if (record === undefined) return false;
    if (record.expiresAt <= now || record.absoluteExpiresAt <= now) {
      this.revoke(session);
      return false;
    }
    return true;
  }

  /** The session's current deadline, whichever clock runs out first. */
  expiresAt(session: string): number | null {
    const record = this.records.get(session);
    return record ? Math.min(record.expiresAt, record.absoluteExpiresAt) : null;
  }

  issue(now = Date.now()): string {
    this.prune(now);
    while (this.records.size >= MAX_BROWSER_SESSIONS) {
      const evicted = this.nearest();
      if (!evicted) break;
      this.revoke(evicted);
    }
    const session = randomBytes(32).toString("base64url");
    this.records.set(session, {
      expiresAt: now + this.idleTtlMs,
      absoluteExpiresAt: now + this.maxLifetimeMs,
    });
    return session;
  }

  refresh(session: string, now = Date.now()): boolean {
    const record = this.records.get(session);
    if (!record || record.expiresAt <= now || record.absoluteExpiresAt <= now) {
      this.revoke(session);
      return false;
    }
    record.expiresAt = Math.min(now + this.idleTtlMs, record.absoluteExpiresAt);
    return true;
  }

  revoke(session: string): void {
    this.records.delete(session);
    const listeners = this.revocationListeners.get(session);
    this.revocationListeners.delete(session);
    if (listeners) for (const listener of Array.from(listeners)) listener();
  }

  /** Token rotation and shutdown: every browser signs in again. */
  revokeAll(): void {
    for (const session of Array.from(this.records.keys())) this.revoke(session);
  }

  prune(now = Date.now()): void {
    for (const [session, record] of Array.from(this.records)) {
      if (record.expiresAt <= now || record.absoluteExpiresAt <= now) {
        this.revoke(session);
      }
    }
  }

  /**
   * The session that dies soonest. `refresh` slides `expiresAt` in place, so
   * Map insertion order no longer tracks the deadline the way it did when every
   * session had one fixed TTL: evicting the first key would drop the session a
   * browser is actively using and keep idle ones that lapse seconds later. Ties
   * keep the earlier-inserted entry.
   */
  private nearest(): string | undefined {
    let nearest: string | undefined;
    let deadline = Number.POSITIVE_INFINITY;
    for (const [session, record] of this.records) {
      const effective = Math.min(record.expiresAt, record.absoluteExpiresAt);
      if (effective < deadline) {
        deadline = effective;
        nearest = session;
      }
    }
    return nearest;
  }
}
