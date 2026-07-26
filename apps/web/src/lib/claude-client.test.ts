import { afterEach, describe, expect, test, mock, beforeEach } from "bun:test";
import {
  createClient,
  checkHealth,
  getModels,
  createSession,
  listSessions,
  getSession,
  lookupSession,
  getSessionMessages,
  getStructuredOutput,
  sendPrompt,
  sendStructuredPrompt,
  abortSession,
  deleteSession,
  getPendingQuestions,
  getPendingPlanApprovals,
  answerQuestion,
  dismissQuestion,
  respondToPlanApproval,
  getSlashCommands,
  subscribeToEvents,
  SessionNotFoundError,
  type ClaudeClient,
} from "./claude-client";
import { StructuredOutputReadUnavailableError } from "@orkestrator/protocol/structured-output";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

function mockFetchJson(data: unknown, status = 200) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(data), { status })
  ) as unknown as typeof fetch;
}

function mockFetchError() {
  globalThis.fetch = mock(async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number) {
  globalThis.fetch = mock(async () =>
    new Response(null, { status })
  ) as unknown as typeof fetch;
}

describe("claude-client", () => {
  let client: ClaudeClient;

  beforeEach(() => {
    client = createClient("http://127.0.0.1:4001");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    delete window.orkestratorGateway;
    mock.restore();
  });

  describe("createClient", () => {
    test("returns a client with the given base URL", () => {
      const c = createClient("http://localhost:5000");
      expect(c.baseUrl).toBe("http://localhost:5000");
    });

    test("rewrites loopback base URLs through the gateway when enabled", () => {
      window.orkestratorGateway = { enabled: true };

      const c = createClient("http://localhost:5000");

      expect(c.baseUrl).toBe(`${window.location.origin}/__orkestrator/proxy/loopback/5000`);
    });
  });

  describe("checkHealth", () => {
    test("returns true when server responds ok", async () => {
      mockFetchJson({ status: "ok" });
      expect(await checkHealth(client)).toBe(true);
    });

    test("returns false when server responds with error status", async () => {
      mockFetchStatus(500);
      expect(await checkHealth(client)).toBe(false);
    });

    test("returns false when fetch throws", async () => {
      mockFetchError();
      expect(await checkHealth(client)).toBe(false);
    });
  });

  describe("getModels", () => {
    test("returns models array on success", async () => {
      mockFetchJson({ models: [{ id: "opus", name: "Opus" }] });
      const models = await getModels(client);
      expect(models).toEqual([{ id: "opus", name: "Opus" }]);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      const models = await getModels(client);
      expect(models).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      const models = await getModels(client);
      expect(models).toEqual([]);
    });
  });

  describe("createSession", () => {
    test("returns session data on success", async () => {
      mockFetchJson({ sessionId: "s-1", title: "Test" }, 201);
      const result = await createSession(client, "Test");
      expect(result).toEqual({ sessionId: "s-1", title: "Test" });
    });

    test("returns null on non-ok response", async () => {
      mockFetchStatus(500);
      const result = await createSession(client);
      expect(result).toBeNull();
    });

    test("returns null on network error", async () => {
      mockFetchError();
      const result = await createSession(client);
      expect(result).toBeNull();
    });
  });

  describe("listSessions", () => {
    test("returns sessions array on success", async () => {
      const sessions = [{ id: "s-1", title: "A", status: "idle" as const, createdAt: "2026-01-01", lastActivity: "2026-01-01" }];
      mockFetchJson({ sessions });
      const result = await listSessions(client);
      expect(result).toEqual(sessions);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      expect(await listSessions(client)).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await listSessions(client)).toEqual([]);
    });
  });

  describe("getSession", () => {
    test("returns session details on success", async () => {
      const session = { id: "s-1", title: "A", status: "idle" as const, createdAt: "2026-01-01", lastActivity: "2026-01-01" };
      mockFetchJson(session);
      const result = await getSession(client, "s-1");
      expect(result).toEqual(session);
      await expect(lookupSession(client, "s-1")).resolves.toEqual({
        kind: "found",
        session,
      });
    });

    test("returns null on 404", async () => {
      mockFetchStatus(404);
      expect(await getSession(client, "s-missing")).toBeNull();
    });

    test("returns null on network error", async () => {
      mockFetchError();
      expect(await getSession(client, "s-1")).toBeNull();
    });

    test("distinguishes missing sessions from an unavailable bridge", async () => {
      mockFetchStatus(404);
      await expect(lookupSession(client, "s-missing")).resolves.toEqual({
        kind: "missing",
      });

      mockFetchStatus(503);
      const unavailableHttp = await lookupSession(client, "s-1");
      expect(unavailableHttp.kind).toBe("unavailable");
      if (unavailableHttp.kind === "unavailable") {
        expect(unavailableHttp.error.message).toContain("HTTP 503");
      }

      mockFetchError();
      const unavailableTransport = await lookupSession(client, "s-1");
      expect(unavailableTransport.kind).toBe("unavailable");
      if (unavailableTransport.kind === "unavailable") {
        expect(unavailableTransport.error.message).toBe("network error");
      }

      mockFetchJson({ id: "s-1", status: "paused" });
      const unavailableMalformed = await lookupSession(client, "s-1");
      expect(unavailableMalformed.kind).toBe("unavailable");
      if (unavailableMalformed.kind === "unavailable") {
        expect(unavailableMalformed.error.message).toContain("malformed");
      }
    });
  });

  describe("getSessionMessages", () => {
    test("returns messages on success", async () => {
      mockFetchJson({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            parts: [{
              type: "tool-invocation",
              toolName: "TodoWrite",
              toolArgs: { todos: [{ content: "task", status: "in_progress" }] },
              toolState: "success",
            }],
            timestamp: "2026-03-10T11:00:00.000Z",
          },
        ],
      });
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe("msg-1");
    });

    test("returns messages as-is when no TodoWrite parts exist", async () => {
      mockFetchJson({
        messages: [{
          id: "msg-1",
          role: "assistant",
          content: "Hello",
          parts: [{ type: "tool-invocation", toolName: "Read", toolArgs: { file_path: "/foo" }, toolState: "success" }],
          timestamp: "2026-03-10T11:00:00.000Z",
        }],
      });
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe("msg-1");
    });

    test("throws SessionNotFoundError on 404", async () => {
      mockFetchStatus(404);
      expect(getSessionMessages(client, "s-missing")).rejects.toThrow(SessionNotFoundError);
    });

    test("returns empty array on non-404 error status", async () => {
      mockFetchStatus(500);
      const messages = await getSessionMessages(client, "s-1");
      expect(messages).toEqual([]);
    });

    test("throws on non-404 error status when strict refresh is requested", async () => {
      mockFetchStatus(500);
      expect(
        getSessionMessages(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("sendPrompt", () => {
    test("returns true on 202 accepted", async () => {
      mockFetchJson({ status: "processing" }, 202);
      const result = await sendPrompt(client, "s-1", "Hello");
      expect(result).toBe(true);
    });

    test("sends effort and permissionMode in request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ status: "processing" }), { status: 202 });
      }) as unknown as typeof fetch;

      await sendPrompt(client, "s-1", "Hello", {
        effort: "xhigh",
        permissionMode: "auto",
        model: "opus",
      });

      const body = JSON.parse(capturedBody!);
      expect(body.effort).toBe("xhigh");
      expect(body.permissionMode).toBe("auto");
      expect(body.model).toBe("opus");
    });

    test("returns false on server error", async () => {
      mockFetchStatus(500);
      expect(await sendPrompt(client, "s-1", "Hello")).toBe(false);
    });

    test("returns false on network error", async () => {
      mockFetchError();
      expect(await sendPrompt(client, "s-1", "Hello")).toBe(false);
    });
  });

  describe("structured output", () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    test("dispatches the schema and preserves the authoritative request id", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return Response.json({
          status: "already-processed",
          requestId: "bridge-request",
          duplicate: true,
        });
      }) as unknown as typeof fetch;

      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema, {
          requestId: "client-request",
          effort: "high",
        }),
      ).resolves.toEqual({
        status: "already-processed",
        requestId: "bridge-request",
        duplicate: true,
      });
      expect(JSON.parse(capturedBody!)).toEqual({
        requestId: "client-request",
        effort: "high",
        prompt: "Review",
        outputSchema: schema,
      });
    });

    test("returns null when dispatch is rejected or its transport is unavailable", async () => {
      mockFetchStatus(409);
      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema),
      ).resolves.toBeNull();

      mockFetchError();
      await expect(
        sendStructuredPrompt(client, "s-1", "Review", schema),
      ).resolves.toBeNull();
    });

    test("reads success, pending, malformed envelopes, and malformed JSON", async () => {
      const success = {
        ok: true,
        provider: "claude",
        requestId: "request/1",
        value: { summary: "done" },
      } as const;
      mockFetchJson({ structuredOutput: success });
      await expect(
        getStructuredOutput(client, "s-1", "request/1"),
      ).resolves.toEqual(success);
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        "http://127.0.0.1:4001/session/s-1/structured-output?requestId=request%2F1",
        expect.anything(),
      );

      mockFetchJson({ structuredOutput: null });
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toBeNull();

      mockFetchJson({ structuredOutput: { ok: true, provider: "claude" } });
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        requestId: "request-1",
        error: { code: "malformed_output" },
      });

      mockFetchJson(null);
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });

      globalThis.fetch = mock(async () =>
        new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })
      ) as unknown as typeof fetch;
      await expect(getStructuredOutput(client, "s-1", "request-1")).resolves.toMatchObject({
        ok: false,
        error: { code: "malformed_output" },
      });
    });

    test("throws a typed observation error when the result channel is unavailable", async () => {
      mockFetchError();

      const promise = getStructuredOutput(client, "s-1", "request-1");
      await expect(promise).rejects.toBeInstanceOf(StructuredOutputReadUnavailableError);
      await expect(promise).rejects.toMatchObject({
        provider: "claude",
        requestId: "request-1",
        retryable: true,
      });
    });
  });

  describe("abortSession", () => {
    test("returns true on success", async () => {
      mockFetchJson({ status: "aborted" });
      expect(await abortSession(client, "s-1")).toBe(true);
    });

    test("returns false on error", async () => {
      mockFetchError();
      expect(await abortSession(client, "s-1")).toBe(false);
    });
  });

  describe("deleteSession", () => {
    test("returns true on success", async () => {
      mockFetchJson({ status: "deleted" });
      expect(await deleteSession(client, "s-1")).toBe(true);
    });

    test("returns false on 404", async () => {
      mockFetchStatus(404);
      expect(await deleteSession(client, "s-missing")).toBe(false);
    });

    test("returns false on network error", async () => {
      mockFetchError();
      expect(await deleteSession(client, "s-1")).toBe(false);
    });
  });

  describe("getPendingQuestions", () => {
    test("returns questions array on success", async () => {
      const questions = [{ id: "q-1", sessionId: "s-1", questions: [{ question: "Continue?", header: "", options: [] }] }];
      mockFetchJson({ questions });
      const result = await getPendingQuestions(client, "s-1");
      expect(result).toEqual(questions);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(404);
      expect(await getPendingQuestions(client, "s-1")).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await getPendingQuestions(client, "s-1")).toEqual([]);
    });

    test("can surface refresh failures to strict callers", async () => {
      mockFetchStatus(500);
      await expect(
        getPendingQuestions(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 500");
    });
  });

  describe("getPendingPlanApprovals", () => {
    test("returns the authoritative approval snapshot", async () => {
      const approvals = [{ id: "approval-1", sessionId: "s-1" }];
      mockFetchJson({ approvals });

      expect(await getPendingPlanApprovals(client, "s-1")).toEqual(approvals);
    });

    test("returns an empty snapshot on ordinary failures and throws in strict mode", async () => {
      mockFetchStatus(503);
      expect(await getPendingPlanApprovals(client, "s-1")).toEqual([]);
      await expect(
        getPendingPlanApprovals(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("HTTP 503");

      mockFetchError();
      expect(await getPendingPlanApprovals(client, "s-1")).toEqual([]);
      await expect(
        getPendingPlanApprovals(client, "s-1", { throwOnError: true }),
      ).rejects.toThrow("network error");
    });
  });

  describe("subscribeToEvents", () => {
    class MockEventSource {
      static latest: MockEventSource | null = null;
      readonly url: string;
      readonly readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = mock(() => {});
      private listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(url: string) {
        this.url = url;
        MockEventSource.latest = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      emit(type: string, data: unknown) {
        this.listeners.get(type)?.({
          type,
          data: JSON.stringify(data),
        } as MessageEvent);
      }
    }

    test("yields parsed events and closes on iterator return", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const source = MockEventSource.latest!;
      source.emit("message.updated", { sessionId: "s-1", message: { id: "m-1" } });

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: {
          type: "message.updated",
          sessionId: "s-1",
          data: { sessionId: "s-1", message: { id: "m-1" } },
        },
      });
      await iterator.return?.();
      expect(source.close).toHaveBeenCalledTimes(1);
    });

    test("rejects a pending read on connection failure", async () => {
      globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
      const iterator = subscribeToEvents(client)[Symbol.asyncIterator]();
      const pending = iterator.next();
      MockEventSource.latest?.onerror?.();

      await expect(pending).rejects.toThrow("SSE connection error");
      expect(MockEventSource.latest?.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("answerQuestion", () => {
    test("returns true on success", async () => {
      mockFetchJson({ status: "answered" });
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe(true);
    });

    test("returns false on error", async () => {
      mockFetchError();
      expect(await answerQuestion(client, "s-1", "q-1", [["yes"]])).toBe(false);
    });
  });

  describe("dismissQuestion", () => {
    test("returns true when the bridge accepts the dismissal", async () => {
      mockFetchJson({ status: "dismissed" });
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${client.baseUrl}/session/s-1/questions/q-1`,
        { method: "DELETE" },
      );
    });

    test("returns false for HTTP and network failures", async () => {
      mockFetchJson({ error: "gone" }, 404);
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe(false);

      mockFetchError();
      expect(await dismissQuestion(client, "s-1", "q-1")).toBe(false);
    });
  });

  describe("respondToPlanApproval", () => {
    test("returns true when approved", async () => {
      mockFetchJson({ status: "approved" });
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe(true);
    });

    test("returns true when rejected with feedback", async () => {
      mockFetchJson({ status: "rejected" });
      expect(await respondToPlanApproval(client, "s-1", "a-1", false, "needs changes")).toBe(true);
    });

    test("returns false on network error", async () => {
      mockFetchError();
      expect(await respondToPlanApproval(client, "s-1", "a-1", true)).toBe(false);
    });
  });

  describe("getSlashCommands", () => {
    test("returns commands array on success", async () => {
      mockFetchJson({ commands: ["/help", "/clear"] });
      const result = await getSlashCommands(client);
      expect(result).toEqual(["/help", "/clear"]);
    });

    test("returns empty array on non-ok response", async () => {
      mockFetchStatus(500);
      expect(await getSlashCommands(client)).toEqual([]);
    });

    test("returns empty array on network error", async () => {
      mockFetchError();
      expect(await getSlashCommands(client)).toEqual([]);
    });
  });

  describe("SessionNotFoundError", () => {
    test("has correct name and message", () => {
      const error = new SessionNotFoundError("s-42");
      expect(error.name).toBe("SessionNotFoundError");
      expect(error.message).toBe("Session not found: s-42");
      expect(error).toBeInstanceOf(Error);
    });
  });
});
