import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";

// `config.ts` reads its environment once, at import, so the bridge modules are
// loaded after this suite's environment is in place (see `http.test.ts`).
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { sessions } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
});

function seedSession(): ReturnType<typeof newSessionState> {
  const state = newSessionState();
  sessions.set(state.id, state);
  return state;
}

async function batch(body: unknown, authorize = true): Promise<Response> {
  return nativeFetch(`${origin}/sessions/activity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorize ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function single(id: string): Promise<unknown> {
  const response = await nativeFetch(`${origin}/session/${encodeURIComponent(id)}/activity`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("POST /sessions/activity", () => {
  test("requires the bridge token", async () => {
    expect((await batch({ version: 1, sessionIds: ["a"] }, false)).status).toBe(401);
  });

  test("answers each session as the single route does, without touching or hydrating", async () => {
    let hydrations = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        return composer;
      },
    });
    const idle = seedSession();
    const running = seedSession();
    running.status = "running";
    const waiting = seedSession();
    waiting.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: () => undefined,
    });
    for (const state of [idle, running, waiting]) state.lastAccessed = 0;
    try {
      const ids = [idle.id, running.id, waiting.id, "does-not-exist"];
      const response = await batch({ version: 1, sessionIds: ids });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { observations: Record<string, unknown> };
      expect(body).toEqual({
        version: 1,
        observations: {
          [idle.id]: { activity: "idle" },
          [running.id]: { activity: "working" },
          [waiting.id]: { activity: "waiting" },
          "does-not-exist": { activity: "missing" },
        },
      });
      for (const id of ids) expect(body.observations[id]).toEqual(await single(id));
      // The backend sweeps every persisted session every couple of seconds;
      // refreshing liveness here would put idle detaching out of reach.
      for (const state of [idle, running, waiting]) {
        expect(state.lastAccessed).toBe(0);
        expect(state.session).toBeNull();
      }
      expect(hydrations).toBe(0);
    } finally {
      for (const state of [idle, running, waiting]) sessions.delete(state.id);
      setAgentSessionTestHooks(undefined);
    }
  });

  test("refuses requests outside the contract", async () => {
    expect((await batch("{")).status).toBe(400);
    expect(
      (await batch({ version: 1, sessionIds: Array.from({ length: 65 }, (_, i) => `s-${i}`) }))
        .status,
    ).toBe(400);
    expect((await batch("x".repeat(200_000))).status).toBe(413);
  });
});
