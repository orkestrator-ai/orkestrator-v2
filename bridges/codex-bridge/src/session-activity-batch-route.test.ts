/**
 * `POST /sessions/activity` through the real Codex bridge router, behind its
 * real authentication middleware.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";

const AUTH_TOKEN = "codex-activity-batch-token";
const codexHome = mkdtempSync(join(tmpdir(), "ork-codex-activity-batch-"));
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_BRIDGE_TOKEN: process.env.CODEX_BRIDGE_TOKEN,
  CODEX_BRIDGE_NO_ENGINE: process.env.CODEX_BRIDGE_NO_ENGINE,
  CODEX_BRIDGE_NO_SERVER: process.env.CODEX_BRIDGE_NO_SERVER,
  CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING: process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING,
};
process.env.CODEX_HOME = codexHome;
process.env.CODEX_BRIDGE_TOKEN = AUTH_TOKEN;
process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
delete process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING;

const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
const { app, __testing } = await import("./index.js");
const runtime = __testing.runtimeForTesting();
const runtimeMethods = runtime as unknown as Record<string, unknown>;

afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(codexHome, { recursive: true, force: true });
});

const authorized = { Authorization: `Bearer ${AUTH_TOKEN}` };

function batch(body: unknown, headers: Record<string, string> = authorized) {
  return app.request("/sessions/activity", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function single(sessionId: string): Promise<unknown> {
  const response = await app.request(`/session/${encodeURIComponent(sessionId)}/activity`, {
    headers: authorized,
  });
  expect(response.status).toBe(200);
  return response.json();
}

/** Count calls to runtime methods that would be liveness side effects. */
async function withSideEffectProbe(run: (calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = [];
  const names = ["touchSession", "ensureAttached", "getStatus", "getMessages"];
  const originals = names.map((name) => runtimeMethods[name]);
  const registry = runtime.getRegistry() as unknown as Record<string, unknown>;
  const originalTouch = registry.touch;
  for (const name of names) {
    const original = runtimeMethods[name] as (...args: unknown[]) => unknown;
    runtimeMethods[name] = (...args: unknown[]) => {
      calls.push(name);
      return original.apply(runtime, args);
    };
  }
  registry.touch = (...args: unknown[]) => {
    calls.push("registry.touch");
    return (originalTouch as (...args: unknown[]) => unknown).apply(registry, args);
  };
  try {
    await run(calls);
  } finally {
    names.forEach((name, index) => {
      runtimeMethods[name] = originals[index];
    });
    registry.touch = originalTouch;
  }
}

describe("POST /sessions/activity on the real Codex bridge router", () => {
  test("requires the bridge token", async () => {
    expect((await batch({ version: 1, sessionIds: ["a"] }, {})).status).toBe(401);
    expect(
      (await batch({ version: 1, sessionIds: ["a"] }, { Authorization: "Bearer wrong" })).status,
    ).toBe(401);
  });

  test("answers every id exactly as the single route does, without touching anything", async () => {
    const { sessionId } = runtime.createSession({ mode: "build" });
    const session = runtime.getRegistry().getSession(sessionId)!;
    session.asyncQuestionItemIds = ["question-1"];
    const sessionBefore = JSON.stringify(session);
    try {
      await withSideEffectProbe(async (calls) => {
        const response = await batch({ version: 1, sessionIds: [sessionId, "never-existed"] });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          version: number;
          observations: Record<string, unknown>;
        };
        expect(body).toEqual({
          version: 1,
          observations: {
            [sessionId]: { activity: "idle", asyncQuestionItemIds: ["question-1"] },
            "never-existed": { activity: "missing" },
          },
        });
        // Metadata parity: the batch carries the single route's whole answer.
        expect(body.observations[sessionId]).toEqual(await single(sessionId));
        expect(body.observations["never-existed"]).toEqual(await single("never-existed"));
        expect(calls).toEqual([]);
      });
      expect(JSON.stringify(session)).toBe(sessionBefore);
    } finally {
      await runtime.deleteSession(sessionId);
    }
  });

  test("an unreadable session is unavailable, never missing or omitted", async () => {
    const original = runtimeMethods.getActivitySnapshot;
    runtimeMethods.getActivitySnapshot = (sessionId: string) => {
      if (sessionId === "broken") throw new Error("registry exploded");
      return { activity: "working" };
    };
    try {
      const response = await batch({ version: 1, sessionIds: ["broken", "fine"] });
      expect(await response.json()).toEqual({
        version: 1,
        observations: { broken: { activity: "unavailable" }, fine: { activity: "working" } },
      });
    } finally {
      runtimeMethods.getActivitySnapshot = original;
    }
  });

  test("refuses requests outside the contract", async () => {
    expect((await batch("{")).status).toBe(400);
    expect((await batch({ version: 2, sessionIds: [] })).status).toBe(400);
    expect(
      (await batch({ version: 1, sessionIds: Array.from({ length: 65 }, (_, i) => `s-${i}`) }))
        .status,
    ).toBe(400);
    expect((await batch("x".repeat(200_000))).status).toBe(413);
  });

  test("the single-session route does not claim the batch path", async () => {
    // A GET on the batch path is not the single route for a session called
    // "activity": `/sessions/...` is outside `/session/:id/...` entirely.
    const response = await app.request("/sessions/activity", { headers: authorized });
    expect(response.status).toBe(404);
  });
});
