import { afterEach, describe, expect, test, mock } from "bun:test";
import { createSession, deleteSession, getSessionMessages, resumeSession, type CodexClient } from "./codex-client";

const originalFetch = globalThis.fetch;

describe("codex-client createSession", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns session on 201 response", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ sessionId: "session-abc", title: "My Session" }), { status: 201 }),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const session = await createSession(client, { model: "gpt-5.3-codex" });

    expect(session.sessionId).toBe("session-abc");
    expect(session.title).toBe("My Session");
  });

  test("throws on non-ok HTTP response with status and body", async () => {
    globalThis.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 }),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };

    await expect(createSession(client)).rejects.toThrow("Codex bridge returned 500");
  });

  test("throws on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };

    await expect(createSession(client)).rejects.toThrow("Failed to fetch");
  });
});

describe("codex-client getSessionMessages", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns messages without appending todo snapshots", async () => {
    globalThis.fetch = mock(async () =>
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
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
  });

  test("returns messages without appending todo snapshots when resuming a session", async () => {
    globalThis.fetch = mock(async () =>
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
          },
        ],
      })),
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const resumed = await resumeSession(client, { threadId: "thread-1" });

    expect(resumed?.messages).toHaveLength(1);
    expect(resumed?.messages[0]?.id).toBe("msg-2");
  });

  test("returns messages as-is when no TodoWrite parts exist", async () => {
    globalThis.fetch = mock(async () =>
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
    ) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");
  });
});

describe("codex-client deleteSession", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns true on success", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };
    const deleted = await deleteSession(client, "session-1");

    expect(deleted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/session/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("returns false on non-ok response", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };

    expect(await deleteSession(client, "missing-session")).toBe(false);
  });

  test("returns false on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof fetch;

    const client: CodexClient = { baseUrl: "http://127.0.0.1:4000" };

    expect(await deleteSession(client, "session-1")).toBe(false);
  });
});
