import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import {
  GATEWAY_SESSION_IDLE_TTL_MS,
  GATEWAY_SESSION_MAX_LIFETIME_MS,
  MAX_BROWSER_SESSIONS,
} from "../src/gateway";
import {
  BrowserSessionStore,
  clearedGatewayCookies,
  gatewaySessionCookie,
  getGatewayAuthCookie,
  requestIsHttps,
} from "../src/gateway-sessions";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

type SessionInternals = {
  browserSessions: Map<string, { expiresAt: number; absoluteExpiresAt: number }>;
};

async function signIn(
  info: { url: string; token: string },
  headers: Record<string, string> = {},
): Promise<{ cookie: string; setCookie: string }> {
  const response = await requestUrl(`${info.url}__orkestrator/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: `token=${encodeURIComponent(info.token)}`,
  });
  expect(response.status).toBe(303);
  const setCookie = response.headers["set-cookie"]![0]!;
  return { cookie: setCookie.split(";")[0]!, setCookie };
}

function fakeRequest(
  headers: Record<string, string>,
  encrypted = false,
): Pick<IncomingMessage, "headers" | "socket"> {
  return { headers, socket: { encrypted } as unknown as IncomingMessage["socket"] };
}

describe("gateway browser sessions", () => {
  test("a login cookie holds an opaque session, never the durable token", async () => {
    const { gateway, info } = await startGateway();
    const { cookie, setCookie } = await signIn(info);
    const sessions = (gateway as unknown as SessionInternals).browserSessions;

    expect(setCookie).not.toContain(info.token);
    expect(setCookie).toContain("HttpOnly; SameSite=Strict; Path=/");
    // A browser-session cookie: the server owns both deadlines.
    expect(setCookie).not.toContain("Max-Age");
    expect(setCookie).not.toContain("Secure");
    const session = cookie.slice("orkestrator_gateway_auth=".length);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.has(session)).toBe(true);
    const record = sessions.get(session)!;
    expect(record.expiresAt - Date.now()).toBeGreaterThan(GATEWAY_SESSION_IDLE_TTL_MS - 60_000);
    expect(record.absoluteExpiresAt - Date.now()).toBeGreaterThan(
      GATEWAY_SESSION_MAX_LIFETIME_MS - 60_000,
    );

    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers: { cookie } });
    expect(status.status).toBe(200);
  });

  test("marks the cookie Secure when the browser reached the gateway over HTTPS", async () => {
    const { info } = await startGateway();
    const forwarded = await signIn(info, { "x-forwarded-proto": "https" });
    expect(forwarded.setCookie).toContain("; Secure");
    const host = new URL(info.url).host;
    const origin = await signIn(info, { origin: `https://${host}` });
    expect(origin.setCookie).toContain("; Secure");
  });

  test("refuses the durable token in a cookie and clears that cookie", async () => {
    const { info } = await startGateway();
    const legacy = `orkestrator_gateway_auth=${encodeURIComponent(info.token)}`;

    const api = await requestUrl(`${info.url}__orkestrator/status`, {
      headers: { cookie: legacy },
    });
    expect(api.status).toBe(401);
    expect(api.headers["set-cookie"]?.[0]).toContain("orkestrator_gateway_auth=;");
    expect(api.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

    // A browser that held the old cookie lands on the login page with a reason.
    const page = await requestUrl(info.url, {
      headers: { cookie: legacy, accept: "text/html" },
    });
    expect(page.status).toBe(401);
    expect(page.body).toContain("Your browser session has ended");
    expect(page.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    expect(page.body).not.toContain(info.token);

    const settings = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: legacy },
    });
    expect(settings.status).toBe(401);
    expect(settings.body).not.toContain(info.token);
  });

  test("an expired session gets the login page, without clearing a cookie it did not issue", async () => {
    const { gateway, info } = await startGateway();
    const { cookie } = await signIn(info);
    const sessions = (gateway as unknown as SessionInternals).browserSessions;
    const session = cookie.slice("orkestrator_gateway_auth=".length);
    sessions.get(session)!.expiresAt = Date.now() - 1;

    const page = await requestUrl(info.url, { headers: { cookie, accept: "text/html" } });
    expect(page.status).toBe(401);
    expect(page.body).toContain("Your browser session has ended");
    // A newer login in another tab may already have replaced the cookie.
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(sessions.has(session)).toBe(false);

    // The absolute cap is not slideable either.
    const second = await signIn(info);
    const secondSession = second.cookie.slice("orkestrator_gateway_auth=".length);
    sessions.get(secondSession)!.absoluteExpiresAt = Date.now() - 1;
    const renewal = await requestUrl(`${info.url}__orkestrator/session`, {
      method: "POST",
      headers: { cookie: second.cookie },
    });
    expect(renewal.status).toBe(401);
  });

  test("renews a login session only through the session route, on explicit activity", async () => {
    const { gateway, info } = await startGateway();
    const { cookie } = await signIn(info);
    const sessions = (gateway as unknown as SessionInternals).browserSessions;
    const session = cookie.slice("orkestrator_gateway_auth=".length);
    sessions.get(session)!.expiresAt = Date.now() + 1_000;
    const shortExpiry = sessions.get(session)!.expiresAt;

    await requestUrl(`${info.url}__orkestrator/status`, { headers: { cookie } });
    expect(sessions.get(session)!.expiresAt).toBe(shortExpiry);

    const detected = await requestUrl(`${info.url}__orkestrator/session`, { headers: { cookie } });
    expect(detected.status).toBe(200);
    expect(detected.json()).toEqual({ active: true });
    const renewed = await requestUrl(`${info.url}__orkestrator/session`, {
      method: "POST",
      headers: { cookie },
    });
    expect(renewed.status).toBe(204);
    expect(sessions.get(session)!.expiresAt).toBeGreaterThan(Date.now() + 60_000);

    // A bearer client holds no session to renew.
    const bearer = await requestUrl(`${info.url}__orkestrator/session`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(bearer.status).toBe(404);
  });

  test("logout revokes the session on the server, not just in the browser", async () => {
    const { info } = await startGateway();
    const { cookie } = await signIn(info);
    const logout = await requestUrl(`${info.url}__orkestrator/logout`, { headers: { cookie } });
    expect(logout.status).toBe(303);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

    const replayed = await requestUrl(`${info.url}__orkestrator/status`, { headers: { cookie } });
    expect(replayed.status).toBe(401);
  });

  test("token rotation revokes every browser session", async () => {
    const { info } = await startGateway({ env: {} });
    const first = await signIn(info);
    const second = await signIn(info);

    const rotation = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "rotated-token-1234567890" }),
    });
    expect(rotation.status).toBe(200);
    expect(rotation.headers["set-cookie"]).toBeUndefined();

    for (const { cookie } of [first, second]) {
      const status = await requestUrl(`${info.url}__orkestrator/status`, { headers: { cookie } });
      expect(status.status).toBe(401);
    }
  });

  test("gateway settings reveal or rotate the token only for a durable-token bearer", async () => {
    const { gateway, info } = await startGateway({ env: {} });
    const { cookie } = await signIn(info);
    const session = cookie.slice("orkestrator_gateway_auth=".length);

    const attempts: Record<string, string>[] = [{ cookie }, { authorization: `Bearer ${session}` }];
    for (const headers of attempts) {
      const read = await requestUrl(`${info.url}__orkestrator/gateway-settings`, { headers });
      expect(read.status).toBe(403);
      expect(read.body).not.toContain(info.token);
      const rotate = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ token: "cookie-chosen-token-123456" }),
      });
      expect(rotate.status).toBe(403);
    }
    expect((await gateway.getTokenSettings()).token).toBe(info.token);

    // A cookie alongside the bearer changes nothing: the bearer decides.
    const bearer = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { authorization: `Bearer ${info.token}`, cookie },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.json()).toMatchObject({ token: info.token });
  });

  test("agent-test sessions use the same bearer-only rule and their own short TTL", async () => {
    const { gateway, info } = await startGateway({ agentTestMode: true });
    const { cookie } = await signIn(info);
    const sessions = (gateway as unknown as SessionInternals).browserSessions;
    const record = sessions.get(cookie.slice("orkestrator_gateway_auth=".length))!;
    expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    const read = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie },
    });
    expect(read.status).toBe(403);
  });
});

