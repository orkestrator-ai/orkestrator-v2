import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  compactOpenCodeSession,
  forkOpenCodeSession,
  getModels,
  getOpenCodeRuntimeHealth,
  getStructuredOutput,
  revertOpenCodeSession,
  sendPrompt,
  sendStructuredPrompt,
  shareOpenCodeSession,
  splitOpenCodeModelId,
  summarizeOpenCodeUsage,
  unrevertOpenCodeSession,
  unshareOpenCodeSession,
  type OpencodeClient,
  type OpenCodeMessage,
  type OpenCodeModel,
} from "./opencode-client";

import { StructuredOutputReadUnavailableError } from "@orkestrator/protocol/structured-output";

import { OPEN_CODE_MESSAGE_HISTORY_LIMIT } from "@orkestrator/protocol/opencode-message-id";

const originalFetch = globalThis.fetch;

function setTestUrl(url: string): void {
  (window as unknown as Window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

function expectedOpenCodeMessageId(requestId: string): string {
  let encoded = "";
  for (let index = 0; index < requestId.length; index += 1) {
    encoded += requestId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `msg_00000000000000000000000000_ork_${encoded}`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  setTestUrl("about:blank");
  mock.restore();
});

describe("opencode-client sendPrompt", () => {
  /** Captures the request handed to `promptAsync` and answers with success. */
  function capturePromptAsync() {
    const captured: Record<string, unknown>[] = [];
    const historyCalls: Record<string, unknown>[] = [];
    let history: unknown[] = [];
    let promptGate: Promise<void> | null = null;
    const client = {
      session: {
        messages: async (parameters: Record<string, unknown>) => {
          historyCalls.push(parameters);
          return { data: history };
        },
        promptAsync: async (request: Record<string, unknown>) => {
          captured.push(request);
          await promptGate;
          return { data: null };
        },
      },
    } as unknown as OpencodeClient;
    return {
      client,
      captured,
      historyCalls,
      setPromptGate(gate: Promise<void> | null) {
        promptGate = gate;
      },
      setHistory(entries: unknown[]) {
        history = entries;
      },
    };
  }

  test("maps build/plan mode to SDK agent", async () => {
    const { client, captured } = capturePromptAsync();

    const result = await sendPrompt(client, "session-1", "Hello", {
      model: "anthropic/claude-sonnet-4",
      variant: "high",
      mode: "plan",
      directory: "/workspace/repo",
    });

    expect(result.success).toBe(true);
    // Asserted as a whole request rather than with `objectContaining`: this is
    // the only place the prompt wire shape is pinned, so a partial matcher is
    // blind to a field silently disappearing from the request builder.
    expect(captured[0]).toEqual({
      sessionID: "session-1",
      directory: "/workspace/repo",
      messageID: undefined,
      parts: [{ type: "text", text: "Hello" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      agent: "plan",
      variant: "high",
      format: undefined,
    });
  });

  describe("model resolution", () => {
    async function modelRefFor(model?: string) {
      const { client, captured } = capturePromptAsync();
      await sendPrompt(client, "session-1", "Hello", { model });
      return captured[0]?.model;
    }

    test("splits a normal provider/model pair", async () => {
      expect(await modelRefFor("anthropic/claude-sonnet-4")).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      });
    });

    test("splits an openrouter-style id on the first slash only", async () => {
      // `split("/")[1]` truncated this to `anthropic`, so the main prompting
      // path silently ran a different model than the one the user picked.
      expect(await modelRefFor("openrouter/anthropic/claude-sonnet-4")).toEqual({
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
      });
    });

    test("sends a bare id as both halves", async () => {
      // Long-standing behaviour of this path: the server resolves a bare id.
      expect(await modelRefFor("claude-sonnet-4")).toEqual({
        providerID: "claude-sonnet-4",
        modelID: "claude-sonnet-4",
      });
    });

    test("treats the store sentinel as an ordinary bare id", async () => {
      // The native-agent adapter maps `"default"` to `undefined` before calling,
      // so it never reaches here; this pins that the client itself does not
      // silently reinterpret it, unlike the compaction path which must.
      expect(await modelRefFor("default")).toEqual({
        providerID: "default",
        modelID: "default",
      });
    });

    test("omits the model entirely when none was selected", async () => {
      expect(await modelRefFor(undefined)).toBeUndefined();
      expect(await modelRefFor("")).toBeUndefined();
    });

    test("preserves the existing handling of a half-specified id", async () => {
      expect(await modelRefFor("/claude-sonnet-4")).toEqual({
        providerID: "",
        modelID: "claude-sonnet-4",
      });
      expect(await modelRefFor("anthropic/")).toEqual({
        providerID: "anthropic",
        modelID: "anthropic/",
      });
    });
  });

  test("prefers an explicit agent over the conversation mode", async () => {
    const { client, captured } = capturePromptAsync();

    await sendPrompt(client, "session-1", "Hello", { agent: "reviewer", mode: "plan" });
    expect(captured[0]?.agent).toBe("reviewer");

    await sendPrompt(client, "session-1", "Hello", { mode: "plan" });
    expect(captured[1]?.agent).toBe("plan");

    await sendPrompt(client, "session-1", "Hello");
    expect(captured[2]?.agent).toBeUndefined();
  });

  test("encodes msg-prefixed caller IDs without colliding with unprefixed IDs", async () => {
    const { client, captured } = capturePromptAsync();

    await expect(
      sendPrompt(client, "session-1", "Hello", {
        requestId: "msg_collision",
      }),
    ).resolves.toEqual({ success: true, requestId: "msg_collision" });
    await expect(
      sendPrompt(client, "session-1", "Hello", {
        requestId: "collision",
      }),
    ).resolves.toEqual({ success: true, requestId: "collision" });

    expect(captured[0]?.messageID).toMatch(/^msg_[0-9a-f]{12}z{14}[0-9a-f]{12}_ork_/);
    expect(captured[1]?.messageID).toMatch(/^msg_[0-9a-f]{12}z{14}[0-9a-f]{12}_ork_/);
    expect(captured[0]?.messageID).not.toBe(captured[1]?.messageID);
  });

  test("orders consecutive caller-owned messages by send order and reuses retries", async () => {
    const { client, captured, historyCalls, setHistory } = capturePromptAsync();
    const sessionId = "ses_fcd9281c1001abcdefghijklmn";

    await sendPrompt(client, sessionId, "First", { requestId: "zz" });
    const first = captured[0]?.messageID;
    if (typeof first !== "string") throw new Error("first message ID missing");
    const firstTime = BigInt(`0x${first.slice(4, 16)}`);
    const assistantTime = ((firstTime + 0x1000n) & 0xffffffffffffn).toString(16).padStart(12, "0");
    const assistant = `msg_${assistantTime}hsJUIHGDARuWRB`;
    setHistory([
      { info: { id: first, role: "user" } },
      { info: { id: assistant, role: "assistant", parentID: first } },
    ]);
    await sendPrompt(client, sessionId, "Second", { requestId: "aa" });
    const second = captured[1]?.messageID;
    if (typeof second !== "string") throw new Error("second message ID missing");
    setHistory([
      { info: { id: first, role: "user" } },
      { info: { id: assistant, role: "assistant", parentID: first } },
      { info: { id: second, role: "user" } },
    ]);
    await sendPrompt(client, sessionId, "Retry", { requestId: "aa" });

    expect(first < assistant).toBe(true);
    expect(assistant < second).toBe(true);
    expect(captured[2]?.messageID).toBe(second);
    expect(historyCalls).toEqual([
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
    ]);
  });

  test("serializes concurrent same-snapshot sends and keeps retry reservations", async () => {
    const { client, captured, historyCalls, setPromptGate } = capturePromptAsync();
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setPromptGate(gate);

    const firstResult = sendPrompt(client, "session-1", "First", { requestId: "zz" });
    for (let index = 0; index < 20 && captured.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(captured).toHaveLength(1);
    const secondResult = sendPrompt(client, "session-1", "Second", { requestId: "aa" });
    await Promise.resolve();
    expect(historyCalls).toHaveLength(1);

    releaseFirst();
    setPromptGate(null);
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      { success: true, requestId: "zz" },
      { success: true, requestId: "aa" },
    ]);
    const first = captured[0]?.messageID;
    const second = captured[1]?.messageID;
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect((first as string) < (second as string)).toBe(true);

    await sendPrompt(client, "session-1", "Retry", { requestId: "aa" });
    expect(captured[2]?.messageID).toBe(second);
  });

  test.each(["", "   "])(
    "rejects a blank caller-supplied request ID without dispatching (%#)",
    async (requestId) => {
      const { client, captured } = capturePromptAsync();

      const result = await sendPrompt(client, "session-1", "Hello", { requestId });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/request id|non-empty|blank/i);
      expect(captured).toHaveLength(0);
    },
  );

  test.each([
    ["error envelope", { error: { message: "history unavailable" } }],
    ["empty envelope", { data: undefined, error: undefined }],
    ["null data", { data: null }],
    ["string data", { data: "invalid" }],
    ["wrapped data", { data: { messages: [] } }],
    [
      "too many messages",
      {
        data: Array.from({ length: OPEN_CODE_MESSAGE_HISTORY_LIMIT + 1 }, () => null),
      },
    ],
  ] as const)(
    "does not dispatch from unavailable or malformed history: %s",
    async (_label, response) => {
      const promptAsync = mock(async () => ({ data: null }));
      const command = mock(async () => ({ data: null }));
      const client = {
        session: {
          messages: async () => response,
          promptAsync,
          command,
        },
      } as unknown as OpencodeClient;

      const promptResult = await sendPrompt(client, "session-1", "Hello", {
        requestId: "request-1",
      });
      const commandResult = await sendPrompt(client, "session-1", "/init", {
        requestId: "request-2",
        command: { name: "init" },
      });

      expect(promptResult.success).toBe(false);
      expect(commandResult.success).toBe(false);
      expect(promptResult.error).toMatch(/history unavailable|malformed|too many|oversized/i);
      expect(commandResult.error).toMatch(/history unavailable|malformed|too many|oversized/i);
      expect(promptAsync).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
    },
  );

  describe("command branch", () => {
    /** Captures both dispatch routes so the selection itself is observable. */
    function captureCommandClient() {
      const command: Record<string, unknown>[] = [];
      const promptAsync: Record<string, unknown>[] = [];
      const client = {
        session: {
          messages: async () => ({ data: [] }),
          command: async (request: Record<string, unknown>) => {
            command.push(request);
            return { data: null };
          },
          promptAsync: async (request: Record<string, unknown>) => {
            promptAsync.push(request);
            return { data: null };
          },
        },
      } as unknown as OpencodeClient;
      return { client, command, promptAsync };
    }

    test("routes a command through session.command and strips the leading slash", async () => {
      const { client, command, promptAsync } = captureCommandClient();

      const result = await sendPrompt(client, "session-1", "/init", {
        command: { name: "/init" },
        model: "anthropic/claude-sonnet-4",
        variant: "high",
        agent: "reviewer",
        directory: "/workspace/repo",
        requestId: "req-1",
      });

      expect(result.success).toBe(true);
      expect(promptAsync).toHaveLength(0);
      expect(command[0]).toEqual({
        sessionID: "session-1",
        directory: "/workspace/repo",
        messageID: expect.any(String),
        command: "init",
        arguments: "",
        // The command path forwards the model id as the raw string the server
        // resolves, unlike `promptAsync`'s provider/model pair.
        model: "anthropic/claude-sonnet-4",
        agent: "reviewer",
        variant: "high",
        parts: [],
      });
      expect(command[0]?.messageID).toMatch(/^msg_[0-9a-f]{12}z{14}[0-9a-f]{12}_ork_/);
    });

    test("sends an empty arguments string for a bare command", async () => {
      // `arguments` is required on the server's command request body. Sending
      // `undefined` drops the key in `JSON.stringify`, the server answers 400,
      // and the caller reads that as a failed send and deletes the user's own
      // message from the transcript.
      const { client, command } = captureCommandClient();

      await sendPrompt(client, "session-1", "/init", { command: { name: "init" } });

      expect(command[0]?.arguments).toBe("");
      expect(Object.keys(command[0] as object)).toContain("arguments");
      expect(JSON.parse(JSON.stringify({ arguments: command[0]?.arguments }))).toEqual({
        arguments: "",
      });
    });

    test("forwards explicit command arguments untouched", async () => {
      const { client, command } = captureCommandClient();

      await sendPrompt(client, "session-1", "/review main", {
        command: { name: "/review", arguments: "main --verbose" },
      });

      expect(command[0]?.arguments).toBe("main --verbose");
    });

    test("passes only file parts, dropping the prompt text", async () => {
      // The command name carries the intent; the echoed prompt text would be
      // sent to the model a second time.
      const { client, command } = captureCommandClient();

      await sendPrompt(client, "session-1", "/review", {
        command: { name: "/review" },
        attachments: [
          { type: "file", path: "/workspace/a.ts", filename: "a.ts" },
          { type: "image", path: "/workspace/b.png", filename: "b.png" },
        ],
      });

      expect(command[0]?.parts).toEqual([
        {
          type: "file",
          mime: "text/typescript",
          url: "file:///workspace/a.ts",
          filename: "a.ts",
        },
        {
          type: "file",
          mime: "image/png",
          url: "file:///workspace/b.png",
          filename: "b.png",
        },
      ]);
    });

    test("prefers an explicit agent over the conversation mode", async () => {
      const { client, command } = captureCommandClient();

      await sendPrompt(client, "session-1", "/init", {
        command: { name: "init" },
        agent: "reviewer",
        mode: "plan",
      });
      expect(command[0]?.agent).toBe("reviewer");

      await sendPrompt(client, "session-1", "/init", {
        command: { name: "init" },
        mode: "plan",
      });
      expect(command[1]?.agent).toBe("plan");
    });

    test("surfaces a command rejection as a failed send", async () => {
      const client = {
        session: {
          command: async () => ({ error: { message: "unknown command" } }),
        },
      } as unknown as OpencodeClient;

      const result = await sendPrompt(client, "session-1", "/nope", {
        command: { name: "nope" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("unknown command");
    });
  });

  test("returns detailed error information on prompt failure", async () => {
    const client = {
      session: {
        promptAsync: async () => {
          throw {
            name: "APIError",
            data: {
              errorType: "rate_limit_error",
              message: "Too many requests. Please retry in 30 seconds.",
              status: 429,
              requestID: "req_123",
            },
          };
        },
      },
    } as unknown as OpencodeClient;

    const result = await sendPrompt(client, "session-1", "Hello");

    expect(result.success).toBe(false);
    expect(result.error).toContain("rate_limit_error");
    expect(result.error).toContain("Too many requests");
    expect(result.error).toContain("Status: 429");
    expect(result.error).toContain("Request ID: req_123");
    expect(result.error).toContain("Raw error:");
  });

  test("forwards every structured prompt option without disabling OpenCode tools", async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        promptAsync: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return { data: undefined, error: undefined };
        },
      },
    } as unknown as OpencodeClient;
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    const result = await sendStructuredPrompt(client, "session-1", "Review this", schema, {
      requestId: "structured-1",
      retryCount: 3,
      model: "openrouter/anthropic/claude-sonnet-4",
      variant: "high",
      mode: "plan",
      attachments: [
        {
          type: "image",
          path: "/workspace/screenshot.png",
          filename: "screenshot.png",
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
    });

    expect(result).toEqual({ success: true, requestId: "structured-1" });
    expect(capturedRequest).toMatchObject({
      sessionID: "session-1",
      messageID: expect.any(String),
      parts: [
        { type: "text", text: "Review this" },
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,AAAA",
          filename: "screenshot.png",
        },
      ],
      model: {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
      },
      agent: "plan",
      variant: "high",
      format: { type: "json_schema", schema, retryCount: 3 },
    });
    // Omitting `tools` preserves the server's normal agent/tool configuration.
    expect(capturedRequest?.tools).toBeUndefined();
  });

  test("generates and reconciles a structured request ID when the caller omits one", async () => {
    let history: unknown[] = [];
    let dispatched: Record<string, unknown> | undefined;
    const client = {
      session: {
        messages: async () => ({ data: history }),
        promptAsync: async (request: Record<string, unknown>) => {
          dispatched = request;
          return { data: null };
        },
      },
    } as unknown as OpencodeClient;
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };

    const result = await sendStructuredPrompt(client, "session-1", "Review", schema);
    expect(result.success).toBe(true);
    expect(result.requestId).toEqual(expect.any(String));
    expect(dispatched?.messageID).toEqual(expect.any(String));
    history = [
      {
        info: {
          id: dispatched?.messageID,
          role: "user",
          format: { type: "json_schema", schema },
        },
      },
      {
        info: {
          id: "assistant-generated",
          role: "assistant",
          parentID: dispatched?.messageID,
          time: { completed: 1 },
          structured: { ok: true },
        },
      },
    ];
    await expect(getStructuredOutput(client, "session-1", result.requestId)).resolves.toMatchObject(
      { ok: true, value: { ok: true } },
    );
  });

  test("reads only OpenCode's structured field and types malformed/retry failures", async () => {
    const successful = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: expectedOpenCodeMessageId("structured-1"),
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
              parts: [],
            },
            {
              info: {
                id: "assistant-1",
                role: "assistant",
                parentID: expectedOpenCodeMessageId("structured-1"),
                time: { created: 1, completed: 2 },
                structured: { summary: "Looks good" },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(successful, "session-1", "structured-1")).toEqual({
      ok: true,
      provider: "opencode",
      requestId: "structured-1",
      value: { summary: "Looks good" },
    });
    expect(await getStructuredOutput(successful, "session-1")).toEqual({
      ok: true,
      provider: "opencode",
      requestId: expectedOpenCodeMessageId("structured-1"),
      value: { summary: "Looks good" },
    });

    const msgPrefixedRequestId = "msg_explicit-structured";
    const msgPrefixed = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: expectedOpenCodeMessageId(msgPrefixedRequestId),
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
              parts: [],
            },
            {
              info: {
                id: "assistant-msg-prefixed",
                role: "assistant",
                parentID: expectedOpenCodeMessageId(msgPrefixedRequestId),
                time: { created: 1, completed: 2 },
                structured: { summary: "Qualified input" },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(msgPrefixed, "session-1", msgPrefixedRequestId)).toEqual({
      ok: true,
      provider: "opencode",
      requestId: msgPrefixedRequestId,
      value: { summary: "Qualified input" },
    });

    const retryPending = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "structured-old",
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
              parts: [],
            },
            {
              info: {
                id: "assistant-old",
                role: "assistant",
                parentID: "structured-old",
                time: { created: 1, completed: 2 },
                structured: { summary: "Stale result" },
              },
              parts: [],
            },
            {
              info: {
                id: "structured-retry",
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(retryPending, "session-1")).toBeNull();
    expect(await getStructuredOutput(retryPending, "session-1", "structured-retry")).toBeNull();

    const plaintextOnly = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: expectedOpenCodeMessageId("structured-2"),
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
              parts: [],
            },
            {
              info: {
                id: "assistant-2",
                role: "assistant",
                parentID: expectedOpenCodeMessageId("structured-2"),
                time: { created: 1, completed: 2 },
              },
              parts: [{ type: "text", text: '{"summary":"not trusted"}' }],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(plaintextOnly, "session-1", "structured-2")).toMatchObject({
      ok: false,
      requestId: "structured-2",
      error: { code: "malformed_output", retryable: true },
    });

    const exhausted = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "assistant-3",
                role: "assistant",
                parentID: expectedOpenCodeMessageId("structured-3"),
                time: { created: 1, completed: 2 },
                error: {
                  name: "StructuredOutputError",
                  data: { message: "Schema retries exhausted", retries: 3 },
                },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(exhausted, "session-1", "structured-3")).toMatchObject({
      ok: false,
      requestId: "structured-3",
      error: {
        code: "schema_retry_exhausted",
        retryable: true,
        details: { retries: 3 },
      },
    });
  });

  test("keeps explicit structured lookup pinned when later unrelated turns exist", async () => {
    const target = expectedOpenCodeMessageId("target-request");
    const later = expectedOpenCodeMessageId("later-request");
    const client = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: target,
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
            },
            {
              info: {
                id: "assistant-target",
                role: "assistant",
                parentID: target,
                time: { completed: 1 },
                structured: { request: "target" },
              },
            },
            {
              info: {
                id: later,
                role: "user",
                format: { type: "json_schema", schema: { type: "object" } },
              },
            },
            {
              info: {
                id: "assistant-later",
                role: "assistant",
                parentID: later,
                time: { completed: 2 },
                structured: { request: "later" },
              },
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    await expect(getStructuredOutput(client, "session-1", "target-request")).resolves.toMatchObject(
      { ok: true, value: { request: "target" } },
    );
    await expect(getStructuredOutput(client, "session-1")).resolves.toMatchObject({
      ok: true,
      value: { request: "later" },
    });
  });

  test.each(["", "  "])(
    "rejects blank structured lookup IDs before reading transcript history (%#)",
    async (requestId) => {
      const messages = mock(async () => ({ data: [] }));
      const client = { session: { messages } } as unknown as OpencodeClient;

      await expect(getStructuredOutput(client, "session-1", requestId)).rejects.toThrow(
        /request id|non-empty/i,
      );
      expect(messages).not.toHaveBeenCalled();
    },
  );

  test("keeps provider errors authoritative but throws for result-channel outages", async () => {
    const providerFailure = {
      session: {
        messages: async () => ({
          data: undefined,
          error: {
            name: "MessageAbortedError",
            data: { message: "Turn was cancelled" },
          },
        }),
      },
    } as unknown as OpencodeClient;
    await expect(
      getStructuredOutput(providerFailure, "session-1", "structured-4"),
    ).resolves.toMatchObject({
      ok: false,
      provider: "opencode",
      requestId: "structured-4",
      error: {
        code: "interrupted",
        message: "Turn was cancelled",
      },
    });

    const unavailable = {
      session: {
        messages: async () => {
          throw new Error("message history offline");
        },
      },
    } as unknown as OpencodeClient;
    const promise = getStructuredOutput(unavailable, "session-1", "structured-5");
    await expect(promise).rejects.toBeInstanceOf(StructuredOutputReadUnavailableError);
    await expect(promise).rejects.toMatchObject({
      provider: "opencode",
      requestId: "structured-5",
      retryable: true,
    });

    const malformed = {
      session: {
        messages: async () => ({ data: { messages: [] } }),
      },
    } as unknown as OpencodeClient;
    await expect(
      getStructuredOutput(malformed, "session-1", "structured-6"),
    ).resolves.toMatchObject({
      ok: false,
      requestId: "structured-6",
      error: { code: "malformed_output" },
    });

    const malformedTiming = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "assistant-invalid-time",
                role: "assistant",
                parentID: expectedOpenCodeMessageId("structured-invalid-time"),
                time: "completed yesterday",
                structured: { summary: "Must not be accepted" },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    await expect(
      getStructuredOutput(malformedTiming, "session-1", "structured-invalid-time"),
    ).resolves.toMatchObject({
      ok: false,
      requestId: "structured-invalid-time",
      error: {
        code: "malformed_output",
        message: "OpenCode returned malformed assistant timing data.",
      },
    });
  });
});

