import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  abortSession,
  checkHealth,
  createClient,
  createSession,
  deleteSession,
  fetchPendingApprovals,
  getBridgeHealth,
  getModels,
  getSessionMessages,
  getSessionStatus,
  getSlashCommands,
  isCodexSessionPhase,
  listSessions,
  lookupSessionStatus,
  respondToApproval,
  resumeSession,
  sendPrompt,
  subscribeToEvents,
  updateSessionConfig,
  type CodexClient,
} from "./codex-client";

const originalFetch = globalThis.fetch;
const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };

function mockFetch(response: () => Response | Promise<Response>) {
  globalThis.fetch = mock(response) as unknown as typeof fetch;
}

function mockFetchError(error: Error) {
  globalThis.fetch = mock(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  mock.restore();
}

afterEach(() => {
  delete window.orkestratorGateway;
});

describe("codex-client createClient", () => {
  test("returns a client with the provided base URL", () => {
    expect(createClient("http://127.0.0.1:9999")).toEqual({
      baseUrl: "http://127.0.0.1:9999",
    });
  });

  test("rewrites loopback base URLs through the gateway when enabled", () => {
    window.orkestratorGateway = { enabled: true };

    expect(createClient("http://127.0.0.1:9999")).toEqual({
      baseUrl: `${window.location.origin}/__orkestrator/proxy/loopback/9999`,
    });
  });
});

describe("codex-client checkHealth", () => {
  afterEach(restoreFetch);

  test("returns true on ok health response", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    expect(await checkHealth(client)).toBe(true);
  });

  test("returns false on non-ok health response or network error", async () => {
    mockFetch(async () => new Response(null, { status: 503 }));
    expect(await checkHealth(client)).toBe(false);

    mockFetchError(new Error("offline"));
    expect(await checkHealth(client)).toBe(false);
  });
});

describe("codex-client getBridgeHealth", () => {
  afterEach(restoreFetch);

  test("returns engine details from a healthy bridge", async () => {
    mockFetch(async () =>
      Response.json({
        status: "ok",
        engine: "app-server",
        appServer: { state: "running", generation: 3 },
        activeTurns: 1,
      }),
    );

    await expect(getBridgeHealth(client)).resolves.toMatchObject({
      status: "ok",
      engine: "app-server",
      appServer: { state: "running", generation: 3 },
      activeTurns: 1,
    });
  });

  test("returns null for an unhealthy or unreachable bridge", async () => {
    mockFetch(async () => new Response(null, { status: 503 }));
    await expect(getBridgeHealth(client)).resolves.toBeNull();

    mockFetchError(new Error("offline"));
    await expect(getBridgeHealth(client)).resolves.toBeNull();
  });
});

describe("codex-client getModels", () => {
  afterEach(restoreFetch);

  test("returns bridge models and cache source when present", async () => {
    const models = [{ id: "custom-model", name: "Custom" }];
    mockFetch(async () =>
      new Response(JSON.stringify({ models, source: "cache" }), { status: 200 }),
    );

    await expect(getModels(client)).resolves.toEqual({ models, source: "cache" });
  });

  test("falls back to bundled models on invalid, non-ok, or failed responses", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [], source: "cache" }), { status: 200 }),
    );
    await expect(getModels(client)).resolves.toEqual({
      models: CODEX_MODELS,
      source: "cache",
    });

    mockFetch(async () => new Response(null, { status: 500 }));
    await expect(getModels(client)).resolves.toEqual({
      models: CODEX_MODELS,
      source: "fallback",
    });

    mockFetchError(new Error("offline"));
    await expect(getModels(client)).resolves.toEqual({
      models: CODEX_MODELS,
      source: "fallback",
    });
  });
});

describe("codex-client getSlashCommands", () => {
  afterEach(restoreFetch);

  test("returns commands from the bridge", async () => {
    const commands = [{ name: "/review", source: "prompt" as const }];
    mockFetch(async () =>
      new Response(JSON.stringify({ commands }), { status: 200 }),
    );

    await expect(getSlashCommands(client)).resolves.toEqual(commands);
  });

  test("returns empty list for invalid, non-ok, or failed responses", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ commands: null }), { status: 200 }),
    );
    await expect(getSlashCommands(client)).resolves.toEqual([]);

    mockFetch(async () => new Response(null, { status: 500 }));
    await expect(getSlashCommands(client)).resolves.toEqual([]);

    mockFetchError(new Error("offline"));
    await expect(getSlashCommands(client)).resolves.toEqual([]);
  });
});

