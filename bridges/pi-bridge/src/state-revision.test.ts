/**
 * The state revision and the observe stream (to-do 8102 task 2, design D7).
 *
 * The harness drives each mutation path the bridge's other suites drive and
 * fails when what the backend's state read gets (`/status` without its
 * `stateRevision`, `/queue`, `/approvals`, `/interactions`) changed but the
 * revision peeked without reading did not move: a site that forgot to
 * announce itself costs the backend push latency.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import {
  SessionManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseBridgeObservationFrame } from "@orkestrator/protocol/bridge-state-revision";
import { expectStateRevisionMoves } from "@orkestrator/protocol/node/bridge-state-revision";

// `config.ts` reads its environment once, at import; see `http.test.ts`.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const {
  detachSession,
  newSessionState,
  piReadiness,
  setAgentSessionTestHooks,
  setSessionReadOnly,
} = await import("./agent-session.js");
const { refreshModels } = await import("./models.js");
const { setModelRuntimeFactoryForTests } = await import("./runtime.js");
const { sessions } = await import("./state.js");
const { applySessionEvent } = await import("./translate.js");
const { requestToolApproval } = await import("./interactions.js");
const { publicStatus } = await import("./public.js");
const { stateRevisions } = await import("./observation.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

type State = ReturnType<typeof newSessionState>;

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
});

function call(path: string, init: RequestInit & { authorize?: boolean } = {}): Promise<Response> {
  const { authorize = true, ...request } = init;
  return nativeFetch(`${origin}${path}`, {
    ...request,
    headers: {
      ...(authorize ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(request.headers as Record<string, string> | undefined),
    },
  });
}

function post(path: string, body: unknown = {}): Promise<Response> {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function installRuntime(): void {
  const model = {
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
  } as Model<Api>;
  const runtime = {
    getProviders: () => [{ id: "test-provider", name: "Test Provider" }],
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: "environment", type: "api_key" }),
    getAvailable: async () => [model],
    getProvider: () => ({ id: "test-provider", name: "Test Provider" }),
    getModel: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    refresh: async () => undefined,
  } as unknown as ModelRuntime;
  setModelRuntimeFactoryForTests(async () => runtime);
  refreshModels();
}

function resetTestDependencies(): void {
  setAgentSessionTestHooks(undefined);
  setModelRuntimeFactoryForTests();
  refreshModels();
}

/** A run this test settles: `finish` ends it, `emit` feeds Pi events first. */
function controlledSession(state: State) {
  let settle: () => void = () => undefined;
  const session = {
    sessionId: "pi-session-test",
    sessionFile: undefined,
    sessionManager: SessionManager.inMemory("/workspace"),
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    prompt: (_text: string, options: { preflightResult?: (disposition: string) => void }) => {
      options.preflightResult?.("started");
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
    abort: async () => settle(),
    clearQueue: () => ({ steering: [], followUp: [] }),
    compact: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    setSessionName: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
  } as unknown as AgentSession;
  state.session = session;
  return {
    finish: () => settle(),
    emit: (event: unknown) => applySessionEvent(state, event),
  };
}

/** A registered session with a catalogue, so no read starts a hydration. */
function seedSession(): State {
  const state = newSessionState();
  state.composer = {
    ...state.composer,
    models: [{ platform: "pi", id: "test-provider/test-model", label: "Test" }],
    selectedModelId: "test-provider/test-model",
  };
  sessions.set(state.id, state);
  return state;
}

/** Exactly what the backend's state read gets, minus the revision itself. */
async function readState(state: State): Promise<unknown> {
  const id = encodeURIComponent(state.id);
  const [status, queue, approvals, interactions] = await Promise.all(
    ["status", "queue", "approvals", "interactions"].map(async (route) => {
      const response = await call(`/session/${id}/${route}`);
      return response.status === 200 ? await response.json() : { httpStatus: response.status };
    }),
  );
  const { stateRevision: _revision, ...statusBody } = status as Record<string, unknown>;
  return { status: statusBody, queue, approvals, interactions };
}

/** Run one mutation through the harness; it must change the state read. */
async function mutation(state: State, label: string, mutate: () => unknown): Promise<void> {
  const result = await expectStateRevisionMoves({
    label,
    read: () => readState(state),
    peek: () => stateRevisions.peek(state.id),
    mutate,
  });
  expect(result, label).toEqual({ changed: true, moved: true });
}

function textDelta(delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

describe("revision harness", () => {
  test("a turn: start, streaming, tools, queue, approvals, compaction, finish", async () => {
    installRuntime();
    const state = seedSession();
    state.policy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "restricted",
    };
    const run = controlledSession(state);
    try {
      await mutation(state, "prompt start", async () => {
        const response = await post(`/session/${state.id}/prompt`, {
          prompt: "ship it",
          requestId: "rev-turn",
        });
        expect(response.status).toBe(202);
      });
      await mutation(state, "streamed text", () => run.emit(textDelta("Hello")));
      await mutation(state, "more streamed text", () => run.emit(textDelta(" world")));
      await mutation(state, "tool start", () =>
        run.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "ls" },
        }),
      );
      await mutation(state, "tool end", () =>
        run.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "README.md" }] },
          isError: false,
        }),
      );
      await mutation(state, "queue add", () =>
        run.emit({ type: "queue_update", steering: ["check the tests"], followUp: ["summarize"] }),
      );
      await mutation(state, "queue remove", () =>
        run.emit({ type: "queue_update", steering: [], followUp: [] }),
      );

      let approval: Promise<unknown> | undefined;
      await mutation(state, "approval parked", () => {
        approval = requestToolApproval(state, "call-2", "bash", { command: "make release" });
      });
      const [approvalId] = [...state.approvals.keys()];
      await mutation(state, "approval held", async () => {
        const response = await post(`/session/${state.id}/approvals/${approvalId}/hold`, {
          held: true,
        });
        expect(response.status).toBe(200);
      });
      await mutation(state, "approval answered", async () => {
        const response = await post(`/session/${state.id}/approvals/${approvalId}`, {
          decision: "approve",
        });
        expect(response.status).toBe(200);
        await approval;
      });

      await mutation(state, "second approval parked", () => {
        approval = requestToolApproval(state, "call-3", "bash", { command: "rm -rf build" });
      });
      await mutation(state, "thinking level", () =>
        run.emit({ type: "thinking_level_changed", level: "high" }),
      );
      await mutation(state, "title from Pi", () =>
        run.emit({ type: "session_info_changed", name: "Ship the release" }),
      );
      await mutation(state, "auto compaction start", () =>
        run.emit({ type: "compaction_start", reason: "threshold" }),
      );
      await mutation(state, "auto compaction end", () =>
        run.emit({
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          result: { summary: "kept the plan", tokensBefore: 1200 },
        }),
      );
      await mutation(state, "unrendered SDK event (runtime drift)", () =>
        run.emit({ type: "agent_end" }),
      );
      await mutation(state, "prompt finish", async () => {
        run.finish();
        await waitFor(() => state.status === "idle" && state.promptClaim === undefined);
      });
      // The parked call was denied when the turn ended.
      await approval;
      expect(state.approvals.size).toBe(0);
    } finally {
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("a failed turn, a refused prompt and a cancelled one", async () => {
    installRuntime();
    const state = seedSession();
    const run = controlledSession(state);
    try {
      await mutation(state, "prompt start", async () => {
        expect((await post(`/session/${state.id}/prompt`, { prompt: "a" })).status).toBe(202);
      });
      await mutation(state, "prompt error", async () => {
        run.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "OAuth token refresh failed",
          },
        });
        run.finish();
        await waitFor(() => state.status === "error" && state.promptClaim === undefined);
      });

      await mutation(state, "prompt refused in preflight", async () => {
        (state.session as unknown as { prompt: () => Promise<void> }).prompt = () =>
          Promise.reject(new Error("Pi refused"));
        const response = await post(`/session/${state.id}/prompt`, { prompt: "b" });
        expect(response.status).toBe(422);
      });

      const again = controlledSession(state);
      await mutation(state, "prompt start again", async () => {
        expect((await post(`/session/${state.id}/prompt`, { prompt: "c" })).status).toBe(202);
      });
      await mutation(state, "cancel", async () => {
        const response = await post(`/session/${state.id}/cancel`);
        expect(response.ok).toBe(true);
        again.finish();
        await waitFor(() => state.status === "idle" && state.promptClaim === undefined);
      });
    } finally {
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("configuration, title, manual compaction, health, detach and close", async () => {
    installRuntime();
    const state = seedSession();
    controlledSession(state);
    try {
      await mutation(state, "model and reasoning config", async () => {
        // Detached, so the selection is recorded rather than reconciled
        // against the fake session's (absent) model.
        const session = state.session;
        state.session = null;
        const response = await post(`/session/${state.id}/config`, {
          model: "test-provider/other-model",
          reasoningId: "high",
        });
        state.session = session;
        expect(response.status).toBe(200);
      });
      await mutation(state, "auto-compaction toggle", async () => {
        const session = state.session;
        state.session = null;
        const response = await post(`/session/${state.id}/config`, {
          parameterValues: { autoCompaction: false },
        });
        state.session = session;
        expect(response.status).toBe(200);
      });
      await mutation(state, "title route", async () => {
        const response = await post(`/session/${state.id}/title`, { title: "Renamed" });
        expect(response.status).toBe(200);
      });
      await mutation(state, "manual compaction", async () => {
        const response = await post(`/session/${state.id}/compact`);
        expect(response.status).toBe(200);
      });
      await mutation(state, "runtime notice", () =>
        state.health.recordNotice({ message: "MCP server failed", severity: "warning" }),
      );
      await mutation(state, "detach", () => detachSession(state));
      await mutation(state, "read-only", () => setSessionReadOnly(state, true));
      await mutation(state, "close", async () => {
        const response = await post(`/session/${state.id}/close`);
        expect(response.status).toBe(200);
      });
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      sessions.delete(state.id);
      resetTestDependencies();
    }
  });

  test("the harness fails a change no site announced", async () => {
    const state = seedSession();
    try {
      await expect(
        mutation(state, "silent queue edit", () => {
          state.queue = { steering: ["unannounced"], followUp: [] };
        }),
      ).rejects.toThrow("silent queue edit");
    } finally {
      sessions.delete(state.id);
    }
  });
});

