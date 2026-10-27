/**
 * Answering Grok's parked requests through the real ACP router, in process:
 * `GET`/`POST /session/:id/interactions[/:id]` for plan approvals and
 * `GET`/`POST /session/:id/approvals[/:id]` for a file change. Requests are
 * parked directly on a seeded session with a stub agent, as in
 * `acp-interaction-hold.test.ts`; what the agent is sent back is the evidence.
 */
import "./testing/unit-test-env.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { clearApprovals, parkGrokInteraction, parkPermission } from "./acp-session.js";
import { nativeFetch } from "./acp-test-harness.js";

const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };

let server: Server;
let origin: string;

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

let state: SessionState;
let child: AcpProcess;
let responses: Array<{ id: number; result: unknown }>;

beforeEach(() => {
  responses = [];
  child = {
    respond: (id: number, result: unknown) => responses.push({ id, result }),
  } as AcpProcess;
  state = {
    id: "answer-route-test",
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
});

afterEach(() => {
  // Settles every deadline, so no timer outlives the test.
  clearApprovals(state);
  sessions.delete(state.id);
});

async function read(path: "approvals" | "interactions") {
  const response = await nativeFetch(`${origin}/session/${state.id}/${path}`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, Array<Record<string, unknown>>>;
}

async function answer(path: string, body: unknown) {
  const response = await nativeFetch(`${origin}/session/${state.id}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function parkPlan(requestId: number, toolCallId: string) {
  parkGrokInteraction(state, child, requestId, "x.ai/exit_plan_mode", {
    sessionId: "vendor-session",
    toolCallId,
    planContent: "# Plan\n\nShip it.",
  });
}

describe("Grok plan approval through its route", () => {
  test("is listed with its plan, and each answer reaches Grok as its own outcome", async () => {
    parkPlan(1, "plan-approve");
    parkPlan(2, "plan-revise");
    parkPlan(3, "plan-abandon");
    expect((await read("interactions")).interactions).toEqual([
      expect.objectContaining({
        id: "plan-approve",
        kind: "plan-approval",
        plan: "# Plan\n\nShip it.",
        planTruncated: false,
      }),
      expect.objectContaining({ id: "plan-revise", kind: "plan-approval" }),
      expect.objectContaining({ id: "plan-abandon", kind: "plan-approval" }),
    ]);

    // The bodies are the ones the backend sends (`http-bridge-interactions.ts`).
    expect(await answer("interactions/plan-approve", { action: "approve" })).toEqual({
      status: 200,
      body: { resolved: true },
    });
    expect(
      await answer("interactions/plan-revise", { action: "revise", feedback: "Add rollback" }),
    ).toEqual({ status: 200, body: { resolved: true } });
    expect(await answer("interactions/plan-abandon", { action: "abandon" })).toEqual({
      status: 200,
      body: { resolved: true },
    });
    expect(responses).toEqual([
      { id: 1, result: { outcome: "approved" } },
      { id: 2, result: { outcome: "cancelled", feedback: "Add rollback" } },
      { id: 3, result: { outcome: "abandoned" } },
    ]);
    expect((await read("interactions")).interactions).toEqual([]);

    // Answered is gone: a repeat answers nothing.
    expect((await answer("interactions/plan-approve", { action: "approve" })).status).toBe(404);
    expect(responses).toHaveLength(3);
  });

  test("an answer that is not an approval keeps the plan unapproved", async () => {
    parkPlan(4, "plan-unknown");
    expect((await answer("interactions/plan-unknown", { action: "accept" })).status).toBe(200);
    expect(responses).toEqual([{ id: 4, result: { outcome: "cancelled" } }]);
  });
});

describe("Grok file approval through its route", () => {
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];

  function parkFileChange(requestId: number, toolCallId: string) {
    parkPermission(state, child, requestId, {
      sessionId: "vendor-session",
      toolCall: {
        toolCallId,
        title: "Edit a.ts",
        kind: "edit",
        locations: [{ path: "/w/a.ts" }],
      },
      options,
    });
  }

  test("is listed with its paths and runs once approved", async () => {
    parkFileChange(5, "edit-option");
    parkFileChange(6, "edit-decision");
    const { approvals } = await read("approvals");
    expect(approvals).toEqual([
      expect.objectContaining({ title: "Edit a.ts", kind: "file-change", paths: ["/w/a.ts"] }),
      expect.objectContaining({ title: "Edit a.ts", kind: "file-change", paths: ["/w/a.ts"] }),
    ]);
    expect(approvals[0]!).not.toHaveProperty("pathsOmitted");

    // The backend answers with the agent's own option; a bare decision picks
    // the allow-once option.
    expect(await answer(`approvals/${approvals[0]!.id}`, { optionId: "allow" })).toEqual({
      status: 200,
      body: { resolved: true },
    });
    expect(await answer(`approvals/${approvals[1]!.id}`, { decision: "approve" })).toEqual({
      status: 200,
      body: { resolved: true },
    });
    expect(responses).toEqual([
      { id: 5, result: { outcome: { outcome: "selected", optionId: "allow" } } },
      { id: 6, result: { outcome: { outcome: "selected", optionId: "allow" } } },
    ]);
    expect((await read("approvals")).approvals).toEqual([]);
    expect((await answer(`approvals/${approvals[0]!.id}`, { optionId: "allow" })).status).toBe(404);
  });
});