describe("codex-client createSession", () => {
  afterEach(restoreFetch);

  test("returns session on 201 response", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ sessionId: "session-abc", title: "My Session" }), { status: 201 }),
    );

    const session = await createSession(client, { model: "gpt-5.3-codex" });

    expect(session.sessionId).toBe("session-abc");
    expect(session.title).toBe("My Session");
  });

  test("serializes max and ultra reasoning efforts", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ sessionId: "session-abc" }), { status: 201 }),
    );

    await createSession(client, {
      model: "gpt-5.6-sol",
      modelReasoningEffort: "ultra",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/create",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          modelReasoningEffort: "ultra",
        }),
      }),
    );
  });

  test("throws on non-ok HTTP response with status and body", async () => {
    mockFetch(async () =>
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(createSession(client)).rejects.toThrow("Codex bridge returned 500");
  });

  test("throws on network error", async () => {
    mockFetchError(new TypeError("Failed to fetch"));

    await expect(createSession(client)).rejects.toThrow("Failed to fetch");
  });
});

describe("codex-client listSessions", () => {
  afterEach(restoreFetch);

  test("returns persisted sessions from the bridge", async () => {
    const sessions = [{ id: "thread-1", title: "Saved", updatedAt: "2026-03-10T10:00:00.000Z" }];
    mockFetch(async () =>
      new Response(JSON.stringify({ sessions }), { status: 200 }),
    );

    await expect(listSessions(client)).resolves.toEqual(sessions);
  });

  test("returns empty list for invalid, non-ok, or failed responses", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ sessions: null }), { status: 200 }),
    );
    await expect(listSessions(client)).resolves.toEqual([]);

    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(listSessions(client)).resolves.toEqual([]);

    mockFetchError(new Error("offline"));
    await expect(listSessions(client)).resolves.toEqual([]);
  });
});

describe("codex-client getSessionMessages", () => {
  afterEach(restoreFetch);

  test("returns messages without appending todo snapshots", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolArgs: {
                todos: [{ content: "Track work", status: "in_progress" }],
              },
              toolState: "success",
            }],
            createdAt: "2026-03-10T10:00:00.000Z",
            planReview: true,
          },
        ],
      })),
    );

    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
    expect(messages[0]?.planReview).toBe(true);
  });

  test("returns messages without appending todo snapshots when resuming a session", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        sessionId: "session-1",
        title: "Resume",
        messages: [
          {
            id: "msg-2",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolOutput: JSON.stringify({
                todos: [{ content: "Resume task", status: "in_progress" }],
              }),
              toolState: "pending",
            }],
            createdAt: "2026-03-10T10:05:00.000Z",
            planReview: true,
          },
        ],
      })),
    );

    const resumed = await resumeSession(client, { threadId: "thread-1" });

    expect(resumed?.messages).toHaveLength(1);
    expect(resumed?.messages[0]?.id).toBe("msg-2");
    expect(resumed?.messages[0]?.planReview).toBe(true);
  });

  test("serializes max reasoning when resuming a session", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ sessionId: "session-1", messages: [] }), { status: 201 }),
    );

    await resumeSession(client, {
      threadId: "thread-1",
      model: "gpt-5.6-luna",
      modelReasoningEffort: "max",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/resume",
      expect.objectContaining({
        body: JSON.stringify({
          threadId: "thread-1",
          model: "gpt-5.6-luna",
          modelReasoningEffort: "max",
        }),
      }),
    );
  });

  test("returns messages as-is when no TodoWrite parts exist", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "Done",
            parts: [{
              type: "tool-invocation",
              toolName: "Bash",
              toolArgs: { command: "ls" },
              toolState: "success",
            }],
            createdAt: "2026-03-10T10:00:00.000Z",
          },
        ],
      })),
    );

    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
  });

  test("throws when a strict refresh cannot fetch messages", async () => {
    mockFetch(async () => new Response(null, { status: 503 }));

    expect(await getSessionMessages(client, "session-1")).toEqual([]);
    expect(
      getSessionMessages(client, "session-1", { throwOnError: true }),
    ).rejects.toThrow("HTTP 503");
  });
});

