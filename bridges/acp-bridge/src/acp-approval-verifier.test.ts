/**
 * A user's approval on a bridge that holds only a verifier (security report H4):
 * the real router, with a request parked as the agent's own would be. What the
 * agent can read is refused and the request stays parked; the backend's token
 * answers it.
 */
import "./testing/unit-test-env.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { bridgeTokenVerifier, mintBridgeToken } from "@orkestrator/protocol/node/bridge-credential";
import type { AcpProcess, SessionState } from "./acp-context.js";
import { nativeFetch } from "./acp-test-harness.js";

const TOKEN = mintBridgeToken();
const VERIFIER = bridgeTokenVerifier(TOKEN);
delete process.env.ACP_BRIDGE_TOKEN;
process.env.ACP_BRIDGE_TOKEN_SHA256 = VERIFIER;
const { HttpError, sessions, authToken } = await import("./acp-context.js");
const { json, route } = await import("./acp-http.js");
const { emptySessionConfig } = await import("./acp-persistence.js");
const { clearApprovals, parkPermission } = await import("./acp-session.js");

let server: Server;
let origin: string;
let state: SessionState;
let responses: Array<{ id: number; result: unknown }>;

const request = (path: string, token: string, init: RequestInit = {}) =>
  nativeFetch(`${origin}/session/${state.id}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

beforeAll(async () => {
  server = createServer((incoming, response) => {
    void route(incoming, response, new AbortController().signal).catch((error: unknown) => {
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
  const child = {
    respond: (id: number, result: unknown) => responses.push({ id, result }),
  } as AcpProcess;
  state = {
    id: "approval-verifier-test",
    acpSessionId: "vendor-session",
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
  parkPermission(state, child, 5, {
    sessionId: "vendor-session",
    toolCall: {
      toolCallId: "edit",
      title: "Edit a.ts",
      kind: "edit",
      locations: [{ path: "/w/a.ts" }],
    },
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
  });
});

afterEach(() => {
  clearApprovals(state);
  sessions.delete(state.id);
});

test("the bridge never had the token to give away", () => {
  expect(authToken).toBe("");
  expect(process.env.ACP_BRIDGE_TOKEN_SHA256).toBeUndefined();
});

test("the agent's reach is refused and leaves the approval parked; the user's answer runs", async () => {
  const [approval] = [...state.approvals.keys()];
  const body = JSON.stringify({ optionId: "allow" });

  for (const forged of [VERIFIER, "", "okb_guess"]) {
    const refused = await request(`approvals/${approval}`, forged, { method: "POST", body });
    expect(refused.status).toBe(401);
  }
  expect(responses).toEqual([]);
  expect(state.approvals.size).toBe(1);

  const answered = await request(`approvals/${approval}`, TOKEN, { method: "POST", body });
  expect(answered.status).toBe(200);
  expect(responses).toEqual([
    { id: 5, result: { outcome: { outcome: "selected", optionId: "allow" } } },
  ]);
});

test("the read-only boundary and policy routes refuse the same reach", async () => {
  for (const [path, init] of [
    ["config", { method: "POST", body: JSON.stringify({ readOnly: false }) }],
    ["prompt", { method: "POST", body: JSON.stringify({ text: "x", readOnly: false }) }],
  ] as const) {
    expect((await request(path, VERIFIER, init)).status).toBe(401);
  }
});
