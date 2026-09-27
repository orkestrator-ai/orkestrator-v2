/**
 * `POST /session/:id/close` through the real Codex bridge router.
 *
 * `session-close-route.test.ts` drives the runtime semantics against a scripted
 * app-server; this file proves the route is actually wired into the production
 * `app` from `index.ts`, behind its real authentication middleware.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";

import { BridgeSessionStore } from "./sessions/persistence.js";

const AUTH_TOKEN = "codex-close-route-token";
const codexHome = mkdtempSync(join(tmpdir(), "ork-codex-close-app-"));
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_BRIDGE_TOKEN: process.env.CODEX_BRIDGE_TOKEN,
  CODEX_BRIDGE_NO_ENGINE: process.env.CODEX_BRIDGE_NO_ENGINE,
  CODEX_BRIDGE_NO_SERVER: process.env.CODEX_BRIDGE_NO_SERVER,
  CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING: process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING,
};
// The bridge-session store resolves CODEX_HOME when the module is evaluated; a
// close writes a tombstone, which must never land in the developer's ~/.codex.
process.env.CODEX_HOME = codexHome;
process.env.CODEX_BRIDGE_TOKEN = AUTH_TOKEN;
process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
// Authentication stays on: the close route must sit behind the real middleware.
delete process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING;

// The UI-test preload replaces browser globals before the bridge module is
// evaluated. Hono captures this constructor while installing its middleware.
const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
const { app, __testing } = await import("./index.js");
const runtime = __testing.runtimeForTesting();

afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(codexHome, { recursive: true, force: true });
});

const authorized = { Authorization: `Bearer ${AUTH_TOKEN}` };

async function close(sessionId: string, headers: Record<string, string> = authorized) {
  const response = await app.request(`/session/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
    headers,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createSession(): Promise<string> {
  const response = await app.request("/session/create", {
    method: "POST",
    headers: { ...authorized, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "build" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

describe("POST /session/:id/close on the real Codex bridge router", () => {
  test("requires the bridge token", async () => {
    const sessionId = await createSession();
    expect((await close(sessionId, {})).status).toBe(401);
    expect((await close(sessionId, { Authorization: "Bearer wrong" })).status).toBe(401);
    // Refused before the route ran: the session is untouched.
    expect(runtime.getStatus(sessionId)).not.toBeNull();
    expect((await close(sessionId)).body).toEqual({ closed: true, retained: true });
  });

  test("answers an unknown id in band, never 404", async () => {
    expect(await close("never-existed")).toEqual({
      status: 200,
      body: { closed: true, missing: true },
    });
  });

  test("retires a live session, and a repeated close reports it missing", async () => {
    const sessionId = await createSession();
    expect(await close(sessionId)).toEqual({
      status: 200,
      body: { closed: true, retained: true },
    });
    expect(runtime.getStatus(sessionId)).toBeNull();
    expect(await close(sessionId)).toEqual({
      status: 200,
      body: { closed: true, missing: true },
    });
  });

  test("answers 503 pending with a fixed error when the removal is not published", async () => {
    const sessionId = await createSession();
    const publish = spyOn(BridgeSessionStore.prototype, "publishRemoval").mockImplementationOnce(
      () => Promise.reject(new Error("EROFS: /private/path/that/must/not/leak")),
    );
    try {
      expect(await close(sessionId)).toEqual({
        status: 503,
        body: { closed: false, pending: true, error: "Session close did not complete" },
      });
      expect(runtime.getStatus(sessionId)).not.toBeNull();
      // Refused by the admission fence, before any dispatch work.
      const prompt = await app.request(`/session/${sessionId}/prompt`, {
        method: "POST",
        headers: { ...authorized, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "late", requestId: "req-late" }),
      });
      expect(prompt.status).toBe(409);
      expect(await prompt.json()).toEqual({ error: "Session is closing" });

      expect(await close(sessionId)).toEqual({
        status: 200,
        body: { closed: true, retained: true },
      });
    } finally {
      publish.mockRestore();
    }
  });
});
