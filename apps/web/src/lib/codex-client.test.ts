import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  abortSession,
  checkHealth,
  classifyCodexPromptOutcome,
  compactCodexSession,
  createClient,
  createSession,
  deleteSession,
  fetchPendingApprovals,
  fetchPendingInteractions,
  forkCodexSession,
  getBridgeHealth,
  getCodexRuntimeHealth,
  getModels,
  getSessionMessages,
  getSessionStatus,
  getStructuredOutput,
  getSlashCommands,
  isCodexSessionPhase,
  listSessions,
  lookupSessionStatus,
  parseApproval,
  parseContextUsage,
  parseInteraction,
  respondToApproval,
  respondToInteraction,
  resumeSession,
  sendPrompt,
  startCodexNativeReview,
  steerCodexSession,
  subscribeToEvents,
  updateSessionConfig,
  type CodexApprovalResponseResult,
  type CodexClient,
} from "./codex-client";
import type { ContextUsageSnapshot } from "./context-usage";
import { StructuredOutputReadUnavailableError } from "@orkestrator/protocol/structured-output";

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

  test("retains the per-bridge authentication token", () => {
    expect(createClient("http://127.0.0.1:9999", "bridge-secret")).toEqual({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "bridge-secret",
    });
  });
});

describe("codex-client checkHealth", () => {
  afterEach(restoreFetch);

  test("returns true on ok health response", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    expect(await checkHealth(client)).toBe(true);
  });

  test("uses the authenticated probe and bearer header", async () => {
    const fetchMock = mock(() => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await checkHealth(createClient("http://127.0.0.1:4000", "bridge-secret")))
      .toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4000/global/auth-check");
    expect(new Headers(init.headers).get("X-Orkestrator-Codex-Token")).toBe("bridge-secret");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
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

describe("codex-client request timeout", () => {
  afterEach(restoreFetch);

  test("abandons a hung bridge instead of hanging the caller", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let deadlineMs: number | undefined;
    // Fire the deadline immediately so the real ten seconds are not spent here,
    // while still proving the request is aborted rather than left pending.
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
      deadlineMs = delay;
      (handler as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        return Promise.reject(
          Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
        );
      }
      // A bridge that accepted the connection and then stopped answering.
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    try {
      // Consumers that swallow failures report unreachable…
      expect(await checkHealth(client)).toBe(false);
      expect(deadlineMs).toBe(10_000);
      await expect(getSessionMessages(client, "session-1")).resolves.toEqual([]);
      // …and the ones that must not guess surface the abort.
      await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow(/aborted/i);
      expect((await lookupSessionStatus(client, "session-1")).kind).toBe("unavailable");
      expect(await abortSession(client, "session-1")).toEqual({ status: "unknown" });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
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

  test("returns null when resuming a session is rejected by the bridge", async () => {
    mockFetch(async () => new Response("thread not found", { status: 404 }));

    await expect(resumeSession(client, { threadId: "missing-thread" })).resolves.toBeNull();
  });

  test("returns null when resuming a session fails in transport", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockFetchError(new Error("connection reset"));

    try {
      await expect(resumeSession(client, { threadId: "thread-1" })).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        "[codex-client] Failed to resume session:",
        expect.objectContaining({ message: "connection reset" }),
      );
    } finally {
      console.error = originalError;
    }
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

  test("posts session settings and reports whether the update was durable", async () => {
    mockFetch(async () => Response.json({ status: "updated", durable: true }));

    await expect(updateSessionConfig(client, "session-1", {
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      mode: "plan",
      fastMode: true,
    })).resolves.toEqual({ outcome: "applied", durable: true });

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

    mockFetch(async () => Response.json({ status: "updated", durable: false }));
    await expect(
      updateSessionConfig(client, "session-1", { mode: "build" }),
    ).resolves.toEqual({ outcome: "applied", durable: false });
  });

  test("distinguishes a definite HTTP rejection from an ambiguous transport failure", async () => {
    mockFetch(async () => new Response(null, { status: 409 }));
    await expect(
      updateSessionConfig(client, "session-1", { mode: "build" }),
    ).resolves.toEqual({ outcome: "rejected", httpStatus: 409 });

    mockFetchError(new Error("offline"));
    await expect(
      updateSessionConfig(client, "session-1", { mode: "build" }),
    ).resolves.toEqual({ outcome: "unknown" });
  });

  test("reconciles an ambiguous update against the authoritative config", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("response lost");
      return Response.json({
        model: "gpt-5.3-codex",
        modelReasoningEffort: "high",
        mode: "plan",
        fastMode: true,
        durable: false,
      });
    });

    await expect(updateSessionConfig(client, "session-1", {
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      mode: "plan",
      fastMode: true,
    })).resolves.toEqual({ outcome: "applied", durable: false });
    expect(calls).toBe(2);
  });

  test("stays unknown when the authoritative config does not match the request", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("response lost");
      // The bridge is still on the old model, so this update did *not* land.
      return Response.json({
        model: "gpt-5.2-codex",
        mode: "plan",
        fastMode: true,
        durable: true,
      });
    });

    await expect(
      updateSessionConfig(client, "session-1", { model: "gpt-5.3-codex", mode: "plan" }),
    ).resolves.toEqual({ outcome: "unknown" });
    expect(calls).toBe(2);
  });

  test("stays unknown when the reconciliation read is itself rejected", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("response lost");
      return new Response(null, { status: 404 });
    });

    await expect(
      updateSessionConfig(client, "session-1", { mode: "build" }),
    ).resolves.toEqual({ outcome: "unknown" });
  });
});

