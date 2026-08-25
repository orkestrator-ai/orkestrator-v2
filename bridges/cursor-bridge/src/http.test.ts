/**
 * The HTTP contract, exercised through the real router.
 *
 * These are the assertions that matter most: the backend's shared bridge
 * provider parses these exact payloads for Claude, Codex and the ACP agents
 * too, so a field or status code that drifts here is a Cursor tab that stops
 * working while every unit test still passes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { authToken } from "./config.js";
import { route } from "./http.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";

let server: Server;
let baseUrl: string;

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

/**
 * The repository-wide test preload installs a browser-like `fetch` for UI
 * tests, which applies CORS to these loopback requests and rejects them. Bun's
 * native client is the same escape hatch the ACP bridge's harness uses.
 */
const nativeFetch = Bun.fetch;

async function call(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token = authToken, ...rest } = init;
  return nativeFetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

async function createSession(body: Record<string, unknown> = {}): Promise<SessionState> {
  const response = await call("/session/create", { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { sessionId: string };
  return sessions.get(payload.sessionId)!;
}

describe("authentication", () => {
  test("health is reachable without a token so a launcher can poll it", async () => {
    const response = await call("/global/health", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "cursor" });
  });

  test("every other route refuses an absent or wrong token", async () => {
    expect((await call("/global/auth-check", { token: null })).status).toBe(401);
    expect((await call("/global/auth-check", { token: "wrong" })).status).toBe(401);
    expect((await call("/global/auth-check")).status).toBe(200);
  });
});

describe("session creation", () => {
  test("returns the shared session projection", async () => {
    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({ clientSessionKey: "k", model: "composer-2", mode: "plan" }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      provider: "cursor",
      status: "idle",
      messages: [],
      baseIndex: 0,
    });
    expect(payload.sessionId).toBe(payload.id as string);
    expect(payload.composer).toMatchObject({
      selectedModelId: "composer-2",
      selectedModeId: "plan",
    });
  });

  test("is idempotent by client session key", async () => {
    const first = await createSession({ clientSessionKey: "same" });
    const second = await createSession({ clientSessionKey: "same" });
    expect(second.id).toBe(first.id);
    expect(sessions.size).toBe(1);
  });

  test("rejects an oversized client session key", async () => {
    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({ clientSessionKey: "k".repeat(600) }),
    });
    expect(response.status).toBe(400);
  });
});

describe("liveness routes", () => {
  test("an unknown session answers activity in band rather than 404", async () => {
    const response = await call("/session/nope/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activity: "missing" });
  });

  test("other routes on an unknown session are a plain 404", async () => {
    expect((await call("/session/nope/status")).status).toBe(404);
  });

  test("reports working while a turn is in flight and idle once it settles", async () => {
    const state = await createSession();
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "idle",
    });

    state.status = "running";
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "working",
    });
  });

  test("a background child keeps the session working after its turn ends", async () => {
    const state = await createSession();
    state.status = "idle";
    state.activeSubagentDescriptors.set("launch", { toolState: "success" });
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "working",
    });
  });

  test("activity does not refresh liveness, so idle detaching stays reachable", async () => {
    const state = await createSession();
    state.lastAccessed = 0;
    await call(`/session/${state.id}/activity`);
    await call(`/session/${state.id}/dispatch?requestId=x`);
    expect(state.lastAccessed).toBe(0);

    await call(`/session/${state.id}/status`);
    expect(state.lastAccessed).toBeGreaterThan(0);
  });
});