describe("codex-client updateSessionConfig", () => {
  afterEach(restoreFetch);

  test("posts session settings and returns true on ok response", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    await expect(updateSessionConfig(client, "session-1", {
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      mode: "plan",
      fastMode: true,
    })).resolves.toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          modelReasoningEffort: "high",
          mode: "plan",
          fastMode: true,
        }),
      }),
    );
  });

  test("returns false on non-ok or failed responses", async () => {
    mockFetch(async () => new Response(null, { status: 409 }));
    await expect(updateSessionConfig(client, "session-1", { mode: "build" })).resolves.toBe(false);

    mockFetchError(new Error("offline"));
    await expect(updateSessionConfig(client, "session-1", { mode: "build" })).resolves.toBe(false);
  });
});

describe("codex-client getSessionStatus", () => {
  afterEach(restoreFetch);

  test("returns normalized status data from the bridge", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        status: "error",
        title: "Session title",
        error: "Codex failed",
      }), { status: 200 }),
    );

    await expect(getSessionStatus(client, "session-1")).resolves.toEqual({
      status: "error",
      title: "Session title",
      error: "Codex failed",
    });
  });

  test("surfaces the app-server phase and turn identifiers when present", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          status: "running",
          phase: "cancelling",
          threadId: "thread-1",
          turnId: "turn-2",
          requestId: "req-3",
          engineGeneration: 4,
        }),
        { status: 200 },
      ),
    );

    // `cancelling` must still report `running`: the turn may be executing, so a
    // caller that advanced on idle here could overlap it.
    await expect(getSessionStatus(client, "session-1")).resolves.toMatchObject({
      status: "running",
      phase: "cancelling",
      threadId: "thread-1",
      turnId: "turn-2",
      requestId: "req-3",
      engineGeneration: 4,
    });
  });

  test("accepts only known app-server lifecycle phases", async () => {
    expect(isCodexSessionPhase("recovering")).toBe(true);
    expect(isCodexSessionPhase("idle")).toBe(true);
    expect(isCodexSessionPhase("surprising-future-phase")).toBe(false);
    expect(isCodexSessionPhase(null)).toBe(false);

    mockFetch(async () =>
      Response.json({ status: "running", phase: "surprising-future-phase" }),
    );
    await expect(getSessionStatus(client, "session-1")).resolves.toEqual({
      status: "running",
      title: undefined,
      error: undefined,
    });
  });

  test("returns null for invalid, non-ok, or failed responses", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ status: "paused" }), { status: 200 }),
    );
    await expect(getSessionStatus(client, "session-1")).resolves.toBeNull();

    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(getSessionStatus(client, "session-1")).resolves.toBeNull();

    mockFetchError(new Error("offline"));
    await expect(getSessionStatus(client, "session-1")).resolves.toBeNull();
  });

  test("distinguishes a missing session from transport and malformed-response failures in strict mode", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(getSessionStatus(client, "missing", { throwOnError: true })).resolves.toBeNull();

    mockFetch(async () => new Response(null, { status: 503 }));
    await expect(getSessionStatus(client, "session-1", { throwOnError: true }))
      .rejects.toThrow("HTTP 503");

    mockFetch(async () => new Response(JSON.stringify({ status: "paused" }), { status: 200 }));
    await expect(getSessionStatus(client, "session-1", { throwOnError: true }))
      .rejects.toThrow("malformed");

    mockFetchError(new Error("offline"));
    await expect(getSessionStatus(client, "session-1", { throwOnError: true }))
      .rejects.toThrow("offline");
  });

  test("structured lookup distinguishes an authoritative 404 from unavailable status", async () => {
    mockFetch(async () => Response.json({ status: "idle", phase: "idle" }));
    await expect(lookupSessionStatus(client, "session-1")).resolves.toEqual({
      kind: "found",
      session: {
        status: "idle",
        phase: "idle",
        title: undefined,
        error: undefined,
      },
    });

    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(lookupSessionStatus(client, "missing-session")).resolves.toEqual({
      kind: "missing",
    });

    mockFetch(async () => new Response(null, { status: 503 }));
    const unavailableHttp = await lookupSessionStatus(client, "session-1");
    expect(unavailableHttp.kind).toBe("unavailable");
    if (unavailableHttp.kind === "unavailable") {
      expect(unavailableHttp.error.message).toContain("HTTP 503");
    }

    mockFetchError(new Error("timed out"));
    const unavailableTransport = await lookupSessionStatus(client, "session-1");
    expect(unavailableTransport.kind).toBe("unavailable");
    if (unavailableTransport.kind === "unavailable") {
      expect(unavailableTransport.error.message).toBe("timed out");
    }
  });
});

