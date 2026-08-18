import { describe, expect, test } from "bun:test";
import { TransformStream } from "node:stream/web";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";

// hono's `streamSSE` constructs a `TransformStream` whose `writable` lacks
// `getWriter` in Bun's test runtime, so the subscribe route would 500 — same
// polyfill as routes/events.test.ts and codex-bridge/src/index-abort.test.ts.
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

// Import the composition root without binding a real port; auth stays enabled
// unless a test overrides it explicitly through `setBridgeAuthForTesting`.
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
const AUTH_TOKEN = "test-claude-bridge-token";
process.env.CLAUDE_BRIDGE_TOKEN = AUTH_TOKEN;

const { app, __testing } = await import("./index.js");

async function requestBridge(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Headers; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) headers.append(name, entry);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        resolve({
          status: response.statusCode ?? 0,
          headers,
          json: () => JSON.parse(body),
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function withLiveBridge<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = __testing.startBridgeServerForTesting({
    PORT: "0",
    HOSTNAME: "127.0.0.1",
  }) as {
    address: () => AddressInfo | string | null;
    once: (event: "listening", listener: () => void) => void;
    close: (callback: (error?: Error) => void) => void;
  };
  if (!server.address()) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Claude bridge test server did not bind a TCP address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("bridge authentication and origin policy", () => {
  test("captures the token once and removes it from the environment inherited by children", async () => {
    expect(process.env.CLAUDE_BRIDGE_TOKEN).toBeUndefined();
    expect(
      (
        await app.request("/global/auth-check", {
          headers: { "X-Orkestrator-Claude-Token": AUTH_TOKEN },
        })
      ).status,
    ).toBe(200);
  });

  test("protects data routes while leaving only the minimal process health public", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      expect((await app.request("/global/auth-check")).status).toBe(401);
      expect(
        (
          await app.request("/global/auth-check", {
            headers: { Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request("/global/auth-check", {
            headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request("/global/auth-check", {
            headers: { "X-Orkestrator-Claude-Token": AUTH_TOKEN },
          })
        ).status,
      ).toBe(200);
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

  test("rejects an untrusted Origin in the actual middleware before authentication", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      await withLiveBridge(async (baseUrl) => {
        const response = await requestBridge(`${baseUrl}/global/auth-check`, {
          headers: {
            Origin: "https://attacker.example",
            "X-Orkestrator-Claude-Token": AUTH_TOKEN,
          },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Origin is not allowed" });

        const preflight = await requestBridge(`${baseUrl}/session/list`, {
          method: "OPTIONS",
          headers: { Origin: "https://attacker.example" },
        });
        expect(preflight.status).toBe(403);
      });
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  test("echoes an allowed local Origin through the actual middleware", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      const origin = "http://127.0.0.1:5173";
      await withLiveBridge(async (baseUrl) => {
        const response = await requestBridge(`${baseUrl}/global/auth-check`, {
          headers: {
            Origin: origin,
            "X-Orkestrator-Claude-Token": AUTH_TOKEN,
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
        expect(response.headers.get("Vary")).toBe("Origin");
      });
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

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
    expect(__testing.isTrustedBridgeOriginForTesting("https://attacker.example")).toBe(false);
    expect(__testing.isTrustedBridgeOriginForTesting("http://127.0.0.1:5173")).toBe(true);
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
