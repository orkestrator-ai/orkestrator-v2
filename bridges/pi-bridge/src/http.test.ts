import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";

const TOKEN = "test-token";

// `config.ts` reads its environment once, at import. Everything below is
// therefore loaded dynamically, after the environment this suite needs is in
// place — importing it statically would bind the real defaults instead.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = TOKEN;
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { newSessionState } = await import("./agent-session.js");
const { sessions } = await import("./state.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;

beforeAll(async () => {
  await start();
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await shutdown();
});

async function call(
  path: string,
  init: RequestInit & { authorize?: boolean } = {},
): Promise<Response> {
  const { authorize = true, ...request } = init;
  return nativeFetch(`${origin}${path}`, {
    ...request,
    headers: {
      ...(authorize ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(request.headers as Record<string, string> | undefined),
    },
  });
}

function seedSession(): ReturnType<typeof newSessionState> {
  const state = newSessionState();
  sessions.set(state.id, state);
  return state;
}

describe("authentication", () => {
  test("serves health without a token, because the launcher polls it first", async () => {
    const response = await call("/global/health", { authorize: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "pi" });
  });

  test("refuses every other route without a token", async () => {
    expect((await call("/global/auth-check", { authorize: false })).status).toBe(401);
    expect((await call("/session/list", { authorize: false })).status).toBe(401);
  });

  test("refuses a token of the wrong length without leaking which", async () => {
    const response = await nativeFetch(`${origin}/global/auth-check`, {
      headers: { authorization: "Bearer short" },
    });
    expect(response.status).toBe(401);
  });
});

describe("session routes", () => {
  test("answers activity for an unknown session in band, never with a 404", async () => {
    // A 404 here would have the backend read "this bridge predates the route"
    // and fail the environment instead of dropping a dead session mapping.
    const response = await call("/session/does-not-exist/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activity: "missing" });
  });

  test("404s every other route for an unknown session", async () => {
    expect((await call("/session/does-not-exist")).status).toBe(404);
    expect((await call("/session/does-not-exist/status")).status).toBe(404);
  });

  test("reports a running session as working and an idle one as idle", async () => {
    const state = seedSession();
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "idle",
    });

    state.status = "running";
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "working",
    });
  });

  test("reports a parked approval as blocked rather than merely busy", async () => {
    const state = seedSession();
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: () => undefined,
    });

    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "blocked",
    });
  });

  test("does not refresh liveness from the activity or dispatch sweeps", async () => {
    const state = seedSession();
    state.lastAccessed = 0;

    await call(`/session/${state.id}/activity`);
    await call(`/session/${state.id}/dispatch?requestId=req-1`);
    // Refreshing here would put idle detaching permanently out of reach: the
    // backend sweeps every persisted session every couple of seconds.
    expect(state.lastAccessed).toBe(0);

    await call(`/session/${state.id}/status`);
    expect(state.lastAccessed).toBeGreaterThan(0);
  });

  test("serves a message window anchored to the retained base index", async () => {
    const state = seedSession();
    state.droppedMessages = 2;
    state.messages = [
      { id: "m3", role: "user", content: "three", parts: [], createdAt: "2026-01-01T00:00:00Z" },
      { id: "m4", role: "user", content: "four", parts: [], createdAt: "2026-01-01T00:00:01Z" },
    ];

    const whole = await (await call(`/session/${state.id}/messages`)).json();
    expect(whole).toMatchObject({ baseIndex: 2, truncated: false });
    expect(whole.messages).toHaveLength(2);

    const tail = await (await call(`/session/${state.id}/messages?fromIndex=3`)).json();
    expect(tail).toMatchObject({ baseIndex: 3 });
    expect(tail.messages).toHaveLength(1);

    // An anchor that was evicted must return the whole retained window, not an
    // incremental slice that silently skips messages.
    const evicted = await (await call(`/session/${state.id}/messages?fromIndex=0`)).json();
    expect(evicted).toMatchObject({ baseIndex: 2 });
    expect(evicted.messages).toHaveLength(2);
  });
});

describe("at-most-once dispatch", () => {
  test("reports an id it never took as unknown", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/dispatch?requestId=req-1`);
    expect(await response.json()).toEqual({ dispatch: "unknown" });
  });

  test("reports an accepted id as dispatched", async () => {
    const state = seedSession();
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "accepted",
      acceptedAt: Date.now(),
    });

    const response = await call(`/session/${state.id}/dispatch?requestId=req-1`);
    expect(await response.json()).toEqual({ dispatch: "dispatched" });
  });

  test("reports a record that predates a restart as unknown, never dispatched", async () => {
    const state = seedSession();
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "ambiguous",
      acceptedAt: Date.now(),
    });

    const response = await call(`/session/${state.id}/dispatch?requestId=req-1`);
    // Reporting a lost record as dispatched would clear the parked dispatch and
    // let the same turn run twice.
    expect(await response.json()).toEqual({ dispatch: "unknown" });
  });

  test("refuses to reuse an ambiguous request id", async () => {
    const state = seedSession();
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "ambiguous",
      acceptedAt: Date.now(),
    });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "go", requestId: "req-1" }),
    });
    expect(response.status).toBe(410);
  });

  test("acknowledges a completed request id as a duplicate rather than rerunning it", async () => {
    const state = seedSession();
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "completed",
      acceptedAt: Date.now(),
    });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "go", requestId: "req-1" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, duplicate: true });
  });

  test("refuses a second turn while one is running", async () => {
    const state = seedSession();
    state.status = "running";

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "go", requestId: "req-2" }),
    });
    expect(response.status).toBe(409);
  });

  test("rejects a prompt with neither text nor attachments", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ requestId: "req-3" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("approvals", () => {
  test("answers an already-settled approval with 404 so the caller reconciles", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/approvals/gone`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(404);
  });

  test("treats a malformed decision as a denial, never as consent", async () => {
    const state = seedSession();
    const decisions: string[] = [];
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => {
        state.approvals.delete("a1");
        decisions.push(decision);
      },
    });

    const response = await call(`/session/${state.id}/approvals/a1`, {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(response.status).toBe(200);
    expect(decisions).toEqual(["deny"]);
  });
});

describe("steering", () => {
  test("answers idle when no turn is running instead of starting one", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ input: "focus on errors" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "idle" });
  });
});

describe("request handling", () => {
  test("rejects a body that is not JSON", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/config`, {
      method: "POST",
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  // The 2MiB body bound is deliberately not asserted here. This suite runs
  // under Bun, whose `node:http` compatibility layer resets the connection on
  // an oversized upload before the handler ever reads it, so the assertion
  // would be measuring the shim rather than the bridge. Verified against the
  // real runtime instead: `node dist/index.js` answers 413.

  test("does not compress for a client that never said it could decompress", async () => {
    const state = seedSession();
    // Large enough to cross the compression threshold, so this only passes if
    // the encoding is actually negotiated rather than assumed.
    state.messages = Array.from({ length: 200 }, (_unused, index) => ({
      id: `m${index}`,
      role: "user" as const,
      content: "x".repeat(64),
      parts: [],
      createdAt: "2026-01-01T00:00:00Z",
    }));

    const response = await nativeFetch(`${origin}/session/${state.id}/messages`, {
      headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "identity" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await response.json()).messages).toHaveLength(200);
  });
});