describe("codex-client sendPrompt", () => {
  afterEach(restoreFetch);

  test("posts prompt attachments and an idempotency key and returns true on ok response", async () => {
    mockFetch(async () => new Response(null, { status: 202 }));

    await expect(sendPrompt(client, "session-1", "Review this", {
      attachments: [{
        type: "image",
        path: "/workspace/screenshot.png",
        dataUrl: "data:image/png;base64,abc",
        filename: "screenshot.png",
      }],
      requestId: "request-1",
    })).resolves.toMatchObject({ status: "processing", requestId: "request-1" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/prompt",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "Review this",
          attachments: [{
            type: "image",
            path: "/workspace/screenshot.png",
            dataUrl: "data:image/png;base64,abc",
            filename: "screenshot.png",
          }],
          requestId: "request-1",
        }),
      }),
    );
  });

  test("returns null on non-ok or failed responses", async () => {
    // Callers treat the result as a boolean, so null must stay falsy.
    mockFetch(async () => new Response(null, { status: 409 }));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toBeNull();

    mockFetchError(new Error("offline"));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toBeNull();
  });

  test("surfaces the accepted turn identifiers for reconnect reconciliation", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          status: "processing",
          requestId: "request-1",
          threadId: "thread-9",
          turnId: "turn-3",
        }),
        { status: 202 },
      ),
    );

    await expect(
      sendPrompt(client, "session-1", "Go", { requestId: "request-1" }),
    ).resolves.toEqual({
      status: "processing",
      requestId: "request-1",
      threadId: "thread-9",
      turnId: "turn-3",
      duplicate: false,
    });
  });

  test("reports an already-processed duplicate so the caller does not retry", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ status: "already-processed", duplicate: true }), {
        status: 202,
      }),
    );

    await expect(
      sendPrompt(client, "session-1", "Go", { requestId: "request-1" }),
    ).resolves.toMatchObject({ status: "already-processed", duplicate: true });
  });
});

describe("codex-client abortSession", () => {
  afterEach(restoreFetch);

  test("posts abort request and reports an accepted outcome", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    await expect(abortSession(client, "session-1")).resolves.toEqual({
      status: "accepted",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/abort",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("distinguishes a definite HTTP rejection from an ambiguous transport failure", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(abortSession(client, "session-1")).resolves.toEqual({
      status: "rejected",
      httpStatus: 404,
    });

    mockFetchError(new Error("offline"));
    await expect(abortSession(client, "session-1")).resolves.toEqual({
      status: "unknown",
    });
  });
});

describe("codex-client deleteSession", () => {
  afterEach(restoreFetch);

  test("returns true on success", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    const deleted = await deleteSession(client, "session-1");

    expect(deleted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("returns false on non-ok response", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));

    expect(await deleteSession(client, "missing-session")).toBe(false);
  });

  test("returns false on network error", async () => {
    mockFetchError(new Error("network unavailable"));

    expect(await deleteSession(client, "session-1")).toBe(false);
  });
});

describe("CODEX_MODELS catalog", () => {
  test("is non-empty and every entry has an id/name", () => {
    expect(CODEX_MODELS.length).toBeGreaterThan(0);
    for (const model of CODEX_MODELS) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe("string");
      expect(model.name.length).toBeGreaterThan(0);
    }
  });

  test("model ids are unique", () => {
    const ids = CODEX_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bundled fallback models expose only their supported reasoning efforts", () => {
    for (const model of CODEX_MODELS) {
      expect(model.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
      expect(model.defaultReasoningEffort).toBe("medium");
      expect(model.reasoningEfforts).not.toContain("max");
      expect(model.reasoningEfforts).not.toContain("ultra");
    }
  });

  test("advertises the current gpt-5.4 family and no retired ids", () => {
    const ids = CODEX_MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-5.4");
    // Retired ids must not linger in the offered list. A persisted preference
    // pointing at one is reconciled by resolveCodexPreferenceSelection.
    for (const retired of [
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ]) {
      expect(ids).not.toContain(retired);
    }
  });

  test("DEFAULT_CODEX_MODEL is the first catalog entry and a real model id", () => {
    expect(DEFAULT_CODEX_MODEL).toBe(CODEX_MODELS[0]!.id);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.4");
    expect(CODEX_MODELS.map((m) => m.id)).toContain(DEFAULT_CODEX_MODEL);
  });
});