describe("codex-client classifyCodexPromptOutcome", () => {
  test("maps every send result shape to a definite classification", () => {
    expect(classifyCodexPromptOutcome({ outcome: "accepted", status: "processing" }))
      .toBe("accepted");
    expect(classifyCodexPromptOutcome({ outcome: "rejected", httpStatus: 409 }))
      .toBe("rejected");
    expect(classifyCodexPromptOutcome({ outcome: "unknown", requestId: "r" }))
      .toBe("unknown");

    // Legacy shapes that component stubs still return.
    expect(classifyCodexPromptOutcome(true)).toBe("accepted");
    expect(classifyCodexPromptOutcome({ status: "processing" })).toBe("accepted");
    expect(classifyCodexPromptOutcome({ status: "already-processed" })).toBe("accepted");

    // Anything that does not positively indicate acceptance is a rejection —
    // never an accidental "unknown", which callers treat as possibly-running.
    expect(classifyCodexPromptOutcome(false)).toBe("rejected");
    expect(classifyCodexPromptOutcome(null)).toBe("rejected");
    expect(classifyCodexPromptOutcome(undefined)).toBe("rejected");
    expect(classifyCodexPromptOutcome({})).toBe("rejected");
    expect(classifyCodexPromptOutcome({ outcome: "weird" })).toBe("rejected");
    expect(classifyCodexPromptOutcome("accepted")).toBe("rejected");
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
          messageRevision: 12,
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
      messageRevision: 12,
    });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "12"],
    ["null", null],
  ])("omits a %s message revision", async (_description, messageRevision) => {
    mockFetch(async () =>
      Response.json({
        status: "idle",
        messageRevision,
      }),
    );

    const status = await getSessionStatus(client, "session-1");
    expect(status).toEqual({
      status: "idle",
      title: undefined,
      error: undefined,
    });
    expect(status).not.toHaveProperty("messageRevision");
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

  test("posts prompt attachments and an idempotency key and reports acceptance", async () => {
    mockFetch(async () => new Response(null, { status: 202 }));

    await expect(sendPrompt(client, "session-1", "Review this", {
      attachments: [{
        type: "image",
        path: "/workspace/screenshot.png",
        dataUrl: "data:image/png;base64,abc",
        filename: "screenshot.png",
      }],
      requestId: "request-1",
    })).resolves.toMatchObject({
      outcome: "accepted",
      status: "processing",
      requestId: "request-1",
    });

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

  test("distinguishes a definite HTTP rejection from an ambiguous transport failure", async () => {
    mockFetch(async () => new Response(null, { status: 409 }));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toEqual({
      outcome: "rejected",
      httpStatus: 409,
    });

    mockFetchError(new Error("offline"));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toMatchObject({
      outcome: "unknown",
      requestId: expect.any(String),
    });
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
      outcome: "accepted",
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
    ).resolves.toMatchObject({
      outcome: "accepted",
      status: "already-processed",
      duplicate: true,
    });
  });

  test("forwards a structured-output schema with the stable request id", async () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    mockFetch(async () => Response.json({ status: "processing" }, { status: 202 }));

    await expect(
      sendPrompt(client, "session-1", "Review", {
        requestId: "structured-1",
        outputSchema: schema,
      }),
    ).resolves.toMatchObject({
      outcome: "accepted",
      requestId: "structured-1",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/prompt",
      expect.objectContaining({
        body: JSON.stringify({
          prompt: "Review",
          requestId: "structured-1",
          outputSchema: schema,
        }),
      }),
    );
  });
});

describe("codex-client getStructuredOutput", () => {
  afterEach(restoreFetch);

  test("returns success and encodes the request id", async () => {
    const success = {
      ok: true,
      provider: "codex",
      requestId: "request/1",
      value: { summary: "done" },
    } as const;
    mockFetch(async () => Response.json({ structuredOutput: success }));

    await expect(
      getStructuredOutput(client, "session-1", "request/1"),
    ).resolves.toEqual(success);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/structured-output?requestId=request%2F1",
      expect.anything(),
    );
  });

  test("returns null for missing and pending output", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(getStructuredOutput(client, "session-1", "request-1"))
      .resolves.toBeNull();

    mockFetch(async () => Response.json({ structuredOutput: null }));
    await expect(getStructuredOutput(client, "session-1", "request-1"))
      .resolves.toBeNull();
  });

  test("returns authoritative malformed-output failures for invalid responses", async () => {
    mockFetch(async () => Response.json({
      structuredOutput: { ok: true, provider: "codex" },
    }));
    await expect(getStructuredOutput(client, "session-1", "request-1"))
      .resolves.toMatchObject({
        ok: false,
        requestId: "request-1",
        error: { code: "malformed_output" },
      });

    mockFetch(async () => Response.json(null));
    await expect(getStructuredOutput(client, "session-1", "request-1"))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });

    mockFetch(async () =>
      new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    await expect(getStructuredOutput(client, "session-1", "request-1"))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });
  });

  test("throws a typed observation error for transport failures", async () => {
    mockFetchError(new Error("bridge offline"));

    const promise = getStructuredOutput(client, "session-1", "request-1");
    await expect(promise).rejects.toBeInstanceOf(StructuredOutputReadUnavailableError);
    await expect(promise).rejects.toMatchObject({
      provider: "codex",
      requestId: "request-1",
      retryable: true,
    });
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

  test("iterator throw closes the source and rejects for the consumer", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const source = MockEventSource.instances[0]!;

    await expect(iterator.throw?.(new Error("consumer gave up"))).rejects.toThrow(
      "consumer gave up",
    );
    expect(source.close).toHaveBeenCalledTimes(1);
    // The stream is finished, not wedged: a later read must resolve, not hang.
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("buffers a burst that arrives before the consumer reads", async () => {
    // The bridge can emit several frames between two `next()` calls; queueing them
    // is what stops a fast turn from losing everything but its last event.
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const source = MockEventSource.instances[0]!;

    source.emit("session.updated", { sessionId: "session-1", phase: "running" }, "1");
    source.emit("message.updated", { sessionId: "session-1" }, "2");
    source.emit("session.idle", { sessionId: "session-1" }, "3");

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "session.updated", revision: 1 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "message.updated", revision: 2 },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "session.idle", revision: 3 },
    });

    await iterator.return?.();
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

  test("requests payload filtering for one session without changing the cursor", () => {
    subscribeToEvents(client, undefined, 42, "session/a b")[Symbol.asyncIterator]().next();
    const url = new URL(instances[0]!.url);
    expect(url.searchParams.get("since")).toBe("42");
    expect(url.searchParams.get("sessionId")).toBe("session/a b");
  });

  test("puts the token only on the EventSource URL", () => {
    const authenticated = createClient("http://127.0.0.1:4000", "bridge-secret");
    subscribeToEvents(authenticated)[Symbol.asyncIterator]().next();
    const url = new URL(instances[0]!.url);
    expect(url.searchParams.get("token")).toBe("bridge-secret");
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

  test("subscribes to and yields cursor-only frames without a session payload", async () => {
    const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const source = instances[0] as unknown as CursorMockEventSource;

    expect(source.listeners.has("bridge.cursor")).toBe(true);
    source.emit("bridge.cursor", {}, "23");

    await expect(pending).resolves.toEqual({
      done: false,
      value: {
        type: "bridge.cursor",
        sessionId: undefined,
        data: {},
        revision: 23,
      },
    });
    await iterator.return?.();
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

  /**
   * A named SSE event is only delivered to an explicit listener, so a type the
   * bridge emits but this list omits is silently dropped — the card never
   * appears and the turn blocks until the bridge's auto-deny. Asserted as the
   * whole set so adding a `CodexEvent["type"]` without a listener fails here.
   */
  test("subscribes to every event type the bridge emits", () => {
    subscribeToEvents(client)[Symbol.asyncIterator]().next();
    expect([...instances[0]!.listeners.keys()].sort()).toEqual([
      "bridge.cursor",
      "connected",
      "keepalive",
      "message.updated",
      "session.approval-requested",
      "session.approval-resolved",
      "session.error",
      "session.idle",
      "session.interaction-requested",
      "session.interaction-resolved",
      "session.reconcile-required",
      "session.structured-output",
      "session.title-updated",
      "session.updated",
    ]);
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
      actionable: true,
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
            actionable: false,
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

  test("accepts a well-formed permissions descriptor", async () => {
    mockFetch(() =>
      Response.json({
        approvals: [{
          approvalId: "apr-permissions",
          kind: "permissions",
          method: "item/permissions/requestApproval",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          requestedAt: 1,
          expiresAt: 2,
          permissions: { network: true, fileSystem: false },
          actionable: true,
          supportsApproveForSession: false,
        }],
      }),
    );

    await expect(fetchPendingApprovals(client, "session-1")).resolves.toMatchObject([
      { permissions: { network: true, fileSystem: false } },
    ]);
  });

  test("fetchPendingApprovals rejects bad responses so callers preserve existing state", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("HTTP 500");

    mockFetch(() => Response.json({ approvals: "not-an-array" }));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("malformed");

    mockFetchError(new Error("network down"));
    await expect(fetchPendingApprovals(client, "session-1")).rejects.toThrow("network down");
  });

  /**
   * The turn is *blocked* on an approval, so a descriptor we refuse to render is
   * a turn that hangs until the bridge's five-minute auto-deny. These assert the
   * exact field contract with `describeApproval` in the bridge, and that every
   * rejection is reported rather than dropped on the floor.
   */
  describe("parseApproval", () => {
    const VALID = {
      approvalId: "apr-1",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestedAt: 1,
      expiresAt: 2,
      command: "rm -rf build",
      cwd: "/workspace",
      actionable: true,
      supportsApproveForSession: true,
    };

    let warn = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;

    beforeEach(() => {
      warn = mock((..._args: unknown[]) => {});
      console.warn = warn as unknown as typeof console.warn;
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    test("accepts the descriptor the bridge actually sends", () => {
      expect(parseApproval(VALID)).toMatchObject({
        approvalId: "apr-1",
        kind: "command",
        command: "rm -rf build",
        cwd: "/workspace",
        supportsApproveForSession: true,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    test.each([
      ["a non-object payload", null],
      ["a missing approvalId", { ...VALID, approvalId: 7 }],
      ["an unknown kind", { ...VALID, kind: "network" }],
      ["a non-string method", { ...VALID, method: 12 }],
      ["a non-string, non-null threadId", { ...VALID, threadId: 5 }],
      ["a non-string, non-null turnId", { ...VALID, turnId: {} }],
      ["a non-string, non-null itemId", { ...VALID, itemId: [] }],
      ["a non-finite requestedAt", { ...VALID, requestedAt: Number.NaN }],
      ["a missing expiresAt", { ...VALID, expiresAt: undefined }],
      ["a non-finite expiresAt", { ...VALID, expiresAt: Number.POSITIVE_INFINITY }],
      ["a missing actionable flag", { ...VALID, actionable: undefined }],
      ["a non-boolean actionable flag", { ...VALID, actionable: "yes" }],
      ["a non-boolean supportsApproveForSession", { ...VALID, supportsApproveForSession: "yes" }],
    ])("rejects and warns about %s", (_label, payload) => {
      expect(parseApproval(payload)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as unknown as [string, { approvalId?: string }];
      expect(message).toContain("unrecognised Codex approval");
      // Never the command, the cwd or any file content: the user has not agreed
      // to run this yet, and the log is shared.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("rm -rf build");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("/workspace");
    });

    test("names the approval it dropped when the id survived", () => {
      parseApproval({ ...VALID, kind: "network" });
      const [, context] = warn.mock.calls[0] as unknown as [string, { approvalId?: string }];
      expect(context).toEqual({ approvalId: "apr-1" });
    });

    test.each([
      ["command", 42],
      ["cwd", {}],
      ["reason", null],
      ["grantRoot", []],
      ["networkHost", 7],
    ])("drops a malformed optional %s rather than the whole request", (field, value) => {
      // These are cosmetic. Rejecting the request over one would block a turn the
      // user could otherwise answer.
      const parsed = parseApproval({ ...VALID, command: undefined, [field]: value });
      expect(parsed).not.toBeNull();
      expect(parsed?.[field as "command"]).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    test("tolerates a changes field that is not a well-formed list", () => {
      // The v2 file-change method sends no changes at all, so an absent or odd
      // list is normal rather than a parse failure.
      expect(parseApproval({ ...VALID, changes: "all of them" })?.changes).toBeUndefined();
      expect(
        parseApproval({
          ...VALID,
          changes: [null, "src/a.ts", { path: "/workspace/a.ts", kind: "delete" }, { path: 1, kind: "add" }],
        })?.changes,
      ).toEqual([{ path: "/workspace/a.ts", kind: "delete" }]);
      expect(warn).not.toHaveBeenCalled();
    });
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

  test("reports the entries it drops so a protocol change is not silent", async () => {
    const originalWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as unknown as typeof console.warn;
    try {
      mockFetch(() =>
        Response.json({
          approvals: [{ approvalId: "apr-broken", kind: "future-kind", command: "rm -rf /" }],
        }),
      );

      await expect(fetchPendingApprovals(client, "session-1")).resolves.toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("encodes the approval id into the path", async () => {
    const fetchMock = mock(() => Response.json({ status: "applied" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await respondToApproval(client, "session-1", "apr/1?x", "deny");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("apr%2F1%3Fx");
  });
});

describe("codex-client interactions", () => {
  afterEach(restoreFetch);

  const QUESTION = {
    id: "q-1",
    header: "Deploy target",
    question: "Which environment?",
    options: [
      { label: "staging", description: "safe" },
      { label: "production" },
    ],
  };

  const VALID_INTERACTION = {
    interactionId: "int-1",
    kind: "question",
    method: "item/userInput/request",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 1,
    expiresAt: 2,
    questions: [QUESTION],
  };

  describe("parseInteraction", () => {
    test("accepts the descriptor the bridge actually sends", () => {
      expect(parseInteraction(VALID_INTERACTION)).toEqual({
        interactionId: "int-1",
        kind: "question",
        method: "item/userInput/request",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        requestedAt: 1,
        expiresAt: 2,
        questions: [
          {
            id: "q-1",
            header: "Deploy target",
            question: "Which environment?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "staging", description: "safe" },
              { label: "production" },
            ],
          },
        ],
      });
    });

    test("nulls a turnId and itemId that are not strings", () => {
      const parsed = parseInteraction({
        ...VALID_INTERACTION,
        turnId: 5,
        itemId: null,
      });
      expect(parsed?.turnId).toBeNull();
      expect(parsed?.itemId).toBeNull();
    });

    test("carries the mcp-form and mcp-url payload fields", () => {
      expect(
        parseInteraction({
          ...VALID_INTERACTION,
          kind: "mcp-form",
          questions: undefined,
          serverName: "docs",
          message: "Fill this in",
          schema: { type: "object" },
          elicitationId: "elic-1",
        }),
      ).toMatchObject({
        kind: "mcp-form",
        serverName: "docs",
        message: "Fill this in",
        schema: { type: "object" },
        elicitationId: "elic-1",
      });

      expect(
        parseInteraction({
          ...VALID_INTERACTION,
          kind: "mcp-url",
          questions: undefined,
          url: "https://example.test/auth",
          autoResolutionMs: 30_000,
        }),
      ).toMatchObject({
        kind: "mcp-url",
        url: "https://example.test/auth",
        autoResolutionMs: 30_000,
      });
    });

    test.each([
      ["a null payload", null],
      ["a non-object payload", "int-1"],
      ["an array payload", [VALID_INTERACTION]],
      // An empty id produces `POST /session/:id/interactions/`, which matches no
      // bridge route: the card renders but can never be answered.
      ["an empty interactionId", { ...VALID_INTERACTION, interactionId: "" }],
      ["a non-string interactionId", { ...VALID_INTERACTION, interactionId: 7 }],
      ["a missing interactionId", { ...VALID_INTERACTION, interactionId: undefined }],
      ["an unknown kind", { ...VALID_INTERACTION, kind: "mcp-widget" }],
      ["a missing kind", { ...VALID_INTERACTION, kind: undefined }],
      ["a non-string method", { ...VALID_INTERACTION, method: 12 }],
      ["a null threadId", { ...VALID_INTERACTION, threadId: null }],
      ["a non-string threadId", { ...VALID_INTERACTION, threadId: 5 }],
      ["a missing requestedAt", { ...VALID_INTERACTION, requestedAt: undefined }],
      ["a NaN requestedAt", { ...VALID_INTERACTION, requestedAt: Number.NaN }],
      [
        "an infinite requestedAt",
        { ...VALID_INTERACTION, requestedAt: Number.POSITIVE_INFINITY },
      ],
      ["a missing expiresAt", { ...VALID_INTERACTION, expiresAt: undefined }],
      ["a NaN expiresAt", { ...VALID_INTERACTION, expiresAt: Number.NaN }],
      [
        "an infinite expiresAt",
        { ...VALID_INTERACTION, expiresAt: Number.NEGATIVE_INFINITY },
      ],
      // A question card with nothing to answer is a permanently blocked turn.
      ["a question kind with no questions", { ...VALID_INTERACTION, questions: undefined }],
      ["a question kind with an empty question list", { ...VALID_INTERACTION, questions: [] }],
      [
        "a question kind whose only question is malformed",
        { ...VALID_INTERACTION, questions: [{ id: "q-1" }] },
      ],
    ])("rejects %s", (_label, payload) => {
      expect(parseInteraction(payload)).toBeNull();
    });

    test("omits optional fields the bridge sent in the wrong shape", () => {
      const parsed = parseInteraction({
        ...VALID_INTERACTION,
        autoResolutionMs: "soon",
        serverName: 5,
        message: {},
        url: [],
        elicitationId: 9,
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.autoResolutionMs).toBeUndefined();
      expect(parsed?.serverName).toBeUndefined();
      expect(parsed?.message).toBeUndefined();
      expect(parsed?.url).toBeUndefined();
      expect(parsed?.elicitationId).toBeUndefined();
    });

    test("keeps a schema key even when its value is null", () => {
      // `"schema" in raw` is deliberate: the MCP form schema is opaque and a
      // null schema is a server answer, not an absent field.
      const parsed = parseInteraction({
        ...VALID_INTERACTION,
        kind: "mcp-form",
        questions: undefined,
        schema: null,
      });
      expect(parsed).not.toBeNull();
      expect("schema" in (parsed as object)).toBe(true);
      expect(parsed?.schema).toBeNull();
    });
  });

  describe("parseInteractionQuestion", () => {
    const withQuestions = (questions: unknown) =>
      parseInteraction({ ...VALID_INTERACTION, questions })?.questions;

    test("defaults the isOther and isSecret flags to false", () => {
      expect(
        withQuestions([{ id: "q-1", header: "H", question: "Q?" }]),
      ).toEqual([{ id: "q-1", header: "H", question: "Q?", isOther: false, isSecret: false }]);
    });

    test("passes the isOther and isSecret flags through only when strictly true", () => {
      expect(
        withQuestions([
          { id: "q-1", header: "H", question: "Q?", isOther: true, isSecret: "yes" },
        ]),
      ).toEqual([{ id: "q-1", header: "H", question: "Q?", isOther: true, isSecret: false }]);
    });

    test.each([
      ["null entries", null],
      ["array entries", []],
      ["string entries", "q-1"],
      ["a non-string id", { id: 1, header: "H", question: "Q?" }],
      ["a missing header", { id: "q-1", question: "Q?" }],
      ["a missing question", { id: "q-1", header: "H" }],
      ["a non-string question", { id: "q-1", header: "H", question: 5 }],
    ])("drops %s", (_label, entry) => {
      // One malformed question among good ones is dropped rather than failing
      // the whole interaction.
      expect(
        withQuestions([entry, { id: "q-2", header: "H", question: "Q?" }]),
      ).toEqual([{ id: "q-2", header: "H", question: "Q?", isOther: false, isSecret: false }]);
    });

    test("filters options down to the entries that carry a label", () => {
      expect(
        withQuestions([
          {
            id: "q-1",
            header: "H",
            question: "Q?",
            options: [
              null,
              "staging",
              [],
              { description: "no label" },
              { label: 5 },
              { label: "prod", description: 7 },
            ],
          },
        ]),
      ).toEqual([
        {
          id: "q-1",
          header: "H",
          question: "Q?",
          isOther: false,
          isSecret: false,
          options: [{ label: "prod" }],
        },
      ]);
    });

    test("omits the options key when nothing survived the filter", () => {
      const parsed = withQuestions([
        { id: "q-1", header: "H", question: "Q?", options: [null, { label: 5 }] },
      ]);
      expect(parsed?.[0]?.options).toBeUndefined();

      const notAnArray = withQuestions([
        { id: "q-1", header: "H", question: "Q?", options: "staging" },
      ]);
      expect(notAnArray?.[0]?.options).toBeUndefined();
    });
  });

  describe("fetchPendingInteractions", () => {
    test("returns the parsed list", async () => {
      mockFetch(() => Response.json({ interactions: [VALID_INTERACTION] }));

      const interactions = await fetchPendingInteractions(client, "session-1");
      expect(interactions).toHaveLength(1);
      expect(interactions[0]?.interactionId).toBe("int-1");
    });

    test("drops the entries it cannot parse rather than the whole snapshot", async () => {
      mockFetch(() =>
        Response.json({
          interactions: [
            { ...VALID_INTERACTION, interactionId: "" },
            VALID_INTERACTION,
            null,
          ],
        }),
      );

      const interactions = await fetchPendingInteractions(client, "session-1");
      expect(interactions.map((entry) => entry.interactionId)).toEqual(["int-1"]);
    });

    test("throws on a non-2xx response, a malformed body and a network failure", async () => {
      mockFetch(() => new Response(null, { status: 500 }));
      await expect(fetchPendingInteractions(client, "session-1")).rejects.toThrow(
        "HTTP 500",
      );

      mockFetch(() => Response.json({ interactions: "not-an-array" }));
      await expect(fetchPendingInteractions(client, "session-1")).rejects.toThrow(
        "malformed",
      );

      mockFetch(() => Response.json({}));
      await expect(fetchPendingInteractions(client, "session-1")).rejects.toThrow(
        "malformed",
      );

      mockFetchError(new Error("network down"));
      await expect(fetchPendingInteractions(client, "session-1")).rejects.toThrow(
        "network down",
      );
    });
  });

  describe("respondToInteraction", () => {
    test("posts the answer to the interaction route", async () => {
      const fetchMock = mock(() => Response.json({ status: "applied" }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      expect(
        await respondToInteraction(client, "session-1", "int-1", {
          action: "accept",
          answers: { "q-1": ["staging"] },
        }),
      ).toBe("applied");

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:4000/session/session-1/interactions/int-1");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        action: "accept",
        answers: { "q-1": ["staging"] },
      });
    });

    test("encodes the interaction id into the path", async () => {
      const fetchMock = mock(() => Response.json({ status: "applied" }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await respondToInteraction(client, "session-1", "int/1?x", { action: "decline" });
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain("int%2F1%3Fx");
    });

    test.each([
      [200, "applied"],
      [409, "stale"],
      [403, "forbidden"],
      [500, "error"],
      [404, "error"],
    ])("maps HTTP %p to %p", async (status, expected) => {
      mockFetch(() => new Response(null, { status: status as number }));
      expect(
        await respondToInteraction(client, "session-1", "int-1", { action: "cancel" }),
      ).toBe(expected as CodexApprovalResponseResult);
    });

    test("reports error rather than throwing when the request fails outright", async () => {
      mockFetchError(new Error("network down"));
      expect(
        await respondToInteraction(client, "session-1", "int-1", { action: "cancel" }),
      ).toBe("error");
    });
  });
});

describe("codex-client parseContextUsage", () => {
  const EXACT: ContextUsageSnapshot = {
    usedTokens: 12_500,
    totalTokens: 200_000,
    percentUsed: 6.25,
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    lastTurnTokens: 900,
    sessionTokens: 12_500,
    costUsd: 0.42,
    durationMs: 1_200,
    apiDurationMs: 900,
    permissionDenials: 1,
    linesAdded: 30,
    linesRemoved: 4,
    modelId: "gpt-5-codex",
    estimated: false,
    source: "provider",
    updatedAt: "2026-07-26T00:00:00.000Z",
    rateLimits: [
      { label: "5h", usedPercent: 12, resetsAt: "2026-07-26T05:00:00.000Z", windowMinutes: 300 },
    ],
    credits: { hasCredits: true, unlimited: false, balance: "12.00" },
    contextCategories: [{ name: "tools", tokens: 500, color: "#fff" }],
  };

  test("passes an exact bridge snapshot through unchanged", () => {
    expect(parseContextUsage(EXACT)).toEqual(EXACT);
  });

  test("accepts the bare numeric triple", () => {
    expect(parseContextUsage({ usedTokens: 1, totalTokens: 2, percentUsed: 50 })).toEqual({
      usedTokens: 1,
      totalTokens: 2,
      percentUsed: 50,
    });
  });

  test.each([
    ["a null payload", null],
    ["a string payload", "12%"],
    ["an array payload", [{ usedTokens: 1, totalTokens: 2, percentUsed: 50 }]],
    ["a missing usedTokens", { totalTokens: 2, percentUsed: 50 }],
    ["a missing totalTokens", { usedTokens: 1, percentUsed: 50 }],
    // The UI calls `percentUsed.toFixed(...)` unguarded, so a string here throws
    // inside render and takes the whole tab down, not just the meter.
    ["a string percentUsed", { usedTokens: 1, totalTokens: 2, percentUsed: "50" }],
    ["a missing percentUsed", { usedTokens: 1, totalTokens: 2 }],
    ["a NaN usedTokens", { usedTokens: Number.NaN, totalTokens: 2, percentUsed: 50 }],
    [
      "an infinite totalTokens",
      { usedTokens: 1, totalTokens: Number.POSITIVE_INFINITY, percentUsed: 50 },
    ],
  ])("rejects %s", (_label, payload) => {
    expect(parseContextUsage(payload)).toBeNull();
  });

  test("drops malformed optional fields rather than the whole reading", () => {
    const parsed = parseContextUsage({
      usedTokens: 1,
      totalTokens: 2,
      percentUsed: 50,
      inputTokens: "10",
      costUsd: Number.NaN,
      durationMs: null,
      modelId: "",
      updatedAt: 12,
      estimated: "false",
      source: "telepathy",
    });

    expect(parsed).toEqual({ usedTokens: 1, totalTokens: 2, percentUsed: 50 });
  });

  test("keeps only the well-formed rate limit windows", () => {
    expect(
      parseContextUsage({
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
        rateLimits: [
          null,
          "5h",
          { usedPercent: 10 },
          { label: "" },
          { label: "weekly", usedPercent: "10", resetsAt: 5, windowMinutes: Number.NaN },
          { label: "5h", usedPercent: 12 },
        ],
      })?.rateLimits,
    ).toEqual([{ label: "weekly" }, { label: "5h", usedPercent: 12 }]);
  });

  test("omits empty optional collections entirely", () => {
    expect(
      parseContextUsage({
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
        rateLimits: [null],
        contextCategories: "lots",
        credits: { balance: 5 },
      }),
    ).toEqual({ usedTokens: 1, totalTokens: 2, percentUsed: 50 });
  });

  test("keeps only the well-formed context categories", () => {
    expect(
      parseContextUsage({
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
        contextCategories: [
          { name: "tools", tokens: 500 },
          { name: "system" },
          { tokens: 10 },
          null,
        ],
      })?.contextCategories,
    ).toEqual([{ name: "tools", tokens: 500 }]);
  });

  test("gates the session status snapshot on the same validation", async () => {
    mockFetch(() =>
      Response.json({
        status: "idle",
        contextUsage: { usedTokens: 5, totalTokens: 10, percentUsed: "50" },
      }),
    );
    const rejected = await lookupSessionStatus(client, "session-1");
    expect(rejected.kind).toBe("found");
    expect(rejected.kind === "found" && rejected.session.contextUsage).toBeUndefined();

    mockFetch(() =>
      Response.json({
        status: "idle",
        contextUsage: { usedTokens: 5, totalTokens: 10, percentUsed: 50 },
      }),
    );
    const accepted = await lookupSessionStatus(client, "session-1");
    expect(accepted.kind === "found" && accepted.session.contextUsage).toEqual({
      usedTokens: 5,
      totalTokens: 10,
      percentUsed: 50,
    });

    restoreFetch();
  });
});

describe("codex-client session operations", () => {
  afterEach(restoreFetch);

  function captureFetch(response: () => Response) {
    const fetchMock = mock(response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return () => fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
  }

  describe("forkCodexSession", () => {
    test("returns the forked session and posts the anchor message id", async () => {
      const call = captureFetch(() =>
        Response.json({ sessionId: "session-2", title: "Fork" }),
      );

      expect(await forkCodexSession(client, "session-1", "msg-3")).toEqual({
        sessionId: "session-2",
        title: "Fork",
      });
      const [url, init] = call();
      expect(url).toBe("http://127.0.0.1:4000/session/session-1/fork");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ lastMessageId: "msg-3" });
    });

    test("omits a title the bridge did not report", async () => {
      mockFetch(() => Response.json({ sessionId: "session-2", title: 7 }));
      expect(await forkCodexSession(client, "session-1")).toEqual({
        sessionId: "session-2",
      });
    });

    test("returns null rather than a session bound to no id", async () => {
      mockFetch(() => Response.json({}));
      expect(await forkCodexSession(client, "session-1")).toBeNull();

      mockFetch(() => Response.json({ sessionId: 7 }));
      expect(await forkCodexSession(client, "session-1")).toBeNull();
    });

    test("returns null on a non-2xx response", async () => {
      mockFetch(() => new Response(null, { status: 500 }));
      expect(await forkCodexSession(client, "session-1")).toBeNull();
    });
  });

  describe("compactCodexSession", () => {
    test("posts to the compact route", async () => {
      const call = captureFetch(() => new Response(null, { status: 200 }));

      expect(await compactCodexSession(client, "session-1")).toBe(true);
      const [url, init] = call();
      expect(url).toBe("http://127.0.0.1:4000/session/session-1/compact");
      expect(init?.method).toBe("POST");
    });

    test("reports failure without throwing", async () => {
      mockFetch(() => new Response(null, { status: 409 }));
      expect(await compactCodexSession(client, "session-1")).toBe(false);
    });
  });

  describe("steerCodexSession", () => {
    test("posts the input alongside its idempotency key", async () => {
      const call = captureFetch(() => new Response(null, { status: 200 }));

      expect(
        await steerCodexSession(client, "session-1", "use bun", "req-1"),
      ).toBe(true);
      const [url, init] = call();
      expect(url).toBe("http://127.0.0.1:4000/session/session-1/steer");
      expect(JSON.parse(init?.body as string)).toEqual({
        input: "use bun",
        requestId: "req-1",
      });
    });

    test("reports failure without throwing", async () => {
      mockFetch(() => new Response(null, { status: 409 }));
      expect(await steerCodexSession(client, "session-1", "use bun", "req-1")).toBe(
        false,
      );
    });
  });

  describe("startCodexNativeReview", () => {
    test("defaults to reviewing the uncommitted changes", async () => {
      const call = captureFetch(() => new Response(null, { status: 200 }));

      expect(await startCodexNativeReview(client, "session-1")).toBe(true);
      const [url, init] = call();
      expect(url).toBe("http://127.0.0.1:4000/session/session-1/review");
      expect(JSON.parse(init?.body as string)).toEqual({ type: "uncommittedChanges" });
    });

    test.each([
      [{ type: "uncommittedChanges" as const }],
      [{ type: "baseBranch" as const, branch: "main" }],
      [{ type: "commit" as const, sha: "abc123", title: "Fix it" }],
      [{ type: "custom" as const, instructions: "Look at the auth path" }],
    ])("forwards the %p target verbatim", async (target) => {
      const call = captureFetch(() => new Response(null, { status: 200 }));
      await startCodexNativeReview(client, "session-1", target);
      expect(JSON.parse(call()[1]?.body as string)).toEqual(target);
    });

    test("reports failure without throwing", async () => {
      mockFetch(() => new Response(null, { status: 500 }));
      expect(await startCodexNativeReview(client, "session-1")).toBe(false);
    });
  });

  describe("getCodexRuntimeHealth", () => {
    test("returns the bridge payload", async () => {
      const call = captureFetch(() => Response.json({ mcpServers: [], skills: [] }));

      expect(await getCodexRuntimeHealth(client, "session-1")).toEqual({
        mcpServers: [],
        skills: [],
      });
      expect(call()[0]).toBe(
        "http://127.0.0.1:4000/session/session-1/runtime-health",
      );
    });

    test("throws on a non-2xx response", async () => {
      mockFetch(() => new Response(null, { status: 503 }));
      await expect(getCodexRuntimeHealth(client, "session-1")).rejects.toThrow(
        "HTTP 503",
      );
    });

    test("propagates a network failure", async () => {
      mockFetchError(new Error("network down"));
      await expect(getCodexRuntimeHealth(client, "session-1")).rejects.toThrow(
        "network down",
      );
    });
  });
});
