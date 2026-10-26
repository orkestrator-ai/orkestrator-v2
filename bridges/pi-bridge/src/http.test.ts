import { publicInteractionKinds } from "./public.js";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import {
  AUTH_SECRET_CANARIES,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
} from "../../../tests/helpers/auth-secret-canaries.js";
import { testApprovalDeadline } from "./testing/approval-fixtures.js";

// `config.ts` reads its environment once, at import. Everything below is
// therefore loaded dynamically, after the environment this suite needs is in
// place — importing it statically would bind the real defaults instead.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { setDeleteCancelTimeoutForTests } = await import("./http.js");
// Read back rather than assumed. In a shared process another suite may have
// imported `config.ts` before the assignment above, in which case the module
// froze a different token and every request here would 401 — a failure that
// looks like broken routing rather than a test that was never self-sufficient.
const { authToken: TOKEN } = await import("./config.js");
const { isSessionClosed, newSessionState, setAgentSessionTestHooks } =
  await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions, clientSessionKeys, piRunId } = await import("./state.js");
const { loadPersistedState, setPersistWriteGateForTests } = await import("./persistence.js");
const { applySessionEvent } = await import("./translate.js");
const { nativeFetch } = await import("./testing/native-fetch.js");
const { buildCommandCatalogue, publishCommandCatalogue } = await import("./commands.js");
const { setCommandPreviewReaderForTests } = await import("./command-preview.js");
const { NOT_AUTHENTICATED_MESSAGE } = await import("./credentials.js");
const { requestToolApproval, resolveApproval } = await import("./interactions.js");
const { approvalTimeoutMs } = await import("./config.js");

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

