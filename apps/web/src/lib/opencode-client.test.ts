import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildOpenCodeMessageFromPart,
  abortSession,
  createClient,
  createSession,
  deleteSession,
  formatOpenCodeError,
  getAvailableSlashCommands,
  getModels,
  getModelsWithDefaults,
  getOpenCodePartKey,
  getPendingPermissions,
  getPendingQuestions,
  getSessionMessages,
  getSessionStatus,
  hasOpenCodeSubagentSession,
  listSessions,
  mergeOpenCodeSubagentTranscript,
  normalizeOpenCodeMessage,
  normalizeOpenCodePart,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  sendPrompt,
  subscribeToEvents,
  type OpencodeClient,
  type OpenCodeMessage,
} from "./opencode-client";

const originalFetch = globalThis.fetch;

function setTestUrl(url: string): void {
  (window as unknown as Window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  setTestUrl("about:blank");
  mock.restore();
});

describe("opencode-client createClient", () => {
  test("rewrites loopback SDK requests through the gateway when enabled", async () => {
    const requests: string[] = [];
    setTestUrl("http://gateway.test/");
    window.orkestratorGateway = { enabled: true };
    globalThis.fetch = mock(async (input) => {
      requests.push((input as Request).url);
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createClient("http://127.0.0.1:7777");
    await client.session.list();

    expect(requests).toEqual([
      `${window.location.origin}/__orkestrator/proxy/loopback/7777/session`,
    ]);
  });
});

describe("opencode-client listSessions", () => {
  test("maps SDK sessions into UI session shape", async () => {
    const createdMs = 1739232000000;
    const client = {
      session: {
        list: async () => ({
          data: [
            {
              id: "session-1",
              title: "My Session",
              time: {
                created: createdMs,
              },
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const sessions = await listSessions(client);

    expect(sessions).toEqual([
      {
        id: "session-1",
        title: "My Session",
        createdAt: new Date(createdMs).toISOString(),
      },
    ]);
  });

  test("rethrows errors so callers can display failure state", async () => {
    const expectedError = new Error("network unavailable");
    const client = {
      session: {
        list: async () => {
          throw expectedError;
        },
      },
    } as unknown as OpencodeClient;

    await expect(listSessions(client)).rejects.toThrow("network unavailable");
  });
});

const noProviderCatalog = {
  provider: {
    list: async () => {
      throw new Error("provider catalog unavailable");
    },
  },
};

describe("opencode-client getModelsWithDefaults", () => {
  test("prefers provider catalog so unconfigured models still appear", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-sonnet-4": {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                  },
                  "claude-opus-4": {
                    id: "claude-opus-4",
                    name: "Claude Opus 4",
                  },
                },
              },
            ],
            default: {
              model: "anthropic/claude-sonnet-4",
            },
            connected: ["anthropic"],
          },
        }),
      },
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                models: {
                  "claude-sonnet-4": {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                  },
                },
              },
            ],
            default: {
              model: "anthropic/claude-sonnet-4",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
      },
      {
        id: "anthropic/claude-opus-4",
        name: "Claude Opus 4",
        provider: "anthropic",
      },
    ]);
    expect(result.defaults.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("maps default model and variant from direct default config", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                models: {
                  "claude-sonnet-4": {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                    variants: {
                      low: {},
                      high: {},
                    },
                  },
                },
              },
            ],
            default: {
              model: "anthropic/claude-sonnet-4",
              variant: "high",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.defaults).toEqual({
      modelId: "anthropic/claude-sonnet-4",
      variant: "high",
    });
    expect(result.models.map((m) => m.id)).toContain("anthropic/claude-sonnet-4");
  });

  test("maps nested default model object to provider/model id", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "openai",
                models: {
                  "gpt-5": {
                    id: "gpt-5",
                    name: "GPT-5",
                    variants: {
                      medium: {},
                    },
                  },
                },
              },
            ],
            default: {
              model: {
                providerID: "openai",
                modelID: "gpt-5",
                variant: "medium",
              },
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.defaults).toEqual({
      modelId: "openai/gpt-5",
      variant: "medium",
    });
  });

  test("accepts provider models returned as an array", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "openai",
                models: [
                  {
                    id: "gpt-5",
                    name: "GPT-5",
                    variants: {
                      high: {},
                    },
                  },
                ],
              },
            ],
            default: {
              providerID: "openai",
              modelID: "gpt-5",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        variants: ["high"],
      },
    ]);
    expect(result.defaults.modelId).toBe("openai/gpt-5");
  });

  test("accepts providers returned as an object map", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: {
              anthropic: {
                id: "anthropic",
                models: {
                  "claude-sonnet-4": {
                    id: "claude-sonnet-4",
                    name: "Claude Sonnet 4",
                  },
                },
              },
            },
            default: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "anthropic",
      },
    ]);
    expect(result.defaults.modelId).toBe("anthropic/claude-sonnet-4");
  });

  test("uses object-map model keys when model entries omit id", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: {
              openai: {
                models: {
                  "gpt-5-codex": {
                    name: "GPT-5 Codex",
                  },
                },
              },
            },
            default: {
              providerID: "openai",
              modelID: "gpt-5-codex",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "openai/gpt-5-codex",
        name: "GPT-5 Codex",
        provider: "openai",
      },
    ]);
    expect(result.defaults.modelId).toBe("openai/gpt-5-codex");
  });

  test("returns empty models when both provider.list and config.providers fail", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => {
          throw new Error("config providers also unavailable");
        },
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([]);
    expect(result.defaults).toEqual({});
  });
});

