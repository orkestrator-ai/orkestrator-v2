import { describe, expect, test } from "bun:test";
import {
  buildOpenCodeMessageFromPart,
  formatOpenCodeError,
  getAvailableSlashCommands,
  getModelsWithDefaults,
  getOpenCodePartKey,
  getSessionMessages,
  listSessions,
  normalizeOpenCodeMessage,
  normalizeOpenCodePart,
  sendPrompt,
  type OpencodeClient,
  type OpenCodeMessage,
} from "./opencode-client";

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

  test("returns null for non-object input", () => {
    expect(normalizeOpenCodeMessage(null)).toBeNull();
    expect(normalizeOpenCodeMessage(42)).toBeNull();
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
});
