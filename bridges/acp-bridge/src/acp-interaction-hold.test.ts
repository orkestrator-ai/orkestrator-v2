/**
 * `POST /session/:id/{approvals,interactions}/:id/hold` over the real ACP
 * router, in process. Requests are parked directly on a seeded session with a
 * stub agent; nothing here waits on a deadline; the clock-driven behaviour is
 * covered in `acp-session-process.test.ts`.
 */
import "./testing/unit-test-env.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
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
import { persistedSnapshot } from "./acp-persist-writer.js";
import { clearApprovals, parkGrokInteraction, parkPermission } from "./acp-session.js";
import { nativeFetch } from "./acp-test-harness.js";

const headers = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
const MINUTE = 60_000;

let server: Server;
let origin: string;

beforeAll(async () => {
  // Errors are answered the way `acp-server.ts` answers them.
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
let responses: Array<{ id: number; result: unknown }>;
let approvalId: string;
const questionId = "tool-question-1";

beforeEach(() => {
  responses = [];
  const child = {
    respond: (id: number, result: unknown) => responses.push({ id, result }),
  } as AcpProcess;
  // Complete, so the production persist path accepts it.
  state = {
    id: "hold-route-test",
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
    promptDeadlineAt: Date.now() + 30 * MINUTE,
  };
  sessions.set(state.id, state);
  parkPermission(state, child, 7, {
    sessionId: "vendor-session",
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  });
  approvalId = [...state.approvals.keys()][0]!;
  parkGrokInteraction(state, child, 9, "x.ai/ask_user_question", {
    sessionId: "vendor-session",
    toolCallId: questionId,
    questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }],
  });
});

afterEach(() => {
  // Settles every deadline, so no timer outlives the test.
  clearApprovals(state);
  sessions.delete(state.id);
});

async function hold(path: string, body: unknown, sessionId = state.id) {
  const response = await nativeFetch(`${origin}/session/${sessionId}/${path}/hold`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function read(path: "approvals" | "interactions") {
  const response = await nativeFetch(`${origin}/session/${state.id}/${path}`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown> & { revision: number };
}

describe("hold routes", () => {
  test("pause and resume move the published deadline and never answer", async () => {
    const turnEndsAt = state.promptDeadlineAt!;
    const paused = await hold(`approvals/${approvalId}`, { held: true });
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({
      status: "applied",
      expiresAt: turnEndsAt,
      hold: { available: true, heldAt: expect.any(Number), reason: "provider-limit" },
    });
    const approvals = await read("approvals");
    expect(approvals.revision).toBe(3);
    expect(approvals.approvals).toEqual([
      expect.objectContaining({ id: approvalId, expiresAt: turnEndsAt, hold: paused.body.hold }),
    ]);

    const again = await hold(`approvals/${approvalId}`, { held: true });
    expect(again).toEqual({ status: 200, body: { ...paused.body, status: "unchanged" } });
    expect((await read("approvals")).revision).toBe(3);

    const questionPaused = await hold(`interactions/${questionId}`, { held: true });
    expect(questionPaused.status).toBe(200);
    expect(questionPaused.body).toMatchObject({ status: "applied", expiresAt: turnEndsAt });
    const interactions = await read("interactions");
    expect(interactions.revision).toBe(4);
    expect(interactions.interactions).toEqual([
      expect.objectContaining({ id: questionId, hold: questionPaused.body.hold }),
    ]);

    const resumed = await hold(`approvals/${approvalId}`, { held: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      status: "applied",
      hold: { available: true, reason: "provider-limit" },
    });
    const resumedAt = resumed.body.expiresAt as number;
    expect(resumedAt).toBeLessThanOrEqual(Date.now() + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
    expect(resumedAt).toBeGreaterThan(Date.now() + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS - MINUTE);

    // A hold answered nothing, and the answer routes still work after one.
    expect(responses).toEqual([]);
    const answered = await nativeFetch(`${origin}/session/${state.id}/approvals/${approvalId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(await answered.json()).toEqual({ resolved: true });
    const questionAnswered = await nativeFetch(
      `${origin}/session/${state.id}/interactions/${questionId}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "accept", answers: { q: ["A"] } }),
      },
    );
    expect(await questionAnswered.json()).toEqual({ resolved: true });
    expect(responses).toEqual([
      { id: 7, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { id: 9, result: { outcome: "accepted", answers: { q: ["A"] } } },
    ]);
  });

  test("a pause reaches the state file only as a revision", async () => {
    await hold(`approvals/${approvalId}`, { held: true });
    const snapshot = persistedSnapshot();
    expect(snapshot.sessions.map(({ id, revision }) => ({ id, revision }))).toEqual([
      { id: state.id, revision: 3 },
    ]);
    const written = JSON.stringify(snapshot);
    for (const absent of [approvalId, questionId, "heldAt", "deadline", "promptDeadlineAt"]) {
      expect(written).not.toContain(absent);
    }
  });

  test("a request that is no longer parked is stale", async () => {
    state.approvals.get(approvalId)!.respond("allow");
    expect(await hold(`approvals/${approvalId}`, { held: true })).toEqual({
      status: 409,
      body: { error: "Approval is no longer pending", status: "stale" },
    });
    expect(await hold("approvals/unknown-approval", { held: false })).toEqual({
      status: 409,
      body: { error: "Approval is no longer pending", status: "stale" },
    });
    expect(await hold("interactions/unknown-tool-call", { held: true })).toEqual({
      status: 409,
      body: { error: "Interaction is no longer pending", status: "stale" },
    });
    expect(await hold("interactions/%E0%A4%A", { held: true })).toMatchObject({ status: 409 });
  });

  test("a pause the turn leaves no room for is unavailable", async () => {
    // The turn ends before the request's own countdown does.
    state.promptDeadlineAt = state.approvals.get(approvalId)!.deadline.expiresAt - MINUTE;
    expect((await read("approvals")).approvals).toEqual([
      expect.objectContaining({ hold: { available: false, reason: "no-extension" } }),
    ]);
    expect(await hold(`approvals/${approvalId}`, { held: true })).toEqual({
      status: 422,
      body: { error: "This request's deadline cannot be extended", status: "unavailable" },
    });
    expect((await read("approvals")).revision).toBe(2);
  });

  test("malformed bodies, closing and unknown sessions answer like the answer routes", async () => {
    expect((await hold(`approvals/${approvalId}`, "{")).status).toBe(400);
    expect(await hold(`approvals/${approvalId}`, { held: "yes" })).toEqual({
      status: 400,
      body: { error: "held must be a boolean" },
    });
    expect((await hold(`interactions/${questionId}`, {})).status).toBe(400);

    expect(await hold(`approvals/${approvalId}`, { held: true }, "missing-session")).toEqual({
      status: 404,
      body: { error: "Session not found" },
    });

    state.closing = "fenced";
    expect(await hold(`approvals/${approvalId}`, { held: true })).toEqual({
      status: 409,
      body: { error: "Session is closing" },
    });
    expect((await hold(`interactions/${questionId}`, { held: true })).status).toBe(409);
    state.closing = undefined;

    const wrongMethod = await nativeFetch(
      `${origin}/session/${state.id}/approvals/${approvalId}/hold`,
      { headers },
    );
    expect(wrongMethod.status).toBe(405);
    // None of these touched the deadline or answered the request.
    expect(state.approvals.get(approvalId)!.deadline.heldAt).toBeUndefined();
    expect(responses).toEqual([]);
  });
});
