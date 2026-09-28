import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { authToken } from "./config.js";
import { route } from "./http.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";

let server: Server;
let baseUrl: string;
/** The test preload's browser-like `fetch` applies CORS; see `http.test.ts`. */
const nativeFetch = Bun.fetch;

beforeEach(async () => {
  sessions.clear();
  clientSessionKeys.clear();
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessions.clear();
  clientSessionKeys.clear();
});

async function call(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = authToken, ...rest } = init;
  return nativeFetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function createSession(): Promise<SessionState> {
  const response = await call("/session/create", {
    method: "POST",
    body: JSON.stringify({
      policy: {
        id: "interactive-host",
        sandbox: "none",
        approvals: "auto-approve",
        projectResources: false,
        networkAccess: "full",
      },
    }),
  });
  expect(response.status).toBe(201);
  return sessions.get(((await response.json()) as { sessionId: string }).sessionId)!;
}

function batch(body: unknown, token?: string | null) {
  return call("/sessions/activity", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(token !== undefined ? { token } : {}),
  });
}

async function single(id: string): Promise<unknown> {
  const response = await call(`/session/${encodeURIComponent(id)}/activity`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("POST /sessions/activity", () => {
  test("requires the bridge token", async () => {
    expect((await batch({ version: 1, sessionIds: ["a"] }, null)).status).toBe(401);
    expect((await batch({ version: 1, sessionIds: ["a"] }, "wrong")).status).toBe(401);
  });

  test("answers each session as the single route does, and never refreshes liveness", async () => {
    const idle = await createSession();
    const running = await createSession();
    running.status = "running";
    const closing = await createSession();
    closing.closed = true;
    for (const state of [idle, running, closing]) state.lastAccessed = 0;

    const ids = [idle.id, running.id, closing.id, "nope"];
    const response = await batch({ version: 1, sessionIds: ids });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { observations: Record<string, unknown> };
    expect(body).toEqual({
      version: 1,
      observations: {
        [idle.id]: { activity: "idle" },
        [running.id]: { activity: "working" },
        // The whole single-route answer travels, including `closing`.
        [closing.id]: { activity: "idle", closing: true },
        nope: { activity: "missing" },
      },
    });
    for (const id of ids) expect(body.observations[id]).toEqual(await single(id));
    for (const state of [idle, running, closing]) {
      // Refreshing here would keep every polled session attached forever.
      expect(state.lastAccessed).toBe(0);
      expect(state.agent).toBeFalsy();
    }
  });

  test("refuses requests outside the contract", async () => {
    expect((await batch("{")).status).toBe(400);
    expect((await batch({ version: 1, sessionIds: ["a", "a"] })).status).toBe(400);
    expect((await batch("x".repeat(200_000))).status).toBe(413);
  });
});