/** Poll for work a route deliberately did not wait for. */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  const session = {
    sessionId: "pi-session-test",
    sessionFile: "/tmp/pi-session-test.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
      options.preflightResult?.("started");
      return Promise.resolve();
    },
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
  } as unknown as AgentSession;
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(overrides));
  return session;
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
        state: "signed-in",
        providers: [
          {
            id: "test-provider",
            label: "Test Provider",
            state: "signed-in",
            method: "api-key",
          },
        ],
        signIn: { kind: "terminal", hint: "Open a Pi terminal tab and run /login." },
        signOut: false,
      });
    } finally {
      resetTestDependencies();
    }
  });

  test("reports neither the provider credential nor where it came from", async () => {
    installRuntime({
      // Everything a provider and an auth check carry, credential fields included.
      getProviders: () => [
        {
          id: "test-provider",
          name: "Test Provider",
          apiKey: AUTH_SECRET_CANARIES.anthropicApiKey,
          oauth: { refresh: AUTH_SECRET_CANARIES.refreshToken },
        },
      ],
      checkAuth: async () => ({
        source: `env:${AUTH_SECRET_CANARIES.anthropicApiKey}`,
        type: "oauth",
        apiKey: AUTH_SECRET_CANARIES.anthropicApiKey,
        access: AUTH_SECRET_CANARIES.accessToken,
        refresh: AUTH_SECRET_CANARIES.refreshToken,
      }),
      isUsingOAuth: () => true,
    });
    try {
      const { result, output } = await captureOutput(async () => {
        const status = await call("/global/auth");
        const login = await call("/global/auth/login", { method: "POST" });
        return { status: await status.json(), login: await login.json() };
      });
      expectAuthStatusShape(result.status);
      expect(result.status).toMatchObject({
        state: "signed-in",
        providers: [{ id: "test-provider", state: "signed-in", method: "oauth" }],
      });
      expectNoCanary(result, "Pi auth routes");
      expectNothingSecretLogged(output, "Pi auth routes");
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

  test("marks the model a session with no explicit model starts on (0172)", async () => {
    // Pi's saved default is not the catalogue's first model: a launch that
    // fell back to the first one ran a model the login refused.
    const agentDir = await mkdtemp(join(tmpdir(), "pi-bridge-catalogue-default-"));
    const previous = {
      agent: process.env.PI_AGENT_DIR,
      fallback: process.env.PI_BRIDGE_DEFAULT_MODEL,
    };
    process.env.PI_AGENT_DIR = agentDir;
    delete process.env.PI_BRIDGE_DEFAULT_MODEL;
    installRuntime({}, [
      testModel({ id: "refused", name: "Refused" }),
      testModel({ id: "saved", name: "Saved" }),
    ]);
    try {
      const marked = async () =>
        ((await (await call("/global/models")).json()) as { models: Record<string, unknown>[] })
          .models;

      // No saved default and no fallback: a session starts on the first
      // model, which is where callers fall back anyway, so nothing is marked.
      expect((await marked()).some((model) => "sessionDefault" in model)).toBe(false);

      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "test-provider", defaultModel: "saved" }),
      );
      expect((await marked()).map((model) => [model.id, model.sessionDefault ?? false])).toEqual([
        ["test-provider/refused", false],
        ["test-provider/saved", true],
      ]);

      // A saved default the catalogue does not offer is skipped, as a session
      // skips it, and the backend's fallback is marked instead.
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "signed-out", defaultModel: "x" }),
      );
      process.env.PI_BRIDGE_DEFAULT_MODEL = "test-provider/saved";
      expect((await marked()).find((model) => model.sessionDefault)?.id).toBe(
        "test-provider/saved",
      );
    } finally {
      if (previous.agent === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previous.agent;
      if (previous.fallback === undefined) delete process.env.PI_BRIDGE_DEFAULT_MODEL;
      else process.env.PI_BRIDGE_DEFAULT_MODEL = previous.fallback;
      resetTestDependencies();
      await rm(agentDir, { recursive: true, force: true });
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
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "refresh-open-session" }),
      });
      const sessionId = (await created.json()).sessionId as string;
      expect(sessions.get(sessionId)?.composer.models.map((model) => model.id)).toEqual([
        "test-provider/before",
      ]);

      const refresh = await call("/global/refresh-catalog", { method: "POST" });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toEqual({ ok: true });
      expect(refreshed).toBe(1);
      expect(sessions.get(sessionId)?.composer.models.map((model) => model.id)).toEqual([
        "test-provider/after",
      ]);

      const catalogue = await (await call("/global/models")).json();
      expect(catalogue.models.map((model: { id: string }) => model.id)).toEqual([
        "test-provider/after",
      ]);
    } finally {
      // `resetTestDependencies` does not touch the session maps, and
      // `/global/refresh-catalog` force-hydrates every session it finds — so a
      // session left here would be probed by later tests against whatever
      // runtime they install.
      sessions.clear();
      clientSessionKeys.clear();
      resetTestDependencies();
    }
  });

  test("serves no legacy global command list: Pi's commands are per session", async () => {
    // Retired with the backend's global fallback. It answered an empty list.
    const response = await call("/plugins/commands");
    expect(response.status).toBe(404);
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

  test("stores tab-scoped MCP credentials and serves the live inventory", async () => {
    const { preparePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    setPiMcpTransportForTests({
      async connect() {
        return {
          tools: [{ name: "send_message" }],
          async call() {
            return { content: [{ type: "text", text: "ok" }] };
          },
          async close() {},
        };
      },
    });
    try {
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "tab-mcp",
          agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "tab-secret" },
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { sessionId: string; runtime?: { mcp?: unknown } };
      expect(JSON.stringify(body)).not.toContain("tab-secret");
      const state = sessions.get(body.sessionId)!;
      expect(state.agentMcp).toEqual({
        url: "http://127.0.0.1:4567/mcp",
        token: "tab-secret",
      });

      const empty = await call(`/session/${body.sessionId}/mcp`);
      expect(await empty.json()).toEqual({ servers: [] });

      await preparePiMcp(state, {
        agentDir: await mkdtemp(join(tmpdir(), "pi-http-mcp-")),
        cwd: process.cwd(),
        env: {},
      });
      const inventory = await call(`/session/${body.sessionId}/mcp`);
      expect(await inventory.json()).toEqual({
        servers: [
          expect.objectContaining({
            id: "orkestrator",
            scope: "orkestrator",
            status: "connected",
            tools: ["send_message"],
          }),
        ],
      });
      const status = await call(`/session/${body.sessionId}/status`);
      const statusBody = (await status.json()) as { runtime?: { mcpServers?: number } };
      expect(statusBody.runtime?.mcpServers).toBe(1);
    } finally {
      const { setPiMcpTransportForTests: reset } = await import("./mcp.js");
      reset();
      resetTestDependencies();
    }
  });

  test("accepts attach without a credential but preserves the stored one", async () => {
    setAgentSessionTestHooks({
      createAgentSession: async () => fakeAgentSession({ bindExtensions: async () => undefined }),
      hydrateComposer: async (composer) => composer,
    });
    const state = seedSession();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "token-a" };
    try {
      const response = await call(`/session/${state.id}/attach`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      expect(state.agentMcp).toEqual({ url: "http://127.0.0.1:4567/mcp", token: "token-a" });
    } finally {
      await state.session?.dispose();
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("ignores a malformed agentMcp instead of failing creation", async () => {
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "tab-malformed-mcp",
          agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "x".repeat(1025) },
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { sessionId: string };
      expect(sessions.get(body.sessionId)?.agentMcp).toBeUndefined();
    } finally {
      resetTestDependencies();
    }
  });

  test("rebuilds an attached session when a prompt rotates the agent MCP credential", async () => {
    const { preparePiMcp, setPiMcpTransportForTests: setTransport } = await import("./mcp.js");
    installRuntime();
    setTransport({
      async connect() {
        return {
          tools: [],
          async call() {
            return {};
          },
          async close() {},
        };
      },
    });
    let disposed = 0;
    setAgentSessionTestHooks({
      createAgentSession: async () => fakeAgentSession({ bindExtensions: async () => undefined }),
      hydrateComposer: async (composer) => composer,
    });
    const state = seedSession();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "token-a" };
    await preparePiMcp(state, {
      agentDir: await mkdtemp(join(tmpdir(), "pi-http-rotate-")),
      cwd: process.cwd(),
      env: {},
    });
    state.session = fakeAgentSession({
      dispose: () => {
        disposed += 1;
      },
    });
    try {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "rotate",
          requestId: "rotate-1",
          agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "token-b" },
        }),
      });

      expect(response.status, await response.clone().text()).toBe(202);
      // The old SDK session, bound to token A's MCP connection, was released
      // and a fresh one attached from the current credential.
      expect(disposed).toBe(1);
      expect(state.agentMcp?.token).toBe("token-b");
    } finally {
      await state.session?.dispose();
      const { closePiMcp, setPiMcpTransportForTests: reset } = await import("./mcp.js");
      await closePiMcp(state);
      reset();
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("a prompt adopts a config change at its own turn start and releases the claim if the rebuild fails", async () => {
    installRuntime();
    let disposed = 0;
    const readsWhileClaimed: boolean[] = [];
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      // Reached only through `atTurnStart`: without it, the prompt's own
      // `dispatching` claim makes the reconcile return before reading.
      mcpConfigNeedsRefresh: async (target) => {
        readsWhileClaimed.push(target.dispatching);
        return true;
      },
      createAgentSession: async () => {
        throw new Error("rebuild refused");
      },
    });
    const state = seedSession();
    state.session = fakeAgentSession({
      dispose: () => {
        disposed += 1;
      },
    });
    try {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "go", requestId: "reattach-1" }),
      });

      expect(response.status).toBe(500);
      expect(readsWhileClaimed).toEqual([true]);
      expect(disposed).toBe(1);
      expect(state.session).toBeNull();
      // The turn provably never ran: the claim and the prepared record go, so
      // the caller can retry under the same id.
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("reattach-1")).toBe(false);
      expect(state.status).toBe("idle");
      expect(state.messages).toHaveLength(0);
    } finally {
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("refuses attach and idempotent create from rotating MCP during a live turn", async () => {
    const {
      closePiMcp,
      preparePiMcp,
      setPiMcpTransportForTests: setTransport,
    } = await import("./mcp.js");
    let closed = 0;
    setTransport({
      async connect() {
        return {
          tools: [],
          async call() {
            return {};
          },
          async close() {
            closed += 1;
          },
        };
      },
    });
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const directory = await mkdtemp(join(tmpdir(), "pi-http-busy-mcp-"));
    const state = seedSession();
    state.clientSessionKey = "tab-busy-mcp";
    clientSessionKeys.set(state.clientSessionKey, state.id);
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "token-a" };
    await preparePiMcp(state, { agentDir: directory, cwd: process.cwd(), env: {} });
    state.status = "running";
    try {
      const rotated = {
        agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "token-b" },
      };
      const attach = await call(`/session/${state.id}/attach`, {
        method: "POST",
        body: JSON.stringify(rotated),
      });
      expect(attach.status).toBe(409);
      expect(state.agentMcp?.token).toBe("token-a");

      const create = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: state.clientSessionKey, ...rotated }),
      });
      expect(create.status).toBe(409);
      expect(state.agentMcp?.token).toBe("token-a");
      expect(closed).toBe(0);
    } finally {
      state.status = "idle";
      await closePiMcp(state);
      setTransport();
      sessions.delete(state.id);
      clientSessionKeys.delete(state.clientSessionKey);
      await rm(directory, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  test("a real read-only SDK session declares and executes inline attempt MCP tools", async () => {
    const { ModelRuntime: SdkModelRuntime } = await import("./pi-sdk.js");
    const { closeSession } = await import("./agent-session.js");
    const { setPiMcpTransportForTests } = await import("./mcp.js");
    const { workflowResultToolName, workflowResultTurnToolNames } =
      await import("@orkestrator/protocol/workflow-results");
    const directory = await mkdtemp(join(tmpdir(), "pi-http-real-read-only-"));
    const previousAgentDir = process.env.PI_AGENT_DIR;
    const previousSessionDir = process.env.PI_SESSION_DIR;
    process.env.PI_AGENT_DIR = directory;
    process.env.PI_SESSION_DIR = directory;
    const turn = { tool: workflowResultToolName("review-report"), resultKey: "sdk-attempt" };
    const tools = workflowResultTurnToolNames(turn);
    const calls: Array<{ name: string; args: unknown }> = [];
    let state: ReturnType<typeof newSessionState> | undefined;
    setAgentSessionTestHooks(undefined);
    try {
      // Real SDK/runtime, isolated credentials and no model or catalogue network
      // requests. Only the remote MCP transport is deterministic in this test.
      const runtime = await SdkModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: join(directory, "models.json"),
        allowModelNetwork: false,
      });
      await runtime.setRuntimeApiKey("anthropic", "test-only-no-provider-requests");
      setModelRuntimeFactoryForTests(async () => runtime);
      refreshModels();
      setPiMcpTransportForTests({
        connect: async () => ({
          tools: tools.map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties: { resultKey: { type: "string" } },
              required: ["resultKey"],
            },
          })),
          call: async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: "text", text: "attempt accepted" }] };
          },
          close: async () => {},
        }),
      });
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "sdk-read-only",
          readOnly: true,
          agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "sdk-attempt-token" },
        }),
      });
      expect(created.status).toBe(201);
      state = sessions.get((await created.json()).sessionId)!;
      const attached = await call(`/session/${state.id}/attach`, { method: "POST", body: "{}" });
      expect(attached.status).toBe(200);
      const session = state.session!;
      expect(state.readOnly).toBe(true);
      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([...tools]));
      const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
      let responses = 0;
      // Drive the real SDK loop and its tool_call hooks, substituting only the
      // model stream. No provider request or paid inference is needed.
      session.agent.streamFunction = (model) => {
        const first = responses++ === 0;
        const response: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: first ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: first
            ? [
                ...tools.map((name) => ({
                  type: "toolCall" as const,
                  id: `sdk-${name}`,
                  name,
                  arguments: { resultKey: turn.resultKey },
                })),
                {
                  type: "toolCall",
                  id: "wrong-attempt",
                  name: "report_finding",
                  arguments: { resultKey: "another-attempt" },
                },
              ]
            : [{ type: "text", text: "Finished." }],
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: response });
        stream.end(response);
        return stream;
      };
      const prompted = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "Review the supplied package.",
          workflowResultTool: turn.tool,
          workflowResultKey: turn.resultKey,
        }),
      });
      expect(prompted.status).toBe(202);
      await session.agent.waitForIdle();
      expect(calls).toEqual(tools.map((name) => ({ name, args: { resultKey: turn.resultKey } })));
      const results = session.agent.state.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(tools.length + 1);
      expect(results.find((result) => result.toolCallId === "wrong-attempt")).toMatchObject({
        isError: true,
      });
      for (const name of tools) {
        expect(results.find((result) => result.toolCallId === `sdk-${name}`)).toMatchObject({
          isError: false,
          content: [{ type: "text", text: "attempt accepted" }],
        });
      }
    } finally {
      if (state) {
        await closeSession(state);
        sessions.delete(state.id);
        if (state.clientSessionKey) clientSessionKeys.delete(state.clientSessionKey);
      }
      setPiMcpTransportForTests();
      resetTestDependencies();
      if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previousSessionDir;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("validates and symmetrically updates readOnly on idempotent creation", async () => {
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const malformed = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "tab-read-only", readOnly: "yes" }),
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: "readOnly must be a boolean" });

      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "tab-read-only", readOnly: true }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { sessionId: string };
      const state = sessions.get(createdBody.sessionId)!;
      expect(state.readOnly).toBe(true);

      let disposed = 0;
      state.session = fakeAgentSession({
        dispose: () => {
          disposed += 1;
        },
      });
      const recreated = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "tab-read-only", readOnly: false }),
      });
      expect(recreated.status).toBe(201);
      expect((await recreated.json()).sessionId).toBe(createdBody.sessionId);
      expect(state.readOnly).toBe(false);
      expect(state.session).toBeNull();
      expect(disposed).toBe(1);
    } finally {
      sessions.clear();
      clientSessionKeys.clear();
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

  test("status rehydrates a restored session's live model catalogue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-model-rehydrate-"));
    process.env.PI_BRIDGE_STATE_DIR = directory;
    installRuntime();
    try {
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({ clientSessionKey: "tab-model-rehydrate" }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as {
        sessionId: string;
        composer: { models: Array<{ id: string }> };
      };
      expect(createdBody.composer.models.map((model) => model.id)).toEqual([
        "test-provider/test-model",
      ]);

      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      expect(sessions.get(createdBody.sessionId)?.composer.models).toEqual([]);

      const status = await call(`/session/${createdBody.sessionId}/status`);
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as {
        composer: { models: Array<{ id: string }> };
      };
      expect(statusBody.composer.models.map((model) => model.id)).toEqual([
        "test-provider/test-model",
      ]);
      expect(sessions.get(createdBody.sessionId)?.composer.models).toHaveLength(1);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(directory, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  describe("sign-in readiness", () => {
    const signInRequired = {
      state: "authentication-required",
      message: NOT_AUTHENTICATED_MESSAGE,
      signIn: { kind: "terminal", hint: "Open a Pi terminal tab and run /login." },
    };

    async function readiness(id: string): Promise<unknown> {
      const status = await call(`/session/${id}/status`);
      expect(status.status).toBe(200);
      return ((await status.json()) as { readiness?: unknown }).readiness;
    }

    test("reports sign-in required once a catalogue read finds no signed-in provider", async () => {
      installRuntime({}, []);
      const state = seedSession();
      try {
        expect(await readiness(state.id)).toEqual(signInRequired);
      } finally {
        sessions.clear();
        resetTestDependencies();
      }
    });

    test.each([
      ["a runnable model exists", () => installRuntime()],
      [
        "the catalogue read failed",
        () =>
          installRuntime({
            getAvailable: async () => {
              throw new Error("provider offline");
            },
          }),
      ],
    ])("leaves readiness unreported when %s", async (_name, install) => {
      install();
      const state = seedSession();
      try {
        expect(await readiness(state.id)).toBeUndefined();
      } finally {
        sessions.clear();
        resetTestDependencies();
      }
    });

    test("a login made elsewhere unlocks the session after its retry deadline", async () => {
      let available: Model<Api>[] = [];
      installRuntime({ getAvailable: async () => available });
      const state = seedSession();
      const now = Date.now();
      const clock = spyOn(Date, "now");
      try {
        expect(await readiness(state.id)).toEqual(signInRequired);

        available = [testModel()];
        // Inside the retry deadline the empty answer still stands.
        expect(await readiness(state.id)).toEqual(signInRequired);
        clock.mockImplementation(() => now + 31_000);
        expect(await readiness(state.id)).toBeUndefined();
        expect(state.composer.models).toHaveLength(1);
      } finally {
        clock.mockRestore();
        sessions.clear();
        resetTestDependencies();
      }
    });

    test("refuses an attach with no signed-in provider as a sign-in problem", async () => {
      installRuntime({}, []);
      const state = seedSession();
      try {
        const response = await call(`/session/${state.id}/attach`, { method: "POST" });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          error: NOT_AUTHENTICATED_MESSAGE,
          kind: "authentication-required",
        });
      } finally {
        sessions.clear();
        resetTestDependencies();
      }
    });
  });

  test("answers a polled status read without waiting out a stalled catalogue", async () => {
    // `/status` is what the backend polls, and it budgets the whole call at the
    // same 30s the catalogue probe is bounded by. Waiting the probe out would
    // turn a slow provider into a *failed* status read, so the route publishes
    // the snapshot it has and lets the hydration finish for the next poll.
    let release: (() => void) | undefined;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ...composer, models: [{ platform: "pi", id: "late/model", label: "Late" }] };
      },
    });
    const state = seedSession();
    try {
      const status = await call(`/session/${state.id}/status`);

      expect(status.status).toBe(200);
      expect(
        ((await status.json()) as { composer: { models: unknown[] } }).composer.models,
      ).toEqual([]);

      // The hydration was not abandoned, only un-awaited: releasing it still
      // repairs the session, which is what the next poll will publish.
      release!();
      await waitFor(() => state.composer.models.length === 1);
    } finally {
      release?.();
      sessions.clear();
      resetTestDependencies();
    }
  });

  test.each([
    ["messages", "GET"],
    ["activity", "GET"],
    ["prompt", "POST"],
  ])("does not hydrate the composer on /%s", async (action, method) => {
    // Only the routes that publish composer state pay for a catalogue probe.
    // `/activity` in particular is swept for every persisted session every two
    // seconds, so probing there would put idle detaching out of reach.
    let hydrations = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => {
        hydrations += 1;
        return composer;
      },
    });
    const state = seedSession();
    try {
      await call(`/session/${state.id}/${action}`, {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ prompt: "" }) } : {}),
      });

      expect(hydrations).toBe(0);
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test("attach persists the Pi session pointer so a restart re-attaches it", async () => {
    // The bridge id alone is not enough to recover a conversation: `sessionFile`
    // is what `resumeSession` re-opens. Create publishes the id, attach is the
    // only moment the pointer exists, so it has to publish that.
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-attach-persist-"));
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const state = seedSession();
    state.clientSessionKey = "tab-durable-attach";
    clientSessionKeys.set(state.clientSessionKey, state.id);
    setAgentSessionTestHooks({
      createAgentSession: async () =>
        fakeAgentSession({
          sessionId: "attached-pi-session",
          sessionFile: "/tmp/attached-pi-session.jsonl",
        }),
      hydrateComposer: async (composer) => composer,
    });
    try {
      expect((await call(`/session/${state.id}/attach`, { method: "POST" })).status).toBe(200);

      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();

      const restored = sessions.get(state.id);
      expect(restored?.sessionFile).toBe("/tmp/attached-pi-session.jsonl");
      expect(restored?.piSessionId).toBe("attached-pi-session");
      expect(clientSessionKeys.get("tab-durable-attach")).toBe(state.id);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(directory, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  test("attach does not rewrite the state file when it is already attached", async () => {
    // The backend attaches before *every* prompt, and `ensureSession` returns an
    // already-attached session untouched. A barrier there would serialize and
    // rewrite every transcript this bridge holds, once per turn, for nothing.
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-http-attach-reattach-"));
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const stateFile = join(directory, "state.json");
    const state = seedSession();
    let creations = 0;
    setAgentSessionTestHooks({
      createAgentSession: async () => {
        creations += 1;
        return fakeAgentSession({ sessionId: "warm-pi-session" });
      },
      hydrateComposer: async (composer) => composer,
    });
    try {
      expect((await call(`/session/${state.id}/attach`, { method: "POST" })).status).toBe(200);
      expect(creations).toBe(1);
      // Removing the published file makes a second write unmistakable: only a
      // barrier that actually ran could put it back.
      await rm(stateFile, { force: true });

      expect((await call(`/session/${state.id}/attach`, { method: "POST" })).status).toBe(200);

      expect(creations).toBe(1);
      expect(await Bun.file(stateFile).exists()).toBe(false);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(directory, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  test("resume persists the adopted session so a restart can reopen it", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-bridge-http-resume-sessions-"));
    const stateDir = await mkdtemp(join(tmpdir(), "pi-bridge-http-resume-state-"));
    const sessionFile = join(sessionDir, "resumable.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "resumed-pi-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );
    process.env.PI_SESSION_DIR = sessionDir;
    process.env.PI_BRIDGE_STATE_DIR = stateDir;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const response = await call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: sessionFile }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { sessionId: string; messages?: unknown };
      expect(body).not.toHaveProperty("messages");

      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();

      expect(sessions.get(body.sessionId)?.sessionFile).toBe(await realpath(sessionFile));
    } finally {
      delete process.env.PI_SESSION_DIR;
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(sessionDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
      resetTestDependencies();
    }
  });

  test("resume adopts the tab-scoped agent MCP credential", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-bridge-http-resume-mcp-sessions-"));
    const sessionFile = join(sessionDir, "resumable-mcp.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "resumed-mcp-session",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );
    process.env.PI_SESSION_DIR = sessionDir;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const response = await call("/session/resume", {
        method: "POST",
        body: JSON.stringify({
          sessionId: sessionFile,
          agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "resume-token" },
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { sessionId: string };
      expect(sessions.get(body.sessionId)?.agentMcp).toEqual({
        url: "http://127.0.0.1:4567/mcp",
        token: "resume-token",
      });
    } finally {
      delete process.env.PI_SESSION_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await rm(sessionDir, { recursive: true, force: true });
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

  test("an attach racing close answers session-closing", async () => {
    const state = seedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAgentSessionTestHooks({
      createAgentSession: async () => {
        await gate;
        return fakeAgentSession();
      },
    });
    try {
      const attaching = call(`/session/${state.id}/attach`, { method: "POST", body: "{}" });
      await waitFor(() => state.attaching !== undefined);
      const closing = call(`/session/${state.id}/close`, { method: "POST" });
      await waitFor(() => isSessionClosed(state));
      release();
      expect((await attaching).status).toBe(409);
      expect((await closing).status).toBe(200);
    } finally {
      release();
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("accepts and completes a prompt through the HTTP route", async () => {
    const state = seedSession();
    const prompts: string[] = [];
    state.session = fakeAgentSession({
      prompt: (text: string, options: { preflightResult?: (disposition: string) => void }) => {
        prompts.push(text);
        options.preflightResult?.("started");
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

  test.each([
    [
      false,
      "Pi has no credentials for Other Provider. Sign in with /login other-provider in a Pi " +
        "terminal tab, set the provider's API key, or choose another model.",
    ],
    [
      true,
      "Pi's sign-in for Other Provider failed: it may have expired, or the network is " +
        "unavailable. Run /login other-provider in a Pi terminal tab, or choose another model.",
    ],
  ])(
    "refuses a turn whose model's provider has no login (OAuth %p) after Pi refuses preflight",
    async (oauth, message) => {
      const state = seedSession();
      let prompts = 0;
      state.session = fakeAgentSession({
        // Another provider is signed in, so the session itself attached fine.
        model: { provider: "other-provider", id: "other-model" },
        prompt: () => {
          prompts += 1;
          return Promise.reject(new Error("No API key found for other-provider."));
        },
      });
      installRuntime({
        hasConfiguredAuth: (provider: string) => provider !== "other-provider",
        checkAuth: async (provider: string) =>
          provider === "other-provider" ? undefined : { source: "environment", type: "api_key" },
        getProvider: (provider: string) => ({
          id: provider,
          name: provider === "other-provider" ? "Other Provider" : "Test Provider",
        }),
        isUsingOAuth: () => oauth,
      });
      try {
        const response = await call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "hello", requestId: "req-signed-out" }),
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: message, kind: "authentication-required" });
        expect(prompts).toBe(1);
        expect(state.messages).toHaveLength(0);
        expect(state.status).toBe("error");
        expect(state.dispatching).toBe(false);
        expect(state.promptJournal.has("req-signed-out")).toBe(false);
      } finally {
        resetTestDependencies();
      }
    },
  );

  test("fails a turn Pi ended on a failed response instead of completing it empty", async () => {
    const state = seedSession();
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        options.preflightResult?.("started");
        // What pi-agent-core emits when the run throws, e.g. an OAuth refresh.
        applySessionEvent(state, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "OAuth token refresh failed: invalid_grant",
          },
        });
        return Promise.resolve();
      },
    });
    installRuntime();
    try {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello", requestId: "req-run-failed" }),
      });
      expect(response.status).toBe(202);
      await waitFor(() => state.status !== "running");
      expect(state.status).toBe("error");
      expect(state.error).toBe("OAuth token refresh failed: invalid_grant");
      expect(state.promptJournal.get("req-run-failed")?.state).toBe("failed");
      // The reason is in the transcript too, where the next turn cannot
      // replace it, rather than an empty reply.
      const failure = state.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "status");
      expect(failure).toEqual([
        expect.objectContaining({
          type: "status",
          severity: "error",
          content: "OAuth token refresh failed: invalid_grant",
        }),
      ]);
    } finally {
      resetTestDependencies();
    }
  });

  test("a retry's answer replaces an earlier failed response", async () => {
    const state = seedSession();
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        options.preflightResult?.("started");
        applySessionEvent(state, {
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
        });
        applySessionEvent(state, {
          type: "message_end",
          message: { role: "assistant", stopReason: "stop" },
        });
        return Promise.resolve();
      },
    });
    installRuntime();
    try {
      const response = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello", requestId: "req-retried" }),
      });
      expect(response.status).toBe(202);
      await waitFor(() => state.status !== "running");
      expect(state.status).toBe("idle");
      expect(state.error).toBeUndefined();
      expect(state.promptJournal.get("req-retried")?.state).toBe("completed");
      expect(
        state.messages.flatMap((message) => message.parts).some((part) => part.type === "status"),
      ).toBe(false);
    } finally {
      resetTestDependencies();
    }
  });

  test("validates readOnly and rebuilds the SDK session across policy transitions", async () => {
    const state = seedSession();
    let disposedWritable = 0;
    let disposedReadOnly = 0;
    let creations = 0;
    state.session = fakeAgentSession({
      dispose: () => {
        disposedWritable += 1;
      },
    });
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        creations += 1;
        return fakeAgentSession({
          bindExtensions: async () => undefined,
          dispose: () => {
            if (creations === 1) disposedReadOnly += 1;
          },
        });
      },
    });
    try {
      const malformed = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "review", requestId: "req-malformed", readOnly: 1 }),
      });
      expect(malformed.status).toBe(400);
      expect(state.session).not.toBeNull();

      const review = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "review", requestId: "req-review", readOnly: true }),
      });
      expect(review.status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(state.readOnly).toBe(true);
      expect(disposedWritable).toBe(1);
      expect(creations).toBe(1);

      const fix = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "fix", requestId: "req-fix", readOnly: false }),
      });
      expect(fix.status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(state.readOnly).toBe(false);
      expect(disposedReadOnly).toBe(1);
      expect(creations).toBe(2);
    } finally {
      await state.session?.dispose();
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("records the workflow-result attempt each turn declares, and refuses a malformed one", async () => {
    const state = seedSession();
    state.session = fakeAgentSession({});
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const resultKey = "11111111-1111-4111-8111-111111111111";
    try {
      for (const malformed of [
        { workflowResultTool: "submit_review_report" },
        { workflowResultTool: "rm -rf", workflowResultKey: resultKey },
        { workflowResultTool: "submit_review_report", workflowResultKey: "not a key" },
      ]) {
        const response = await call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "review", requestId: "req-malformed", ...malformed }),
        });
        expect(response.status).toBe(400);
      }
      expect(state.workflowResultTurn).toBeUndefined();

      const review = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "review",
          requestId: "req-review",
          workflowResultTool: "submit_review_report",
          workflowResultKey: resultKey,
        }),
      });
      expect(review.status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(state.workflowResultTurn).toEqual({ tool: "submit_review_report", resultKey });

      // The next ordinary turn is not that attempt's.
      const ordinary = await call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "thanks", requestId: "req-ordinary" }),
      });
      expect(ordinary.status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(state.workflowResultTurn).toBeUndefined();
    } finally {
      await state.session?.dispose();
      sessions.delete(state.id);
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
    const stateDir = await mkdtemp(join(tmpdir(), "pi-bridge-http-fork-state-"));
    process.env.PI_SESSION_DIR = directory;
    process.env.PI_BRIDGE_STATE_DIR = stateDir;
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

      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect(body.sessionId).not.toBe(state.id);
      expect(sessions.get(body.sessionId)?.sessionFile).toBe(await realpath(forkedFile));

      // The fork is a real conversation on disk from the moment it is minted.
      // Losing its pointer to a restart would strand the branched JSONL file
      // with nothing left that knows how to reopen it.
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      expect(sessions.get(body.sessionId)?.sessionFile).toBe(await realpath(forkedFile));
    } finally {
      delete process.env.PI_SESSION_DIR;
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      resetTestDependencies();
      await rm(directory, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("session routes", () => {
  test("status exposes the provider identity accepted by resume", async () => {
    const state = seedSession();
    state.sessionFile = "/tmp/resumable-pi-session.jsonl";

    expect(await (await call(`/session/${state.id}/status`)).json()).toMatchObject({
      resumableSessionId: state.sessionFile,
    });
  });

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

  test("reports a parked approval as waiting rather than merely busy", async () => {
    const state = seedSession();
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
      createdAt: Date.now(),
      deadline: testApprovalDeadline(),
      settle: () => undefined,
    });

    // The shared activity vocabulary: the backend observer rejects anything
    // else, and `blocked` used to fail the whole provider group.
    expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
      activity: "waiting",
    });
  });

  test("does not refresh liveness from the activity or dispatch sweeps", async () => {
    const state = seedSession();
    state.lastAccessed = 0;
    state.health.recordUnknown("future-event");

    await call(`/session/${state.id}/activity`);
    await call(`/session/${state.id}/dispatch?requestId=req-1`);
    expect(await (await call(`/session/${state.id}/runtime-health`)).json()).toMatchObject({
      summary: { drift: { unknownEvents: 1, unknownKinds: ["future-event"] } },
      notices: [],
    });
    // Refreshing here would put idle detaching permanently out of reach: the
    // backend sweeps every persisted session every couple of seconds.
    expect(state.lastAccessed).toBe(0);

    await call(`/session/${state.id}/status`);
    expect(state.lastAccessed).toBeGreaterThan(0);
  });

  test("reports the attached generation's MCP configuration without touching liveness", async () => {
    const { preparePiMcp, closePiMcp, setPiMcpTransportForTests } = await import("./mcp.js");
    setPiMcpTransportForTests({
      connect: async () => ({ tools: [], call: async () => ({}), close: async () => {} }),
    });
    const root = await mkdtemp(join(tmpdir(), "pi-http-mcp-config-"));
    try {
      await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      const state = seedSession();
      state.lastAccessed = 0;
      await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });
      // Detached: nothing loaded, nothing reported, but the bridge still says
      // it reports, so the backend does not read it as an older bridge.
      const detached = await (await call(`/session/${state.id}/runtime-health`)).json();
      expect(detached.mcpConfig).toBeUndefined();
      expect(detached.mcpConfigReporting).toBe(MCP_CONFIG_REPORTING_VERSION);
      expect(
        (await (await call(`/session/unknown-session/runtime-health`)).json()).mcpConfigReporting,
      ).toBe(MCP_CONFIG_REPORTING_VERSION);

      state.session = {} as never;
      const body = await (await call(`/session/${state.id}/runtime-health`)).json();
      expect(body.mcpConfig).toMatchObject({
        fingerprint: expect.any(String),
        sources: {
          user: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/),
          project: "excluded",
        },
        builtAt: expect.any(String),
      });
      expect(state.lastAccessed).toBe(0);
      state.session = null;
      await closePiMcp(state);
    } finally {
      setPiMcpTransportForTests();
      await rm(root, { recursive: true, force: true });
    }
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

    // A tail read keeps only the newest messages; an unusable limit is ignored.
    const newest = await (await call(`/session/${state.id}/messages?limit=1`)).json();
    expect(newest).toMatchObject({
      baseIndex: 3,
      totalMessages: 4,
      messageWindow: { truncated: true, omittedMessages: 3 },
    });
    expect(newest.messages.map((message: { id: string }) => message.id)).toEqual(["m4"]);
    const ignored = await (await call(`/session/${state.id}/messages?limit=0`)).json();
    expect(ignored).toMatchObject({ baseIndex: 2 });
    expect(ignored.messages).toHaveLength(2);
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
      deadline: testApprovalDeadline(),
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

  test("finishes deletion when cancellation never settles", async () => {
    const state = newSessionState("tab-hung-cancel");
    sessions.set(state.id, state);
    clientSessionKeys.set("tab-hung-cancel", state.id);
    state.status = "running";
    state.cancelTurn = () => new Promise<void>(() => undefined);
    setDeleteCancelTimeoutForTests(5);
    try {
      const response = await call(`/session/${state.id}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
      expect(clientSessionKeys.has("tab-hung-cancel")).toBe(false);
    } finally {
      setDeleteCancelTimeoutForTests();
    }
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
      deadline: testApprovalDeadline(),
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
  test("withdraws a steer whose session closes during the Pi call", async () => {
    const state = seedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let clears = 0;
    state.session = fakeAgentSession({
      steer: async () => {
        entered = true;
        await gate;
      },
      clearQueue: () => {
        clears += 1;
        return { steering: [], followUp: [] };
      },
      pendingMessageCount: 1,
    });
    state.status = "running";
    state.promptSequence = 3;
    try {
      const steering = call(`/session/${state.id}/steer`, {
        method: "POST",
        body: JSON.stringify({
          input: "late instruction",
          requestId: "steer-close",
          expectedRunId: piRunId(state),
        }),
      });
      await waitFor(() => entered);
      const closing = call(`/session/${state.id}/close`, { method: "POST" });
      await waitFor(() => isSessionClosed(state));
      release();
      expect((await steering).status).toBe(409);
      expect(clears).toBe(1);
      await closing;
    } finally {
      release();
      sessions.delete(state.id);
    }
  });

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

  test("pins, deduplicates, and reconciles delivery without requeueing", async () => {
    let steerCalls = 0;
    const state = seedSession();
    state.session = fakeAgentSession({
      steer: async () => {
        steerCalls += 1;
      },
    });
    state.status = "running";
    state.promptSequence = 4;
    const request = {
      input: "focus on the parser",
      requestId: "steer-4",
      expectedRunId: piRunId(state),
    };

    const accepted = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ outcome: "unknown", requestId: "steer-4" });
    expect(steerCalls).toBe(1);
    expect(state.steerJournal.get("steer-4")?.state).toBe("queued");

    const duplicate = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(duplicate.status).toBe(503);
    expect(steerCalls).toBe(1);

    const conflict = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ ...request, input: "a different instruction" }),
    });
    expect(conflict.status).toBe(409);
    expect(steerCalls).toBe(1);

    const livenessBefore = state.lastAccessed;
    expect(
      await (await call(`/session/${state.id}/steer/dispatch?requestId=steer-4`)).json(),
    ).toEqual({ dispatch: "unknown" });
    expect(state.lastAccessed).toBe(livenessBefore);

    applySessionEvent(state, {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "a different instruction" }],
        timestamp: Date.now(),
      },
    });
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({
      role: "user",
      content: "a different instruction",
    });
    expect(state.steerJournal.get("steer-4")?.state).toBe("delivered");
    expect(
      await (await call(`/session/${state.id}/steer/dispatch?requestId=steer-4`)).json(),
    ).toEqual({ dispatch: "dispatched" });

    const reconciled = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(reconciled.status).toBe(202);
    expect(await reconciled.json()).toMatchObject({ outcome: "applied", duplicate: true });
    expect(steerCalls).toBe(1);
  });

  test("removes a steer handled by an extension before a later delivery", async () => {
    const state = seedSession();
    let calls = 0;
    state.session = fakeAgentSession({
      steer: async () => (++calls === 1 ? "handled" : undefined),
    });
    state.status = "running";
    state.promptSequence = 6;
    const expectedRunId = piRunId(state);
    const handled = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "extension command",
        requestId: "handled-steer",
        expectedRunId,
      }),
    });
    expect(handled.status).toBe(503);
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.steerJournal.get("handled-steer")?.state).toBe("ambiguous");

    const later = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({ input: "real instruction", requestId: "real-steer", expectedRunId }),
    });
    expect(later.status).toBe(202);
    applySessionEvent(state, {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "real instruction" }],
        timestamp: Date.now(),
      },
    });
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.steerJournal.get("handled-steer")?.state).toBe("ambiguous");
    expect(state.steerJournal.get("real-steer")?.state).toBe("delivered");
  });

  test("rejects a steer pinned to a replaced run without entering Pi", async () => {
    let steerCalls = 0;
    const state = seedSession();
    state.session = fakeAgentSession({
      steer: async () => {
        steerCalls += 1;
      },
    });
    state.status = "running";
    state.promptSequence = 2;
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "focus on tests",
        requestId: "stale-steer",
        expectedRunId: "pi:old-generation:1",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "mismatch" });
    expect(steerCalls).toBe(0);
    expect(state.steerJournal.size).toBe(0);
  });

  test("does not miss a delivery event emitted before steer returns", async () => {
    const state = seedSession();
    state.status = "running";
    state.promptSequence = 5;
    state.session = fakeAgentSession({
      steer: async (text) => {
        applySessionEvent(state, {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          },
        });
      },
    });
    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "preserve the current API",
        requestId: "steer-fast-delivery",
        expectedRunId: piRunId(state),
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      outcome: "applied",
      requestId: "steer-fast-delivery",
    });
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.steerJournal.get("steer-fast-delivery")?.state).toBe("delivered");
    expect(state.messages.at(-1)).toMatchObject({
      role: "user",
      content: "preserve the current API",
    });
  });

  test("withdraws a steer Pi queued after its run settled", async () => {
    // Pi 0.87 awaits extension `input` handlers inside `steer()` before it
    // queues. A run that settles in that window has already had its queue
    // cleared, so the late instruction would otherwise wait for the next prompt.
    const state = seedSession();
    let finishRun: () => void = () => undefined;
    let queued = 0;
    let clears = 0;
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        options.preflightResult?.("started");
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      steer: async () => {
        finishRun();
        await waitFor(() => state.status === "idle");
        queued += 1;
      },
      clearQueue: () => {
        clears += 1;
        queued = 0;
        return { steering: [], followUp: [] };
      },
      get pendingMessageCount() {
        return queued;
      },
    });

    const prompt = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "first", requestId: "prompt-late-steer" }),
    });
    expect(prompt.status).toBe(202);
    await waitFor(() => state.status === "running" && !state.dispatching);

    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "arrives too late",
        requestId: "steer-late",
        expectedRunId: piRunId(state),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "idle" });
    // Once by `settleTurn`, once more for the instruction queued after it.
    expect(clears).toBe(2);
    expect(queued).toBe(0);
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.steerJournal.get("steer-late")?.state).toBe("dropped");
    expect(
      await (await call(`/session/${state.id}/steer/dispatch?requestId=steer-late`)).json(),
    ).toEqual({ dispatch: "absent" });
  });

  test("leaves a late steer ambiguous when a replacement run owns multiple queued messages", async () => {
    const state = seedSession();
    let finishRun: () => void = () => undefined;
    let queued = 0;
    let clears = 0;
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        options.preflightResult?.("started");
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      steer: async () => {
        finishRun();
        await waitFor(() => state.status === "idle");
        state.status = "running";
        state.promptSequence += 1;
        queued = 2;
      },
      clearQueue: () => {
        clears += 1;
        queued = 0;
        return { steering: [], followUp: [] };
      },
      get pendingMessageCount() {
        return queued;
      },
    });

    expect(
      (
        await call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "first", requestId: "prompt-before-replacement" }),
        })
      ).status,
    ).toBe(202);
    await waitFor(() => state.status === "running" && !state.dispatching);
    const expectedRunId = piRunId(state);

    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "late steer",
        requestId: "steer-replacement-ambiguous",
        expectedRunId,
      }),
    });

    expect(response.status).toBe(503);
    expect(state.steerJournal.get("steer-replacement-ambiguous")?.state).toBe("ambiguous");
    expect(queued).toBe(2);
    // The terminal cleanup cleared the old run once; withdrawal did not clear
    // the replacement run's queue.
    expect(clears).toBe(1);
  });

  test("leaves a late steer ambiguous when Pi refuses queue cleanup", async () => {
    const state = seedSession();
    let finishRun: () => void = () => undefined;
    let clearAttempts = 0;
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        options.preflightResult?.("started");
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      steer: async () => {
        finishRun();
        await waitFor(() => state.status === "idle");
      },
      clearQueue: () => {
        clearAttempts += 1;
        throw new Error("queue unavailable");
      },
      get pendingMessageCount() {
        return 1;
      },
    });

    expect(
      (
        await call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "first", requestId: "prompt-before-clear-failure" }),
        })
      ).status,
    ).toBe(202);
    await waitFor(() => state.status === "running" && !state.dispatching);

    const response = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "late steer",
        requestId: "steer-clear-ambiguous",
        expectedRunId: piRunId(state),
      }),
    });

    expect(response.status).toBe(503);
    expect(state.steerJournal.get("steer-clear-ambiguous")?.state).toBe("ambiguous");
    expect(clearAttempts).toBe(2);
  });

  test("refuses steering while the initial prompt is still in preflight", async () => {
    const state = seedSession();
    let rejectFirstRun: (error: unknown) => void = () => undefined;
    let promptCalls = 0;
    let steerCalls = 0;
    const firstRun = new Promise<void>((_resolve, reject) => {
      rejectFirstRun = reject;
    });
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        promptCalls += 1;
        if (promptCalls === 1) {
          return firstRun;
        }
        options.preflightResult?.("started");
        return Promise.resolve();
      },
      steer: async () => {
        steerCalls += 1;
      },
    });

    const firstPrompt = call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "first", requestId: "prompt-preflight" }),
    });
    await waitFor(() => state.dispatching && state.status === "running");

    const steer = await call(`/session/${state.id}/steer`, {
      method: "POST",
      body: JSON.stringify({
        input: "must not leak",
        requestId: "steer-during-preflight",
        expectedRunId: piRunId(state),
      }),
    });
    expect(await steer.json()).toEqual({ outcome: "idle" });
    expect(steerCalls).toBe(0);

    rejectFirstRun(new Error("preflight rejected"));
    const refused = await firstPrompt;
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "preflight rejected", kind: "prompt-refused" });
    expect(state.pendingSteerDeliveries).toEqual([]);
    expect(state.steerJournal.size).toBe(0);

    const secondPrompt = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "second", requestId: "prompt-after-preflight" }),
    });
    expect(secondPrompt.status).toBe(202);
    expect(steerCalls).toBe(0);
  });
});

describe("provider-owned follow-ups", () => {
  test("close during prepared-journal publication prevents a follow-up enqueue", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "pi-follow-up-close-"));
    const previous = process.env.PI_BRIDGE_STATE_DIR;
    process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
    const state = seedSession();
    state.status = "running";
    let followUps = 0;
    state.session = fakeAgentSession({
      followUp: async () => {
        followUps += 1;
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    setPersistWriteGateForTests(async () => {
      if (!held && state.promptJournal.get("follow-up-barrier")?.state === "prepared") {
        held = true;
        await gate;
      }
    });
    try {
      const following = call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "Do this next", requestId: "follow-up-barrier" }),
      });
      await waitFor(() => held);
      const closing = call(`/session/${state.id}/close`, { method: "POST" });
      await waitFor(() => isSessionClosed(state));
      release();
      expect((await following).status).toBe(409);
      expect(followUps).toBe(0);
      await closing;
    } finally {
      release();
      setPersistWriteGateForTests();
      sessions.delete(state.id);
      if (previous === undefined) delete process.env.PI_BRIDGE_STATE_DIR;
      else process.env.PI_BRIDGE_STATE_DIR = previous;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("withdraws a follow-up whose session closes during Pi input handling", async () => {
    const state = seedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let clears = 0;
    state.session = fakeAgentSession({
      followUp: async () => {
        entered = true;
        await gate;
      },
      clearQueue: () => {
        clears += 1;
        return { steering: [], followUp: [] };
      },
      pendingMessageCount: 1,
    });
    state.status = "running";
    try {
      const following = call(`/session/${state.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: "Do this next", requestId: "follow-up-close" }),
      });
      await waitFor(() => entered);
      const closing = call(`/session/${state.id}/close`, { method: "POST" });
      await waitFor(() => isSessionClosed(state));
      release();
      expect((await following).status).toBe(409);
      expect(clears).toBe(1);
      await closing;
    } finally {
      release();
      sessions.delete(state.id);
    }
  });

  test("journals and exposes a second prompt while a turn is running", async () => {
    const state = seedSession();
    const followUps: string[] = [];
    state.session = fakeAgentSession({
      followUp: async (text: string) => {
        followUps.push(text);
        state.queue.followUp.push(text);
      },
    });
    state.status = "running";

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Do this next", requestId: "follow-up-1" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true });
    expect(followUps).toEqual(["Do this next"]);
    expect(state.promptJournal.get("follow-up-1")?.state).toBe("accepted");
    expect(await (await call(`/session/${state.id}/queue`)).json()).toEqual({
      items: [{ id: "queued:0", text: "Do this next", mode: "follow-up" }],
    });
  });

  test("rolls the prepared journal entry back when followUp fails", async () => {
    const state = seedSession();
    state.session = fakeAgentSession({
      followUp: async () => {
        throw new Error("queue unavailable");
      },
    });
    state.status = "running";

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Do this next", requestId: "follow-up-failed" }),
    });

    expect(response.status).toBe(500);
    expect(state.promptJournal.has("follow-up-failed")).toBe(false);
  });

  test("withdraws a follow-up Pi queues after its target run settles", async () => {
    const state = seedSession();
    let finishRun: () => void = () => undefined;
    let promptCalls = 0;
    let queued = 0;
    const queuedAtLaterPrompt: number[] = [];
    state.session = fakeAgentSession({
      prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
        promptCalls += 1;
        options.preflightResult?.("started");
        if (promptCalls === 1) {
          return new Promise<void>((resolve) => {
            finishRun = resolve;
          });
        }
        queuedAtLaterPrompt.push(queued);
        return Promise.resolve();
      },
      followUp: async () => {
        finishRun();
        await waitFor(() => state.status === "idle");
        queued += 1;
        state.queue.followUp = ["late follow-up"];
      },
      clearQueue: () => {
        queued = 0;
        return { steering: [], followUp: [] };
      },
      get pendingMessageCount() {
        return queued;
      },
    });

    expect(
      (
        await call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "first", requestId: "prompt-before-follow-up" }),
        })
      ).status,
    ).toBe(202);
    await waitFor(() => state.status === "running" && !state.dispatching);

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "late follow-up", requestId: "late-follow-up" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ accepted: false, outcome: "idle" });
    expect(state.promptJournal.get("late-follow-up")?.state).toBe("dropped");
    expect(state.queue.followUp).toEqual([]);
    expect(queued).toBe(0);

    const later = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "ordinary later prompt", requestId: "later-prompt" }),
    });
    expect(later.status).toBe(202);
    await waitFor(() => state.status === "idle");
    expect(queuedAtLaterPrompt).toEqual([0]);
  });
});