describe("codex-client subscribeToEvents", () => {
  const originalEventSource = globalThis.EventSource;

  class MockEventSource {
    static instances: MockEventSource[] = [];
    readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    readonly close = mock(() => {});
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      MockEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, data: Record<string, unknown>, lastEventId?: string) {
      const event = {
        type,
        data: JSON.stringify(data),
        ...(lastEventId === undefined ? {} : { lastEventId }),
      } as MessageEvent;
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
  });

  test("yields parsed events and closes when iteration is aborted", async () => {
    const controller = new AbortController();
    const iterator = subscribeToEvents(client, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const source = MockEventSource.instances[0]!;

    expect(source.url).toBe("http://127.0.0.1:4000/event/subscribe");
    source.emit("session.updated", { sessionId: "session-1", status: "running" });
    await expect(pending).resolves.toEqual({
      done: false,
      value: {
        type: "session.updated",
        sessionId: "session-1",
        data: { sessionId: "session-1", status: "running" },
      },
    });

    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  test("rejects a pending read when the event stream errors", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const source = MockEventSource.instances[0]!;

    source.onerror?.();

    await expect(pending).rejects.toThrow("SSE connection error");
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  test("does not open a connection for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const iterator = subscribeToEvents(client, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  test("ignores malformed JSON and continues with the next valid event", async () => {
    const originalError = console.error;
    console.error = mock(() => {}) as unknown as typeof console.error;
    try {
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const pending = iterator.next();
      const source = MockEventSource.instances[0]!;
      const malformed = {
        type: "session.updated",
        data: "{not-json",
        lastEventId: "",
      } as MessageEvent;
      for (const listener of source.listeners.get("session.updated") ?? []) {
        listener(malformed);
      }
      source.emit("session.idle", { sessionId: "session-1" });

      await expect(pending).resolves.toMatchObject({
        done: false,
        value: { type: "session.idle", sessionId: "session-1" },
      });
      await iterator.return?.();
    } finally {
      console.error = originalError;
    }
  });

  test("iterator return closes the source and resolves a pending read", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const source = MockEventSource.instances[0]!;

    await iterator.return?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});

describe("codex-client event cursor", () => {
  const originalEventSource = globalThis.EventSource;
  const instances: Array<{ url: string; listeners: Map<string, Array<(event: MessageEvent) => void>> }> = [];

  class CursorMockEventSource {
    readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    readonly close = mock(() => {});
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, data: Record<string, unknown>, lastEventId?: string) {
      const event = {
        type,
        data: JSON.stringify(data),
        ...(lastEventId === undefined ? {} : { lastEventId }),
      } as MessageEvent;
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  beforeEach(() => {
    instances.length = 0;
    (globalThis as unknown as { EventSource: unknown }).EventSource = CursorMockEventSource;
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
  });

  test("omits ?since when no cursor is given", () => {
    subscribeToEvents(client)[Symbol.asyncIterator]().next();
    expect(instances[0]!.url).toBe("http://127.0.0.1:4000/event/subscribe");
  });

  test("sends ?since when a cursor is given, including zero", () => {
    subscribeToEvents(client, undefined, 42)[Symbol.asyncIterator]().next();
    expect(instances[0]!.url).toContain("since=42");

    subscribeToEvents(client, undefined, 0)[Symbol.asyncIterator]().next();
    // Cursor 0 is meaningful ("I have nothing yet"), so it must be sent.
    expect(instances[1]!.url).toContain("since=0");
  });

  test("ignores a nonsensical cursor rather than sending it", () => {
    subscribeToEvents(client, undefined, -1)[Symbol.asyncIterator]().next();
    expect(instances[0]!.url).not.toContain("since");

    subscribeToEvents(client, undefined, 1.5)[Symbol.asyncIterator]().next();
    expect(instances[1]!.url).not.toContain("since");
  });

  test("exposes the SSE id as a numeric revision", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const pending = iterator.next();
    (instances[0] as unknown as CursorMockEventSource).emit(
      "session.idle",
      { sessionId: "s1" },
      "17",
    );

    const result = await pending;
    expect(result.value.revision).toBe(17);
  });

  test("omits the revision when the id is absent or unparseable", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const first = iterator.next();
    (instances[0] as unknown as CursorMockEventSource).emit("session.idle", { sessionId: "s1" });
    expect((await first).value.revision).toBeUndefined();

    const second = iterator.next();
    (instances[0] as unknown as CursorMockEventSource).emit(
      "session.idle",
      { sessionId: "s1" },
      "not-a-number",
    );
    expect((await second).value.revision).toBeUndefined();
  });

  test("subscribes to the approval and reconcile event types", () => {
    subscribeToEvents(client)[Symbol.asyncIterator]().next();
    const types = [...instances[0]!.listeners.keys()];
    expect(types).toContain("session.approval-requested");
    expect(types).toContain("session.approval-resolved");
    expect(types).toContain("session.reconcile-required");
  });
});

describe("codex-client approvals", () => {
  afterEach(restoreFetch);

  test("fetchPendingApprovals returns the list", async () => {
    const approval = {
      approvalId: "apr-1-1",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestedAt: 1,
      expiresAt: 2,
      command: "ls",
      supportsApproveForSession: true,
    };
    mockFetch(() =>
      Response.json({
        approvals: [approval],
      }),
    );

    const approvals = await fetchPendingApprovals(client, "session-1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.approvalId).toBe("apr-1-1");
  });

  test("filters malformed approval entries and sanitizes malformed optional fields", async () => {
    mockFetch(() =>
      Response.json({
        approvals: [
          { approvalId: "missing-required-fields" },
          {
            approvalId: "apr-valid",
            kind: "permissions",
            method: "item/permissions/requestApproval",
            threadId: null,
            turnId: null,
            itemId: null,
            requestedAt: 1,
            expiresAt: 2,
            permissions: { network: "yes", fileSystem: true },
            changes: [{ path: "/valid", kind: "update" }, { nope: true }],
            supportsApproveForSession: false,
          },
        ],
      }),
    );

    const approvals = await fetchPendingApprovals(client, "session-1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalId: "apr-valid",
      changes: [{ path: "/valid", kind: "update" }],
    });
    expect(approvals[0]?.permissions).toBeUndefined();
  });

  test("fetchPendingApprovals rejects bad responses so callers preserve existing state", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("HTTP 500");

    mockFetch(() => Response.json({ approvals: "not-an-array" }));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("malformed");

    mockFetchError(new Error("network down"));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("network down");
  });

  test("respondToApproval posts the decision", async () => {
    const fetchMock = mock(() => Response.json({ status: "applied" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await respondToApproval(client, "session-1", "apr-1-1", "approve")).toBe("applied");

    // `mock(() => …)` infers a zero-arg signature, so the recorded call args
    // need widening before they can be read.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4000/session/session-1/approvals/apr-1-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ decision: "approve" });
  });

  test("distinguishes stale, forbidden and error outcomes", async () => {
    // The UI reacts differently to each: drop the card for the first two, offer a
    // retry for the third.
    mockFetch(() => new Response("{}", { status: 409 }));
    expect(await respondToApproval(client, "s", "a", "deny")).toBe("stale");

    mockFetch(() => new Response("{}", { status: 403 }));
    expect(await respondToApproval(client, "s", "a", "deny")).toBe("forbidden");

    mockFetch(() => new Response("{}", { status: 500 }));
    expect(await respondToApproval(client, "s", "a", "deny")).toBe("error");

    mockFetchError(new Error("offline"));
    expect(await respondToApproval(client, "s", "a", "deny")).toBe("error");
  });

  test("encodes the approval id into the path", async () => {
    const fetchMock = mock(() => Response.json({ status: "applied" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await respondToApproval(client, "session-1", "apr/1?x", "deny");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("apr%2F1%3Fx");
  });
});