describe("prompt dispatch", () => {
  test("accepts a turn, records it, and renders the streamed reply", async () => {
    const state = await createSession();
    attachFake(state, {
      updates: [
        { type: "text-delta", text: "Working" },
        {
          type: "tool-call-completed",
          callId: "c1",
          modelCallId: "m1",
          toolCall: { type: "read", args: { path: "a.ts" } },
        },
      ],
      result: "done",
    });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hello", requestId: "r1" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });

    expect(state.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", content: "Working" });

    // The journal can answer positively the moment the run has started.
    expect(await (await call(`/session/${state.id}/dispatch?requestId=r1`)).json()).toEqual({
      dispatch: "dispatched",
    });
  });

  test("a repeat of the same request id is a duplicate, never a second turn", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "one", requestId: "r1" }),
    });
    await waitFor(() => state.status !== "running");

    const repeat = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "one", requestId: "r1" }),
    });
    expect(repeat.status).toBe(202);
    expect(await repeat.json()).toEqual({ accepted: true, duplicate: true });
    expect(agent.sends).toHaveLength(1);
  });

  test("a request id left ambiguous by a restart is refused, not replayed", async () => {
    const state = await createSession();
    attachFake(state);
    state.promptJournal.set("r1", { requestId: "r1", state: "ambiguous", acceptedAt: 0 });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "again", requestId: "r1" }),
    });
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toContain("new requestId");
    // And it still reports unknown, so a caller cannot read it as delivered.
    expect(await (await call(`/session/${state.id}/dispatch?requestId=r1`)).json()).toEqual({
      dispatch: "unknown",
    });
  });

  test("refuses a second turn while one is running", async () => {
    const state = await createSession();
    let release = () => undefined as void;
    attachFake(state, { hold: new Promise<void>((resolve) => (release = () => resolve())) });

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "first", requestId: "r1" }),
    });
    const second = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "second", requestId: "r2" }),
    });
    expect(second.status).toBe(409);
    release();
  });

  test("an empty prompt with no attachment is a caller error", async () => {
    const state = await createSession();
    attachFake(state);
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "   ", requestId: "r1" }),
    });
    expect(response.status).toBe(400);
    expect(state.promptJournal.has("r1")).toBe(false);
  });

  test("a run that fails to start rolls the turn back rather than wedging it", async () => {
    const state = await createSession();
    attachFake(state, { failToStart: new Error("provider refused") });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
    });
    expect(response.status).toBe(500);
    expect(state.status).toBe("error");
    // The id was released, so the caller may retry under the same one: nothing
    // ran, and that is provable rather than assumed.
    expect(state.promptJournal.has("r1")).toBe(false);
  });

  test("a turn that ends in error is reported as a failed session", async () => {
    const state = await createSession();
    attachFake(state, { status: "error", errorMessage: "model unavailable" });
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
    });
    await waitFor(() => state.status === "error");
    expect(state.error).toBe("model unavailable");
    expect(await (await call(`/session/${state.id}/dispatch?requestId=r1`)).json()).toEqual({
      dispatch: "dispatched",
    });
  });
});

describe("structured output", () => {
  test("parses a schema turn's final JSON value", async () => {
    const state = await createSession();
    attachFake(state, { updates: [{ type: "text-delta", text: '{"answer":42}' }] });

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "compute",
        requestId: "r1",
        outputSchema: { type: "object" },
      }),
    });
    await waitFor(() => state.status !== "running");

    const response = await call(`/session/${state.id}/structured-output?requestId=r1`);
    expect(await response.json()).toEqual({
      structuredOutput: { ok: true, provider: "cursor", requestId: "r1", value: { answer: 42 } },
    });
  });

  test("reports a turn that produced no JSON as an invalid result", async () => {
    const state = await createSession();
    attachFake(state, { updates: [{ type: "text-delta", text: "sorry, no" }] });
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "c", requestId: "r1", outputSchema: { type: "object" } }),
    });
    await waitFor(() => state.status !== "running");

    const payload = (await (
      await call(`/session/${state.id}/structured-output?requestId=r1`)
    ).json()) as { structuredOutput: { ok: boolean } };
    expect(payload.structuredOutput.ok).toBe(false);
  });

  test("an unknown request id reads as null rather than 404", async () => {
    const state = await createSession();
    expect(await (await call(`/session/${state.id}/structured-output?requestId=x`)).json()).toEqual(
      { structuredOutput: null },
    );
  });
});