describe("composer configuration", () => {
  test("applies a config update without waiting out a stalled catalogue", async () => {
    let release: (() => void) | undefined;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ...composer,
          models: [{ platform: "pi", id: "late/model", label: "Late" }],
        };
      },
    });
    const state = seedSession();
    try {
      const response = await call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ model: "chosen/model", reasoningId: "high" }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        selectedModelId?: string;
        selectedReasoningId?: string;
        models: unknown[];
      };
      expect(body.selectedModelId).toBe("chosen/model");
      expect(body.selectedReasoningId).toBe("high");
      expect(body.models).toEqual([]);

      // The request has completed, but the shared hydration continues. Its
      // eventual catalogue update must retain the selection the POST applied
      // while that read was in flight.
      release!();
      await waitFor(() => state.composer.models.length === 1);
      expect(state.composer.selectedModelId).toBe("chosen/model");
      expect(state.composer.selectedReasoningId).toBe("high");
    } finally {
      release?.();
      sessions.clear();
      resetTestDependencies();
    }
  });

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

  test("reports a record that predates a restart as lost, never dispatched", async () => {
    const state = seedSession();
    state.promptJournal.set("req-1", {
      requestId: "req-1",
      state: "ambiguous",
      acceptedAt: Date.now(),
    });
    state.promptJournal.set("local-1", {
      requestId: "local-1",
      state: "ambiguous",
      acceptedAt: Date.now(),
      local: true,
    });

    const response = await call(`/session/${state.id}/dispatch?requestId=req-1`);
    // Reporting a lost record as dispatched would clear the parked dispatch and
    // let the same turn run twice. `lost` is the 410 the prompt route answers.
    expect(await response.json()).toEqual({ dispatch: "lost" });
    // A local reply is answered as processed by the prompt route, so not lost.
    const local = await call(`/session/${state.id}/dispatch?requestId=local-1`);
    expect(await local.json()).toEqual({ dispatch: "unknown" });
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
    expect(await response.json()).toMatchObject({ kind: "dispatch-outcome-lost" });
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
        prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
          const persisted = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
          journalAtDispatch = persisted.sessions
            .find((entry: { id: string }) => entry.id === state.id)
            ?.promptJournal.find(
              (entry: { requestId: string }) => entry.requestId === "req-durable",
            );
          options.preflightResult?.("started");
          return Promise.resolve();
        },
        abort: async () => undefined,
        getContextUsage: () => undefined,
        getSessionStats: () => ({ cost: 0 }),
        getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
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
      prompt: (_text: string) => {
        return Promise.reject(new Error("Pi refused the prompt"));
      },
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
      getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
    } as unknown as AgentSession;

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "never accepted", requestId: "req-refused" }),
    });

    // Nothing ran, so this is a definite refusal with Pi's reason, not the
    // outcome-unknown 500 the backend would park as ambiguous.
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Pi refused the prompt",
      kind: "prompt-refused",
    });
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
      deadline: testApprovalDeadline(),
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

  describe("hold", () => {
    /**
     * Park a call through the real gate. Its timer is real but unref'd and
     * never waited on: every test settles it before it could fire.
     */
    function parkThroughGate(state: ReturnType<typeof newSessionState>) {
      state.policy = {
        id: "interactive-host",
        sandbox: "provider",
        approvals: "ask",
        projectResources: false,
        networkAccess: "restricted",
      };
      let decision: { block: boolean; reason?: string } | undefined;
      const settled = requestToolApproval(state, "call-1", "bash", {
        command: "make release",
      }).then((value) => {
        decision = value;
        return value;
      });
      const [id] = [...state.approvals.keys()];
      return { id: id!, settled, decision: () => decision };
    }

    function hold(state: ReturnType<typeof newSessionState>, id: string, body: unknown) {
      return call(`/session/${state.id}/approvals/${id}/hold`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    test("pauses and resumes the countdown without answering the call", async () => {
      const state = seedSession();
      const parked = parkThroughGate(state);
      const requestedAt = state.approvals.get(parked.id)!.createdAt;

      const paused = await hold(state, parked.id, { held: true });
      expect(paused.status).toBe(200);
      const pausedBody = (await paused.json()) as {
        status: string;
        expiresAt: number;
        hold: { available: boolean; heldAt: number };
      };
      expect(pausedBody).toEqual({
        status: "applied",
        expiresAt: expect.any(Number),
        hold: { available: true, heldAt: expect.any(Number) },
      });
      // The ceiling, a day out, not the five-minute window.
      expect(pausedBody.expiresAt).toBeGreaterThan(requestedAt + approvalTimeoutMs());

      // Still parked, and the snapshot publishes the moved deadline.
      expect(state.approvals.has(parked.id)).toBe(true);
      const snapshot = (await (await call(`/session/${state.id}/approvals`)).json()) as {
        approvals: Array<Record<string, unknown>>;
      };
      expect(snapshot.approvals).toEqual([
        expect.objectContaining({
          approvalId: parked.id,
          requestedAt,
          expiresAt: pausedBody.expiresAt,
          hold: pausedBody.hold,
        }),
      ]);

      const again = await hold(state, parked.id, { held: true });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ...pausedBody, status: "unchanged" });

      const resumed = await hold(state, parked.id, { held: false });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({
        status: "applied",
        expiresAt: expect.any(Number),
        hold: { available: true },
      });

      await Promise.resolve();
      expect(parked.decision()).toBeUndefined();
      expect(state.approvals.has(parked.id)).toBe(true);
      resolveApproval(state, parked.id, "deny");
      expect((await parked.settled).block).toBe(true);
    });

    test("answers 409 stale for an approval that is no longer parked", async () => {
      const state = seedSession();
      const parked = parkThroughGate(state);
      resolveApproval(state, parked.id, "allow");
      expect(await parked.settled).toEqual({ block: false });

      for (const id of [parked.id, "never-existed"]) {
        const response = await hold(state, id, { held: true });
        // Never 404: that is what a bridge without this route answers.
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: "Approval is no longer pending",
          status: "stale",
        });
      }
    });

    test("answers 422 when the turn's budget leaves the pause nothing to buy", async () => {
      const state = seedSession();
      state.turnDeadlineAt = Date.now() + 60_000;
      const parked = parkThroughGate(state);
      const before = state.approvals.get(parked.id)!.deadline.expiresAt;

      const response = await hold(state, parked.id, { held: true });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "This request's deadline cannot be extended",
        status: "unavailable",
      });
      expect(state.approvals.get(parked.id)!.deadline.expiresAt).toBe(before);

      resolveApproval(state, parked.id, "deny");
      await parked.settled;
    });

    test("rejects a malformed hold with 400 and never treats it as an answer", async () => {
      const state = seedSession();
      const parked = parkThroughGate(state);
      const revision = state.revision;

      for (const body of [{}, { held: "true" }, { decision: "approve" }, "not json"]) {
        const response = await hold(state, parked.id, body);
        expect(response.status).toBe(400);
      }

      // Unlike the decision route, nothing here denies or approves.
      await Promise.resolve();
      expect(parked.decision()).toBeUndefined();
      expect(state.approvals.has(parked.id)).toBe(true);
      expect(state.revision).toBe(revision);
      expect(state.approvals.get(parked.id)!.deadline.heldAt).toBeUndefined();

      resolveApproval(state, parked.id, "deny");
      await parked.settled;
    });

    test("answers an unknown session as the other approval routes do", async () => {
      const response = await call(`/session/no-such-session/approvals/a1/hold`, {
        method: "POST",
        body: JSON.stringify({ held: true }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Session not found" });
    });

    test("serves the suffix only under one approval", async () => {
      const state = seedSession();
      for (const path of [`/session/${state.id}/messages/a1/hold`, `/session/${state.id}/hold`]) {
        expect((await call(path, { method: "POST", body: "{}" })).status).toBe(404);
      }
      expect((await call(`/session/${state.id}/approvals/a1/hold`)).status).toBe(404);
    });
  });
});

