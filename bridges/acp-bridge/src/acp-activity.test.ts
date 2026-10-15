import "./testing/unit-test-env.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { authToken, sessions, type SessionState } from "./acp-context.js";
import { route } from "./acp-http.js";
import { nativeFetch } from "./acp-test-harness.js";

let server: Server;
let base: string;
const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A session whose every property write is recorded. Answering activity must
 * write nothing: no process attach, transcript bounding or persistence field.
 */
function observedSession(
  id: string,
  fields: Partial<SessionState>,
): { state: SessionState; writes: string[] } {
  const writes: string[] = [];
  const target = {
    id,
    child: null,
    status: "idle",
    activeSubagentToolIds: new Set<string>(),
    approvals: new Map(),
    interactions: new Map(),
    messages: [],
    ...fields,
  } as unknown as SessionState;
  const state = new Proxy(target, {
    set(object, property, value) {
      writes.push(String(property));
      return Reflect.set(object, property, value);
    },
  });
  return { state, writes };
}

async function batch(body: unknown, requestHeaders: Record<string, string> = headers) {
  return nativeFetch(`${base}/sessions/activity`, {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function single(id: string): Promise<unknown> {
  const response = await nativeFetch(`${base}/session/${encodeURIComponent(id)}/activity`, {
    headers,
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("POST /sessions/activity", () => {
  test("requires the bridge token", async () => {
    const body = { version: 1, sessionIds: ["a"] };
    expect((await batch(body, { "content-type": "application/json" })).status).toBe(401);
    expect(
      (await batch(body, { authorization: "Bearer wrong", "content-type": "application/json" }))
        .status,
    ).toBe(401);
  });

  test("answers each session as the single route does, and touches nothing", async () => {
    const idle = observedSession("acp-idle", {});
    const running = observedSession("acp-running", { status: "running" } as Partial<SessionState>);
    const subagent = observedSession("acp-subagent", {
      activeSubagentToolIds: new Set(["tool-1"]),
    } as Partial<SessionState>);
    // A held permission or Grok question stops the agent until someone answers.
    const permission = observedSession("acp-permission", {
      status: "running",
      approvals: new Map([["approval-1", {}]]),
    } as Partial<SessionState>);
    const question = observedSession("acp-question", {
      status: "running",
      interactions: new Map([["tool-2", {}]]),
    } as Partial<SessionState>);
    // A request left over from a finished turn is not a reason to wait.
    const settled = observedSession("acp-settled", {
      approvals: new Map([["approval-2", {}]]),
    } as Partial<SessionState>);
    const observed = [idle, running, subagent, permission, question, settled];
    for (const { state } of observed) sessions.set(state.id, state);
    try {
      const response = await batch({
        version: 1,
        sessionIds: [...observed.map(({ state }) => state.id), "acp-unknown"],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { observations: Record<string, unknown> };
      expect(body).toEqual({
        version: 1,
        observations: {
          "acp-idle": { activity: "idle" },
          "acp-running": { activity: "working" },
          "acp-subagent": { activity: "working" },
          "acp-permission": { activity: "waiting" },
          "acp-question": { activity: "waiting" },
          "acp-settled": { activity: "idle" },
          "acp-unknown": { activity: "missing" },
        },
      });
      for (const id of Object.keys(body.observations)) {
        expect(body.observations[id]).toEqual(await single(id));
      }
      for (const { state, writes } of observed) {
        expect(writes).toEqual([]);
        expect(state.child).toBeNull();
      }
    } finally {
      for (const { state } of observed) sessions.delete(state.id);
    }
  });

  test("refuses requests outside the contract", async () => {
    expect((await batch("{")).status).toBe(400);
    expect((await batch({ version: 1, sessionIds: [""] })).status).toBe(400);
    expect((await batch("x".repeat(200_000))).status).toBe(413);
  });
});