describe("opencode-client getAvailableSlashCommands", () => {
  test("normalizes, deduplicates, and sorts commands", async () => {
    const client = {
      command: {
        list: async () => ({
          data: [
            {
              name: "fix",
              description: "Fix issues",
              hints: ["fix lint", "fix tests"],
            },
            {
              name: " /build ",
              hints: ["Build project"],
            },
            {
              name: "agent-helper",
              description: "Agent helper command",
              subtask: true,
              hints: [],
            },
            {
              name: "/fix",
              description: "Duplicate should be ignored",
            },
            {
              name: " ",
              description: "Ignored empty command",
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client);

    expect(commands).toEqual([
      {
        name: "/agent-helper",
        description: "Agent helper command",
      },
      {
        name: "/build",
        description: "Build project",
        hints: ["Build project"],
      },
      {
        name: "/fix",
        description: "Fix issues",
        hints: ["fix lint", "fix tests"],
      },
    ]);
  });

  test("passes directory when provided (two calls: global + directory)", async () => {
    const capturedCalls: unknown[] = [];

    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          capturedCalls.push(request);
          return { data: [] };
        },
      },
    } as unknown as OpencodeClient;

    await getAvailableSlashCommands(client, "/workspace");

    // Should make two calls: one without directory, one with
    expect(capturedCalls).toEqual([undefined, { directory: "/workspace" }]);
  });

  test("keeps successful command source when one source fails", async () => {
    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          if (request?.directory) {
            throw new Error("directory unavailable");
          }

          return {
            data: [
              {
                name: "global-only",
                description: "Global command",
                hints: [],
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client, "/workspace");

    expect(commands).toEqual([
      {
        name: "/global-only",
        description: "Global command",
      },
    ]);
  });

  test("prefers directory metadata and backfills missing fields from global", async () => {
    const client = {
      command: {
        list: async (request?: { directory?: string }) => {
          if (request?.directory) {
            return {
              data: [
                {
                  name: "fix",
                  description: "Project fix",
                  hints: ["project hint"],
                },
                {
                  name: "build",
                  hints: [],
                },
              ],
            };
          }

          return {
            data: [
              {
                name: "fix",
                description: "Global fix",
                hints: ["global hint"],
              },
              {
                name: "build",
                description: "Global build",
                hints: ["build hint"],
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client, "/workspace");

    expect(commands).toEqual([
      {
        name: "/build",
        description: "Global build",
        hints: ["build hint"],
      },
      {
        name: "/fix",
        description: "Project fix",
        hints: ["project hint"],
      },
    ]);
  });

  test("returns empty array when command list fails", async () => {
    const client = {
      command: {
        list: async () => {
          throw new Error("not available");
        },
      },
    } as unknown as OpencodeClient;

    const commands = await getAvailableSlashCommands(client);

    expect(commands).toEqual([]);
  });
});

describe("opencode-client getSessionMessages", () => {
  test("serializes non-string tool output and error values", async () => {
    const createdMs = 1739232000000;
    const outputPayload = {
      todos: [{ content: "Handle edge case", status: "cancelled" }],
    };
    const errorPayload = {
      reason: "tool failed",
      retryable: false,
    };

    const client = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "msg-1",
                role: "assistant",
                time: {
                  created: createdMs,
                },
              },
              parts: [
                {
                  type: "tool",
                  tool: "TodoWrite",
                  state: {
                    status: "completed",
                    input: {
                      todos: [{ content: "Task", status: "pending" }],
                    },
                    output: outputPayload,
                    error: errorPayload,
                  },
                },
              ],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("msg-1");

    const part = messages[0]?.parts[0];
    expect(part?.type).toBe("tool-invocation");
    expect(part?.toolOutput).toBe(JSON.stringify(outputPayload, null, 2));
    expect(part?.toolError).toBe(JSON.stringify(errorPayload, null, 2));
  });

  test("throws when a strict refresh cannot fetch messages", async () => {
    const client = {
      session: {
        messages: async () => {
          throw new Error("offline");
        },
      },
    } as unknown as OpencodeClient;

    expect(
      getSessionMessages(client, "session-1", { throwOnError: true }),
    ).rejects.toThrow("offline");
  });

  test("treats resolved SDK error responses as failures for strict callers", async () => {
    const messages = mock(
      async (_input: unknown, _options?: { throwOnError?: boolean }) => ({
        data: undefined,
        error: { message: "bridge offline" },
      }),
    );
    const client = {
      session: { messages },
    } as unknown as OpencodeClient;

    expect(await getSessionMessages(client, "session-1")).toEqual([]);
    await expect(
      getSessionMessages(client, "session-1", { throwOnError: true }),
    ).rejects.toThrow("bridge offline");
    expect(messages.mock.calls[1]?.[1]).toEqual({ throwOnError: true });
  });
});

describe("opencode-client getSessionStatus", () => {
  test("selects one session from the v2 status map", async () => {
    const client = {
      session: {
        status: async () => ({
          data: {
            "session-1": { type: "busy" },
            "session-2": { type: "idle" },
            "session-3": { type: "retry" },
          },
        }),
      },
    } as unknown as OpencodeClient;

    expect(await getSessionStatus(client, "session-1")).toBe("busy");
    expect(await getSessionStatus(client, "session-2")).toBe("idle");
    expect(await getSessionStatus(client, "session-3")).toBe("retry");
    expect(await getSessionStatus(client, "missing")).toBeNull();
  });

  test("surfaces resolved and thrown status failures only in strict mode", async () => {
    const resolvedFailure = {
      session: {
        status: async () => ({
          data: undefined,
          error: { message: "status unavailable" },
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getSessionStatus(resolvedFailure, "session-1")).toBeNull();
    await expect(
      getSessionStatus(resolvedFailure, "session-1", { throwOnError: true }),
    ).rejects.toThrow("status unavailable");

    const thrownFailure = {
      session: {
        status: async () => {
          throw new Error("connection lost");
        },
      },
    } as unknown as OpencodeClient;
    expect(await getSessionStatus(thrownFailure, "session-1")).toBeNull();
    await expect(
      getSessionStatus(thrownFailure, "session-1", { throwOnError: true }),
    ).rejects.toThrow("connection lost");
  });
});

describe("opencode-client sendPrompt", () => {
  test("maps build/plan mode to SDK agent", async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    const client = {
      session: {
        promptAsync: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return { data: null };
        },
      },
    } as unknown as OpencodeClient;

    const result = await sendPrompt(client, "session-1", "Hello", {
      model: "anthropic/claude-sonnet-4",
      variant: "high",
      mode: "plan",
    });

    expect(result.success).toBe(true);
    expect(capturedRequest).toEqual(
      expect.objectContaining({
        sessionID: "session-1",
        agent: "plan",
        variant: "high",
      }),
    );
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
});

describe("opencode-client streaming part normalization", () => {
  test("normalizes text parts with source identity for incremental updates", () => {
    const part = normalizeOpenCodePart({
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: "Streaming text",
    });

    expect(part).toEqual({
      type: "text",
      content: "Streaming text",
      sourcePartId: "part-1",
      sourceMessageId: "message-1",
    });
  });

  test("normalizes reasoning parts into thinking parts", () => {
    const part = normalizeOpenCodePart({
      id: "part-r",
      messageID: "message-1",
      type: "reasoning",
      text: "Let me think",
    });

    expect(part).toEqual({
      type: "thinking",
      content: "Let me think",
      sourcePartId: "part-r",
      sourceMessageId: "message-1",
    });
  });

  test("drops reasoning parts with empty text", () => {
    expect(
      normalizeOpenCodePart({ id: "part-r", type: "reasoning", text: "" }),
    ).toBeNull();
  });

  test("normalizes tool parts with mapped state and diff metadata", () => {
    const part = normalizeOpenCodePart({
      id: "part-t",
      messageID: "message-1",
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        title: "Edit file.ts",
        input: {
          filePath: "file.ts",
          oldString: "a",
          newString: "a\nb",
        },
        output: "done",
      },
    });

    expect(part?.type).toBe("tool-invocation");
    expect(part?.toolName).toBe("edit");
    expect(part?.toolState).toBe("success");
    expect(part?.toolTitle).toBe("Edit file.ts");
    expect(part?.toolOutput).toBe("done");
    expect(part?.sourcePartId).toBe("part-t");
    expect(part?.sourceMessageId).toBe("message-1");
    expect(part?.toolDiff).toMatchObject({
      filePath: "file.ts",
      before: "a",
      after: "a\nb",
      additions: 2,
      deletions: 1,
    });
  });

  test("normalizes Task tools into shared subagent parts", () => {
    const part = normalizeOpenCodePart({
      id: "part-task",
      messageID: "message-1",
      type: "tool",
      tool: "Task",
      state: {
        status: "running",
        title: "Review import scheduling",
        input: {
          description: "Review import scheduling",
          prompt: "Inspect the scheduling implementation",
          subagent_type: "general",
        },
        metadata: {
          parentSessionId: "session-parent",
          sessionId: "session-child",
        },
      },
    });

    expect(part).toMatchObject({
      type: "subagent",
      content: "Review import scheduling",
      sourcePartId: "part-task",
      sourceMessageId: "message-1",
      toolState: "pending",
      subagentId: "session-child",
      subagentName: "Review import scheduling",
      subagentRole: "general",
      subagentPrompt: "Inspect the scheduling implementation",
      subagentActions: [],
      subagentActionCount: 0,
    });
  });

  test("uses the Task output envelope as a child id and background state fallback", () => {
    const part = normalizeOpenCodePart({
      id: "part-task",
      messageID: "message-1",
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { description: "Background review" },
        output: '<task id="session-background" state="running">\n<task_result>Working</task_result>\n</task>',
      },
    });

    expect(part).toMatchObject({
      type: "subagent",
      subagentId: "session-background",
      toolState: "pending",
    });
  });

  test("supports agent aliases, alternate metadata keys, and Task display fallbacks", () => {
    const sessionIdPart = normalizeOpenCodePart({
      type: "tool",
      tool: "agent",
      state: {
        status: "pending",
        title: "Fallback title",
        input: { agent: "explore", prompt: "Inspect it" },
        metadata: { sessionID: "session-uppercase" },
      },
    });
    expect(sessionIdPart).toMatchObject({
      type: "subagent",
      content: "Fallback title",
      subagentId: "session-uppercase",
      subagentRole: "explore",
      subagentPrompt: "Inspect it",
    });

    const jobIdPart = normalizeOpenCodePart({
      type: "tool",
      tool: "Task",
      metadata: { jobId: "job-child" },
      state: { status: "running", input: {} },
    });
    expect(jobIdPart).toMatchObject({
      type: "subagent",
      content: "Task",
      subagentId: "job-child",
    });
  });

  test("uses completed and error Task envelopes as authoritative terminal states", () => {
    for (const [envelopeState, expectedState] of [
      ["completed", "success"],
      ["error", "failure"],
    ] as const) {
      const part = normalizeOpenCodePart({
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          input: { description: envelopeState },
          output: `<task id="${envelopeState}-child" state="${envelopeState}">result</task>`,
        },
      });
      expect(part).toMatchObject({
        type: "subagent",
        subagentId: `${envelopeState}-child`,
        toolState: expectedState,
      });
    }
  });

  test("parses edit counts from metadata, unified diffs, output diffs, and one-sided content", () => {
    const cases = [
      {
        part: {
          type: "tool", tool: "write", state: {
            status: "completed",
            input: { file_path: "a.ts", old_string: "old", new_string: "new" },
            metadata: { additions: 7, deletions: 3 },
          },
        },
        expected: { filePath: "a.ts", additions: 7, deletions: 3, before: "old", after: "new" },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: { path: "b.ts" },
            metadata: { diff: "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more" },
          },
        },
        expected: { filePath: "b.ts", additions: 2, deletions: 1 },
      },
      {
        part: {
          type: "tool", tool: "patch", state: {
            status: "completed", input: { file: "c.ts" },
            output: "@@ -1 +1 @@\n-old\n+new",
          },
        },
        expected: { filePath: "c.ts", additions: 1, deletions: 1 },
      },
      {
        part: {
          type: "tool", tool: "write", state: {
            status: "completed", input: { filePath: "new.ts", content: "one\ntwo" },
          },
        },
        expected: { filePath: "new.ts", additions: 2, deletions: 0 },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: { filePath: "old.ts", oldString: "one\ntwo" },
          },
        },
        expected: { filePath: "old.ts", additions: 0, deletions: 2 },
      },
      {
        part: {
          type: "tool", tool: "edit", state: {
            status: "completed", input: {},
            metadata: { filediff: { file: "meta.ts", before: "a", after: "b\nc" } },
          },
        },
        expected: { filePath: "meta.ts", additions: 2, deletions: 1, before: "a", after: "b\nc" },
      },
    ];

    for (const { part, expected } of cases) {
      expect(normalizeOpenCodePart(part)?.toolDiff).toMatchObject(expected);
    }
  });

  test("maps tool error status to failure state and stringifies error payloads", () => {
    const part = normalizeOpenCodePart({
      id: "part-t",
      type: "tool",
      tool: "bash",
      state: {
        status: "error",
        error: { message: "boom" },
      },
    });

    expect(part?.toolState).toBe("failure");
    expect(part?.toolError).toBe(JSON.stringify({ message: "boom" }, null, 2));
  });

  test("normalizes file parts using filename then url", () => {
    const part = normalizeOpenCodePart({
      id: "part-f",
      messageID: "message-1",
      type: "file",
      filename: "photo.png",
      url: "file:///tmp/photo.png",
    });

    expect(part).toEqual({
      type: "file",
      content: "photo.png",
      sourcePartId: "part-f",
      sourceMessageId: "message-1",
      fileUrl: "file:///tmp/photo.png",
    });
  });

  test("returns null for unrecognized or non-object parts", () => {
    expect(normalizeOpenCodePart(null)).toBeNull();
    expect(normalizeOpenCodePart("nope")).toBeNull();
    expect(normalizeOpenCodePart({ type: "step-start" })).toBeNull();
  });
});

describe("opencode-client normalizeOpenCodeMessage", () => {
  test("aggregates text content and parts from an SDK message", () => {
    const message = normalizeOpenCodeMessage({
      info: { id: "message-1", role: "assistant", time: { created: 1739232000000 } },
      parts: [
        { id: "p1", messageID: "message-1", type: "text", text: "Hello " },
        { id: "p2", messageID: "message-1", type: "reasoning", text: "thinking" },
        { id: "p3", messageID: "message-1", type: "text", text: "world" },
        { id: "p4", type: "step-start" },
      ],
    });

    expect(message).toEqual({
      id: "message-1",
      role: "assistant",
      content: "Hello world",
      parts: [
        { type: "text", content: "Hello ", sourcePartId: "p1", sourceMessageId: "message-1" },
        { type: "thinking", content: "thinking", sourcePartId: "p2", sourceMessageId: "message-1" },
        { type: "text", content: "world", sourcePartId: "p3", sourceMessageId: "message-1" },
      ],
      createdAt: new Date(1739232000000).toISOString(),
    });
  });

  test("retains only a safe assistant-error marker", () => {
    const message = normalizeOpenCodeMessage({
      info: {
        id: "failed-message",
        role: "assistant",
        error: { message: "secret failure detail", token: "sensitive" },
      },
      parts: [],
    });

    expect(message?.hasError).toBe(true);
    expect(message).not.toHaveProperty("error");
    expect(JSON.stringify(message)).not.toContain("secret failure detail");
  });

  test("returns null for non-object input", () => {
    expect(normalizeOpenCodeMessage(null)).toBeNull();
    expect(normalizeOpenCodeMessage(42)).toBeNull();
  });
});

describe("OpenCode subagent transcript hydration", () => {
  test("loads child messages and exposes their tool calls as agent actions", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "task",
                      state: {
                        status: "running",
                        input: {
                          description: "Inspect imports",
                          prompt: "Review imports",
                          subagent_type: "general",
                        },
                        metadata: { sessionId: "session-child" },
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  info: { id: "child-message", role: "assistant", time: { created: 2 } },
                  parts: [
                    {
                      id: "child-tool",
                      messageID: "child-message",
                      type: "tool",
                      tool: "bash",
                      state: {
                        status: "completed",
                        title: "Read imports",
                        input: { command: "rg import src" },
                        output: "src/index.ts",
                        metadata: {},
                      },
                    },
                    {
                      id: "child-text",
                      messageID: "child-message",
                      type: "text",
                      text: "Review complete",
                    },
                  ],
                },
              ],
        })),
        children: mock(async () => ({ data: [] })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    const task = messages[0]?.parts[0];

    expect(task).toMatchObject({
      type: "subagent",
      subagentId: "session-child",
      subagentActionCount: 1,
      subagentActions: [
        {
          type: "tool-invocation",
          toolName: "bash",
          toolState: "success",
          toolArgs: { command: "rg import src" },
          toolOutput: "src/index.ts",
        },
        { type: "text", content: "Review complete" },
      ],
    });
    expect(hasOpenCodeSubagentSession(messages, "session-child")).toBe(true);
  });

  test("settles a completed background child from the session status snapshot", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "task",
                      state: {
                        status: "completed",
                        input: { description: "Background review" },
                        output: '<task id="background-child" state="running">Working</task>',
                      },
                    },
                  ],
                },
              ]
            : [
                {
                  info: { id: "child-message", role: "assistant", time: { created: 2 } },
                  parts: [
                    {
                      id: "child-text",
                      messageID: "child-message",
                      type: "text",
                      text: "Finished in the background",
                    },
                  ],
                },
              ],
        })),
        status: mock(async () => ({
          data: { "background-child": { type: "idle" } },
        })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "subagent",
      subagentId: "background-child",
      toolState: "success",
      subagentActions: [
        { type: "text", content: "Finished in the background" },
      ],
    });
  });

  test("discovers legacy Task children through session.children", async () => {
    const client = {
      session: {
        messages: mock(async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "session-parent"
            ? [
                {
                  info: { id: "parent-message", role: "assistant", time: { created: 1 } },
                  parts: [
                    {
                      id: "task-part",
                      messageID: "parent-message",
                      type: "tool",
                      tool: "Task",
                      state: {
                        status: "running",
                        input: { description: "Review database", subagent_type: "explore" },
                      },
                    },
                  ],
                },
              ]
            : [],
        })),
        children: mock(async () => ({
          data: [
            {
              id: "legacy-child",
              title: "Review database (@explore subagent)",
              agent: "explore",
            },
          ],
        })),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "session-parent");
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "subagent",
      subagentId: "legacy-child",
      subagentRole: "explore",
    });
  });

  test("merges live child state into nested agent rows", () => {
    const messages: OpenCodeMessage[] = [
      {
        id: "parent-message",
        role: "assistant",
        content: "",
        createdAt: "2026-07-22T12:00:00.000Z",
        parts: [
          {
            type: "subagent",
            content: "Outer",
            subagentId: "outer-child",
            subagentActions: [
              {
                type: "subagent",
                content: "Nested",
                subagentId: "nested-child",
                subagentActions: [],
              },
            ],
          },
        ],
      },
    ];
    const childMessages: OpenCodeMessage[] = [
      {
        id: "child-message",
        role: "assistant",
        content: "Done",
        createdAt: "2026-07-22T12:00:01.000Z",
        parts: [{ type: "text", content: "Done" }],
      },
    ];

    const merged = mergeOpenCodeSubagentTranscript(
      messages,
      "nested-child",
      childMessages,
      "success",
    );
    const outer = merged[0]?.parts[0];
    expect(outer?.type).toBe("subagent");
    expect(outer?.subagentActions?.[0]).toMatchObject({
      type: "subagent",
      toolState: "success",
      subagentActions: [{ type: "text", content: "Done" }],
    });
  });

  test("detects nested sessions and leaves non-matching transcripts unchanged", () => {
    const messages: OpenCodeMessage[] = [{
      id: "parent", role: "assistant", content: "", createdAt: "now",
      parts: [{
        type: "subagent", content: "outer", subagentId: "outer",
        subagentActions: [{ type: "subagent", content: "inner", subagentId: "inner" }],
      }],
    }];

    expect(hasOpenCodeSubagentSession(messages, "inner")).toBe(true);
    expect(hasOpenCodeSubagentSession(messages, "missing")).toBe(false);
    expect(mergeOpenCodeSubagentTranscript(messages, "missing", [], "success")).toBe(messages);
  });

  test("updates every matching row, ignores user actions, counts nested tools, and preserves terminal precedence", () => {
    const messages: OpenCodeMessage[] = [{
      id: "parent", role: "assistant", content: "", createdAt: "now",
      parts: [
        { type: "subagent", content: "first", subagentId: "child", toolState: "success" },
        { type: "subagent", content: "second", subagentId: "child", toolState: "failure" },
      ],
    }];
    const childMessages: OpenCodeMessage[] = [
      {
        id: "user", role: "user", content: "hidden", createdAt: "now",
        parts: [{ type: "tool-invocation", content: "user-tool" }],
      },
      {
        id: "assistant", role: "assistant", content: "", createdAt: "now",
        parts: [
          { type: "tool-invocation", content: "top" },
          {
            type: "subagent", content: "nested", subagentActions: [
              { type: "tool-invocation", content: "nested-tool" },
            ],
          },
        ],
      },
    ];

    const pending = mergeOpenCodeSubagentTranscript(messages, "child", childMessages, "pending");
    expect(pending[0]?.parts[0]).toMatchObject({
      toolState: "success",
      subagentActionCount: 2,
      subagentActions: [{ type: "tool-invocation", content: "top" }, { type: "subagent" }],
    });
    expect(pending[0]?.parts[1]).toMatchObject({ toolState: "failure", subagentActionCount: 2 });

    const failed = mergeOpenCodeSubagentTranscript(messages, "child", [], "failure");
    expect(failed[0]?.parts[0]?.toolState).toBe("failure");
    expect(failed[0]?.parts[1]?.toolState).toBe("failure");
  });

  test("fails the whole snapshot when a child transcript cannot be read", async () => {
    const messages = mock(async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "child") throw new Error("child offline");
      return {
        data: [{
          info: { id: "parent", role: "assistant" },
          parts: [{
            type: "tool", tool: "Task",
            state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
          }],
        }],
      };
    });
    const client = { session: { messages } } as unknown as OpencodeClient;

    expect(await getSessionMessages(client, "parent")).toEqual([]);
    await expect(getSessionMessages(client, "parent", { throwOnError: true })).rejects.toThrow("child offline");
  });

  test("continues without a status snapshot in non-strict mode and propagates it in strict mode", async () => {
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: [{
                  type: "tool", tool: "Task",
                  state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
                }],
              }]
            : [{ info: { id: "child", role: "assistant" }, parts: [{ type: "text", text: "done" }] }],
        }),
        status: async () => { throw new Error("status offline"); },
      },
    } as unknown as OpencodeClient;

    expect((await getSessionMessages(client, "parent"))[0]?.parts[0]).toMatchObject({
      subagentActions: [{ type: "text", content: "done" }],
    });
    await expect(getSessionMessages(client, "parent", { throwOnError: true })).rejects.toThrow("status offline");
  });

  test("handles resolved status errors and malformed status payloads", async () => {
    const messages = async ({ sessionID }: { sessionID: string }) => ({
      data: sessionID === "parent"
        ? [{
            info: { id: "parent", role: "assistant" },
            parts: [{
              type: "tool", tool: "Task",
              state: { status: "running", input: { description: "Child" }, metadata: { sessionId: "child" } },
            }],
          }]
        : [],
    });
    const resolvedFailure = {
      session: {
        messages,
        status: async () => ({ data: undefined, error: { message: "no statuses" } }),
      },
    } as unknown as OpencodeClient;
    expect(await getSessionMessages(resolvedFailure, "parent")).toHaveLength(1);
    await expect(getSessionMessages(resolvedFailure, "parent", { throwOnError: true })).rejects.toThrow("no statuses");

    const malformed = {
      session: { messages, status: async () => ({ data: [] }) },
    } as unknown as OpencodeClient;
    expect(await getSessionMessages(malformed, "parent")).toHaveLength(1);
  });

  test("handles failed and malformed child discovery responses", async () => {
    const parentData = [{
      info: { id: "parent", role: "assistant" },
      parts: [{
        type: "tool", tool: "Task",
        state: { status: "running", input: { description: "Legacy" } },
      }],
    }];
    const failed = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => { throw new Error("children offline"); },
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(failed, "parent"))[0]?.parts[0]?.subagentId).toBeUndefined();
    await expect(getSessionMessages(failed, "parent", { throwOnError: true })).rejects.toThrow("children offline");

    const malformed = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => ({ data: { id: "not-an-array" } }),
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(malformed, "parent"))[0]?.parts[0]?.subagentId).toBeUndefined();
  });

  test("assigns duplicate legacy titles to distinct children", async () => {
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: ["one", "two"].map((id) => ({
                  id, type: "tool", tool: "Task",
                  state: { status: "running", input: { description: "Duplicate" } },
                })),
              }]
            : [],
        }),
        children: async () => ({ data: [
          { id: "child-one", title: "Duplicate" },
          { id: "child-two", title: "Duplicate" },
        ] }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "parent");
    expect(messages[0]?.parts.map((part) => part.subagentId)).toEqual(["child-one", "child-two"]);
  });

  test("hydrates grandchildren once and terminates recursive session cycles", async () => {
    const task = (id: string, child: string) => ({
      id, type: "tool", tool: "Task",
      state: { status: "running", input: { description: child }, metadata: { sessionId: child } },
    });
    const bySession: Record<string, unknown[]> = {
      parent: [{ info: { id: "p", role: "assistant" }, parts: [task("p-task", "child")] }],
      child: [{ info: { id: "c", role: "assistant" }, parts: [
        { type: "tool", tool: "bash", state: { status: "completed", input: {} } },
        task("c-task", "grandchild"),
      ] }],
      grandchild: [{ info: { id: "g", role: "assistant" }, parts: [
        task("g-task", "child"),
        { type: "text", text: "complete" },
      ] }],
    };
    const calls: string[] = [];
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          calls.push(sessionID);
          return { data: bySession[sessionID] };
        },
        status: async () => ({ data: { child: { type: "idle" }, grandchild: { type: "idle" } } }),
      },
    } as unknown as OpencodeClient;

    const messages = await getSessionMessages(client, "parent");
    expect(calls).toEqual(["parent", "child", "grandchild"]);
    expect(messages[0]?.parts[0]).toMatchObject({
      toolState: "success",
      subagentActions: [
        { type: "tool-invocation", toolName: "bash" },
        { type: "subagent", subagentId: "grandchild", toolState: "success", subagentActions: [
          { type: "subagent", subagentId: "child", subagentActions: [] },
          { type: "text", content: "complete" },
        ] },
      ],
    });
  });

  test("maps busy, retry, idle-empty, and assistant-error snapshots to terminal states", async () => {
    const ids = ["busy-child", "retry-child", "empty-child", "failed-child"];
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "parent"
            ? [{
                info: { id: "parent", role: "assistant" },
                parts: ids.map((id) => ({
                  type: "tool", tool: "Task",
                  state: { status: "running", input: { description: id }, metadata: { sessionId: id } },
                })),
              }]
            : sessionID === "failed-child"
              ? [{ info: { id: "failure", role: "assistant", error: { message: "failed" } }, parts: [] }]
              : [],
        }),
        status: async () => ({ data: {
          "busy-child": { type: "busy" },
          "retry-child": { type: "retry" },
          "empty-child": { type: "idle" },
          "failed-child": { type: "idle" },
        } }),
      },
    } as unknown as OpencodeClient;

    const states = (await getSessionMessages(client, "parent"))[0]?.parts.map((part) => part.toolState);
    expect(states).toEqual(["pending", "pending", "success", "failure"]);
  });
});