describe("steering", () => {
  test("answers an idle /steer prompt locally instead of starting a turn", async () => {
    const state = seedSession();
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
    expect(state.messages[1]?.content).toContain("no active Pi turn to steer");

    const retry = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "/steer keep going", requestId: "idle-steer" }),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ accepted: true, local: true, duplicate: true });
    expect(state.messages).toHaveLength(2);
  });

  test("refuses a /steer prompt while a turn is running instead of forwarding the slash command", async () => {
    const state = seedSession();
    const followUps: string[] = [];
    state.session = fakeAgentSession({
      followUp: async (text: string) => {
        followUps.push(text);
      },
    });
    state.status = "running";

    const response = await call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "/steer narrow the scope", requestId: "busy-steer" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Use POST /session/:id/steer to steer the active turn",
    });
    expect(followUps).toEqual([]);
  });

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

/**
 * What this session can actually stop and ask for.
 *
 * The platform table says what Pi *may* raise. A session with the approval gate
 * off raises nothing, and reporting the platform's list there would promise
 * approvals that can never arrive.
 */
describe("interaction capability", () => {
  const policy = (approvals: "ask" | "auto-approve" | "deny") => ({
    id: "interactive-host" as const,
    sandbox: "none" as const,
    approvals,
    projectResources: false,
    networkAccess: "full" as const,
  });

  test("reports nothing without a policy that asks", () => {
    expect(publicInteractionKinds()).toEqual([]);
    expect(publicInteractionKinds(newSessionState())).toEqual([]);
    expect(publicInteractionKinds(newSessionState(undefined, policy("auto-approve")))).toEqual([]);
    expect(publicInteractionKinds(newSessionState(undefined, policy("deny")))).toEqual([]);
  });

  test("reports the approval kinds for a session whose policy asks", () => {
    expect(publicInteractionKinds(newSessionState(undefined, policy("ask")))).toEqual([
      "command-approval",
      "file-approval",
    ]);
  });

  test("the retired approval env override no longer turns the gate on", () => {
    process.env.PI_BRIDGE_REQUIRE_APPROVAL = "1";
    try {
      expect(publicInteractionKinds()).toEqual([]);
      expect(publicInteractionKinds(newSessionState())).toEqual([]);
    } finally {
      delete process.env.PI_BRIDGE_REQUIRE_APPROVAL;
    }
  });
});