describe("transcript reads", () => {
  test("serves an incremental window anchored on the absolute index", async () => {
    const state = await createSession();
    attachFake(state, { updates: [{ type: "text-delta", text: "reply" }] });
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "ask", requestId: "r1" }),
    });
    await waitFor(() => state.messages.length >= 2);

    const all = (await (await call(`/session/${state.id}/messages`)).json()) as {
      messages: unknown[];
      baseIndex: number;
    };
    expect(all.messages).toHaveLength(2);
    expect(all.baseIndex).toBe(0);

    const tail = (await (await call(`/session/${state.id}/messages?fromIndex=1`)).json()) as {
      messages: unknown[];
      baseIndex: number;
    };
    expect(tail.messages).toHaveLength(1);
    expect(tail.baseIndex).toBe(1);
  });

  test("an anchor below the retained window returns everything retained", async () => {
    const state = await createSession();
    state.droppedMessages = 10;
    const payload = (await (await call(`/session/${state.id}/messages?fromIndex=2`)).json()) as {
      baseIndex: number;
    };
    expect(payload.baseIndex).toBe(10);
  });

  test("carries provider errors and truncation metadata on the shared wire shape", async () => {
    const state = await createSession();
    state.status = "error";
    state.error = "model unavailable";
    state.droppedMessages = 3;
    state.droppedParts = 2;
    state.transcriptTruncated = true;

    const payload = (await (await call(`/session/${state.id}/messages`)).json()) as {
      error?: string;
      messageWindow?: {
        truncated?: boolean;
        omittedMessages?: number;
        omittedParts?: number;
      };
      totalMessages?: number;
    };
    expect(payload.error).toBe("model unavailable");
    expect(payload.messageWindow).toEqual({
      truncated: true,
      omittedMessages: 3,
      omittedParts: 2,
    });
    expect(payload.totalMessages).toBe(3);
  });
});

describe("composer configuration", () => {
  test("records a model change and applies it on the next turn", async () => {
    const state = await createSession({ model: "composer-2" });
    const agent = attachFake(state);

    const response = await call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({ modelId: "composer-2.5", mode: "plan" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      selectedModelId: "composer-2.5",
      selectedModeId: "plan",
    });
    // The warm agent is kept: every turn sends its own model and mode, so
    // honouring the change costs nothing and the conversation is not disturbed.
    expect(state.agent).not.toBeNull();

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "go", requestId: "r1" }),
    });
    await waitFor(() => agent.sends.length > 0);
    expect(agent.sends[0]!.options).toMatchObject({
      model: { id: "composer-2.5" },
      mode: "plan",
    });
  });

  test("a model change sent alongside a prompt applies to that same turn", async () => {
    const state = await createSession({ model: "composer-2" });
    const agent = attachFake(state);

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "go", requestId: "r1", model: "composer-2.5" }),
    });
    await waitFor(() => agent.sends.length > 0);
    // Without a per-send model this turn would silently run on the previous
    // selection, which is what the user sees as the picker being ignored.
    expect(agent.sends[0]!.options).toMatchObject({ model: { id: "composer-2.5" } });
  });

  test("refuses a config change mid-turn", async () => {
    const state = await createSession();
    state.status = "running";
    const response = await call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({ modelId: "other" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("cancellation", () => {
  test("cancels the run in flight", async () => {
    const state = await createSession();
    let release = () => undefined as void;
    const agent = attachFake(state, {
      hold: new Promise<void>((resolve) => (release = () => resolve())),
    });
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "long", requestId: "r1" }),
    });

    const response = await call(`/session/${state.id}/cancel`, { method: "POST" });
    expect(await response.json()).toEqual({ cancelled: true });
    expect(agent.cancels).toBe(1);
    release();
    await waitFor(() => state.status !== "running");
  });

  test("cancelling an idle session is a no-op rather than an error", async () => {
    const state = await createSession();
    const response = await call(`/session/${state.id}/abort`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false });
  });

  /**
   * `cancelTurn` cannot exist until `agent.send` resolves, and that call sits
   * open for as long as the SDK takes to start a run. Answering 200/`cancelled`
   * there told the user the turn had stopped while it went on writing files.
   */
  test("a cancel sent before the run handle exists still stops the turn", async () => {
    const state = await createSession();
    let releaseSend = () => undefined as void;
    const agent = attachFake(state, {
      holdSend: new Promise<void>((resolve) => (releaseSend = () => resolve())),
    });

    const prompt = call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "long", requestId: "r1" }),
    });
    await waitFor(() => agent.sends.length > 0);

    const cancel = await call(`/session/${state.id}/cancel`, { method: "POST" });
    // Parked, not honoured: saying `cancelled` here would be a claim about a
    // run that does not exist yet.
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({ cancelled: false, pending: true });

    releaseSend();
    await prompt;
    await waitFor(() => agent.cancels > 0);
    expect(agent.cancels).toBe(1);
  });

  test("a parked cancel does not carry over to the next turn", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    state.pendingCancelPromptSequence = state.promptSequence + 1;

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hello", requestId: "r1" }),
    });
    await waitFor(() => state.status !== "running");
    // The claim clears the park, so a cancel left over from an earlier turn
    // cannot stop one the user did ask for.
    expect(agent.cancels).toBe(0);
    expect(state.pendingCancelPromptSequence).toBeUndefined();
  });
});