describe("opencode-client getOpenCodePartKey", () => {
  test("prefers the source part id", () => {
    expect(
      getOpenCodePartKey({ type: "text", content: "x", sourcePartId: "p1", sourceMessageId: "m1" }),
    ).toBe("p1");
  });

  test("falls back to a composite key from the source message id", () => {
    expect(
      getOpenCodePartKey({
        type: "tool-invocation",
        content: "edit",
        toolName: "edit",
        sourceMessageId: "m1",
      }),
    ).toBe("m1:tool-invocation:edit:edit");
  });

  test("returns null when the part has no source identity", () => {
    expect(getOpenCodePartKey({ type: "text", content: "x" })).toBeNull();
  });
});

describe("opencode-client buildOpenCodeMessageFromPart", () => {
  test("creates a new assistant message when none exists", () => {
    const message = buildOpenCodeMessageFromPart(undefined, "message-1", {
      type: "text",
      content: "Hello",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(message.id).toBe("message-1");
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Hello");
    expect(message.parts).toHaveLength(1);
  });

  test("replaces an existing part matched by source identity", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: "Hello world",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(updated.parts).toHaveLength(1);
    expect(updated.content).toBe("Hello world");
    // Preserves role/createdAt from the existing message.
    expect(updated.createdAt).toBe(existing.createdAt);
  });

  test("appends a delta to the matched part when the incoming content is empty", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hel",
      parts: [{ type: "text", content: "Hel", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(
      existing,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    expect(updated.content).toBe("Hello");
    expect(updated.parts).toHaveLength(1);
  });

  test("appends a new part when the source identity does not match", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: " again",
      sourcePartId: "p2",
      sourceMessageId: "message-1",
    });

    expect(updated.parts).toHaveLength(2);
    expect(updated.content).toBe("Hello again");
  });
});