describe("BrowserSessionStore", () => {
  test("expires on the idle clock and the absolute clock, and slides only the idle one", () => {
    const store = new BrowserSessionStore(false);
    const now = 1_000_000;
    const session = store.issue(now);
    expect(store.matches(session, now)).toBe(true);
    expect(store.expiresAt(session)).toBe(now + GATEWAY_SESSION_IDLE_TTL_MS);

    const later = now + GATEWAY_SESSION_IDLE_TTL_MS - 1;
    expect(store.refresh(session, later)).toBe(true);
    expect(store.expiresAt(session)).toBe(later + GATEWAY_SESSION_IDLE_TTL_MS);

    expect(store.matches(session, now + GATEWAY_SESSION_MAX_LIFETIME_MS)).toBe(false);
    expect(store.has(session)).toBe(false);
  });

  test("bounds the number of sessions and revokes them all on demand", () => {
    const store = new BrowserSessionStore(false);
    const issued = Array.from({ length: MAX_BROWSER_SESSIONS + 3 }, () => store.issue());
    expect(store.records.size).toBe(MAX_BROWSER_SESSIONS);
    expect(store.has(issued.at(-1)!)).toBe(true);
    store.revoke(issued.at(-1)!);
    expect(store.has(issued.at(-1)!)).toBe(false);
    store.revokeAll();
    expect(store.records.size).toBe(0);
  });
});

describe("gateway session cookies", () => {
  test("reads the __Host- name first and builds Secure only when asked", () => {
    expect(
      getGatewayAuthCookie({
        cookie: "orkestrator_gateway_auth=plain; __Host-orkestrator_gateway_auth=hosted",
      }),
    ).toBe("hosted");
    expect(getGatewayAuthCookie({ cookie: "orkestrator_gateway_auth=plain" })).toBe("plain");
    expect(gatewaySessionCookie("abc", false)).toBe(
      "orkestrator_gateway_auth=abc; HttpOnly; SameSite=Strict; Path=/",
    );
    expect(gatewaySessionCookie("abc", true)).toEndWith("; Secure");
    expect(clearedGatewayCookies(false)).toHaveLength(1);
    expect(clearedGatewayCookies(true)[1]).toContain("__Host-orkestrator_gateway_auth=;");
  });

  test("detects HTTPS from TLS, the forwarded protocol, or a same-host https Origin", () => {
    const https = (request: Pick<IncomingMessage, "headers" | "socket">) =>
      requestIsHttps(request as IncomingMessage);
    expect(https(fakeRequest({}, true))).toBe(true);
    expect(https(fakeRequest({ "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(https(fakeRequest({ "x-forwarded-proto": "http" }))).toBe(false);
    expect(https(fakeRequest({ host: "desk.ts.net", origin: "https://desk.ts.net" }))).toBe(true);
    expect(https(fakeRequest({ host: "desk.ts.net", origin: "https://other.ts.net" }))).toBe(false);
    expect(https(fakeRequest({ host: "127.0.0.1:1", origin: "http://127.0.0.1:1" }))).toBe(false);
  });
});