describe("closing a session", () => {
  /**
   * Backend tab teardown DELETEs and treats a 404 as "already gone", so a
   * bridge that did not answer this leaked a session, its transcript and its
   * attached agent on every closed tab — silently, and without bound.
   */
  test("releases the agent and forgets the session", async () => {
    const state = await createSession({ clientSessionKey: "tab-1" });
    const agent = attachFake(state);
    let disposed = 0;
    (agent as unknown as Record<symbol, () => Promise<void>>)[Symbol.asyncDispose] = async () => {
      disposed += 1;
    };

    const response = await call(`/session/${state.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(disposed).toBe(1);
    expect(sessions.has(state.id)).toBe(false);
    expect(clientSessionKeys.has("tab-1")).toBe(false);

    // Gone means gone: a later read must not resurrect it, and activity has to
    // answer in band so the backend can tell this from an older bridge.
    expect((await call(`/session/${state.id}`)).status).toBe(404);
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "missing",
    });
  });

  test("deleting the same session twice is not an error the caller must handle", async () => {
    const state = await createSession();
    expect((await call(`/session/${state.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/session/${state.id}`, { method: "DELETE" })).status).toBe(404);
  });

  /**
   * A method this bridge does not serve on a session it does have is 405, not
   * 404 — otherwise a genuine gap (a route the backend speaks and this bridge
   * does not) is indistinguishable from a session that no longer exists.
   */
  test("an unsupported method on a live session is 405, not 404", async () => {
    const state = await createSession();
    expect((await call(`/session/${state.id}`, { method: "PUT" })).status).toBe(405);
    expect((await call(`/session/${state.id}/status`, { method: "POST" })).status).toBe(405);
  });
});

describe("response encoding", () => {
  /** Big enough to cross the 4KiB compression threshold. */
  async function largeTranscriptSession(): Promise<SessionState> {
    const state = await createSession();
    attachFake(state, {
      updates: [{ type: "text-delta", text: "x".repeat(8_192) }],
    });
    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
    });
    await waitFor(() => state.status !== "running");
    return state;
  }

  test("compresses a large body for a client that asked for gzip", async () => {
    const state = await largeTranscriptSession();
    const response = await call(`/session/${state.id}`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect((await response.json()).messages).toHaveLength(2);
  });

  /**
   * This repository already has a hop that asks for `identity` on purpose, and
   * a body labelled `gzip` that the caller never asked for is one it hands to
   * `JSON.parse` as binary.
   */
  test("never compresses for a client that asked for identity", async () => {
    const state = await largeTranscriptSession();
    const response = await call(`/session/${state.id}`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await response.json()).messages).toHaveLength(2);
  });

  test("honours an explicit gzip;q=0 over a permissive wildcard", async () => {
    const state = await largeTranscriptSession();
    const response = await call(`/session/${state.id}`, {
      headers: { "accept-encoding": "gzip;q=0, *" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});

describe("routes the SDK has no surface for", () => {
  test("approvals and interactions answer empty rather than 404", async () => {
    const state = await createSession();
    expect(await (await call(`/session/${state.id}/approvals`)).json()).toMatchObject({
      approvals: [],
    });
    expect(await (await call(`/session/${state.id}/interactions`)).json()).toMatchObject({
      interactions: [],
    });
    expect(await (await call("/global/slash-commands")).json()).toEqual({ commands: [] });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the bridge to settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
