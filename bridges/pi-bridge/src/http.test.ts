import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

// `config.ts` reads its environment once, at import. Everything below is
// therefore loaded dynamically, after the environment this suite needs is in
// place — importing it statically would bind the real defaults instead.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
// Read back rather than assumed. In a shared process another suite may have
// imported `config.ts` before the assignment above, in which case the module
// froze a different token and every request here would 401 — a failure that
// looks like broken routing rather than a test that was never self-sufficient.
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { loadPersistedState } = await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;

beforeAll(async () => {
  // Explicitly ephemeral rather than relying on `PORT` above: another suite in
  // a shared process may have imported `config.ts` first, in which case that
  // assignment came too late to be read.
  await start(0);
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

function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_000,
    ...overrides,
  } as Model<Api>;
}

function installRuntime(
  overrides: Record<string, unknown> = {},
  models: Model<Api>[] = [testModel()],
): void {
  const runtime = {
    getProviders: () => [{ id: "test-provider", name: "Test Provider" }],
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: "environment", type: "api_key" }),
    getAvailable: async () => models,
    getProvider: () => ({ id: "test-provider", name: "Test Provider" }),
    getModel: (providerId: string, modelId: string) =>
      models.find((model) => model.provider === providerId && model.id === modelId),
    refresh: async () => undefined,
    ...overrides,
  } as unknown as ModelRuntime;
  setModelRuntimeFactoryForTests(async () => runtime);
  refreshModels();
}

function resetTestDependencies(): void {
  setAgentSessionTestHooks(undefined);
  setModelRuntimeFactoryForTests();
  refreshModels();
}

function fakeAgentSession(overrides: Record<string, unknown> = {}): AgentSession {
  return {
    sessionId: "pi-session-test",
    sessionFile: "/tmp/pi-session-test.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    prompt: (_text: string, options: { preflightResult?: (accepted: boolean) => void }) => {
      options.preflightResult?.(true);
      return Promise.resolve();
    },
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    ...overrides,
  } as unknown as AgentSession;
}

describe("authentication", () => {
  test("accepts the configured bearer token", async () => {
    const response = await call("/global/auth-check");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

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

describe("authorized global routes", () => {
  test("reports provider authentication without credential material", async () => {
    installRuntime();
    try {
      const response = await call("/global/auth");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        authenticated: true,
        providers: [
          {
            id: "test-provider",
            label: "Test Provider",
            authenticated: true,
            source: "environment",
            type: "api_key",
            modelCount: 1,
          },
        ],
      });
    } finally {
      resetTestDependencies();
    }
  });

  test("serves the normalized global model catalogue", async () => {
    installRuntime();
    try {
      const response = await call("/global/models");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        models: [
          {
            platform: "pi",
            id: "test-provider/test-model",
            label: "Test Model",
            providerLabel: "Test Provider",
            supportsSpeed: false,
            supportsMode: false,
          },
        ],
      });
    } finally {
      resetTestDependencies();
    }
  });

  test("refreshes the runtime before rebuilding the model catalogue", async () => {
    let refreshed = 0;
    const models = [testModel({ id: "before", name: "Before" })];
    installRuntime(
      {
        refresh: async () => {
          refreshed += 1;
          models.splice(0, models.length, testModel({ id: "after", name: "After" }));
        },
      },
      models,
    );
    try {
      const refresh = await call("/global/refresh-catalog", { method: "POST" });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toEqual({ ok: true });
      expect(refreshed).toBe(1);

      const catalogue = await (await call("/global/models")).json();
      expect(catalogue.models.map((model: { id: string }) => model.id)).toEqual([
        "test-provider/after",
      ]);
    } finally {
      resetTestDependencies();
    }
  });

  test("serves bridge-owned commands before a session exists", async () => {
    const response = await call("/plugins/commands");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commands: [{ name: "/compact", description: "Summarize the conversation to free context" }],
    });
  });
});