describe("conditional status read", () => {
  async function status(state: State, query = ""): Promise<Record<string, unknown>> {
    const response = await call(`/session/${state.id}/status${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  test("without a query it is today's body plus both revisions", async () => {
    const state = seedSession();
    try {
      const body = await status(state);
      const { stateRevision, composerRevision, ...rest } = body;
      expect(stateRevision).toMatch(/^[A-Za-z0-9_.-]+:\d+$/);
      expect(typeof composerRevision).toBe("string");
      expect(rest).toEqual(
        JSON.parse(JSON.stringify(publicStatus(state, piReadiness(state)))) as Record<
          string,
          unknown
        >,
      );
      // The backend's interactive snapshot requires the composer.
      expect(rest.composer).toMatchObject({ models: [expect.any(Object)] });
    } finally {
      sessions.delete(state.id);
    }
  });

  test("a still-current knownStateRevision answers unchanged until something moves", async () => {
    const state = seedSession();
    try {
      const first = await status(state);
      const known = first.stateRevision as string;
      expect(await status(state, `?knownStateRevision=${encodeURIComponent(known)}`)).toEqual({
        unchanged: true,
        stateRevision: known,
      });

      applySessionEvent(state, { type: "queue_update", steering: [], followUp: ["later"] });
      // Not running, so the event is not a turn frame, but the queue still moved.
      const after = await status(state, `?knownStateRevision=${encodeURIComponent(known)}`);
      expect(after.unchanged).toBeUndefined();
      expect(after.stateRevision).not.toBe(known);
      expect(after.composer).toBeDefined();

      // A side route that changed without any site announcing it still moves
      // the revision at the next read: `unchanged` is never wrong.
      const current = after.stateRevision as string;
      state.queue = { steering: ["silent"], followUp: [] };
      const silent = await status(state, `?knownStateRevision=${encodeURIComponent(current)}`);
      expect(silent.unchanged).toBeUndefined();
      expect(silent.stateRevision).not.toBe(current);

      // Garbage is not a revision.
      const garbage = await status(state, "?knownStateRevision=not-a-revision");
      expect(garbage.unchanged).toBeUndefined();
    } finally {
      sessions.delete(state.id);
    }
  });

  test("knownComposerRevision omits the composer while it is current", async () => {
    const state = seedSession();
    try {
      const first = await status(state);
      const composerRevision = first.composerRevision as string;
      const lean = await status(
        state,
        `?knownComposerRevision=${encodeURIComponent(composerRevision)}`,
      );
      expect(lean.composer).toBeUndefined();
      expect(lean.composerRevision).toBe(composerRevision);
      expect(lean.status).toBe("idle");

      // A state change that leaves the composer alone keeps it omitted.
      applySessionEvent(state, { type: "session_info_changed", name: "Renamed" });
      const titled = await status(
        state,
        `?knownComposerRevision=${encodeURIComponent(composerRevision)}`,
      );
      expect(titled.title).toBe("Renamed");
      expect(titled.composer).toBeUndefined();

      // A composer change sends it again, under a new revision.
      state.composer = { ...state.composer, selectedReasoningId: "high" };
      const moved = await status(
        state,
        `?knownComposerRevision=${encodeURIComponent(composerRevision)}`,
      );
      expect(moved.composerRevision).not.toBe(composerRevision);
      expect(moved.composer).toMatchObject({ selectedReasoningId: "high" });
    } finally {
      sessions.delete(state.id);
    }
  });
});

describe("observe stream", () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buffer: { text: string },
    needle: string,
  ): Promise<string> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 2_000;
    while (!buffer.text.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${needle}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${needle}`)), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (done) break;
      buffer.text += decoder.decode(value, { stream: true });
    }
    const at = buffer.text.indexOf(needle);
    const end = buffer.text.indexOf("\n\n", at);
    const frame = buffer.text.slice(0, end === -1 ? undefined : end + 2);
    buffer.text = end === -1 ? "" : buffer.text.slice(end + 2);
    return frame;
  }

  function frameData(frame: string): string {
    return (
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length) ?? ""
    );
  }

  test("requires the token and observe=1", async () => {
    expect((await call("/event/subscribe?observe=1", { authorize: false })).status).toBe(401);
    expect((await call("/event/subscribe")).status).toBe(400);
  });

  test("a change publishes a content-free frame with moved revisions; a close names the session", async () => {
    const state = seedSession();
    state.status = "running";
    const controller = new AbortController();
    try {
      const response = await call("/event/subscribe?observe=1", { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const buffer = { text: "" };
      const connected = await readUntil(reader, buffer, "event: connected");
      expect(connected).toContain('"observe":true');
      expect(connected).toContain('"revisions":1');

      const stateBefore = stateRevisions.peek(state.id);
      applySessionEvent(state, textDelta("Hello"));
      const frame = parseBridgeObservationFrame(
        frameData(await readUntil(reader, buffer, "event: session.changed")),
      );
      expect(frame.sessionId).toBe(state.id);
      expect(frame.stateRevision).toBe(stateRevisions.peek(state.id));
      expect(frame.stateRevision).not.toBe(stateBefore);
      expect(frame.transcriptRevision).toMatch(/^[\x21\x23-\x5b\x5d-\x7e]{1,96}$/);

      // One frame per synchronous burst, carrying where it ended.
      applySessionEvent(state, textDelta(" again"));
      applySessionEvent(state, textDelta(" and again"));
      const burst = parseBridgeObservationFrame(
        frameData(await readUntil(reader, buffer, "event: session.changed")),
      );
      expect(burst.stateRevision).toBe(stateRevisions.peek(state.id));
      expect(burst.transcriptRevision).not.toBe(frame.transcriptRevision);
      expect(buffer.text).not.toContain("session.changed");

      state.status = "idle";
      expect((await post(`/session/${state.id}/close`)).status).toBe(200);
      let closed = parseBridgeObservationFrame(
        frameData(await readUntil(reader, buffer, "event: session.changed")),
      );
      // The close route's own frames come first; the removal's has no revision.
      while (closed.stateRevision !== undefined) {
        closed = parseBridgeObservationFrame(
          frameData(await readUntil(reader, buffer, "event: session.changed")),
        );
      }
      expect(closed).toEqual({ sessionId: state.id });
    } finally {
      controller.abort();
      sessions.delete(state.id);
    }
  });
});
