import { afterEach, describe, expect, test, mock } from "bun:test";
import {
  CODEX_MODELS,
  abortSession,
  checkHealth,
  createClient,
  createSession,
  deleteSession,
  getModels,
  getSessionMessages,
  getSessionStatus,
  getSlashCommands,
  listSessions,
  resumeSession,
  sendPrompt,
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
});

describe("codex-client sendPrompt", () => {
  afterEach(restoreFetch);

  test("posts prompt attachments and returns true on ok response", async () => {
    mockFetch(async () => new Response(null, { status: 202 }));

    await expect(sendPrompt(client, "session-1", "Review this", {
      attachments: [{
        type: "image",
        path: "/workspace/screenshot.png",
        dataUrl: "data:image/png;base64,abc",
        filename: "screenshot.png",
      }],
    })).resolves.toBe(true);

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
        }),
      }),
    );
  });

  test("returns false on non-ok or failed responses", async () => {
    mockFetch(async () => new Response(null, { status: 409 }));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toBe(false);

    mockFetchError(new Error("offline"));
    await expect(sendPrompt(client, "session-1", "Review this")).resolves.toBe(false);
  });
});

describe("codex-client abortSession", () => {
  afterEach(restoreFetch);

  test("posts abort request and returns true on ok response", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    await expect(abortSession(client, "session-1")).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1/abort",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("returns false on non-ok or failed responses", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(abortSession(client, "session-1")).resolves.toBe(false);

    mockFetchError(new Error("offline"));
    await expect(abortSession(client, "session-1")).resolves.toBe(false);
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