describe("opencode-client model and attachment edge cases", () => {
  test("getModels returns only the normalized model list", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: { all: [{ id: "provider", models: { model: { id: "model", name: "Model" } } }] },
        }),
      },
      config: { providers: async () => ({ data: undefined }) },
    } as unknown as OpencodeClient;
    expect(await getModels(client)).toEqual([
      { id: "provider/model", name: "Model", provider: "provider" },
    ]);
  });

  test("maps image and file attachment MIME types and file URL fallback", async () => {
    const promptAsync = mock(async (_input: unknown) => ({}));
    const client = { session: { promptAsync } } as unknown as OpencodeClient;
    await sendPrompt(client, "session-1", "attachments", {
      attachments: [
        { type: "image", path: "/tmp/a.jpg", filename: "a.jpg" },
        {
          type: "image",
          path: "/tmp/b.gif",
          filename: "b.gif",
          dataUrl: "data:image/gif;base64,AA==",
        },
        { type: "image", path: "/tmp/c.webp", filename: "c.webp" },
        { type: "file", path: "/tmp/d.ts", filename: "d.ts" },
        { type: "file", path: "/tmp/e.bin" },
        { type: "file", path: "/tmp/f.txt", filename: "f.txt" },
        { type: "file", path: "/tmp/g.json", filename: "g.json" },
        { type: "file", path: "/tmp/h.js", filename: "h.js" },
        { type: "file", path: "/tmp/i.mjs", filename: "i.mjs" },
        { type: "file", path: "/tmp/j.tsx", filename: "j.tsx" },
        { type: "file", path: "/tmp/k.md", filename: "k.md" },
        { type: "file", path: "/tmp/l.html", filename: "l.html" },
        { type: "file", path: "/tmp/m.css", filename: "m.css" },
        { type: "file", path: "/tmp/n.py", filename: "n.py" },
        { type: "file", path: "/tmp/o.rs", filename: "o.rs" },
      ],
    });
    const parts = (promptAsync.mock.calls[0]![0] as { parts: Array<Record<string, unknown>> })
      .parts;
    expect(parts.slice(1).map((part) => part.mime)).toEqual([
      "image/jpeg",
      "image/gif",
      "image/webp",
      "text/typescript",
      "application/octet-stream",
      "text/plain",
      "application/json",
      "text/javascript",
      "text/javascript",
      "text/typescript",
      "text/markdown",
      "text/html",
      "text/css",
      "text/x-python",
      "text/x-rust",
    ]);
    expect(parts[1]?.url).toBe("file:///tmp/a.jpg");
    expect(parts[2]?.url).toBe("data:image/gif;base64,AA==");
  });

  test("normalizes uppercase image extensions before inferring MIME types", async () => {
    const promptAsync = mock(async (_input: unknown) => ({}));
    const client = { session: { promptAsync } } as unknown as OpencodeClient;

    await sendPrompt(client, "session-1", "images", {
      attachments: [
        { type: "image", path: "/tmp/a.JPG", filename: "a.JPG" },
        { type: "image", path: "/tmp/b.JPEG", filename: "b.JPEG" },
        { type: "image", path: "/tmp/c.GIF", filename: "c.GIF" },
        { type: "image", path: "/tmp/d.WEBP", filename: "d.WEBP" },
      ],
    });

    const parts = (
      promptAsync.mock.calls[0]![0] as {
        parts: Array<Record<string, unknown>>;
      }
    ).parts;
    expect(parts.slice(1).map((part) => part.mime)).toEqual([
      "image/jpeg",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
  });

  test("encodes filesystem path segments without changing the selected filename", async () => {
    const promptAsync = mock(async (_input: unknown) => ({}));
    const client = { session: { promptAsync } } as unknown as OpencodeClient;

    await sendPrompt(client, "session-1", "files", {
      attachments: [
        {
          type: "file",
          path: "/workspace/hash#name.txt",
          filename: "hash#name.txt",
        },
        {
          type: "file",
          path: "/workspace/query?name.txt",
          filename: "query?name.txt",
        },
        {
          type: "file",
          path: "/workspace/%2e%2e/secret.txt",
          filename: "secret.txt",
        },
        {
          type: "file",
          path: "/workspace/space name.txt",
          filename: "space name.txt",
        },
        { type: "file", path: "/workspace/資料/✓.txt", filename: "✓.txt" },
        {
          type: "file",
          path: String.raw`C:\Users\Ada\report #1?.txt`,
          filename: "report #1?.txt",
        },
      ],
    });

    const parts = (
      promptAsync.mock.calls[0]![0] as {
        parts: Array<Record<string, unknown>>;
      }
    ).parts;
    expect(parts.slice(1).map((part) => part.url)).toEqual([
      "file:///workspace/hash%23name.txt",
      "file:///workspace/query%3Fname.txt",
      "file:///workspace/%252e%252e/secret.txt",
      "file:///workspace/space%20name.txt",
      "file:///workspace/%E8%B3%87%E6%96%99/%E2%9C%93.txt",
      "file:///C:/Users/Ada/report%20%231%3F.txt",
    ]);
  });

  test("rejects explicit traversal, relative paths, and null bytes before dispatch", async () => {
    for (const path of [
      "/workspace/../secret.txt",
      "/workspace/./secret.txt",
      String.raw`C:\workspace\..\secret.txt`,
      "workspace/secret.txt",
      "/workspace/\0secret.txt",
    ]) {
      const promptAsync = mock(async (_input: unknown) => ({}));
      const client = { session: { promptAsync } } as unknown as OpencodeClient;

      const result = await sendPrompt(client, "session-1", "file", {
        attachments: [{ type: "file", path, filename: "secret.txt" }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/absolute|traversal|null bytes/);
      expect(promptAsync).not.toHaveBeenCalled();
    }
  });
});

describe("opencode-client summarizeOpenCodeUsage", () => {
  const MODELS: OpenCodeModel[] = [
    {
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      contextWindow: 200_000,
    },
  ];

  function turn(
    usage: Partial<NonNullable<OpenCodeMessage["providerUsage"]>> = {},
  ): OpenCodeMessage {
    return {
      id: `msg-${Math.random()}`,
      role: "assistant",
      content: "",
      parts: [],
      createdAt: "2026-07-26T00:00:00.000Z",
      providerUsage: {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: "anthropic/claude-sonnet-4",
        ...usage,
      },
    };
  }

  test("returns null when no message carries provider usage", () => {
    expect(summarizeOpenCodeUsage([], MODELS)).toBeNull();
    expect(
      summarizeOpenCodeUsage(
        [{ id: "m", role: "user", content: "hi", parts: [], createdAt: "" }],
        MODELS,
      ),
    ).toBeNull();
  });

  test("returns null when every turn reports zero tokens", () => {
    expect(summarizeOpenCodeUsage([turn(), turn()], MODELS)).toBeNull();
  });

  test("never reports 100% for a model missing from the catalogue", () => {
    // Synthesising `totalTokens` from `usedTokens` made `percentUsed` exactly
    // 100 on every mount before the async model list arrived, and the UI renders
    // that number straight into a full progress bar.
    const messages = [turn({ inputTokens: 900, outputTokens: 100 })];

    expect(summarizeOpenCodeUsage(messages, [])).toBeNull();
    expect(
      summarizeOpenCodeUsage(messages, [
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400_000 },
      ]),
    ).toBeNull();
  });

  test("returns null when the catalogue window is not positive", () => {
    expect(
      summarizeOpenCodeUsage([turn({ totalTokens: 1_000 })], [{ ...MODELS[0]!, contextWindow: 0 }]),
    ).toBeNull();
    expect(
      summarizeOpenCodeUsage(
        [turn({ totalTokens: 1_000 })],
        [{ ...MODELS[0]!, contextWindow: undefined }],
      ),
    ).toBeNull();
  });

  test("keeps the completed reading while the next turn streams zeros", () => {
    // `AssistantMessage.tokens` is required and zero-initialised while the turn
    // streams, so anchoring on the last turn collapsed the reading to 0% for the
    // whole duration of every turn and then snapped back on completion.
    const summary = summarizeOpenCodeUsage(
      [turn({ totalTokens: 50_000, inputTokens: 45_000, outputTokens: 5_000 }), turn()],
      MODELS,
    );

    expect(summary?.usedTokens).toBe(50_000);
    expect(summary?.percentUsed).toBe(25);
  });

  test("uses the provider total when it reports one", () => {
    expect(
      summarizeOpenCodeUsage(
        [turn({ totalTokens: 40_000, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 })],
        MODELS,
      )?.usedTokens,
    ).toBe(40_000);
  });

  test("falls back to input + output + cache reads without a provider total", () => {
    // Cache writes and reasoning are deliberately excluded: neither occupies the
    // context window on the next turn.
    expect(
      summarizeOpenCodeUsage(
        [
          turn({
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheReadTokens: 3_000,
            cacheWriteTokens: 500,
            reasoningTokens: 700,
          }),
        ],
        MODELS,
      )?.usedTokens,
    ).toBe(15_000);
  });

  test("ignores a zero provider total in favour of the counter sum", () => {
    expect(
      summarizeOpenCodeUsage(
        [turn({ totalTokens: 0, inputTokens: 1_000, outputTokens: 500 })],
        MODELS,
      )?.usedTokens,
    ).toBe(1_500);
  });

  test("clamps the percentage at 100 when a turn overflows the window", () => {
    expect(summarizeOpenCodeUsage([turn({ totalTokens: 400_000 })], MODELS)?.percentUsed).toBe(100);
  });

  test("sums every turn for the session-level figures", () => {
    const summary = summarizeOpenCodeUsage(
      [
        turn({
          cost: 0.25,
          inputTokens: 1_000,
          outputTokens: 200,
          reasoningTokens: 30,
          cacheReadTokens: 400,
          cacheWriteTokens: 100,
          durationMs: 1_500,
        }),
        // The in-flight turn contributes nothing, so it cannot skew the sums.
        turn(),
        turn({
          cost: 0.75,
          inputTokens: 2_000,
          outputTokens: 300,
          reasoningTokens: 70,
          cacheReadTokens: 600,
          cacheWriteTokens: 900,
          durationMs: 2_500,
        }),
      ],
      MODELS,
    );

    expect(summary).toMatchObject({
      usedTokens: 2_900,
      totalTokens: 200_000,
      lastTurnTokens: 2_900,
      modelId: "anthropic/claude-sonnet-4",
      inputTokens: 3_000,
      outputTokens: 500,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 100,
      costUsd: 1,
      durationMs: 4_000,
      // Reasoning is deliberately excluded from `sessionTokens`: it is already
      // counted inside the output tokens the provider bills for.
      sessionTokens: 5_500,
    });
    expect(summary?.percentUsed).toBeCloseTo(1.45, 10);
  });

  test("marks the reading as exact provider data", () => {
    const summary = summarizeOpenCodeUsage([turn({ totalTokens: 1_000 })], MODELS);

    expect(summary?.estimated).toBe(false);
    expect(summary?.source).toBe("opencode");
    expect(summary?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(summary!.updatedAt!).toISOString()).toBe(summary!.updatedAt!);
  });
});

describe("opencode-client getOpenCodeRuntimeHealth", () => {
  function healthClient(overrides: Record<string, unknown> = {}) {
    return {
      app: {
        agents: async () => ({
          data: [
            {
              name: "build",
              description: "Default",
              mode: "primary",
              native: true,
              model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
              variant: "high",
            },
            { name: "internal", mode: "subagent", hidden: true },
          ],
        }),
        skills: async () => ({ data: [{ name: "review", location: "/skills/review" }] }),
      },
      mcp: {
        status: async () => ({
          data: {
            docs: { status: "connected" },
            broken: { error: "spawn failed" },
          },
        }),
      },
      lsp: {
        status: async () => ({
          data: [{ id: "ts", name: "typescript", root: "/repo", status: "ready" }],
        }),
      },
      formatter: {
        status: async () => ({ data: [{ name: "prettier", enabled: true, extensions: [".ts"] }] }),
      },
      session: {
        todo: async () => ({ data: [{ content: "ship", status: "pending", priority: "high" }] }),
        diff: async () => ({
          data: [{ file: "a.ts", additions: 3, deletions: 1, status: "modified" }],
        }),
      },
      ...overrides,
    } as unknown as OpencodeClient;
  }

  test("assembles the full snapshot", async () => {
    const health = await getOpenCodeRuntimeHealth(healthClient(), "/repo", "session-1");

    expect(health.agents).toEqual([
      {
        name: "build",
        description: "Default",
        mode: "primary",
        native: true,
        hidden: undefined,
        modelId: "anthropic/claude-sonnet-4",
        variant: "high",
      },
    ]);
    expect(health.skills).toEqual([{ name: "review", location: "/skills/review" }]);
    expect(health.mcpServers).toEqual([
      { name: "docs", status: "connected", error: undefined },
      // A server that reported no status at all is "unknown", not missing.
      { name: "broken", status: "unknown", error: "spawn failed" },
    ]);
    expect(health.lspServers).toHaveLength(1);
    expect(health.formatters).toHaveLength(1);
    expect(health.todos).toHaveLength(1);
    expect(health.diffs).toHaveLength(1);
    expect(new Date(health.fetchedAt).toISOString()).toBe(health.fetchedAt);
  });

  test("passes the working directory to every namespace", async () => {
    const seen: string[] = [];
    const record = (label: string) => async (args: { directory?: string }) => {
      seen.push(`${label}:${args.directory}`);
      return { data: [] };
    };
    const client = {
      app: { agents: record("agents"), skills: record("skills") },
      mcp: {
        status: async (args: { directory?: string }) => {
          seen.push(`mcp:${args.directory}`);
          return { data: {} };
        },
      },
      lsp: { status: record("lsp") },
      formatter: { status: record("formatter") },
      session: { todo: record("todo"), diff: record("diff") },
    } as unknown as OpencodeClient;

    await getOpenCodeRuntimeHealth(client, "/repo", "session-1");

    expect(seen.sort()).toEqual([
      "agents:/repo",
      "diff:/repo",
      "formatter:/repo",
      "lsp:/repo",
      "mcp:/repo",
      "skills:/repo",
      "todo:/repo",
    ]);
  });

  test("degrades one capability at a time rather than losing the snapshot", async () => {
    // Managed installations and test doubles expose only a subset of the v2
    // surface, so a missing namespace must cost exactly that one capability.
    const health = await getOpenCodeRuntimeHealth(
      healthClient({
        mcp: undefined,
        lsp: {
          status: async () => {
            throw new Error("lsp unavailable");
          },
        },
        formatter: { status: async () => ({ data: undefined }) },
      }),
      "/repo",
      "session-1",
    );

    expect(health.mcpServers).toEqual([]);
    expect(health.lspServers).toEqual([]);
    expect(health.formatters).toEqual([]);
    // The capabilities that did answer are unaffected.
    expect(health.agents).toHaveLength(1);
    expect(health.skills).toHaveLength(1);
    expect(health.todos).toHaveLength(1);
  });

  test("survives a client missing every namespace", async () => {
    const health = await getOpenCodeRuntimeHealth({} as unknown as OpencodeClient);

    expect(health).toMatchObject({
      agents: [],
      skills: [],
      mcpServers: [],
      lspServers: [],
      formatters: [],
      todos: [],
      diffs: [],
    });
  });

  test("skips the session-scoped lookups when there is no session yet", async () => {
    let todoCalls = 0;
    let diffCalls = 0;
    const client = healthClient({
      session: {
        todo: async () => {
          todoCalls += 1;
          return { data: [{ content: "ship", status: "pending", priority: "high" }] };
        },
        diff: async () => {
          diffCalls += 1;
          return { data: [] };
        },
      },
    });

    const health = await getOpenCodeRuntimeHealth(client, "/repo");

    expect(todoCalls).toBe(0);
    expect(diffCalls).toBe(0);
    expect(health.todos).toEqual([]);
    expect(health.diffs).toEqual([]);
    expect(health.agents).toHaveLength(1);
  });
});

describe("splitOpenCodeModelId", () => {
  test.each([
    ["anthropic/claude-sonnet-4", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
    [
      "openrouter/anthropic/claude-sonnet-4",
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
      },
    ],
    [
      "  anthropic/claude-sonnet-4  ",
      {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    ],
  ] as const)("splits a complete model override (%s)", (model, expected) => {
    expect(splitOpenCodeModelId(model)).toEqual(expected);
  });

  test.each([undefined, "", "   ", "default", "bare", "/", "/model", "provider/"])(
    "omits an incomplete model override (%s)",
    (model) => {
      expect(splitOpenCodeModelId(model)).toEqual({});
    },
  );
});

describe("opencode-client session operations", () => {
  describe("forkOpenCodeSession", () => {
    test("maps the forked session into the UI shape", async () => {
      const captured: Record<string, unknown>[] = [];
      const client = {
        session: {
          fork: async (request: Record<string, unknown>) => {
            captured.push(request);
            return { data: { id: "session-2", title: "Fork", time: { created: 1739232000000 } } };
          },
        },
      } as unknown as OpencodeClient;

      expect(await forkOpenCodeSession(client, "session-1", "msg-3")).toEqual({
        id: "session-2",
        title: "Fork",
        createdAt: new Date(1739232000000).toISOString(),
        // The server reported no update time, so the fork falls back to its
        // creation time — it has not been touched since.
        updatedAt: new Date(1739232000000).toISOString(),
      });
      expect(captured[0]).toEqual({ sessionID: "session-1", messageID: "msg-3" });
    });

    test("throws on an empty response", async () => {
      const client = {
        session: { fork: async () => ({ data: undefined }) },
      } as unknown as OpencodeClient;

      await expect(forkOpenCodeSession(client, "session-1")).rejects.toThrow("empty fork response");
    });
  });

  describe("compactOpenCodeSession", () => {
    function captureSummarize() {
      const captured: Record<string, unknown>[] = [];
      const client = {
        session: {
          summarize: async (request: Record<string, unknown>) => {
            captured.push(request);
            return { data: true };
          },
        },
      } as unknown as OpencodeClient;
      return { client, captured };
    }

    test("splits a provider/model pair", async () => {
      const { client, captured } = captureSummarize();

      await compactOpenCodeSession(client, "session-1", "anthropic/claude-sonnet-4");

      expect(captured[0]).toEqual({
        sessionID: "session-1",
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        auto: false,
      });
    });

    test("splits on the first slash only", async () => {
      // Ids are built as `${provider.id}/${modelId}` and the model id may itself
      // contain slashes; a plain destructure truncated to the middle segment.
      const { client, captured } = captureSummarize();

      await compactOpenCodeSession(client, "session-1", "openrouter/anthropic/claude-sonnet-4");

      expect(captured[0]).toMatchObject({
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
      });
    });

    test.each([
      ["the store's sentinel", "default"],
      ["an empty string", ""],
      ["whitespace", "   "],
      ["an undefined model", undefined],
      ["an id with no slash", "claude-sonnet-4"],
      ["an id that is only a slash", "/"],
      ["an id with no provider half", "/claude-sonnet-4"],
      ["an id with no model half", "anthropic/"],
    ])("treats %s as no model override", async (_label, model) => {
      // `openCodeStore.selectedModel` legitimately holds "default", and the
      // info-panel caller passes the stored value through untouched. Half a
      // pair is worse than none: the server would resolve a provider that
      // names no model.
      const { client, captured } = captureSummarize();

      await compactOpenCodeSession(client, "session-1", model as string | undefined);

      expect(captured[0]).toEqual({
        sessionID: "session-1",
        providerID: undefined,
        modelID: undefined,
        auto: false,
      });
    });
  });

  describe("revertOpenCodeSession", () => {
    test("posts the anchor message id", async () => {
      const captured: Record<string, unknown>[] = [];
      const client = {
        session: {
          revert: async (request: Record<string, unknown>) => {
            captured.push(request);
            return { data: true };
          },
        },
      } as unknown as OpencodeClient;

      await revertOpenCodeSession(client, "session-1", "msg-3");
      expect(captured[0]).toEqual({ sessionID: "session-1", messageID: "msg-3" });

      await revertOpenCodeSession(client, "session-1");
      expect(captured[1]).toEqual({ sessionID: "session-1", messageID: undefined });
    });

    test("propagates a rejection", async () => {
      const client = {
        session: {
          revert: async () => {
            throw new Error("nothing to revert");
          },
        },
      } as unknown as OpencodeClient;

      await expect(revertOpenCodeSession(client, "session-1")).rejects.toThrow("nothing to revert");
    });
  });

  describe("unrevertOpenCodeSession", () => {
    test("targets the session", async () => {
      const captured: Record<string, unknown>[] = [];
      const client = {
        session: {
          unrevert: async (request: Record<string, unknown>) => {
            captured.push(request);
            return { data: true };
          },
        },
      } as unknown as OpencodeClient;

      await unrevertOpenCodeSession(client, "session-1");
      expect(captured[0]).toEqual({ sessionID: "session-1" });
    });
  });

  describe("shareOpenCodeSession", () => {
    test("returns the share url", async () => {
      const client = {
        session: {
          share: async () => ({
            data: { id: "session-1", share: { url: "https://share.test/s1" } },
          }),
        },
      } as unknown as OpencodeClient;

      expect(await shareOpenCodeSession(client, "session-1")).toBe("https://share.test/s1");
    });

    test("returns undefined when the server shared without reporting a url", async () => {
      const client = {
        session: { share: async () => ({ data: { id: "session-1" } }) },
      } as unknown as OpencodeClient;

      expect(await shareOpenCodeSession(client, "session-1")).toBeUndefined();
    });

    test("throws on an empty response", async () => {
      const client = {
        session: { share: async () => ({ data: undefined }) },
      } as unknown as OpencodeClient;

      await expect(shareOpenCodeSession(client, "session-1")).rejects.toThrow(
        "empty share response",
      );
    });
  });

  describe("unshareOpenCodeSession", () => {
    test("targets the session", async () => {
      const captured: Record<string, unknown>[] = [];
      const client = {
        session: {
          unshare: async (request: Record<string, unknown>) => {
            captured.push(request);
            return { data: true };
          },
        },
      } as unknown as OpencodeClient;

      await unshareOpenCodeSession(client, "session-1");
      expect(captured[0]).toEqual({ sessionID: "session-1" });
    });
  });
});