interface CommandSeedOptions {
  templates?: Array<Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
  extensions?: Array<Record<string, unknown>>;
  overrides?: Record<string, unknown>;
}

/**
 * An attached session whose command list was built by the real builder.
 *
 * `prompts` records exactly what reached Pi and whether expansion was on.
 */
function commandSeed(options: CommandSeedOptions = {}) {
  const state = seedSession();
  const prompts: Array<{ text: string; expandPromptTemplates?: boolean }> = [];
  const extensions = options.extensions ?? [];
  const session = fakeAgentSession({
    promptTemplates: options.templates ?? [],
    resourceLoader: { getSkills: () => ({ skills: options.skills ?? [], diagnostics: [] }) },
    extensionRunner: {
      getRegisteredCommands: () => extensions,
      getCommand: (name: string) =>
        extensions.find((command) => (command.invocationName ?? command.name) === name),
    },
    isIdle: true,
    prompt: (
      text: string,
      opts: { expandPromptTemplates?: boolean; preflightResult?: (disposition: string) => void },
    ) => {
      prompts.push({ text, expandPromptTemplates: opts.expandPromptTemplates });
      opts.preflightResult?.("started");
      return Promise.resolve();
    },
    ...options.overrides,
  });
  state.session = session;
  publishCommandCatalogue(state, buildCommandCatalogue(session));
  return { state, session, prompts };
}