describe("successful lifecycle routes", () => {
  test("creates a session with the requested client key and composer selection", async () => {
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const response = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "tab-create-success",
          model: "test-provider/test-model",
          reasoningEffort: "high",
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({
        provider: "pi",
        status: "idle",
        composer: {
          selectedModelId: "test-provider/test-model",
          selectedReasoningId: "high",
        },
      });
      expect(clientSessionKeys.get("tab-create-success")).toBe(body.sessionId);
      expect(sessions.has(body.sessionId)).toBe(true);
    } finally {
      resetTestDependencies();
    }
  });

  test("create persists the session so a restart can reopen it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-persist-"));
    process.env.PI_BRIDGE_STATE_DIR = directory;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const response = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "tab-durable-create" }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { sessionId: string };
      expect(typeof body.sessionId).toBe("string");

      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();

      expect(sessions.has(body.sessionId)).toBe(true);
      expect(clientSessionKeys.get("tab-durable-create")).toBe(body.sessionId);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(directory, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  test("cold-attaches a lazily created SDK session", async () => {
    const state = seedSession();
    let creations = 0;
    const attached = fakeAgentSession({
      sessionId: "cold-pi-session",
      sessionFile: "/tmp/cold-pi-session.jsonl",
    });
    setAgentSessionTestHooks({
      createAgentSession: async () => {
        creations += 1;
        return attached;
      },
    });
    try {
      const response = await call(`/session/${state.id}/attach`, { method: "POST" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ attached: true });
      expect(creations).toBe(1);
      expect(state.session).toBe(attached);
      expect(state.piSessionId).toBe("cold-pi-session");
    } finally {
      resetTestDependencies();
    }
  });

  test("accepts and completes a prompt through the HTTP route", async () => {
    const state = seedSession();
    const prompts: string[] = [];
    state.session = fakeAgentSession({
      prompt: (text: string, options: { preflightResult?: (accepted: boolean) => void }) => {
        prompts.push(text);
        options.preflightResult?.(true);
        return Promise.resolve();
      },
    });
    installRuntime();
    try {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ship it", requestId: "req-success" }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
      expect(prompts).toEqual(["ship it"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.messages.at(-1)).toMatchObject({ role: "user", content: "ship it" });
      expect(state.status).toBe("idle");
      expect(state.promptJournal.get("req-success")?.state).toBe("completed");
    } finally {
      resetTestDependencies();
    }
  });

  test("forks through a new persisted Pi conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-fork-"));
    const forkedFile = join(directory, "forked.jsonl");
    await writeFile(
      forkedFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "forked-pi-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );
    process.env.PI_SESSION_DIR = directory;
    const state = seedSession();
    state.session = fakeAgentSession({
      sessionManager: { createBranchedSession: (entryId: string) => (entryId ? forkedFile : null) },
    });
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const response = await call(`/session/${state.id}/fork`, {
        method: "POST",
        body: JSON.stringify({ upToMessageId: "entry-1" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sessionId).not.toBe(state.id);
      expect(sessions.get(body.sessionId)?.sessionFile).toBe(await realpath(forkedFile));
    } finally {
      delete process.env.PI_SESSION_DIR;
      resetTestDependencies();
      await rm(directory, { recursive: true, force: true });
    }
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
    // `truncated` lives under `messageWindow` because that is the exact path
    // the backend's `readTranscript` reads; a flat copy parses as `false`.
    expect(whole).toMatchObject({
      baseIndex: 2,
      totalMessages: 4,
      messageWindow: { truncated: true, omittedMessages: 2 },
    });
    expect(whole.messages).toHaveLength(2);

    const tail = await (await call(`/session/${state.id}/messages?fromIndex=3`)).json();
    expect(tail).toMatchObject({ baseIndex: 3 });
    expect(tail.messages).toHaveLength(1);

    // An anchor that was evicted must return the whole retained window, not an
    // incremental slice that silently skips messages.
    const evicted = await (await call(`/session/${state.id}/messages?fromIndex=0`)).json();
    expect(evicted).toMatchObject({ baseIndex: 2 });
    expect(evicted.messages).toHaveLength(2);

    // An anchor past the live tail clamps to it rather than slicing negatively.
    const beyond = await (await call(`/session/${state.id}/messages?fromIndex=99`)).json();
    expect(beyond.messages).toHaveLength(0);
    expect(beyond).toMatchObject({ baseIndex: 4 });
  });

  test("serves the failure text and truncation flag the backend parses", async () => {
    const state = seedSession();
    state.status = "error";
    state.error = "provider refused the request";
    state.transcriptTruncated = true;
    state.droppedParts = 3;

    const body = await (await call(`/session/${state.id}/messages`)).json();
    // The backend prefers the transcript's own error whenever `/messages`
    // carries a status, so an absent one here is not falling back to `/status`
    // — it renders an errored tab with no message at all.
    expect(body.error).toBe("provider refused the request");
    expect(body.status).toBe("error");
    expect(body.messageWindow).toMatchObject({ truncated: true, omittedParts: 3 });
  });

  test("carries the session title on the status route the backend reads", async () => {
    const state = seedSession();
    state.title = "Investigate the failing suite";

    const status = await (await call(`/session/${state.id}/status`)).json();
    expect(status.title).toBe("Investigate the failing suite");
  });
});