describe("opencode-client formatOpenCodeError", () => {
  test("redacts sensitive values from raw error details", () => {
    const errorText = formatOpenCodeError({
      name: "APIError",
      data: {
        message: "Unauthorized",
        status: 401,
        requestID: "req_redact_1",
        authorization: "Bearer top-secret-token",
        apiKey: "sk-secret-key",
        nested: {
          refresh_token: "refresh-secret",
          safeField: "safe-value",
        },
      },
    });

    expect(errorText).toContain("Unauthorized");
    expect(errorText).toContain("Status: 401");
    expect(errorText).toContain("Request ID: req_redact_1");
    expect(errorText).toContain('"authorization": "[REDACTED]"');
    expect(errorText).toContain('"apiKey": "[REDACTED]"');
    expect(errorText).toContain('"refresh_token": "[REDACTED]"');
    expect(errorText).toContain('"safeField": "safe-value"');
    expect(errorText).not.toContain("top-secret-token");
    expect(errorText).not.toContain("sk-secret-key");
    expect(errorText).not.toContain("refresh-secret");
  });

  test("formats primitive, Error, and headline-only fallbacks", () => {
    expect(formatOpenCodeError("Bearer private-value")).toBe("Bearer [REDACTED]");
    expect(formatOpenCodeError(null)).toBe("An unknown error occurred");
    expect(formatOpenCodeError(new Error("offline"))).toContain("offline");
    expect(formatOpenCodeError({ data: { type: "TimeoutError" } })).toContain("TimeoutError");
    expect(formatOpenCodeError({
      data: { errorType: "RateLimit", message: "Try later" },
    })).toStartWith("RateLimit: Try later");
  });

  test("handles circular details and truncates oversized raw errors", () => {
    const circular: Record<string, unknown> = { message: "circular failure" };
    circular.self = circular;
    const circularText = formatOpenCodeError(circular);
    expect(circularText).toContain("circular failure");
    expect(circularText).toContain("[Circular]");

    const oversized = formatOpenCodeError({
      message: "large failure",
      detailBlob: "x".repeat(5_000),
    });
    expect(oversized).toContain("... (details truncated)");
    expect(oversized.length).toBeLessThan(4_200);
  });
});