function template(name: string, path = `/home/someone/.pi/agent/prompts/${name}.md`) {
  return {
    name,
    description: `${name} template`,
    content: "Do $@",
    filePath: path,
    sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
  };
}

function selection(
  state: ReturnType<typeof seedSession>,
  id: string,
  args: string,
): Record<string, unknown> {
  const row = state.slashCommands.find((command) => command.id === id)!;
  return {
    id,
    name: row.name,
    executionKind: row.executionKind,
    bindingRevision: row.bindingRevision,
    arguments: args,
  };
}

async function postPrompt(state: { id: string }, body: Record<string, unknown>) {
  return call(`/session/${state.id}/prompt`, { method: "POST", body: JSON.stringify(body) });
}

describe("command catalogue routes", () => {
  test("serves the enhanced catalogue without touching liveness", async () => {
    const { state } = commandSeed({ templates: [template("review")] });
    state.lastAccessed = 1;
    try {
      const body = await (await call(`/session/${state.id}/commands`)).json();
      expect(body).toMatchObject({
        catalogueVersion: 1,
        status: "ready",
        revision: 1,
        freshness: "ttl",
        commands: [{ name: "/review", id: "pi:template:review" }],
      });
      expect(typeof body.generation).toBe("string");
      // A catalogue read is metadata; it must not keep an idle session warm.
      expect(state.lastAccessed).toBe(1);
    } finally {
      sessions.clear();
    }
  });

  test("answers an unknown session in band as missing, never 404", async () => {
    const read = await call("/session/does-not-exist/commands");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      catalogueVersion: 1,
      status: "missing",
      commands: [],
    });
    const refresh = await call("/session/does-not-exist/commands/refresh", { method: "POST" });
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).outcome).toBe("failed");
  });

  test("a new tab lists its templates and skills before the first turn, without attaching", async () => {
    let attaches = 0;
    let reads = 0;
    setAgentSessionTestHooks({
      createAgentSession: async () => {
        attaches += 1;
        throw new Error("a catalogue read must never attach");
      },
    });
    setCommandPreviewReaderForTests(async () => {
      reads += 1;
      return buildCommandCatalogue({ promptTemplates: [template("review")] as never });
    });
    try {
      const created = await call("/session/create", {
        method: "POST",
        body: JSON.stringify({
          clientSessionKey: "preview-before-first-turn",
          policy: {
            id: "interactive-host",
            sandbox: "provider",
            approvals: "auto-approve",
            projectResources: true,
            networkAccess: "full",
          },
        }),
      });
      expect(created.status).toBe(201);
      const sessionId = (await created.json()).sessionId as string;
      const state = sessions.get(sessionId)!;
      state.lastAccessed = 1;

      const body = await (await call(`/session/${sessionId}/commands`)).json();
      expect(body).toMatchObject({
        catalogueVersion: 1,
        status: "stale",
        attachPending: true,
        commands: [{ name: "/review", id: "pi:template:review", source: "template" }],
      });
      // Still metadata: the read that started the preview kept no session warm.
      expect(state.lastAccessed).toBe(1);
      // Pushed on the status the backend already polls, so a late read is seen.
      expect((await (await call(`/session/${sessionId}/status`)).json()).commandRevision).toBe(
        body.revision,
      );
      await call(`/session/${sessionId}/commands`);
      expect(reads).toBe(1);
      expect(attaches).toBe(0);
      expect(state.session).toBeNull();
    } finally {
      setCommandPreviewReaderForTests(undefined);
      setAgentSessionTestHooks(undefined);
      sessions.clear();
      clientSessionKeys.clear();
    }
  });

  test("publishes the inventory revision on status and session reads", async () => {
    // The same array the fake session serves, so a reload can change it.
    const templates = [template("review")];
    const { state } = commandSeed({
      templates,
      overrides: {
        reload: async () => {
          templates.push(template("deploy"));
        },
      },
    });
    try {
      const before = (await (await call(`/session/${state.id}/status`)).json()).commandRevision;
      expect(before).toBe(state.commandCatalogue.revision);
      expect((await (await call(`/session/${state.id}`)).json()).commandRevision).toBe(before);

      await call(`/session/${state.id}/commands/refresh`, { method: "POST" });

      const after = (await (await call(`/session/${state.id}/status`)).json()).commandRevision;
      expect(after).toBeGreaterThan(before);
      expect((await (await call(`/session/${state.id}/commands`)).json()).revision).toBe(after);
      // Unknown until this process has read a list.
      const fresh = seedSession();
      expect("commandRevision" in (await (await call(`/session/${fresh.id}/status`)).json())).toBe(
        false,
      );
    } finally {
      sessions.clear();
    }
  });

  test("refresh reloads an idle session and defers a busy one without aborting it", async () => {
    let reloads = 0;
    const { state } = commandSeed({
      templates: [template("review")],
      overrides: {
        reload: async () => {
          reloads += 1;
        },
        abort: async () => {
          throw new Error("refresh must never abort a turn");
        },
      },
    });
    try {
      const idle = await call(`/session/${state.id}/commands/refresh`, { method: "POST" });
      expect(await idle.json()).toEqual({ outcome: "reloaded" });
      expect(reloads).toBe(1);

      state.status = "running";
      const busy = await call(`/session/${state.id}/commands/refresh`, { method: "POST" });
      expect((await busy.json()).outcome).toBe("deferred");
      expect(reloads).toBe(1);
      const read = await (await call(`/session/${state.id}/commands`)).json();
      expect(read.status).toBe("stale");
      expect(read.commands.map((command: { name: string }) => command.name)).toEqual(["/review"]);
      expect(state.commandReloadPending).toBe(true);
    } finally {
      sessions.clear();
    }
  });

  test("a prompt waits for a reload in flight instead of racing it", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const { state, prompts } = commandSeed({
      templates: [template("review")],
      overrides: {
        reload: async () => {
          order.push("reload-start");
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          order.push("reload-end");
        },
      },
    });
    installRuntime();
    try {
      const refresh = call(`/session/${state.id}/commands/refresh`, { method: "POST" });
      await waitFor(() => release !== undefined);
      const prompt = postPrompt(state, { prompt: "hello", requestId: "req-after-reload" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toEqual([]);
      release!();
      expect((await refresh).status).toBe(200);
      expect((await prompt).status).toBe(202);
      expect(order).toEqual(["reload-start", "reload-end"]);
      expect(prompts.map((entry) => entry.text)).toEqual(["hello"]);
    } finally {
      release?.();
      sessions.clear();
      resetTestDependencies();
    }
  });

  test("the global refresh reloads attached sessions with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    let reloads = 0;
    installRuntime();
    try {
      for (let index = 0; index < 7; index += 1) {
        commandSeed({
          overrides: {
            reload: async () => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 10));
              inFlight -= 1;
              reloads += 1;
            },
          },
        });
      }
      const response = await call("/global/refresh-catalog", { method: "POST" });
      expect(response.status).toBe(200);
      expect(reloads).toBe(7);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      sessions.clear();
      clientSessionKeys.clear();
      resetTestDependencies();
    }
  });
});

