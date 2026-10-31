/**
 * Grok's `_x.ai/mcp/elicit` over the real ACP router, in process: parked on a
 * seeded session with a stub agent, read and answered through the routes. The
 * answer shapes are the ones the real 1.0.67 binary forwarded to an MCP server.
 */
import "./testing/unit-test-env.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
} from "@orkestrator/protocol/agent-interactions";
import { denyPendingRequests } from "./acp-session-close.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  HttpError,
  authToken,
  sessions,
  type AcpProcess,
  type SessionState,
} from "./acp-context.js";
import { json, route } from "./acp-http.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { applyVendorUpdate, clearApprovals, parkGrokElicitation } from "./acp-session.js";
import { nativeFetch } from "./acp-test-harness.js";

const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
const VENDOR_SESSION = "vendor-session";
const FORM_ID = "mcp-elicit-form";
const URL_ID = "mcp-elicit-url";
const NAME_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name"],
};

let server: Server;
let origin: string;
let state: SessionState;
let child: AcpProcess;
let responses: Array<{ id: number; result: unknown }>;

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch((error: unknown) => {
      json(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  responses = [];
  child = {
    respond: (id: number, result: unknown) => responses.push({ id, result }),
    notify: () => undefined,
  } as AcpProcess;
  state = {
    id: "elicitation-route-test",
    acpSessionId: VENDOR_SESSION,
    status: "running",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 1,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
    promptDeadlineAt: Date.now() + 30 * 60_000,
  };
  sessions.set(state.id, state);
});

afterEach(() => {
  clearApprovals(state);
  sessions.delete(state.id);
});

function parkForm(schema: unknown = NAME_SCHEMA): void {
  parkGrokElicitation(state, child, 7, {
    sessionId: VENDOR_SESSION,
    toolCallId: FORM_ID,
    serverName: "probe",
    message: "What is your name?",
    mode: "form",
    requestedSchema: schema,
  });
}

function parkUrl(url = "https://example.com/auth"): void {
  parkGrokElicitation(state, child, 8, {
    sessionId: VENDOR_SESSION,
    toolCallId: URL_ID,
    serverName: "probe",
    message: "Please sign in",
    mode: "url",
    url,
    elicitationId: "e-1",
  });
}

function answer(id: string, body: unknown): Promise<Response> {
  return nativeFetch(`${origin}/session/${state.id}/interactions/${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function listed(): Promise<Array<Record<string, unknown>>> {
  const response = await nativeFetch(`${origin}/session/${state.id}/interactions`, { headers });
  return ((await response.json()) as { interactions: Array<Record<string, unknown>> }).interactions;
}

describe("Grok MCP elicitation", () => {
  test("expiry cancels once and marks the owning turn", () => {
    jest.useFakeTimers();
    try {
      parkForm();
      const deadline = state.interactions.get(FORM_ID)!.deadline;
      jest.advanceTimersByTime(AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
      expect(responses).toEqual([{ id: 7, result: { outcome: "cancel" } }]);
      expect(state.interactions.size).toBe(0);
      expect(deadline.settled).toBe(true);
      expect(state.expiredRequestPromptSequence).toBe(state.promptSequence);
      jest.advanceTimersByTime(AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
      expect(responses).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("cancelling the turn cancels every parked elicitation", async () => {
    parkForm();
    parkUrl();
    const response = await nativeFetch(`${origin}/session/${state.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(response.ok).toBe(true);
    expect(responses).toEqual([
      { id: 7, result: { outcome: "cancel" } },
      { id: 8, result: { outcome: "cancel" } },
    ]);
    expect(state.interactions.size).toBe(0);
  });

  test("replacement cancels the old request and retires its deadline", async () => {
    parkForm();
    const old = state.interactions.get(FORM_ID)!.deadline;
    parkGrokElicitation(state, child, 10, {
      sessionId: VENDOR_SESSION,
      toolCallId: FORM_ID,
      mode: "url",
      url: "https://example.com/new",
    });
    expect(old.settled).toBe(true);
    expect(responses).toEqual([{ id: 7, result: { outcome: "cancel" } }]);
    expect((await answer(FORM_ID, { action: "accept" })).status).toBe(200);
    expect(responses).toEqual([
      { id: 7, result: { outcome: "cancel" } },
      { id: 10, result: { outcome: "accept" } },
    ]);
  });

  test("at capacity a new request is cancelled while a replacement is allowed", () => {
    for (let index = 0; index < AGENT_INTERACTION_LIMITS.maxPendingRequests; index += 1) {
      parkGrokElicitation(state, child, index, {
        sessionId: VENDOR_SESSION,
        toolCallId: `call-${index}`,
        mode: "form",
        requestedSchema: NAME_SCHEMA,
      });
    }
    parkForm();
    expect(responses).toEqual([{ id: 7, result: { outcome: "cancel" } }]);
    expect(state.interactions.size).toBe(AGENT_INTERACTION_LIMITS.maxPendingRequests);
    parkGrokElicitation(state, child, 999, {
      sessionId: VENDOR_SESSION,
      toolCallId: "call-0",
      mode: "form",
      requestedSchema: NAME_SCHEMA,
    });
    expect(responses.at(-1)).toEqual({ id: 0, result: { outcome: "cancel" } });
    state.interactions.get("call-0")!.respond({ outcome: "decline" });
    expect(responses.at(-1)).toEqual({ id: 999, result: { outcome: "decline" } });
  });

  test.each(["close", "turn end"])(
    "%s cancels parked MCP requests and settles their timers",
    (reason) => {
      parkForm();
      parkUrl();
      const deadlines = [...state.interactions.values()].map((entry) => entry.deadline);
      if (reason === "close") denyPendingRequests(state);
      else clearApprovals(state);
      expect(responses).toEqual([
        { id: 7, result: { outcome: "cancel" } },
        { id: 8, result: { outcome: "cancel" } },
      ]);
      expect(state.interactions.size).toBe(0);
      expect(deadlines.every((deadline) => deadline.settled)).toBe(true);
    },
  );

  test("publishes a form and a URL request for the card to render", async () => {
    parkForm();
    parkUrl();
    expect(await listed()).toMatchObject([
      {
        id: FORM_ID,
        kind: "mcp-form",
        serverName: "probe",
        message: "What is your name?",
        schema: NAME_SCHEMA,
      },
      { id: URL_ID, kind: "mcp-url", url: "https://example.com/auth" },
    ]);
    expect(responses).toEqual([]);
  });

  test("an accepted form answers Grok with the content, tagged by outcome", async () => {
    parkForm();
    const response = await answer(FORM_ID, { action: "accept", content: { name: "Ada", age: 7 } });
    expect(response.status).toBe(200);
    expect(responses).toEqual([
      { id: 7, result: { outcome: "accept", content: { name: "Ada", age: 7 } } },
    ]);
    expect(state.interactions.size).toBe(0);
  });

  test("a form answer that breaks the schema is refused and the card stays", async () => {
    parkForm();
    for (const content of [{ age: 7 }, { name: "Ada", age: "seven" }, { name: "Ada", extra: 1 }]) {
      expect((await answer(FORM_ID, { action: "accept", content })).status).toBe(400);
    }
    expect((await answer(FORM_ID, { action: "accept" })).status).toBe(400);
    expect(responses).toEqual([]);
    expect(state.interactions.has(FORM_ID)).toBe(true);
  });

  test("an accepted URL request carries no content", async () => {
    parkUrl();
    expect((await answer(URL_ID, { action: "accept" })).status).toBe(200);
    expect(responses).toEqual([{ id: 8, result: { outcome: "accept" } }]);
  });

  test.each([
    ["decline", "decline"],
    ["cancel", "cancel"],
    ["anything-else", "cancel"],
  ])("action %s answers Grok %s", async (action, outcome) => {
    parkForm();
    expect((await answer(FORM_ID, { action })).status).toBe(200);
    expect(responses).toEqual([{ id: 7, result: { outcome } }]);
  });

  test.each([
    ["a nested object", { type: "object", properties: { a: { type: "object" } } }],
    ["an array field", { type: "object", properties: { a: { type: "array" } } }],
    ["no schema", null],
  ])("declines %s on the spot and says so", async (_name, schema) => {
    parkForm(schema);
    expect(responses).toEqual([{ id: 7, result: { outcome: "decline" } }]);
    expect(await listed()).toEqual([]);
    expect(state.health.snapshot().notices).toMatchObject([
      { message: "probe asked for input this tab cannot collect, so it was declined." },
    ]);
  });

  test.each(["javascript:alert(1)", "file:///etc/passwd", "not a url"])(
    "declines a link that is not a web page: %s",
    async (url) => {
      parkUrl(url);
      expect(responses).toEqual([{ id: 8, result: { outcome: "decline" } }]);
      expect(await listed()).toEqual([]);
    },
  );

  test("a request for another session is cancelled, not parked", () => {
    parkGrokElicitation(state, child, 9, {
      sessionId: "someone-else",
      toolCallId: FORM_ID,
      mode: "form",
      requestedSchema: NAME_SCHEMA,
    });
    expect(responses).toEqual([{ id: 9, result: { outcome: "cancel" } }]);
    expect(state.interactions.size).toBe(0);
  });

  test("a server that gives up withdraws the card without an answer", async () => {
    parkForm();
    applyVendorUpdate(state, "_x.ai/session_notification", {
      sessionId: VENDOR_SESSION,
      update: { sessionUpdate: "interaction_resolved", tool_call_id: FORM_ID },
    });
    expect(await listed()).toEqual([]);
    expect(responses).toEqual([]);
    // Answering a withdrawn card reports it gone rather than writing to Grok.
    expect((await answer(FORM_ID, { action: "decline" })).status).toBe(404);
  });

  test("a hold pauses the countdown and never answers", async () => {
    parkForm();
    const before = state.interactions.get(FORM_ID)!.deadline.expiresAt;
    const held = await nativeFetch(`${origin}/session/${state.id}/interactions/${FORM_ID}/hold`, {
      method: "POST",
      headers,
      body: JSON.stringify({ held: true }),
    });
    expect(held.status).toBe(200);
    expect(state.interactions.get(FORM_ID)!.deadline.expiresAt).toBeGreaterThanOrEqual(before);
    expect(responses).toEqual([]);
  });
});