describe("opencode-client session lifecycle", () => {
  test("creates sessions and normalizes numeric and string timestamps", async () => {
    const create = mock(async ({ title }: { title?: string }) => ({
      data: { id: `session-${title}`, title, time: { created: title === "numeric" ? 1_700_000_000_000 : "2026-01-02T03:04:05.000Z" } },
    }));
    const client = { session: { create } } as unknown as OpencodeClient;

    expect(await createSession(client, "numeric")).toEqual({
      id: "session-numeric",
      title: "numeric",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect((await createSession(client, "string")).createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("rejects an empty create response", async () => {
    const client = { session: { create: async () => ({ data: undefined }) } } as unknown as OpencodeClient;
    await expect(createSession(client)).rejects.toThrow("empty session response");
  });

  test("returns empty messages for empty responses and transport failures", async () => {
    const empty = { session: { messages: async () => ({ data: undefined }) } } as unknown as OpencodeClient;
    const failed = { session: { messages: async () => { throw new Error("offline"); } } } as unknown as OpencodeClient;

    expect(await getSessionMessages(empty, "session-1")).toEqual([]);
    expect(await getSessionMessages(failed, "session-1")).toEqual([]);
  });

  test("deletes and aborts sessions on success and reports failures", async () => {
    const deleteCall = mock(async () => ({}));
    const abortCall = mock(async () => ({}));
    const client = { session: { delete: deleteCall, abort: abortCall } } as unknown as OpencodeClient;

    expect(await deleteSession(client, "session-1")).toBe(true);
    expect(await abortSession(client, "session-1")).toBe(true);
    expect(deleteCall).toHaveBeenCalledWith({ sessionID: "session-1" });
    expect(abortCall).toHaveBeenCalledWith({ sessionID: "session-1" });

    const failed = {
      session: {
        delete: async () => { throw new Error("delete failed"); },
        abort: async () => { throw new Error("abort failed"); },
      },
    } as unknown as OpencodeClient;
    expect(await deleteSession(failed, "session-1")).toBe(false);
    expect(await abortSession(failed, "session-1")).toBe(false);
  });

  test("lists empty sessions and normalizes string and missing timestamps", async () => {
    const empty = { session: { list: async () => ({ data: undefined }) } } as unknown as OpencodeClient;
    expect(await listSessions(empty)).toEqual([]);

    const client = {
      session: {
        list: async () => ({ data: [
          { id: "string", title: "String", time: { created: "2026-02-03T04:05:06.000Z" } },
          { id: "missing", title: "Missing", time: {} },
        ] }),
      },
    } as unknown as OpencodeClient;
    const sessions = await listSessions(client);
    expect(sessions[0]?.createdAt).toBe("2026-02-03T04:05:06.000Z");
    expect(Number.isNaN(Date.parse(sessions[1]?.createdAt ?? ""))).toBe(false);
  });
});

describe("opencode-client events and pending requests", () => {
  test("subscribes through stream and directly iterable response shapes", async () => {
    const stream = (async function* () { yield { type: "session.updated" }; })();
    const wrapped = { event: { subscribe: async () => ({ stream }) } } as unknown as OpencodeClient;
    expect(await subscribeToEvents(wrapped)).toBe(stream);

    const direct = (async function* () { yield { type: "session.updated" }; })();
    const directClient = { event: { subscribe: async () => direct } } as unknown as OpencodeClient;
    expect(await subscribeToEvents(directClient)).toBe(direct);
  });

  test("returns null for invalid or failed event subscriptions", async () => {
    const invalid = { event: { subscribe: async () => ({}) } } as unknown as OpencodeClient;
    const failed = { event: { subscribe: async () => { throw new Error("stream failed"); } } } as unknown as OpencodeClient;
    expect(await subscribeToEvents(invalid)).toBeNull();
    expect(await subscribeToEvents(failed)).toBeNull();
  });

  test("lists pending questions and permissions, including empty and failed responses", async () => {
    const client = {
      question: { list: async () => ({ data: [{ id: "question-1", questions: [] }] }) },
      permission: { list: async () => ({ data: [{ id: "permission-1", permission: "edit" }] }) },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(client)).toHaveLength(1);
    expect(await getPendingPermissions(client)).toHaveLength(1);

    const empty = {
      question: { list: async () => ({ data: undefined }) },
      permission: { list: async () => ({ data: undefined }) },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(empty)).toEqual([]);
    expect(await getPendingPermissions(empty)).toEqual([]);

    const failed = {
      question: { list: async () => { throw new Error("question failed"); } },
      permission: { list: async () => { throw new Error("permission failed"); } },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(failed)).toEqual([]);
    expect(await getPendingPermissions(failed)).toEqual([]);
    await expect(
      getPendingQuestions(failed, { throwOnError: true }),
    ).rejects.toThrow("question failed");
    await expect(
      getPendingPermissions(failed, { throwOnError: true }),
    ).rejects.toThrow("permission failed");

    const resolvedFailure = {
      question: {
        list: async () => ({
          data: undefined,
          error: { message: "question endpoint unavailable" },
        }),
      },
      permission: {
        list: async () => ({
          data: undefined,
          error: { message: "permission endpoint unavailable" },
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getPendingQuestions(resolvedFailure)).toEqual([]);
    expect(await getPendingPermissions(resolvedFailure)).toEqual([]);
    await expect(
      getPendingQuestions(resolvedFailure, { throwOnError: true }),
    ).rejects.toThrow("question endpoint unavailable");
    await expect(
      getPendingPermissions(resolvedFailure, { throwOnError: true }),
    ).rejects.toThrow("permission endpoint unavailable");
  });

  test("replies to and rejects requests with the v2 SDK shape", async () => {
    const questionReply = mock(async () => ({}));
    const questionReject = mock(async () => ({}));
    const permissionReply = mock(async () => ({}));
    const client = {
      question: { reply: questionReply, reject: questionReject },
      permission: { reply: permissionReply },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(client, "question-1", [["Yes"]])).toBe(true);
    expect(await replyToPermission(client, "permission-1", "always", "remember")).toBe(true);
    expect(await rejectQuestion(client, "question-1")).toBe(true);
    expect(questionReply).toHaveBeenCalledWith({ requestID: "question-1", answers: [["Yes"]] });
    expect(permissionReply).toHaveBeenCalledWith({ requestID: "permission-1", reply: "always", message: "remember" });
    expect(questionReject).toHaveBeenCalledWith({ requestID: "question-1" });
  });

  test("returns false when replying to or rejecting requests fails", async () => {
    const failed = {
      question: {
        reply: async () => { throw new Error("reply failed"); },
        reject: async () => { throw new Error("reject failed"); },
      },
      permission: { reply: async () => { throw new Error("permission failed"); } },
    } as unknown as OpencodeClient;
    expect(await replyToQuestion(failed, "question-1", [])).toBe(false);
    expect(await replyToPermission(failed, "permission-1", "reject")).toBe(false);
    expect(await rejectQuestion(failed, "question-1")).toBe(false);
  });
});

describe("opencode-client model and attachment edge cases", () => {
  test("getModels returns only the normalized model list", async () => {
    const client = {
      provider: { list: async () => ({ data: { all: [{ id: "provider", models: { model: { id: "model", name: "Model" } } }] } }) },
      config: { providers: async () => ({ data: undefined }) },
    } as unknown as OpencodeClient;
    expect(await getModels(client)).toEqual([{ id: "provider/model", name: "Model", provider: "provider" }]);
  });

  test("maps image and file attachment MIME types and file URL fallback", async () => {
    const promptAsync = mock(async (_input: unknown) => ({}));
    const client = { session: { promptAsync } } as unknown as OpencodeClient;
    await sendPrompt(client, "session-1", "attachments", {
      attachments: [
        { type: "image", path: "/tmp/a.jpg", filename: "a.jpg" },
        { type: "image", path: "/tmp/b.gif", filename: "b.gif", dataUrl: "data:image/gif;base64,AA==" },
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
    const parts = (promptAsync.mock.calls[0]?.[0] as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts.slice(1).map((part) => part.mime)).toEqual([
      "image/jpeg", "image/gif", "image/webp", "text/typescript", "application/octet-stream",
      "text/plain", "application/json", "text/javascript", "text/javascript", "text/typescript",
      "text/markdown", "text/html", "text/css", "text/x-python", "text/x-rust",
    ]);
    expect(parts[1]?.url).toBe("file:///tmp/a.jpg");
    expect(parts[2]?.url).toBe("data:image/gif;base64,AA==");
  });
});