/**
 * A row as the pre-catalogue backend saw it: `HttpBridgeCatalogAdapter.slashCommands`
 * at `ff4026b4e^` (the parent of #827, `apps/backend/src/core/http-bridge-catalog.ts`).
 */
interface LegacySlashCommand {
  name: string;
  source: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  scope?: "global" | "session";
}

const LEGACY_SOURCES = new Set([
  "builtin",
  "project",
  "user",
  "plugin",
  "skill",
  "template",
  "extension",
  "orkestrator",
]);

/** That reader's row parsing, minus its byte caps: only `payload.commands`, unknown fields ignored. */
function readAsOldBackend(payload: unknown): LegacySlashCommand[] {
  const record = payload as { commands?: unknown } | null;
  if (!record || !Array.isArray(record.commands)) return [];
  const commands = new Map<string, LegacySlashCommand>();
  for (const candidate of record.commands) {
    const command = (typeof candidate === "string" ? { name: candidate } : candidate) as Record<
      string,
      unknown
    > | null;
    const rawName = typeof command?.name === "string" ? command.name : "";
    if (!rawName) continue;
    const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
    commands.set(name, {
      name,
      source:
        typeof command?.source === "string" && LEGACY_SOURCES.has(command.source)
          ? command.source
          : "unknown",
      ...(typeof command?.description === "string" ? { description: command.description } : {}),
      ...(typeof command?.argumentHint === "string" ? { argumentHint: command.argumentHint } : {}),
      ...(Array.isArray(command?.aliases)
        ? {
            aliases: command.aliases.filter((alias): alias is string => typeof alias === "string"),
          }
        : {}),
      ...(command?.scope === "global" || command?.scope === "session"
        ? { scope: command.scope }
        : {}),
    });
  }
  return [...commands.values()];
}

/** That reader's routing: the session route first, the global list only on a 404. */
async function oldBackendSlashCommands(sessionId: string) {
  let response = await call(`/session/${encodeURIComponent(sessionId)}/commands`);
  const fellBack = response.status === 404;
  if (fellBack) response = await call("/plugins/commands");
  // `assertOk`: anything else failed the whole list.
  expect(response.ok).toBe(true);
  return { fellBack, commands: readAsOldBackend(await response.json()) };
}