describe("closing a session", () => {
  test("removes the session, its client key, and answers deleted", async () => {
    const state = newSessionState("tab-7");
    sessions.set(state.id, state);
    clientSessionKeys.set("tab-7", state.id);

    const response = await call(`/session/${state.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });

    // Without this route the backend's tab teardown reads a 404 as "already
    // gone" and the bridge retains the session — and its transcript — forever.
    expect(sessions.has(state.id)).toBe(false);
    expect(clientSessionKeys.has("tab-7")).toBe(false);
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "missing",
    });
  });

  test("denies anything parked on the way out", async () => {
    const state = seedSession();
    const decisions: string[] = [];
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "rm -rf build" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => decisions.push(decision),
    });

    await call(`/session/${state.id}`, { method: "DELETE" });
    // A closing session must never leave a tool call awaiting a promise
    // nothing will settle, and it must deny rather than approve.
    expect(decisions).toEqual(["deny"]);
  });

  test("cancels a turn still in flight", async () => {
    const state = seedSession();
    state.status = "running";
    let cancelled = false;
    state.cancelTurn = async () => {
      cancelled = true;
    };

    await call(`/session/${state.id}`, { method: "DELETE" });
    expect(cancelled).toBe(true);
  });

  test("answers an unknown session 404 so teardown treats it as gone", async () => {
    const response = await call("/session/never-existed", { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});

describe("resume containment", () => {
  test("refuses a handle outside the session directory", async () => {
    // The handle is a filesystem path that arrives over HTTP. Unchecked,
    // `SessionManager.open` reads any JSONL-parseable file into a transcript.
    const response = await call("/session/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId: "/etc/passwd" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/session directory|does not exist/);
  });

  test("refuses a traversal out of the session directory", async () => {
    const response = await call("/session/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId: "../../../../etc/passwd" }),
    });
    expect(response.status).toBe(400);
  });

  test("refuses a path that does not exist rather than creating a session there", async () => {
    // A nonexistent path is the write case: the SDK preserves the explicit
    // path and would create a session file wherever this points.
    const response = await call("/session/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId: "/tmp/pi-bridge-should-not-be-created.jsonl" }),
    });
    expect(response.status).toBe(400);
    expect(await Bun.file("/tmp/pi-bridge-should-not-be-created.jsonl").exists()).toBe(false);
  });

  test("still requires a handle at all", async () => {
    const response = await call("/session/resume", { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });
});

describe("compaction", () => {
  test("refuses to compact a running turn", async () => {
    const state = seedSession();
    state.status = "running";

    // Pi's manual compaction aborts the current operation, so allowing this
    // would silently cancel the turn the user is watching.
    const response = await call(`/session/${state.id}/compact`, { method: "POST" });
    expect(response.status).toBe(409);
  });

  test("refuses a prompt while a compaction holds the session", async () => {
    const state = seedSession();
    state.compacting = true;

    // The window that mattered: compaction claims the session across a cold
    // attach, and a prompt admitted inside it was aborted by the compaction.
    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(response.status).toBe(409);
  });

  test("refuses a second compaction while one is already running", async () => {
    const state = seedSession();
    state.compacting = true;
    const response = await call(`/session/${state.id}/compact`, { method: "POST" });
    expect(response.status).toBe(409);
  });
});

describe("cancel", () => {
  test("reports whether there was anything to cancel", async () => {
    const state = seedSession();
    expect(await (await call(`/session/${state.id}/cancel`, { method: "POST" })).json()).toEqual({
      cancelled: false,
    });

    let cancelled = false;
    state.cancelTurn = async () => {
      cancelled = true;
    };
    expect(await (await call(`/session/${state.id}/abort`, { method: "POST" })).json()).toEqual({
      cancelled: true,
    });
    expect(cancelled).toBe(true);
  });

  test("denies parked approvals before aborting the run", async () => {
    const state = seedSession();
    const order: string[] = [];
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "make release" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => order.push(decision),
    });
    state.cancelTurn = async () => {
      order.push("abort");
    };

    await call(`/session/${state.id}/cancel`, { method: "POST" });

    expect(order).toEqual(["deny", "abort"]);
  });
});

describe("steering", () => {
  test("answers idle rather than failing when no turn is running", async () => {
    const state = seedSession();
    // The caller's view of the turn is a poll behind, so a steer that lands
    // after the turn ended is a race, not an error — and must not be turned
    // into a fresh prompt the user never sent.
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ input: "focus on the parser" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "idle" });
  });

  test("requires text to steer with", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ input: "   " }),
    });
    expect(response.status).toBe(400);
  });
});

describe("composer configuration", () => {
  test("records a model and the thinking level sent alongside it", async () => {
    const state = seedSession();
    const response = await call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({ model: "anthropic/claude-opus-4-5", reasoningId: "high" }),
    });

    expect(response.status).toBe(200);
    expect(state.composer.selectedModelId).toBe("anthropic/claude-opus-4-5");
    expect(state.composer.selectedReasoningId).toBe("high");
  });

  test("accepts the reasoningEffort spelling the backend sends", async () => {
    const state = seedSession();
    // The backend sends `reasoningEffort` on create and on every prompt.
    // Reading only `reasoningId` dropped the level silently.
    await call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-5", reasoningEffort: "xhigh" }),
    });
    expect(state.composer.selectedReasoningId).toBe("xhigh");
  });

  test("serves the current selection back with the session's commands", async () => {
    const state = seedSession();
    state.composer = { ...state.composer, selectedModelId: "anthropic/claude-opus-4-5" };
    const body = await (await call(`/session/${state.id}/config`)).json();
    expect(body.selectedModelId).toBe("anthropic/claude-opus-4-5");
    expect(Array.isArray(body.commands)).toBe(true);
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

  test("durably records prepared before handing the prompt to Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-journal-"));
    process.env.PI_BRIDGE_STATE_DIR = directory;
    try {
      const state = seedSession();
      let journalAtDispatch: unknown;
      state.session = {
        prompt: (_text: string, options: { preflightResult?: (accepted: boolean) => void }) => {
          const persisted = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
          journalAtDispatch = persisted.sessions
            .find((entry: { id: string }) => entry.id === state.id)
            ?.promptJournal.find(
              (entry: { requestId: string }) => entry.requestId === "req-durable",
            );
          options.preflightResult?.(true);
          return Promise.resolve();
        },
        abort: async () => undefined,
        getContextUsage: () => undefined,
        getSessionStats: () => ({ cost: 0 }),
        setModel: async () => undefined,
        setThinkingLevel: () => undefined,
      } as unknown as AgentSession;

      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "go", requestId: "req-durable" }),
      });

      expect(response.status).toBe(202);
      // Prepared is serialized as ambiguous on disk: that is the conservative
      // state a successor needs if this process dies as Pi accepts the prompt.
      expect(journalAtDispatch).toMatchObject({ requestId: "req-durable", state: "ambiguous" });
      const { persistBarrier } = await import("./persistence.js");
      await persistBarrier();
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not dispatch when the prepared journal cannot be made durable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-journal-failure-"));
    const notDirectory = join(directory, "not-a-directory");
    await writeFile(notDirectory, "occupied", "utf8");
    process.env.PI_BRIDGE_STATE_DIR = notDirectory;
    try {
      const state = seedSession();
      let prompts = 0;
      state.session = {
        prompt: () => {
          prompts += 1;
          return Promise.resolve();
        },
        setModel: async () => undefined,
        setThinkingLevel: () => undefined,
      } as unknown as AgentSession;

      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "must not run", requestId: "req-undurable" }),
      });

      expect(response.status).toBe(500);
      expect(prompts).toBe(0);
      expect(state.promptJournal.has("req-undurable")).toBe(false);
      expect(state.dispatching).toBe(false);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes the optimistic user message when Pi rejects preflight", async () => {
    const state = seedSession();
    state.session = {
      prompt: (_text: string, options: { preflightResult?: (accepted: boolean) => void }) => {
        options.preflightResult?.(false);
        return Promise.resolve();
      },
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
    } as unknown as AgentSession;

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "never accepted", requestId: "req-refused" }),
    });

    expect(response.status).toBe(500);
    expect(state.messages).toHaveLength(0);
    expect(state.status).toBe("error");
    expect(state.dispatching).toBe(false);
    expect(state.promptJournal.has("req-refused")).toBe(false);
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

  test("honours gzip quality values and explicit refusal over a wildcard", async () => {
    const state = seedSession();
    state.messages = Array.from({ length: 200 }, (_unused, index) => ({
      id: `quality-${index}`,
      role: "user" as const,
      content: "x".repeat(64),
      parts: [],
      createdAt: "2026-01-01T00:00:00Z",
    }));

    for (const encoding of ["gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=bogus"]) {
      const response = await nativeFetch(`${origin}/session/${state.id}/messages`, {
        headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": encoding },
      });
      expect(response.headers.get("content-encoding"), encoding).toBeNull();
      await response.arrayBuffer();
    }

    const accepted = await nativeFetch(`${origin}/session/${state.id}/messages`, {
      headers: { authorization: `Bearer ${TOKEN}`, "accept-encoding": "br, gzip;q=0.5" },
    });
    expect(accepted.headers.get("content-encoding")).toBe("gzip");
    await accepted.arrayBuffer();
  });
});
