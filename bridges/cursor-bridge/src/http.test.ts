/**
 * The HTTP contract, exercised through the real router.
 *
 * These are the assertions that matter most: the backend's shared bridge
 * provider parses these exact payloads for Claude, Codex and the ACP agents
 * too, so a field or status code that drifts here is a Cursor tab that stops
 * working while every unit test still passes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detachAgent,
  ensureAgent,
  setCursorMcpConfigHomeForTests,
  setCursorMcpFingerprintForTests,
  useCursorAgentForTests,
} from "./agent-session.js";
import { authToken } from "./config.js";
import { route } from "./http.js";
import { resetPlanAccountWindowsForTests, seedPlanAccountWindowsForTests } from "./plan-usage.js";
import { useCursorSdkRuntimeForTests } from "./sdk-runtime.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake, fakeAgent, type FakeAgent } from "./testing/fake-agent.js";
import { applyInteractionUpdate } from "./translate.js";
import { CURSOR_AUTHENTICATION_REQUIRED_MESSAGE, credentialStore } from "./credentials.js";

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
const defaultPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
} as const;

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
  const response = await call("/session/create", {
    method: "POST",
    body: JSON.stringify({ policy: defaultPolicy, ...body }),
  });
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

  test("reports missing Cursor credentials as authoritative session readiness", async () => {
    const previousApiKey = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    const load = spyOn(credentialStore, "load").mockResolvedValue(undefined);
    try {
      const state = await createSession();
      const status = (await (await call(`/session/${state.id}/status`)).json()) as Record<
        string,
        unknown
      >;
      expect(status.readiness).toEqual({
        state: "authentication-required",
        message: CURSOR_AUTHENTICATION_REQUIRED_MESSAGE,
      });

      const prompt = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello", requestId: "missing-auth" }),
      });
      expect(prompt.status).toBe(401);
      expect(await prompt.json()).toEqual({
        error: CURSOR_AUTHENTICATION_REQUIRED_MESSAGE,
        kind: "authentication-required",
      });
    } finally {
      load.mockRestore();
      if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousApiKey;
    }
  });

  test("reports an authenticated credential as ready", async () => {
    const previousApiKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "status-test-key";
    try {
      const state = await createSession();
      const status = (await (await call(`/session/${state.id}/status`)).json()) as Record<
        string,
        unknown
      >;
      expect(status.readiness).toEqual({ state: "ready" });
    } finally {
      if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousApiKey;
    }
  });

  test("an attached agent is ready without reading credentials", async () => {
    const state = await createSession();
    attachFake(state);
    const load = spyOn(credentialStore, "load").mockRejectedValue(
      new Error("attached sessions must not load credentials"),
    );
    try {
      const status = (await (await call(`/session/${state.id}/status`)).json()) as Record<
        string,
        unknown
      >;
      expect(status.readiness).toEqual({ state: "ready" });
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });
});

describe("session creation", () => {
  test("returns the shared session projection", async () => {
    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({
        clientSessionKey: "k",
        model: "composer-2",
        mode: "plan",
        policy: defaultPolicy,
      }),
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

  test("stores a per-tab agentMcp and ignores a malformed one", async () => {
    const state = await createSession({
      agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "tab-secret" },
    });
    expect(state.agentMcp).toEqual({
      url: "http://127.0.0.1:4567/mcp",
      token: "tab-secret",
    });

    const rejected = await createSession({
      clientSessionKey: "malformed-mcp",
      agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "x".repeat(1025) },
    });
    expect(rejected.agentMcp).toBeUndefined();
  });

  test("records the read-only boundary before the session is attached", async () => {
    const state = await createSession({ mode: "plan", readOnly: true });

    expect(state.readOnly).toBe(true);
    expect(state.agent).toBeNull();
  });

  test("rejects a malformed read-only boundary at session creation", async () => {
    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({ policy: defaultPolicy, readOnly: "yes" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "readOnly must be a boolean" });
  });

  test("recreating an idle session under a stricter boundary drops its warm agent", async () => {
    const state = await createSession({ clientSessionKey: "tab-1", readOnly: false });
    attachFake(state);

    const again = await createSession({ clientSessionKey: "tab-1", readOnly: true });

    // Creation is idempotent by client key, so this is the same session.
    expect(again).toBe(state);
    expect(again.readOnly).toBe(true);
    expect(again.agent).toBeNull();
  });

  test("refuses to move the read-only boundary of a running session", async () => {
    const state = await createSession({ clientSessionKey: "tab-2", readOnly: false });
    attachFake(state);
    state.status = "running";

    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({
        policy: defaultPolicy,
        clientSessionKey: "tab-2",
        readOnly: true,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Session is already running" });
    expect(state.readOnly).toBe(false);
    expect(state.agent).not.toBeNull();
  });

  test("status exposes token-delta progress while the first model call is running", async () => {
    const state = await createSession({ model: "grok-4.6" });
    state.status = "running";
    state.currentRunModelId = "grok-4.6";
    state.currentTurnUsage = {};
    applyInteractionUpdate(state, { type: "token-delta", tokens: 17 });

    const status = (await (await call(`/session/${state.id}/status`)).json()) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({
      status: "running",
      contextUsage: {
        modelId: "grok-4.6",
        usedTokens: 17,
        lastTurnTokens: 17,
        sessionTokens: 17,
        estimated: true,
      },
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

  test("rejects session creation without a backend execution policy", async () => {
    const response = await call("/session/create", {
      method: "POST",
      body: JSON.stringify({ clientSessionKey: "missing-policy" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "policy is required" });
  });

  test("rejects session resume without a backend execution policy", async () => {
    const response = await call("/session/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId: "cursor-agent-1" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "policy is required" });
  });

  test("rejects a second resume of the same agent under a different policy", async () => {
    const existing = await createSession();
    existing.agentId = "cursor-shared-agent";
    const denied = await call("/session/resume", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "cursor-shared-agent",
        policy: {
          id: "coordinator-read-only",
          sandbox: "provider",
          approvals: "deny",
          projectResources: false,
          capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
          networkAccess: "restricted",
        },
      }),
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({
      error: "Cursor session is already adopted under a different execution policy",
    });
  });
});

describe("liveness routes", () => {
  test("status exposes the provider identity accepted by resume", async () => {
    const state = await createSession();
    state.agentId = "cursor-agent-1";

    expect(await (await call(`/session/${state.id}/status`)).json()).toMatchObject({
      resumableSessionId: "cursor-agent-1",
    });
  });

  test("an unknown session answers activity in band rather than 404", async () => {
    const response = await call("/session/nope/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activity: "missing" });
  });

  test("other routes on an unknown session are a plain 404", async () => {
    expect((await call("/session/nope/status")).status).toBe(404);
  });

  test("routes usage explicitly and rejects unknown session subpaths", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    state.usage = {
      turn: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      updatedAt: new Date(0).toISOString(),
    };
    const getUsage = spyOn(agent, "getUsage").mockResolvedValue({ runs: [] });

    const usage = await call(`/session/${state.id}/usage`);
    expect(usage.status).toBe(200);
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(await usage.json()).toHaveProperty("contextUsage");

    const unknown = await call(`/session/${state.id}/unknown`, { method: "DELETE" });
    expect(unknown.status).toBe(404);
    expect(sessions.has(state.id)).toBe(true);
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
    state.health.recordUnknown("future-update");
    await call(`/session/${state.id}/activity`);
    await call(`/session/${state.id}/dispatch?requestId=x`);
    const health = await call(`/session/${state.id}/runtime-health`);
    expect(await health.json()).toMatchObject({
      summary: { drift: { unknownEvents: 1, unknownKinds: ["future-update"] } },
      notices: [],
    });
    expect(state.lastAccessed).toBe(0);

    await call(`/session/${state.id}/status`);
    expect(state.lastAccessed).toBeGreaterThan(0);
  });

  test("runtime health reports the attached agent's MCP configuration without attaching", async () => {
    const home = await mkdtemp(join(tmpdir(), "cursor-http-mcp-config-"));
    setCursorMcpConfigHomeForTests(home);
    const { restore } = stubEnsureAgentResume(fakeAgent());
    try {
      const state = await createSession();
      await detachAgent(state);
      state.agentId = "kept-conversation";
      state.lastAccessed = 0;
      const detached = await (await call(`/session/${state.id}/runtime-health`)).json();
      expect(detached.mcpConfig).toBeUndefined();
      // The read attached nothing and refreshed nothing.
      expect(state.agent).toBeNull();
      expect(state.lastAccessed).toBe(0);

      await ensureAgent(state);
      const attached = await (await call(`/session/${state.id}/runtime-health`)).json();
      expect(attached.mcpConfig).toMatchObject({
        fingerprint: expect.any(String),
        sources: { user: "absent" },
        builtAt: expect.any(String),
      });
      expect(state.lastAccessed).toBe(0);
    } finally {
      restore();
      setCursorMcpConfigHomeForTests();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("prompt dispatch", () => {
  test("carries a container policy through a read-only prompt", async () => {
    const state = await createSession({
      readOnly: true,
      policy: {
        id: "pipeline",
        sandbox: "container",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "restricted",
      },
    });
    const agent = attachFake(state);

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "review", requestId: "read-only", readOnly: true }),
    });

    expect(response.status).toBe(202);
    expect(state.policy).toMatchObject({ sandbox: "container", networkAccess: "restricted" });
    expect(state.readOnly).toBe(true);
    expect(agent.sends).toHaveLength(1);
  });

  test("accepts a turn, records it, and renders the streamed reply", async () => {
    const state = await createSession();
    let release = () => undefined as void;
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
      hold: new Promise<void>((resolve) => {
        release = () => resolve();
      }),
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

    release();
    await waitFor(() => state.status !== "running");
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "Workingdone",
      parts: [
        { type: "text", content: "Working" },
        { type: "tool-invocation", toolName: "read", toolUseId: "c1" },
        { type: "text", content: "done" },
      ],
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

  test("refuses attach while a turn is running and leaves the agent in place", async () => {
    const state = await createSession();
    let release = () => undefined as void;
    const agent = attachFake(state, {
      hold: new Promise<void>((resolve) => (release = () => resolve())),
    });

    await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "first", requestId: "r1" }),
    });
    const attach = await call(`/session/${state.id}/attach`, {
      method: "POST",
      body: JSON.stringify({
        agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "token-b" },
      }),
    });
    expect(attach.status).toBe(409);
    expect(await attach.json()).toEqual({ error: "Session is already running" });
    expect(state.agent).toBe(agent);
    expect(state.agentMcp).toBeUndefined();

    release();
    await waitFor(() => state.status !== "running");
    expect((await call(`/session/${state.id}/attach`, { method: "POST", body: "{}" })).status).toBe(
      200,
    );
    expect(state.agent).toBe(agent);
  });

  test("answers an idle /steer locally instead of starting a model turn", async () => {
    const state = await createSession();
    attachFake(state);
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "/steer keep going", requestId: "idle-steer" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, local: true });
    expect(state.status).toBe("idle");
    expect(state.promptJournal.get("idle-steer")).toMatchObject({
      state: "completed",
      local: true,
    });
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1]?.content).toContain("no active Cursor turn to steer");

    const retry = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "/steer keep going", requestId: "idle-steer" }),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ accepted: true, local: true, duplicate: true });
    expect(state.messages).toHaveLength(2);
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
    expect(state.messages).toEqual([]);
    expect(state.uncheckedTranscriptBytes).toBe(0);
  });

  test("a run that fails to start rolls the turn back rather than wedging it", async () => {
    const state = await createSession();
    const revision = state.revision;
    attachFake(state, {
      // A defensive simulation of an SDK that emits progress before `send`
      // rejects. The rollback must clear state created in that narrow window.
      updatesBeforeStartFailure: [{ type: "token-delta", tokens: 9 }],
      failToStart: new Error("provider refused"),
    });

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
    });
    expect(response.status).toBe(500);
    expect(state.status).toBe("error");
    // Prompt claim, delivered token delta, then rollback. This proves the
    // estimate existed inside the failure window before the rollback cleared it.
    expect(state.revision).toBe(revision + 3);
    expect(state.currentTurnOutputTokenEstimate).toBeUndefined();
    expect(state.currentRunUsageUpdatedAt).toBeUndefined();
    expect((await (await call(`/session/${state.id}/status`)).json()) as object).not.toHaveProperty(
      "contextUsage.estimated",
    );
    // The id was released, so the caller may retry under the same one: nothing
    // ran, and that is provable rather than assumed.
    expect(state.promptJournal.has("r1")).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.uncheckedTranscriptBytes).toBe(0);
    // The SDK agent that refused `send` must not be reused. Leaving it attached
    // is what makes the same HTTP 500 come back on every retry.
    expect(state.agent).toBeNull();
  });

  test("a send that fails to start releases the agent so a retry can re-attach", async () => {
    const state = await createSession();
    const refused = attachFake(state, { failToStart: new Error("provider refused") });
    const conversationId = state.agentId;

    const failed = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
    });
    expect(failed.status).toBe(500);
    expect(state.agent).toBeNull();
    expect(state.agentId).toBe(conversationId);
    expect(state.promptJournal.has("r1")).toBe(false);
    expect(refused.sends).toHaveLength(1);

    const replacement = fakeAgent();
    const { restore, resumed } = stubEnsureAgentResume(replacement);
    try {
      const retry = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
      });
      expect(retry.status).toBe(202);
      expect(resumed).toEqual([conversationId]);
      expect(state.agent).toBe(replacement);
      expect(state.agent).not.toBe(refused);
      expect(state.agentId).toBe(conversationId);
      expect(refused.sends).toHaveLength(1);
      expect(replacement.sends).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({ role: "user", content: "hi" });
    } finally {
      restore();
    }
  });

  test("a prompt adopts a config change at its own turn start and releases the claim if the resume fails", async () => {
    const state = await createSession();
    state.agentId = "kept-conversation";
    const first = fakeAgent();
    const { restore, resumed } = stubEnsureAgentResume(first);
    const readsWhileClaimed: boolean[] = [];
    let fingerprint = "before";
    setCursorMcpFingerprintForTests(async (target) => {
      readsWhileClaimed.push(target.dispatching);
      return fingerprint;
    });
    const refuseResume = useCursorAgentForTests({
      resume: async (agentId: string) => {
        resumed.push(agentId);
        if (resumed.length > 1) throw new Error("resume unavailable");
        return first;
      },
      create: async () => {
        throw new Error("a configuration change must never start a new conversation");
      },
    } as Parameters<typeof useCursorAgentForTests>[0]);
    try {
      expect(await ensureAgent(state)).toBe(first);
      readsWhileClaimed.length = 0;
      fingerprint = "after";

      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "go", requestId: "config-1" }),
      });

      expect(response.status).toBe(500);
      // Read under the prompt's own claim: only `atTurnStart` gets that far.
      expect(readsWhileClaimed[0]).toBe(true);
      expect(resumed).toEqual(["kept-conversation", "kept-conversation"]);
      expect(first.sends).toHaveLength(0);
      expect(state.agent).toBeNull();
      expect(state.agentId).toBe("kept-conversation");
      expect(state.configResumePending).toBe(true);
      // The turn provably never ran: the claim and the prepared record go.
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("config-1")).toBe(false);
      expect(state.status).toBe("idle");
      expect(state.messages).toEqual([]);
    } finally {
      refuseResume();
      restore();
      setCursorMcpFingerprintForTests();
    }
  });

  test("a stalled detach does not hold the prompt 500 or steal a replacement agent", async () => {
    const state = await createSession();
    let finishCleanup: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const refused = attachFake(state, {
      failToStart: new Error("provider refused"),
      holdDispose: cleanup,
    });
    state.workspaceWarmRelease = () => cleanup;
    state.hostedMcpClose = () => cleanup;

    const failed = await Promise.race([
      call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("prompt 500 was held by detach cleanup")), 200),
      ),
    ]);
    expect(failed.status).toBe(500);
    expect(state.agent).toBeNull();
    expect(state.promptJournal.has("r1")).toBe(false);
    expect(refused.sends).toHaveLength(1);

    const replacement = fakeAgent();
    const { restore } = stubEnsureAgentResume(replacement);
    try {
      const retry = await Promise.race([
        call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("retry was held by the in-flight dispose")), 200),
        ),
      ]);
      expect(retry.status).toBe(202);
      expect(state.agent).toBe(replacement);
      expect(state.agent).not.toBe(refused);
      expect(refused.sends).toHaveLength(1);
      expect(replacement.sends).toHaveLength(1);

      finishCleanup();
      await Promise.resolve();
      expect(state.agent).toBe(replacement);
    } finally {
      finishCleanup();
      restore();
    }
  });

  test("a rejected detach still returns the prompt 500", async () => {
    const state = await createSession();
    const refused = attachFake(state, {
      failToStart: new Error("provider refused"),
      failDispose: new Error("dispose exploded"),
    });
    state.workspaceWarmRelease = async () => {
      throw new Error("warm release failed");
    };
    state.hostedMcpClose = async () => {
      throw new Error("mcp close failed");
    };

    const failed = await Promise.race([
      call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("prompt 500 was held by a rejected detach")), 200),
      ),
    ]);
    expect(failed.status).toBe(500);
    expect(state.agent).toBeNull();
    expect(state.promptJournal.has("r1")).toBe(false);
    expect(refused.sends).toHaveLength(1);

    const replacement = fakeAgent();
    const { restore } = stubEnsureAgentResume(replacement);
    try {
      const retry = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hi", requestId: "r1" }),
      });
      expect(retry.status).toBe(202);
      expect(state.agent).toBe(replacement);
      expect(refused.sends).toHaveLength(1);
      await Promise.resolve();
      expect(state.agent).toBe(replacement);
    } finally {
      restore();
    }
  });

  test("starting a prompt clears an estimate left by the previous run", async () => {
    const state = await createSession();
    let release = () => undefined as void;
    attachFake(state, { hold: new Promise<void>((resolve) => (release = () => resolve())) });
    state.currentTurnOutputTokenEstimate = 42;
    state.currentRunUsageUpdatedAt = new Date(1).toISOString();

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "next", requestId: "r1" }),
    });

    expect(response.status).toBe(202);
    expect(state.currentTurnOutputTokenEstimate).toBeUndefined();
    expect(state.currentRunUsageUpdatedAt).toBeUndefined();
    release();
    await waitFor(() => state.status !== "running");
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

describe("global usage", () => {
  beforeEach(() => {
    resetPlanAccountWindowsForTests();
  });

  test("answers null rather than an empty plan when no credential resolves", async () => {
    const payload = (await (await call("/global/usage")).json()) as { account: unknown };
    // The backend reads `null` as unavailable; `[]` would render as "no metered
    // plan limits" for an account that was never read.
    expect(payload.account).toBeNull();
  });

  test("returns an authoritative empty list when the account genuinely reports none", async () => {
    seedPlanAccountWindowsForTests([]);
    const payload = (await (await call("/global/usage")).json()) as { account: unknown };
    expect(payload.account).toEqual([]);
  });

  test("returns the cached plan windows", async () => {
    seedPlanAccountWindowsForTests([
      { window: "billing_cycle", label: "Cursor quota", usedPercent: 42 },
    ]);
    const payload = (await (await call("/global/usage")).json()) as {
      account: Array<Record<string, unknown>>;
    };
    expect(payload.account).toEqual([
      { window: "billing_cycle", label: "Cursor quota", usedPercent: 42 },
    ]);
  });
});

describe("steering", () => {
  test("qualifies the no-touch dispatch route without a journal entry", async () => {
    const state = await createSession();
    const response = await call(
      `/session/${state.id}/steer/dispatch?requestId=orkestrator-steer-qualification`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatch: "unknown" });
  });

  test("answers idle when no run can accept steering", async () => {
    const state = await createSession();
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "focus on tests",
        requestId: "steer-idle",
        expectedRunId: "run-1",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "idle" });
  });

  test("pins, delivers, and deduplicates a running steer", async () => {
    const state = await createSession();
    const steered: string[] = [];
    state.status = "running";
    state.activeRun = {
      id: "run-1",
      supports: (feature: string) => feature === "stream",
      steer: async (text: string) => {
        steered.push(text);
        return "complete_delivered";
      },
    } as SessionState["activeRun"];

    const accepted = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "narrow the scope",
        requestId: "steer-1",
        expectedRunId: "run-1",
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ outcome: "applied", requestId: "steer-1" });
    expect(steered).toEqual(["narrow the scope"]);

    const duplicate = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "narrow the scope",
        requestId: "steer-1",
        expectedRunId: "run-1",
      }),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ outcome: "applied", duplicate: true });
    expect(steered).toEqual(["narrow the scope"]);

    const mismatch = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "something else",
        requestId: "steer-2",
        expectedRunId: "run-old",
      }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ outcome: "mismatch" });

    expect(
      await (await call(`/session/${state.id}/steer/dispatch?requestId=steer-1`)).json(),
    ).toEqual({ dispatch: "dispatched" });
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
    expect(await (await call("/global/slash-commands")).json()).toMatchObject({ commands: [] });
  });
});

describe("provider commands", () => {
  const unsupported = { catalogueVersion: 1, status: "unsupported", commands: [] };

  test("legacy catalogue routes stay empty and the enhanced envelope says unsupported", async () => {
    const state = await createSession();
    state.lastAccessed = 0;
    // `commands: []` is all an older backend reads; the envelope keeps a newer
    // one from mistaking "no SDK surface" for an authoritative empty list.
    expect(await (await call("/global/slash-commands")).json()).toEqual(unsupported);
    expect(await (await call(`/session/${state.id}/commands`)).json()).toEqual(unsupported);
    const refresh = await call(`/session/${state.id}/commands/refresh`, { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ outcome: "unsupported" });
    // Metadata reads never keep an idle agent attached.
    expect(state.lastAccessed).toBe(0);
  });

  test("an unknown session is answered in band, never 404", async () => {
    const commands = await call("/session/nope/commands");
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({
      catalogueVersion: 1,
      status: "missing",
      commands: [],
    });
    const refresh = await call("/session/nope/commands/refresh", { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ outcome: "unsupported" });
  });

  test("a selected command is refused before anything is journaled or sent", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "/review src",
        requestId: "command-1",
        allowProviderCommands: true,
        command: {
          id: "cursor:review",
          name: "/review",
          executionKind: "provider-prompt",
          arguments: "src",
        },
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Cursor exposes no provider commands",
      kind: "command-unavailable",
    });
    expect(agent.sends).toHaveLength(0);
    expect(state.promptJournal.has("command-1")).toBe(false);
    expect(state.messages).toEqual([]);
  });

  test("malformed command fields are caller errors", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    for (const body of [
      { prompt: "hello", allowProviderCommands: "no" },
      { prompt: "hello", command: { id: "x" } },
      {
        prompt: "/review",
        allowProviderCommands: false,
        command: { id: "x", name: "/x", executionKind: "provider-prompt", arguments: "" },
      },
    ]) {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ ...body, requestId: "bad" }),
      });
      expect(response.status).toBe(400);
    }
    expect(agent.sends).toHaveLength(0);
    expect(state.promptJournal.has("bad")).toBe(false);
  });

  test("literal intent skips the local /steer reply and sends the text unchanged", async () => {
    const state = await createSession();
    const agent = attachFake(state);
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "/steer is a word in this workflow input",
        requestId: "literal-1",
        allowProviderCommands: false,
      }),
    });
    expect(response.status).toBe(202);
    await waitFor(() => agent.sends.length === 1);
    expect(JSON.stringify(agent.sends[0]?.message)).toContain(
      "/steer is a word in this workflow input",
    );
    expect(state.promptJournal.get("literal-1")?.local).toBeUndefined();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the bridge to settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Drive a retry through production `ensureAgent` instead of assigning
 * `state.agent` by hand. Resume is the path that keeps conversation continuity
 * after a refused send; create would start a new one.
 */
function stubEnsureAgentResume(replacement: FakeAgent): { restore: () => void; resumed: string[] } {
  const previousApiKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = previousApiKey?.trim() ? previousApiKey : "retry-test-key";
  resetPlanAccountWindowsForTests();
  const resumed: string[] = [];
  const restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: () => undefined,
    createPlatform: (async () => ({
      prewarmLocalWorkspace: async () => async () => undefined,
    })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
  });
  const restoreAgent = useCursorAgentForTests({
    resume: async (agentId: string) => {
      resumed.push(agentId);
      return replacement;
    },
    create: async () => {
      throw new Error("retry must resume the persisted conversation, not create");
    },
  } as Parameters<typeof useCursorAgentForTests>[0]);
  return {
    resumed,
    restore() {
      restoreAgent();
      restoreRuntime();
      if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousApiKey;
    },
  };
}