describe("mixed-version: old backend, current bridge", () => {
  test("the pre-session list is gone and an unknown session reads as empty, with no fallback", async () => {
    // Without a session the old backend went straight to `/plugins/commands`.
    // The pre-#827 Pi answered `[/compact]` there and a 2.21-2.28 one `[]`;
    // the route is retired, so that read now fails, which the old backend
    // shows as "no commands" until the session exists.
    expect((await call("/plugins/commands")).status).toBe(404);

    // The pre-#827 Pi 404'd an unknown session's `/commands`, so the old
    // backend fell back to the global list and showed `/compact`. Now the
    // bridge answers in band, so it never falls back and shows nothing.
    const unknown = await call("/session/does-not-exist/commands");
    expect(unknown.status).toBe(200);
    const body = await unknown.json();
    expect(body).toMatchObject({ status: "missing", commands: [] });
    expect(readAsOldBackend(body)).toEqual([]);
    expect(await oldBackendSlashCommands("does-not-exist")).toEqual({
      fellBack: false,
      commands: [],
    });
  });

  test("a held session's enhanced rows keep the legacy row shape", async () => {
    const { state } = commandSeed({
      templates: [{ ...template("review"), argumentHint: "<path>" }],
      skills: [
        {
          name: "lint",
          description: "Lint",
          filePath: "/w/.pi/skills/lint/SKILL.md",
          sourceInfo: { path: "/w/.pi/skills/lint/SKILL.md", scope: "project" },
        },
      ],
      extensions: [{ name: "deploy", description: "Deploy it", sourceInfo: { scope: "user" } }],
    });
    try {
      const response = await call(`/session/${state.id}/commands`);
      expect(response.status).toBe(200);
      const body = await response.json();
      // The envelope is additive: top-level keys the old reader never read.
      expect(body).toMatchObject({ catalogueVersion: 1, status: "ready", revision: 1 });
      expect(Array.isArray(body.commands)).toBe(true);
      expect(body.commands).toHaveLength(3);
      for (const row of body.commands as Array<Record<string, unknown>>) {
        expect(typeof row.name).toBe("string");
        expect((row.name as string).startsWith("/")).toBe(true);
        expect(LEGACY_SOURCES.has(row.source as string)).toBe(true);
        if ("description" in row) expect(typeof row.description).toBe("string");
        if ("argumentHint" in row) expect(typeof row.argumentHint).toBe("string");
        if ("aliases" in row) expect(Array.isArray(row.aliases)).toBe(true);
        if ("scope" in row) expect(["global", "session"]).toContain(row.scope);
      }
      // What the old picker displays: the pre-#827 rows (`readSlashCommands`,
      // `ff4026b4e^:bridges/pi-bridge/src/agent-session.ts`), with one
      // additive difference — template rows now carry `scope` too.
      expect(readAsOldBackend(body)).toEqual([
        {
          name: "/review",
          source: "template",
          description: "review template",
          argumentHint: "<path>",
          scope: "global",
        },
        { name: "/skill:lint", source: "skill", description: "Lint", scope: "session" },
        { name: "/deploy", source: "extension", description: "Deploy it", scope: "global" },
      ]);
    } finally {
      sessions.clear();
    }
  });

  test("the status snapshot adds commandRevision beside unchanged legacy keys", async () => {
    // The old snapshot reader (`ff4026b4e^:apps/backend/src/core/http-bridge-progressive.ts`)
    // read `status`, then `messageRevision` or else top-level `revision` as the
    // provider revision. `commandRevision` itself is pinned under "command
    // catalogue routes"; this checks only what the old reader relied on.
    const templates = [template("review")];
    const { state } = commandSeed({
      templates,
      overrides: {
        reload: async () => {
          templates.push(template("deploy"));
        },
      },
    });
    try {
      const before = await (await call(`/session/${state.id}/status`)).json();
      expect(before.status).toBe("idle");
      expect(Number.isSafeInteger(before.revision)).toBe(true);
      expect("messageRevision" in before).toBe(false);
      expect(typeof before.composer).toBe("object");
      expect(typeof before.runtime).toBe("object");
      expect(Number.isSafeInteger(before.commandRevision)).toBe(true);

      await call(`/session/${state.id}/commands/refresh`, { method: "POST" });

      const after = await (await call(`/session/${state.id}/status`)).json();
      expect(after.commandRevision).toBeGreaterThan(before.commandRevision);
      // An inventory change also advances the session `revision`
      // (`publishCommandCatalogue`), which the old reader takes as the provider
      // revision: it may re-read once, but the revision never moves backwards.
      expect(Number.isSafeInteger(after.revision)).toBe(true);
      expect(after.revision).toBeGreaterThanOrEqual(before.revision);
      expect(after.status).toBe("idle");
    } finally {
      sessions.clear();
    }
  });

  test("a prompt without the command fields is interpreted, as Pi always did", async () => {
    // The old backend sent neither `allowProviderCommands` nor `command` to an
    // HTTP bridge, and the pre-#827 Pi always prompted with
    // `expandPromptTemplates: true` (`ff4026b4e^:bridges/pi-bridge/src/prompt.ts`).
    installRuntime();
    try {
      for (const [index, prompt] of ["/review src/a.ts", "/skill:lint now"].entries()) {
        const { state, prompts } = commandSeed({
          templates: [template("review")],
          skills: [
            { name: "lint", description: "Lint", filePath: "/s/lint/SKILL.md", sourceInfo: {} },
          ],
        });
        const response = await postPrompt(state, { prompt, requestId: `req-old-${index}` });
        expect(response.status).toBe(202);
        expect(prompts).toEqual([{ text: prompt, expandPromptTemplates: true }]);
      }
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });
});

describe("command dispatch", () => {
  test("sends a selected template as its canonical invocation with arguments verbatim", async () => {
    const { state, prompts } = commandSeed({ templates: [template("review")] });
    installRuntime();
    try {
      const response = await postPrompt(state, {
        prompt: "/review  src/a.ts\n  keep this",
        requestId: "req-template",
        command: selection(state, "pi:template:review", "src/a.ts\n  keep this"),
      });

      expect(response.status).toBe(202);
      expect(prompts).toEqual([
        { text: "/review src/a.ts\n  keep this", expandPromptTemplates: true },
      ]);
      await waitFor(() => state.status === "idle");
      expect(state.promptJournal.get("req-template")?.state).toBe("completed");
      // The transcript shows what the user typed.
      expect(state.messages[0]).toMatchObject({
        role: "user",
        content: "/review  src/a.ts\n  keep this",
      });
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test.each(["typed", "selected", "input-handler"])(
    "runs a local %s command without selected-model credentials",
    async (kind) => {
      const handled: string[] = [];
      const { state } = commandSeed({
        extensions: [{ name: "review", sourceInfo: {} }],
        overrides: {
          model: { provider: "other-provider", id: "other-model" },
          prompt: async (
            text: string,
            opts: { preflightResult?: (disposition: string) => void },
          ) => {
            if (text === "/review x" || text === "local input") {
              handled.push(text);
              opts.preflightResult?.("handled");
              return;
            }
            throw new Error("No API key found for other-provider.");
          },
        },
      });
      installRuntime({ hasConfiguredAuth: () => false, checkAuth: async () => undefined });
      try {
        // A stale selection must still fail before a local handler can execute.
        const unavailable = await postPrompt(state, {
          prompt: "/review x",
          requestId: "stale-local",
          command: { ...selection(state, "pi:extension:review", "x"), bindingRevision: "invalid" },
        });
        expect(unavailable.status).toBe(422);
        expect(handled).toEqual([]);
        const text = kind === "input-handler" ? "local input" : "/review x";
        const response = await postPrompt(state, {
          prompt: text,
          requestId: "local-no-login",
          ...(kind === "selected" ? { command: selection(state, "pi:extension:review", "x") } : {}),
        });
        expect(response.status).toBe(202);
        await waitFor(() => state.status === "idle");
        expect(handled).toEqual([text]);
        expect(state.promptJournal.get("local-no-login")?.state).toBe("completed");
        const refused = await postPrompt(state, {
          prompt: "ordinary model prompt",
          requestId: "model-no-login",
        });
        expect(refused.status).toBe(401);
        expect(await refused.json()).toMatchObject({
          kind: "authentication-required",
          error: expect.stringContaining("/login other-provider"),
        });
        expect(state.promptJournal.has("model-no-login")).toBe(false);
      } finally {
        sessions.clear();
        resetTestDependencies();
      }
    },
  );

  test("dispatches the extension that shadows a template, and refuses the shadowed row", async () => {
    const extensions = [{ name: "review", description: "Extension review", sourceInfo: {} }];
    const { state, prompts } = commandSeed({ templates: [template("review")], extensions });
    installRuntime();
    try {
      expect(state.slashCommands.map((command) => command.id)).toEqual(["pi:extension:review"]);
      const shadowed = await postPrompt(state, {
        prompt: "/review x",
        requestId: "req-shadowed",
        command: {
          id: "pi:template:review",
          name: "/review",
          executionKind: "provider-prompt",
          arguments: "x",
        },
      });
      expect(shadowed.status).toBe(422);
      expect(prompts).toEqual([]);

      const response = await postPrompt(state, {
        prompt: "/review x",
        requestId: "req-extension",
        command: selection(state, "pi:extension:review", "x"),
      });
      expect(response.status).toBe(202);
      expect(prompts).toEqual([{ text: "/review x", expandPromptTemplates: true }]);
      await waitFor(() => state.status === "idle");
      // The extension produced no model turn; the outcome says so durably.
      expect(state.messages.at(-1)?.id).toBe("command-outcome:req-extension");
      expect(state.promptJournal.get("req-extension")?.state).toBe("completed");
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test.each([
    ["a changed binding revision", { bindingRevision: "0000000000000000" }],
    ["a forged id", { id: "pi:template:not-listed", name: "/not-listed" }],
    ["a mismatched name", { name: "/other" }],
    ["a different execution kind", { executionKind: "provider-command" }],
  ])("refuses %s with 422 before journaling or dispatching", async (_label, change) => {
    const { state, prompts } = commandSeed({ templates: [template("review")] });
    installRuntime();
    try {
      const response = await postPrompt(state, {
        prompt: "/review x",
        requestId: "req-stale",
        command: { ...selection(state, "pi:template:review", "x"), ...change },
      });

      expect(response.status).toBe(422);
      expect((await response.json()).kind).toBe("command-unavailable");
      expect(prompts).toEqual([]);
      expect(state.promptJournal.has("req-stale")).toBe(false);
      expect(state.messages).toEqual([]);
      expect(state.status).toBe("idle");
      expect(state.dispatching).toBe(false);
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test("rejects malformed command fields and a command carried by a literal prompt", async () => {
    const { state, prompts } = commandSeed({ templates: [template("review")] });
    try {
      const literalCommand = await postPrompt(state, {
        prompt: "/review x",
        allowProviderCommands: false,
        command: selection(state, "pi:template:review", "x"),
      });
      expect(literalCommand.status).toBe(400);
      const badFlag = await postPrompt(state, { prompt: "x", allowProviderCommands: "no" });
      expect(badFlag.status).toBe(400);
      expect(prompts).toEqual([]);
    } finally {
      sessions.clear();
    }
  });

  test("literal intent reaches Pi with every command path off", async () => {
    const { state, prompts } = commandSeed({
      templates: [template("review")],
      skills: [{ name: "lint", description: "Lint", filePath: "/s/lint/SKILL.md", sourceInfo: {} }],
      extensions: [{ name: "deploy", sourceInfo: {} }],
    });
    installRuntime();
    try {
      for (const [index, prompt] of ["/review x", "/skill:lint", "/deploy now"].entries()) {
        const response = await postPrompt(state, {
          prompt,
          requestId: `req-literal-${index}`,
          allowProviderCommands: false,
        });
        expect(response.status).toBe(202);
        await waitFor(() => state.status === "idle");
      }
      expect(prompts).toEqual([
        { text: "/review x", expandPromptTemplates: false },
        { text: "/skill:lint", expandPromptTemplates: false },
        { text: "/deploy now", expandPromptTemplates: false },
      ]);
      // Literal text is a model turn, never an extension command outcome.
      expect(state.messages.some((message) => message.id.startsWith("command-outcome:"))).toBe(
        false,
      );
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test("a legacy /compact is answered locally and never sent to Pi", async () => {
    const { state, prompts } = commandSeed();
    try {
      const response = await postPrompt(state, { prompt: "/compact", requestId: "req-compact" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, local: true });
      expect(prompts).toEqual([]);
      expect(state.messages.at(-1)?.content).toContain("terminal command");
      expect(state.slashCommands.some((command) => command.name === "/compact")).toBe(false);

      const duplicate = await postPrompt(state, { prompt: "/compact", requestId: "req-compact" });
      expect(await duplicate.json()).toEqual({ accepted: true, local: true, duplicate: true });
      expect(state.messages).toHaveLength(2);
    } finally {
      sessions.clear();
    }
  });

  test("a session's own /compact template is a provider command, not the builtin", async () => {
    const { state, prompts } = commandSeed({ templates: [template("compact")] });
    installRuntime();
    try {
      const response = await postPrompt(state, { prompt: "/compact", requestId: "req-own" });
      expect(response.status).toBe(202);
      expect(prompts).toEqual([{ text: "/compact", expandPromptTemplates: true }]);
    } finally {
      sessions.clear();
      resetTestDependencies();
    }
  });

  test("refuses an extension command, and a literal command-like follow-up, mid-turn", async () => {
    const followUps: string[] = [];
    const { state, prompts } = commandSeed({
      templates: [template("review")],
      extensions: [{ name: "deploy", sourceInfo: {} }],
      overrides: {
        followUp: async (text: string) => {
          followUps.push(text);
        },
      },
    });
    state.status = "running";
    try {
      const extension = await postPrompt(state, {
        prompt: "/deploy",
        requestId: "req-busy-ext",
        command: selection(state, "pi:extension:deploy", ""),
      });
      expect(extension.status).toBe(409);

      // Pi's `followUp` always expands templates, so a literal `/review` has
      // no faithful queue; it is refused rather than run as the template.
      const literal = await postPrompt(state, {
        prompt: "/review x",
        requestId: "req-busy-literal",
        allowProviderCommands: false,
      });
      expect(literal.status).toBe(409);

      // Literal text Pi would not interpret still queues.
      const plain = await postPrompt(state, {
        prompt: "/not/a/command",
        requestId: "req-busy-plain",
        allowProviderCommands: false,
      });
      expect(plain.status).toBe(202);

      const template = await postPrompt(state, {
        prompt: "/review y",
        requestId: "req-busy-template",
        command: selection(state, "pi:template:review", "y"),
      });
      expect(template.status).toBe(202);

      expect(followUps).toEqual(["/not/a/command", "/review y"]);
      expect(prompts).toEqual([]);
      expect(state.promptJournal.has("req-busy-ext")).toBe(false);
      expect(state.promptJournal.has("req-busy-literal")).toBe(false);
    } finally {
      sessions.clear();
    }
  });
});
