import { describe, expect, test } from "bun:test";
import { TransformStream } from "node:stream/web";

// hono's `streamSSE` constructs a `TransformStream` whose `writable` lacks
// `getWriter` in Bun's test runtime, so the subscribe route would 500 — same
// polyfill as routes/events.test.ts and codex-bridge/src/index-abort.test.ts.
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

// Import the composition root without binding a real port; auth stays enabled
// unless a test overrides it explicitly through `setBridgeAuthForTesting`.
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";

const { app, __testing } = await import("./index.js");
const AUTH_TOKEN = "test-claude-bridge-token";

describe("bridge authentication and origin policy", () => {
  test("protects data routes while leaving only the minimal process health public", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      expect((await app.request("/global/auth-check")).status).toBe(401);
      expect((await app.request("/global/auth-check", {
        headers: { Authorization: "Bearer wrong" },
      })).status).toBe(401);
      expect((await app.request("/global/auth-check", {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })).status).toBe(200);
      expect((await app.request("/global/auth-check", {
        headers: { "X-Orkestrator-Claude-Token": AUTH_TOKEN },
      })).status).toBe(200);
      expect((await app.request("/session/list")).status).toBe(401);
      expect((await app.request("/")).status).toBe(401);

      const health = await app.request("/global/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", version: "1.0.0" });
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  test("accepts the token on the query string only for the EventSource route", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      expect((await app.request(`/session/list?token=${AUTH_TOKEN}`)).status).toBe(401);
      expect((await app.request("/event/subscribe")).status).toBe(401);

      const controller = new AbortController();
      const response = await app.request(
        `/event/subscribe?token=${encodeURIComponent(AUTH_TOKEN)}`,
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  // The middleware's 403 branch is not driven through `app.request` here: the
  // test runtime's Request implementation treats `Origin` as a forbidden header
  // and silently drops it, so the origin policy is asserted on the function the
  // middleware calls — same as codex-bridge's index-routes tests.
  test("answers preflight without a token", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      const preflight = await app.request("/session/list", {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
        "X-Orkestrator-Claude-Token",
      );
      expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  test("allows only local, file, and explicitly configured origins", () => {
    expect(__testing.isTrustedBridgeOriginForTesting("https://attacker.example"))
      .toBe(false);
    expect(__testing.isTrustedBridgeOriginForTesting("http://127.0.0.1:5173"))
      .toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting("http://[::1]:5173")).toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting("file://")).toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting("null")).toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting(undefined)).toBe(true);
  });

  test("reads the configured allowlist, tolerating blanks and trailing slashes", () => {
    const previous = process.env.CLAUDE_BRIDGE_ALLOWED_ORIGINS;
    process.env.CLAUDE_BRIDGE_ALLOWED_ORIGINS =
      " https://app.example.test/ , , https://other.example.test ";
    try {
      // A trailing slash on either side is the same origin, and an empty entry
      // from a stray comma must not become an allowlisted empty string.
      expect(__testing.isTrustedBridgeOriginForTesting("https://app.example.test")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://app.example.test/")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://other.example.test")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://attacker.example")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_BRIDGE_ALLOWED_ORIGINS;
      else process.env.CLAUDE_BRIDGE_ALLOWED_ORIGINS = previous;
    }
  });

  test("does not bind a server when CLAUDE_BRIDGE_NO_SERVER is set", () => {
    let started = 0;
    const start = () => {
      started += 1;
      return {};
    };
    expect(
      __testing.startBridgeServerForTesting({ CLAUDE_BRIDGE_NO_SERVER: "1" }, start),
    ).toBeUndefined();
    expect(started).toBe(0);

    __testing.startBridgeServerForTesting({ PORT: "0", HOSTNAME: "127.0.0.1" }, start);
    expect(started).toBe(1);
  });
});
