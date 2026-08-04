import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildOpenCodeMessageFromPart,
  carryOverOpenCodeSubagentHydration,
  abortSession,
  compactOpenCodeSession,
  checkHealth,
  checkClientHealth,
  collectOpenCodeSubagentIds,
  createClient,
  createSession,
  deleteSession,
  forkOpenCodeSession,
  formatOpenCodeError,
  getAvailableSlashCommands,
  getModels,
  getModelsWithDefaults,
  getOpenCodePartKey,
  getOpenCodeRuntimeHealth,
  getPendingPermissions,
  getPendingQuestions,
  getSessionMessages,
  getSessionStatus,
  getStructuredOutput,
  hasOpenCodeSubagentSession,
  isOpenCodeMessageAbortedError,
  listSessions,
  lookupSessionStatus,
  mergeOpenCodeMessageInfo,
  mergeOpenCodeSubagentTranscript,
  normalizeOpenCodeMessage,
  normalizeOpenCodePart,
  rejectQuestion,
  replyToPermission,
  replyToQuestion,
  revertOpenCodeSession,
  sendPrompt,
  sendStructuredPrompt,
  shareOpenCodeSession,
  splitOpenCodeModelId,
  subscribeToEvents,
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

describe("opencode-client createClient", () => {
  test("returns false when the health endpoint rejects or reports a non-success status", async () => {
    globalThis.fetch = mock(
      async () => new Response("unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(checkHealth("http://127.0.0.1:7777")).resolves.toBe(false);

    globalThis.fetch = mock(async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expect(checkHealth("http://127.0.0.1:7777")).resolves.toBe(false);
  });

  test("rewrites loopback SDK requests through the gateway when enabled", async () => {
    const requests: string[] = [];
    const headers: Headers[] = [];
    setTestUrl("http://gateway.test/");
    window.orkestratorGateway = { enabled: true };
    globalThis.fetch = mock(async (input) => {
      const request = input as Request;
      requests.push(request.url);
      headers.push(request.headers);
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createClient(
      "http://127.0.0.1:7777",
      undefined,
      "opencode-secret",
    );
    await client.session.list();

    expect(requests).toEqual([
      `${window.location.origin}/__orkestrator/proxy/loopback/7777/session`,
    ]);
    expect(headers[0]?.get("authorization")).toBe(
      `Basic ${btoa("opencode:opencode-secret")}`,
    );
    expect(headers[0]?.get("x-orkestrator-opencode-token")).toBe("opencode-secret");
  });

  test("health-checks a cached client with the credential it was created with", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return new Response("ok");
    }) as unknown as typeof fetch;

    const client = createClient(
      "http://127.0.0.1:7777",
      undefined,
      "cached-secret",
    );

    await expect(checkClientHealth(client)).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:7777/global/health");
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Basic ${btoa("opencode:cached-secret")}`,
    );
    expect(requests[0]?.headers.get("x-orkestrator-opencode-token"))
      .toBe("cached-secret");
  });

  test("fails closed for a client not created by this wrapper", async () => {
    await expect(checkClientHealth({} as OpencodeClient)).resolves.toBe(false);
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
        // No `time.updated` reported, so it falls back to the creation time.
        updatedAt: new Date(createdMs).toISOString(),
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

  test("keeps distinct created and updated times and falls back from invalid timestamps", async () => {
    const createdMs = 1_739_232_000_000;
    const updated = "2026-04-05T06:07:08.000Z";
    const client = {
      session: {
        list: async () => ({
          data: [
            {
              id: "distinct",
              time: { created: createdMs, updated },
            },
            {
              id: "invalid-update",
              time: { created: "2026-01-02T03:04:05.000Z", updated: "not-a-date" },
            },
            {
              id: "invalid-created",
              time: { created: "not-a-date", updated: undefined },
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const sessions = await listSessions(client);

    expect(sessions[0]).toMatchObject({
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: updated,
    });
    expect(sessions[1]).toMatchObject({
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(Number.isNaN(Date.parse(sessions[2]?.createdAt ?? ""))).toBe(false);
    expect(sessions[2]?.updatedAt).toBe(sessions[2]?.createdAt);
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

  test("maps the legacy provider plus bare model default shape", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: [],
            default: {
              provider: "anthropic",
              model: "claude-sonnet-4",
              variant: "high",
            },
          },
        }),
      },
    } as unknown as OpencodeClient;

    await expect(getModelsWithDefaults(client)).resolves.toEqual({
      models: [],
      defaults: {
        modelId: "anthropic/claude-sonnet-4",
        variant: "high",
      },
    });
  });

  test.each([null, "not-a-catalog", 42, []])(
    "returns an empty result for malformed provider catalog data %#",
    async (data) => {
      const client = {
        provider: { list: async () => ({ data }) },
      } as unknown as OpencodeClient;

      await expect(getModelsWithDefaults(client)).resolves.toEqual({
        models: [],
        defaults: {},
      });
    },
  );

  test.each([
    {},
    { all: "not-a-provider-list" },
    { providers: "not-a-provider-map" },
    { all: [{ id: "broken", models: "not-a-model-list" }] },
  ])(
    "returns an empty result for malformed nested provider catalog data %#",
    async (data) => {
      const client = {
        provider: { list: async () => ({ data }) },
      } as unknown as OpencodeClient;

      await expect(getModelsWithDefaults(client)).resolves.toEqual({
        models: [],
        defaults: {},
      });
    },
  );

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

  test("maps capabilities.input.image onto models that report it", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "deepseek",
                models: {
                  "deepseek-v4-flash": {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek V4 Flash",
                    capabilities: {
                      input: { image: false },
                    },
                  },
                  "deepseek-v4": {
                    id: "deepseek-v4",
                    name: "DeepSeek V4",
                    capabilities: {
                      input: { image: true },
                    },
                  },
                },
              },
            ],
          },
        }),
      },
      config: {
        providers: async () => ({ data: { providers: {}, default: {} } }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        provider: "deepseek",
        supportsImageInput: false,
      },
      {
        id: "deepseek/deepseek-v4",
        name: "DeepSeek V4",
        provider: "deepseek",
        supportsImageInput: true,
      },
    ]);
  });

  test("leaves supportsImageInput undefined when the catalog omits the capability", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "deepseek",
                models: {
                  "deepseek-v4-flash": {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek V4 Flash",
                  },
                  "deepseek-v4": {
                    id: "deepseek-v4",
                    name: "DeepSeek V4",
                    capabilities: {
                      input: {},
                    },
                  },
                  "deepseek-v3": {
                    id: "deepseek-v3",
                    name: "DeepSeek V3",
                    capabilities: {
                      input: { image: "yes" },
                    },
                  },
                },
              },
            ],
          },
        }),
      },
      config: {
        providers: async () => ({ data: { providers: {}, default: {} } }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);
    const byId = new Map(result.models.map((model) => [model.id, model]));

    // Missing field, empty input map, and a non-boolean value all stay
    // `undefined` so the compose bar lets the attach through rather than
    // blocking on data the server did not actually report.
    for (const id of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4", "deepseek/deepseek-v3"]) {
      expect(byId.get(id)?.supportsImageInput).toBeUndefined();
    }
  });

  test("maps capabilities.input.image through the config.providers fallback", async () => {
    const client = {
      ...noProviderCatalog,
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "deepseek",
                models: {
                  "deepseek-v4": {
                    id: "deepseek-v4",
                    name: "DeepSeek V4",
                    capabilities: {
                      input: { image: true },
                    },
                  },
                },
              },
            ],
            default: {},
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "deepseek/deepseek-v4",
        name: "DeepSeek V4",
        provider: "deepseek",
        supportsImageInput: true,
      },
    ]);
  });

  test("keeps image capability alongside variants and cost metadata", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: {
                  "gpt-5": {
                    id: "gpt-5",
                    name: "GPT-5",
                    cost: { input: 1, output: 2 },
                    limit: { context: 400000 },
                    capabilities: { input: { image: true } },
                    variants: { low: {}, high: {}, retired: { disabled: true } },
                  },
                  "gpt-5-text": {
                    id: "gpt-5-text",
                    name: "GPT-5 Text",
                    capabilities: { input: { image: false } },
                    variants: { high: {} },
                  },
                },
              },
            ],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);
    const byId = new Map(result.models.map((model) => [model.id, model]));

    // Variant filtering runs after the capability read, so a variant-bearing
    // model must not lose supportsImageInput on the way through.
    expect(byId.get("openai/gpt-5")).toEqual({
      id: "openai/gpt-5",
      name: "GPT-5",
      provider: "openai",
      variants: ["low", "high"],
      inputCost: 1,
      outputCost: 2,
      contextWindow: 400000,
      supportsImageInput: true,
    });
    expect(byId.get("openai/gpt-5-text")?.supportsImageInput).toBe(false);
    expect(byId.get("openai/gpt-5-text")?.variants).toEqual(["high"]);
  });

  test("filters disabled variants and orders enabled variants consistently", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: {
                  "gpt-5": {
                    id: "gpt-5",
                    variants: {
                      zeta: {},
                      disabled: { disabled: true },
                      high: {},
                      alpha: {},
                      minimal: {},
                      beta: null,
                      legacy: "enabled",
                    },
                  },
                },
              },
            ],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "openai/gpt-5",
        name: "gpt-5",
        provider: "openai",
        variants: ["minimal", "high", "alpha", "zeta"],
      },
    ]);
  });

  test("maps cost aliases and skips malformed model entries", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: [
                  null,
                  "invalid",
                  {},
                  { id: 42, name: "Invalid id" },
                  { id: "nested", name: 42, cost: { input: 0, output: 2 } },
                  { id: "camel", inputCost: 3, outputCost: 4 },
                  { id: "snake", input_cost: 5, output_cost: 6 },
                  { id: "invalid-cost", inputCost: "7", output_cost: null },
                ],
              },
              null,
              "invalid",
              { models: [{ id: "missing-provider" }] },
            ],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([
      {
        id: "openai/nested",
        name: "nested",
        provider: "openai",
        inputCost: 0,
        outputCost: 2,
      },
      {
        id: "openai/camel",
        name: "camel",
        provider: "openai",
        inputCost: 3,
        outputCost: 4,
      },
      {
        id: "openai/snake",
        name: "snake",
        provider: "openai",
        inputCost: 5,
        outputCost: 6,
      },
      {
        id: "openai/invalid-cost",
        name: "invalid-cost",
        provider: "openai",
      },
    ]);
  });

  test("resolves the context window alias chain and rejects non-positive windows", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: [
                  { id: "limit", limit: { context: 200_000 } },
                  { id: "camel", contextWindow: 128_000 },
                  { id: "snake", context_window: 64_000 },
                  {
                    id: "prefers-limit",
                    limit: { context: 111 },
                    contextWindow: 222,
                    context_window: 333,
                  },
                  { id: "zero", limit: { context: 0 } },
                  { id: "negative", contextWindow: -1 },
                  { id: "infinite", contextWindow: Number.POSITIVE_INFINITY },
                  { id: "stringly", contextWindow: "200000" },
                  { id: "absent" },
                ],
              },
            ],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);
    const byId = new Map(result.models.map((model) => [model.id, model]));

    // Asserted field by field rather than with `toEqual` on the list: Bun treats
    // an explicit `contextWindow: undefined` as absent, so a whole-object
    // comparison gives no signal at all on the alias chain — and the presence of
    // this field is exactly what decides whether `summarizeOpenCodeUsage` can
    // report a percentage.
    expect(byId.get("openai/limit")?.contextWindow).toBe(200_000);
    expect(byId.get("openai/camel")?.contextWindow).toBe(128_000);
    expect(byId.get("openai/snake")?.contextWindow).toBe(64_000);
    expect(byId.get("openai/prefers-limit")?.contextWindow).toBe(111);

    // A non-positive or non-finite window is not a window: keeping it would
    // reach the usage summary and produce `0/0` -> `NaN%`. The model itself
    // still survives, it simply has no denominator.
    for (const id of ["zero", "negative", "infinite", "stringly", "absent"]) {
      expect(byId.has(`openai/${id}`)).toBe(true);
      expect(byId.get(`openai/${id}`)?.contextWindow).toBeUndefined();
    }
  });

  test("ignores malformed variant collections", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: {
                  "gpt-5": { id: "gpt-5", variants: "high" },
                },
              },
            ],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models[0]?.variants).toBeUndefined();
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

  test("returns empty array when command discovery throws before returning a promise", async () => {
    const client = {
      command: {
        list: () => {
          throw new Error("command namespace unavailable");
        },
      },
    } as unknown as OpencodeClient;

    await expect(getAvailableSlashCommands(client)).resolves.toEqual([]);
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

  test("falls back to string conversion when circular tool payloads cannot be serialized", async () => {
    const circularOutput: Record<string, unknown> = { result: "partial" };
    circularOutput.self = circularOutput;
    const circularError: Record<string, unknown> = { reason: "failed" };
    circularError.self = circularError;
    const client = {
      session: {
        messages: async () => ({
          data: [{
            info: { id: "msg-circular", role: "assistant", time: { created: 1 } },
            parts: [{
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                input: {},
                output: circularOutput,
                error: circularError,
              },
            }],
          }],
        }),
      },
    } as unknown as OpencodeClient;

    const part = (await getSessionMessages(
      client,
      "session-1",
      { includeSubagents: false },
    ))[0]?.parts[0];
    expect(part?.toolOutput).toBe("[object Object]");
    expect(part?.toolError).toBe("[object Object]");
  });

  /*
   * Stopping a parent turn aborts its subagents, and each aborted child message
   * carries an error. Deriving "failure" from that would paint the Agent row red
   * for a cancellation the user performed deliberately — and the state latches,
   * so nothing later can clear it.
   */
  test("does not mark an intentionally aborted subagent transcript as failed", async () => {
    const buildClient = (childError: unknown) => ({
      session: {
        messages: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "parent"
            ? {
                data: [{
                  info: { id: "msg-parent", role: "assistant", time: { created: 1 } },
                  parts: [{
                    type: "tool",
                    tool: "task",
                    state: {
                      status: "running",
                      input: { agent: "explore", prompt: "Look" },
                      metadata: { sessionID: "child" },
                    },
                  }],
                }],
              }
            : {
                data: [{
                  info: {
                    id: "msg-child",
                    role: "assistant",
                    time: { created: 2 },
                    error: childError,
                  },
                  parts: [{ type: "text", text: "partial work" }],
                }],
              },
        status: async () => ({ data: { child: { type: "idle" } } }),
      },
    } as unknown as OpencodeClient);

    const findSubagent = (messages: Awaited<ReturnType<typeof getSessionMessages>>) =>
      messages[0]?.parts.find((part) => part.type === "subagent");

    const aborted = await getSessionMessages(
      buildClient({ name: "MessageAbortedError", data: { message: "Aborted" } }),
      "parent",
    );
    expect(findSubagent(aborted)?.toolState).not.toBe("failure");

    // A genuine child failure must still surface as one.
    const failed = await getSessionMessages(
      buildClient({ name: "ProviderError", data: { message: "boom" } }),
      "parent",
    );
    expect(findSubagent(failed)?.toolState).toBe("failure");
  });

  test("wraps a non-Error strict message failure without exposing the thrown value", async () => {
    const client = {
      session: {
        messages: async () => {
          throw "transport failed";
        },
      },
    } as unknown as OpencodeClient;

    await expect(
      getSessionMessages(client, "session-1", { throwOnError: true }),
    ).rejects.toThrow("Failed to get OpenCode session messages");
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

  test("distinguishes a missing session from unavailable status transport", async () => {
    const missing = {
      session: {
        status: async () => ({ data: { "another-session": { type: "idle" } } }),
      },
    } as unknown as OpencodeClient;
    await expect(lookupSessionStatus(missing, "session-1")).resolves.toEqual({
      kind: "missing",
    });

    const resolvedFailure = {
      session: {
        status: async () => ({
          data: undefined,
          error: { message: "status unavailable" },
        }),
      },
    } as unknown as OpencodeClient;
    const unavailableResponse = await lookupSessionStatus(resolvedFailure, "session-1");
    expect(unavailableResponse.kind).toBe("unavailable");
    if (unavailableResponse.kind === "unavailable") {
      expect(unavailableResponse.error.message).toContain("status unavailable");
    }

    const emptyEnvelope = {
      session: {
        status: async () => ({ data: undefined, error: undefined }),
      },
    } as unknown as OpencodeClient;
    const unavailableEmpty = await lookupSessionStatus(emptyEnvelope, "session-1");
    expect(unavailableEmpty.kind).toBe("unavailable");
    if (unavailableEmpty.kind === "unavailable") {
      expect(unavailableEmpty.error.message).toBe("Failed to get OpenCode session status");
    }
    await expect(getSessionStatus(emptyEnvelope, "session-1", { throwOnError: true }))
      .rejects.toThrow("Failed to get OpenCode session status");

    const thrownFailure = {
      session: {
        status: async () => {
          throw new Error("connection lost");
        },
      },
    } as unknown as OpencodeClient;
    const unavailableTransport = await lookupSessionStatus(thrownFailure, "session-1");
    expect(unavailableTransport.kind).toBe("unavailable");
    if (unavailableTransport.kind === "unavailable") {
      expect(unavailableTransport.error.message).toBe("connection lost");
    }

    const malformed = {
      session: {
        status: async () => ({ data: { "session-1": { type: "paused" } } }),
      },
    } as unknown as OpencodeClient;
    const unavailableMalformed = await lookupSessionStatus(malformed, "session-1");
    expect(unavailableMalformed.kind).toBe("unavailable");
    if (unavailableMalformed.kind === "unavailable") {
      expect(unavailableMalformed.error.message).toContain("malformed");
    }
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
      // `OpenCodeChatTab` maps `"default"` to `undefined` before calling, so it
      // never reaches here; this pins that the client itself does not silently
      // reinterpret it, unlike the compaction path which must.
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

    await expect(sendPrompt(client, "session-1", "Hello", {
      requestId: "msg_collision",
    })).resolves.toEqual({ success: true, requestId: "msg_collision" });
    await expect(sendPrompt(client, "session-1", "Hello", {
      requestId: "collision",
    })).resolves.toEqual({ success: true, requestId: "collision" });

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
    const assistantTime = ((firstTime + 0x1000n) & 0xffffffffffffn)
      .toString(16)
      .padStart(12, "0");
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
    const {
      client,
      captured,
      historyCalls,
      setPromptGate,
    } = capturePromptAsync();
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
        data: Array.from(
          { length: OPEN_CODE_MESSAGE_HISTORY_LIMIT + 1 },
          () => null,
        ),
      },
    ],
  ] as const)("does not dispatch from unavailable or malformed history: %s", async (_label, response) => {
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
  });

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

    const result = await sendStructuredPrompt(
      client,
      "session-1",
      "Review this",
      schema,
      {
        requestId: "structured-1",
        retryCount: 3,
        model: "openrouter/anthropic/claude-sonnet-4",
        variant: "high",
        mode: "plan",
        attachments: [{
          type: "image",
          path: "/workspace/screenshot.png",
          filename: "screenshot.png",
          dataUrl: "data:image/png;base64,AAAA",
        }],
      },
    );

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
    await expect(
      getStructuredOutput(client, "session-1", result.requestId),
    ).resolves.toMatchObject({ ok: true, value: { ok: true } });
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
    expect(
      await getStructuredOutput(msgPrefixed, "session-1", msgPrefixedRequestId),
    ).toEqual({
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
    expect(
      await getStructuredOutput(retryPending, "session-1", "structured-retry"),
    ).toBeNull();

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
              parts: [{ type: "text", text: "{\"summary\":\"not trusted\"}" }],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await getStructuredOutput(plaintextOnly, "session-1", "structured-2"))
      .toMatchObject({
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
    expect(await getStructuredOutput(exhausted, "session-1", "structured-3"))
      .toMatchObject({
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

    await expect(getStructuredOutput(client, "session-1", "target-request"))
      .resolves.toMatchObject({ ok: true, value: { request: "target" } });
    await expect(getStructuredOutput(client, "session-1"))
      .resolves.toMatchObject({ ok: true, value: { request: "later" } });
  });

  test.each(["", "  "])(
    "rejects blank structured lookup IDs before reading transcript history (%#)",
    async (requestId) => {
      const messages = mock(async () => ({ data: [] }));
      const client = { session: { messages } } as unknown as OpencodeClient;

      await expect(
        getStructuredOutput(client, "session-1", requestId),
      ).rejects.toThrow(/request id|non-empty/i);
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
          data: [{
            info: {
              id: "assistant-invalid-time",
              role: "assistant",
              parentID: expectedOpenCodeMessageId("structured-invalid-time"),
              time: "completed yesterday",
              structured: { summary: "Must not be accepted" },
            },
            parts: [],
          }],
        }),
      },
    } as unknown as OpencodeClient;
    await expect(
      getStructuredOutput(
        malformedTiming,
        "session-1",
        "structured-invalid-time",
      ),
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

  test("removes OpenCode's surrounding bold markers from reasoning", () => {
    const part = normalizeOpenCodePart({
      id: "part-r-bold",
      messageID: "message-1",
      type: "reasoning",
      text: "**Planning next changes**",
    });

    expect(part).toEqual({
      type: "thinking",
      content: "Planning next changes",
      sourcePartId: "part-r-bold",
      sourceMessageId: "message-1",
    });
  });

  test("removes an opening bold marker while reasoning is still streaming", () => {
    const part = normalizeOpenCodePart({
      id: "part-r-streaming",
      type: "reasoning",
      text: "**Planning next",
      time: { start: 1 },
    });

    expect(part?.content).toBe("Planning next");
  });

  test("preserves an unmatched opening marker when reasoning is not streaming", () => {
    expect(
      normalizeOpenCodePart({
        type: "reasoning",
        text: "**Planning next",
        time: { start: 1, end: 2 },
      })?.content,
    ).toBe("**Planning next");
    expect(
      normalizeOpenCodePart({ type: "reasoning", text: "**Planning next" })
        ?.content,
    ).toBe("**Planning next");
  });

  test("preserves inline, trailing, and completed prefix bold Markdown", () => {
    for (const content of [
      "Use **care** when editing",
      "Planning ends with **care**",
      "**Planning** then inspect",
      "**Planning**\n- inspect files",
      "**Planning** then **care**",
      "Planning next**",
    ]) {
      expect(
        normalizeOpenCodePart({ type: "reasoning", text: content })?.content,
      ).toBe(content);
    }
  });

  test("preserves surrounding whitespace while removing an outer bold wrapper", () => {
    const part = normalizeOpenCodePart({
      type: "reasoning",
      text: " \n**Planning next changes** \n",
    });

    expect(part?.content).toBe(" \nPlanning next changes \n");
  });

  test("drops reasoning that is empty after marker normalization", () => {
    for (const content of ["****", "  **  ", " \n\t "]) {
      expect(normalizeOpenCodePart({ type: "reasoning", text: content })).toBeNull();
    }
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

  test("uses the URL when a file part has no filename", () => {
    const part = normalizeOpenCodePart({
      type: "file",
      url: "file:///tmp/attachment.txt",
    });

    expect(part).toEqual({
      type: "file",
      content: "file:///tmp/attachment.txt",
      sourcePartId: undefined,
      sourceMessageId: undefined,
      fileUrl: "file:///tmp/attachment.txt",
    });
  });

  test("normalizes an empty file part with safe fallbacks", () => {
    const part = normalizeOpenCodePart({ type: "file" });

    expect(part).toEqual({
      type: "file",
      content: "",
      sourcePartId: undefined,
      sourceMessageId: undefined,
      fileUrl: undefined,
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

  test("retains the error discriminator but no other error payload", () => {
    const aborted = normalizeOpenCodeMessage({
      info: {
        id: "aborted-message",
        role: "assistant",
        error: { name: "MessageAbortedError", data: { message: "secret detail" } },
      },
      parts: [],
    });

    expect(aborted?.hasError).toBe(true);
    expect(aborted?.errorName).toBe("MessageAbortedError");
    expect(JSON.stringify(aborted)).not.toContain("secret detail");

    // A non-record or unnamed error still marks the message, with no name to keep.
    const unnamed = normalizeOpenCodeMessage({
      info: { id: "unnamed", role: "assistant", error: { data: { message: "boom" } } },
      parts: [],
    });
    expect(unnamed?.hasError).toBe(true);
    expect(unnamed?.errorName).toBeUndefined();

    const primitive = normalizeOpenCodeMessage({
      info: { id: "primitive", role: "assistant", error: "boom" },
      parts: [],
    });
    expect(primitive?.hasError).toBe(true);
    expect(primitive?.errorName).toBeUndefined();
  });

  test("returns null for non-object input", () => {
    expect(normalizeOpenCodeMessage(null)).toBeNull();
    expect(normalizeOpenCodeMessage(42)).toBeNull();
  });
});

describe("OpenCode subagent transcript hydration", () => {
  test("collects nested ids once, deduplicates them, and caches by transcript identity", () => {
    const messages = [{
      id: "message-1",
      role: "assistant",
      content: "",
      parts: [{
        type: "subagent",
        subagentId: "child",
        content: "child",
        subagentActions: [
          {
            type: "subagent",
            subagentId: "grandchild",
            content: "grandchild",
            subagentActions: [],
          },
          {
            type: "subagent",
            subagentId: "child",
            content: "duplicate",
            subagentActions: [],
          },
        ],
      }],
      createdAt: "2026-07-28T00:00:00.000Z",
    }] as OpenCodeMessage[];

    const first = collectOpenCodeSubagentIds(messages);
    const second = collectOpenCodeSubagentIds(messages);

    expect([...first].sort()).toEqual(["child", "grandchild"]);
    expect(second).toBe(first);
  });

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

    const resolvedFailure = {
      session: {
        messages: async () => ({ data: parentData }),
        children: async () => ({
          data: undefined,
          error: { message: "children rejected" },
        }),
      },
    } as unknown as OpencodeClient;
    expect((await getSessionMessages(resolvedFailure, "parent"))[0]?.parts[0]?.subagentId)
      .toBeUndefined();
    await expect(
      getSessionMessages(resolvedFailure, "parent", { throwOnError: true }),
    ).rejects.toThrow("children rejected");

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

  test("includes the file url so two attachments of a message stay distinct", () => {
    // Deliberate asymmetry with getPartFingerprint, which excludes fileUrl:
    // this key identifies a part *within one message* for in-place streaming
    // replacement, where the client and server URL never disagree.
    const first = getOpenCodePartKey({
      type: "file",
      content: "logo.png",
      fileUrl: "file:///one/logo.png",
      sourceMessageId: "m1",
    });
    const second = getOpenCodePartKey({
      type: "file",
      content: "logo.png",
      fileUrl: "file:///two/logo.png",
      sourceMessageId: "m1",
    });

    expect(first).toBe("m1:file:file:///one/logo.png:logo.png");
    expect(first).not.toBe(second);
  });

  test("collapses two empty-content file parts of one message onto the same key", () => {
    // `.filter(Boolean)` drops empty segments, so parts that differ only in an
    // absent field share a key and overwrite each other during streaming.
    const key = getOpenCodePartKey({ type: "file", content: "", sourceMessageId: "m1" });

    expect(key).toBe("m1:file");
    expect(getOpenCodePartKey({ type: "file", content: "", sourceMessageId: "m1" })).toBe(key);
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

  test("preserves message-level metadata while streamed parts are rebuilt", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", content: "Hello", sourcePartId: "p1", sourceMessageId: "message-1" }],
      createdAt: new Date(0).toISOString(),
      modelId: "anthropic/claude-sonnet-4",
      hasError: true,
      turnId: "turn-1",
      providerUsage: {
        cost: 0.1,
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: "anthropic/claude-sonnet-4",
      },
    };

    const updated = buildOpenCodeMessageFromPart(existing, "message-1", {
      type: "text",
      content: "Hello world",
      sourcePartId: "p1",
      sourceMessageId: "message-1",
    });

    expect(updated.modelId).toBe(existing.modelId);
    expect(updated.hasError).toBe(true);
    expect(updated.turnId).toBe("turn-1");
    expect(updated.providerUsage).toEqual(existing.providerUsage);
  });

  test("seeds role and createdAt from a partial base carrying no parts", () => {
    // This is the shape OpenCodeChatTab supplies when a part streams in before
    // its `message.updated`: the echo's role/createdAt are known from the
    // pending optimistic bubble, but none of its parts are.
    const message = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-early",
      {
        type: "text",
        content: "Hello from the part",
        sourcePartId: "p1",
        sourceMessageId: "server-early",
      },
    );

    expect(message).toMatchObject({
      id: "server-early",
      role: "user",
      content: "Hello from the part",
      createdAt: "2026-04-15T10:00:01.000Z",
    });
    expect(message.parts).toHaveLength(1);
  });

  test("keeps a user role across a follow-up part of the same message", () => {
    const seeded = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-early",
      { type: "text", content: "Look", sourcePartId: "p1", sourceMessageId: "server-early" },
    );

    const withFile = buildOpenCodeMessageFromPart(seeded, "server-early", {
      type: "file",
      content: "a.png",
      fileUrl: "file:///workspace/a.png",
      sourcePartId: "p2",
      sourceMessageId: "server-early",
    });

    expect(withFile.role).toBe("user");
    expect(withFile.parts).toHaveLength(2);
    // Aggregate content is recomputed from text parts only.
    expect(withFile.content).toBe("Look");
  });

  test("yields empty content when the first part of a message is a file", () => {
    const message = buildOpenCodeMessageFromPart(
      { role: "user", createdAt: "2026-04-15T10:00:01.000Z" },
      "server-file-first",
      {
        type: "file",
        content: "a.png",
        fileUrl: "file:///workspace/a.png",
        sourcePartId: "p1",
        sourceMessageId: "server-file-first",
      },
    );

    expect(message.role).toBe("user");
    expect(message.content).toBe("");
    expect(message.parts).toHaveLength(1);
  });

  test("drops the delta when no existing part matches", () => {
    const message = buildOpenCodeMessageFromPart(
      undefined,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    // There is nothing to append to, so the empty part is stored as-is rather
    // than inventing a message body from a fragment.
    expect(message.content).toBe("");
    expect(message.parts).toHaveLength(1);
  });

  test("drops the delta when the matched part has a different type", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "",
      parts: [{
        type: "file",
        content: "a.png",
        sourcePartId: "p1",
        sourceMessageId: "message-1",
      }],
      createdAt: new Date(0).toISOString(),
    };

    const updated = buildOpenCodeMessageFromPart(
      existing,
      "message-1",
      { type: "text", content: "", sourcePartId: "p1", sourceMessageId: "message-1" },
      "lo",
    );

    expect(updated.parts).toHaveLength(1);
    expect(updated.parts[0]).toMatchObject({ type: "text", content: "" });
  });

  test("carries message-level metadata from the supplied base onto the new id", () => {
    // `existing` is spread wholesale, so a caller passing another message's
    // metadata would relabel this one. Pinned so the coupling is visible.
    const updated = buildOpenCodeMessageFromPart(
      {
        role: "assistant",
        createdAt: "2026-04-15T10:00:00.000Z",
        modelId: "anthropic/claude-sonnet-4",
        turnId: "turn-9",
      },
      "message-2",
      { type: "text", content: "Hi", sourcePartId: "p1", sourceMessageId: "message-2" },
    );

    expect(updated).toMatchObject({
      id: "message-2",
      modelId: "anthropic/claude-sonnet-4",
      turnId: "turn-9",
    });
  });
});

describe("opencode-client incremental message helpers", () => {
  test("merges message info without discarding existing parts", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "streamed",
      parts: [{ type: "text", content: "streamed" }],
      createdAt: "2026-04-15T00:00:00.000Z",
    };

    expect(mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      error: { name: "ProviderError" },
      tokens: { input: 4, output: 6 },
    })).toMatchObject({
      content: "streamed",
      parts: existing.parts,
      modelId: "openai/gpt-5.6-sol",
      hasError: true,
    });
    expect(mergeOpenCodeMessageInfo(
      { ...existing, hasError: true },
      { id: "message-1", role: "assistant" },
    )?.hasError).toBeUndefined();
    expect(mergeOpenCodeMessageInfo(existing, null)).toBeNull();
    expect(mergeOpenCodeMessageInfo(existing, {})).toBeNull();
  });

  test("carries the error discriminator in both directions", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "assistant",
      content: "streamed",
      parts: [{ type: "text", content: "streamed" }],
      createdAt: "2026-04-15T00:00:00.000Z",
    };

    expect(mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "assistant",
      error: { name: "MessageAbortedError" },
    })).toMatchObject({ hasError: true, errorName: "MessageAbortedError" });

    // `info` is the whole record, so a retried turn that no longer reports an
    // error must lose the stale discriminator along with the flag.
    const cleared = mergeOpenCodeMessageInfo(
      { ...existing, hasError: true, errorName: "MessageAbortedError" },
      { id: "message-1", role: "assistant" },
    );
    expect(cleared?.hasError).toBeUndefined();
    expect(cleared?.errorName).toBeUndefined();

    // A later, differently-named failure replaces the previous discriminator.
    const replaced = mergeOpenCodeMessageInfo(
      { ...existing, hasError: true, errorName: "MessageAbortedError" },
      { id: "message-1", role: "assistant", error: { name: "ProviderError" } },
    );
    expect(replaced?.errorName).toBe("ProviderError");
  });

  test("keeps the existing createdAt rather than adopting the incoming clock", () => {
    // Consequence worth pinning: when a part streamed in before its info frame
    // and seeded createdAt from the optimistic bubble, the later info frame
    // does not replace that client send time with the server's.
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "user",
      content: "Run the tests",
      parts: [{ type: "text", content: "Run the tests" }],
      createdAt: "2026-04-15T10:00:01.000Z",
    };

    const merged = mergeOpenCodeMessageInfo(existing, {
      id: "message-1",
      role: "user",
      time: { created: Date.parse("2026-04-15T10:00:09.000Z") },
    });

    expect(merged?.createdAt).toBe("2026-04-15T10:00:01.000Z");
  });

  test("adopts the authoritative role from a later info frame", () => {
    const existing: OpenCodeMessage = {
      id: "message-1",
      role: "user",
      content: "Run the tests",
      parts: [{ type: "text", content: "Run the tests" }],
      createdAt: "2026-04-15T10:00:01.000Z",
    };

    expect(
      mergeOpenCodeMessageInfo(existing, { id: "message-1", role: "assistant" })?.role,
    ).toBe("assistant");
  });

  test("preserves hydrated child actions and terminal state during a cheap refresh", () => {
    const previous: OpenCodeMessage[] = [{
      id: "parent",
      role: "assistant",
      content: "",
      createdAt: "2026-04-15T00:00:00.000Z",
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "success",
        subagentActionCount: 1,
        subagentActions: [{ type: "text", content: "done" }],
      }],
    }];
    const next: OpenCodeMessage[] = [{
      ...previous[0]!,
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "pending",
      }],
    }];

    expect(carryOverOpenCodeSubagentHydration(previous, next)[0]?.parts[0])
      .toMatchObject({
        toolState: "success",
        subagentActionCount: 1,
        subagentActions: [{ type: "text", content: "done" }],
      });
  });

  test("keeps an authoritative newly hydrated child instead of carrying stale actions", () => {
    const previous: OpenCodeMessage[] = [{
      id: "parent",
      role: "assistant",
      content: "",
      createdAt: "2026-04-15T00:00:00.000Z",
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "success",
        subagentActions: [{ type: "text", content: "old" }],
      }],
    }];
    const next: OpenCodeMessage[] = [{
      ...previous[0]!,
      parts: [{
        type: "subagent",
        content: "Worker",
        subagentId: "child",
        toolState: "failure",
        subagentActions: [{ type: "text", content: "new" }],
      }],
    }];

    expect(carryOverOpenCodeSubagentHydration(previous, next)).toBe(next);
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
        attempts: [
          "Bearer array-secret",
          { accessToken: "nested-array-secret" },
        ],
      },
    });

    expect(errorText).toContain("Unauthorized");
    expect(errorText).toContain("Status: 401");
    expect(errorText).toContain("Request ID: req_redact_1");
    expect(errorText).toContain('"authorization": "[REDACTED]"');
    expect(errorText).toContain('"apiKey": "[REDACTED]"');
    expect(errorText).toContain('"refresh_token": "[REDACTED]"');
    expect(errorText).toContain('"accessToken": "[REDACTED]"');
    expect(errorText).toContain("Bearer [REDACTED]");
    expect(errorText).toContain('"safeField": "safe-value"');
    expect(errorText).not.toContain("top-secret-token");
    expect(errorText).not.toContain("sk-secret-key");
    expect(errorText).not.toContain("refresh-secret");
    expect(errorText).not.toContain("array-secret");
    expect(errorText).not.toContain("nested-array-secret");
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

  test("keeps the headline when raw error serialization fails", () => {
    const unserializable: Record<string, unknown> = { message: "serialization failed" };
    Object.defineProperty(unserializable, "details", {
      enumerable: true,
      get() {
        throw new Error("getter must not escape");
      },
    });

    expect(formatOpenCodeError(unserializable)).toBe("serialization failed");
  });

  test("emits the code detail line and does not repeat an error type already in the summary", () => {
    const withCode = formatOpenCodeError({
      data: { message: "Quota exhausted", code: "insufficient_quota", status: 429 },
      name: "RateLimitError",
    });
    expect(withCode).toStartWith("RateLimitError: Quota exhausted");
    expect(withCode).toContain("Code: insufficient_quota");
    expect(withCode).toContain("Status: 429");

    // The type is already spelled out in the summary, so prefixing it again
    // would render "TimeoutError: TimeoutError: ...".
    const deduped = formatOpenCodeError({
      name: "TimeoutError",
      data: { message: "TimeoutError while contacting the provider" },
    });
    expect(deduped).toStartWith("TimeoutError while contacting the provider");
    expect(deduped).not.toContain("TimeoutError: TimeoutError");
  });
});

describe("opencode-client isOpenCodeMessageAbortedError", () => {
  test("recognizes only the SDK's intentional-abort discriminator", () => {
    expect(isOpenCodeMessageAbortedError({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })).toBe(true);
    expect(isOpenCodeMessageAbortedError({
      name: "UnknownError",
      data: { message: "MessageAbortedError" },
    })).toBe(false);
    expect(isOpenCodeMessageAbortedError("MessageAbortedError: Aborted")).toBe(false);
    expect(isOpenCodeMessageAbortedError(null)).toBe(false);
    expect(isOpenCodeMessageAbortedError(undefined)).toBe(false);
  });

  test("matches an Error instance carrying the discriminator on its prototype", () => {
    // The SDK's error interceptor wraps some failures into real Errors, so the
    // name is not always an own property of a plain object.
    class MessageAbortedError extends Error {
      override readonly name = "MessageAbortedError";
    }
    expect(isOpenCodeMessageAbortedError(new MessageAbortedError("Aborted"))).toBe(true);

    const tagged = new Error("Aborted");
    tagged.name = "MessageAbortedError";
    expect(isOpenCodeMessageAbortedError(tagged)).toBe(true);

    expect(isOpenCodeMessageAbortedError(new Error("MessageAbortedError"))).toBe(false);
  });

  test("does not match a nested or differently-cased discriminator", () => {
    // Only the top-level `name` is the SDK's NamedError discriminator; a nested
    // copy is a real failure whose payload happens to mention the abort.
    expect(isOpenCodeMessageAbortedError({
      name: "ProviderError",
      data: { name: "MessageAbortedError" },
    })).toBe(false);
    expect(isOpenCodeMessageAbortedError({ name: "messageabortederror" })).toBe(false);
    expect(isOpenCodeMessageAbortedError({ data: { message: "Aborted" } })).toBe(false);
    expect(isOpenCodeMessageAbortedError([])).toBe(false);
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
      updatedAt: new Date(1_700_000_000_000).toISOString(),
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
    expect(deleteCall).toHaveBeenCalledWith(
      { sessionID: "session-1" },
      { throwOnError: false },
    );
    expect(abortCall).toHaveBeenCalledWith(
      { sessionID: "session-1" },
      { throwOnError: false },
    );

    const failed = {
      session: {
        delete: async () => { throw new Error("delete failed"); },
        abort: async () => { throw new Error("abort failed"); },
      },
    } as unknown as OpencodeClient;
    expect(await deleteSession(failed, "session-1")).toBe(false);
    expect(await abortSession(failed, "session-1")).toBe(false);
  });

  /*
   * The SDK only throws on a non-2xx response or a transport failure when the
   * caller opts in with `throwOnError`; the default hands both back as
   * `response.error`. A `return true` that only rules out a thrown exception
   * therefore reports every real abort failure as a success.
   */
  test("reports a rejected delete or abort that resolves with an error payload", async () => {
    const errored = {
      session: {
        delete: async () => ({ error: { name: "NotFound", data: { message: "no such session" } } }),
        abort: async () => ({ error: { name: "ProviderError", data: { message: "boom" } } }),
      },
    } as unknown as OpencodeClient;

    expect(await deleteSession(errored, "session-1")).toBe(false);
    expect(await abortSession(errored, "session-1")).toBe(false);

    // A transport failure takes the same non-throwing path: `{ error }`, no data.
    const offline = {
      session: {
        delete: async () => ({ error: new TypeError("Failed to fetch") }),
        abort: async () => ({ error: new TypeError("Failed to fetch") }),
      },
    } as unknown as OpencodeClient;
    expect(await deleteSession(offline, "session-1")).toBe(false);
    expect(await abortSession(offline, "session-1")).toBe(false);
  });

  test("treats an absent response body as a successful delete or abort", async () => {
    // `responseStyle: "data"` resolves to undefined on 2xx-with-no-body.
    const bodyless = {
      session: {
        delete: async () => undefined,
        abort: async () => undefined,
      },
    } as unknown as OpencodeClient;

    expect(await deleteSession(bodyless, "session-1")).toBe(true);
    expect(await abortSession(bodyless, "session-1")).toBe(true);
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

    const primitiveFailure = {
      question: { list: async () => { throw "question offline"; } },
      permission: { list: async () => { throw 503; } },
    } as unknown as OpencodeClient;
    await expect(
      getPendingQuestions(primitiveFailure, { throwOnError: true }),
    ).rejects.toThrow("Failed to get pending OpenCode questions");
    await expect(
      getPendingPermissions(primitiveFailure, { throwOnError: true }),
    ).rejects.toThrow("Failed to get pending OpenCode permissions");
  });

  test("normalizes both session-id spellings and rejects malformed or missing ids", async () => {
    const client = {
      question: {
        list: async () => ({
          data: [
            { id: "question-sdk", sessionID: "session-sdk", questions: [] },
            { id: "question-legacy", sessionId: "session-legacy", questions: [] },
            {
              id: "question-fallback",
              sessionID: 42,
              sessionId: "session-valid-fallback",
              questions: [],
            },
            { id: "question-malformed", sessionID: { id: "nested" }, questions: [] },
            { id: "question-missing", questions: [] },
          ],
        }),
      },
      permission: {
        list: async () => ({
          data: [
            {
              id: "permission-sdk",
              sessionID: "session-sdk",
              permission: "edit",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-legacy",
              sessionId: "session-legacy",
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-fallback",
              sessionID: "",
              sessionId: "session-valid-fallback",
              permission: "bash",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-malformed",
              sessionId: false,
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
            {
              id: "permission-missing",
              permission: "read",
              patterns: [],
              metadata: {},
              always: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    expect((await getPendingQuestions(client)).map((request) => request.sessionId)).toEqual([
      "session-sdk",
      "session-legacy",
      "session-valid-fallback",
      "",
      "",
    ]);
    expect((await getPendingPermissions(client)).map((request) => request.sessionId)).toEqual([
      "session-sdk",
      "session-legacy",
      "session-valid-fallback",
      "",
      "",
    ]);
  });

  test("replies to and rejects requests with the v2 SDK shape", async () => {
    const questionReply = mock(async () => ({}));
    const questionReject = mock(async () => ({}));
    const permissionReply = mock(async () => ({}));
    const client = {
      question: { reply: questionReply, reject: questionReject },
      permission: { reply: permissionReply },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(client, "question-1", [["Yes"]])).toBe("applied");
    expect(await replyToPermission(client, "permission-1", "always", "remember")).toBe("applied");
    expect(await rejectQuestion(client, "question-1")).toBe("applied");
    expect(questionReply).toHaveBeenCalledWith(
      { requestID: "question-1", answers: [["Yes"]] },
      { throwOnError: true },
    );
    expect(permissionReply).toHaveBeenCalledWith(
      { requestID: "permission-1", reply: "always", message: "remember" },
      { throwOnError: true },
    );
    expect(questionReject).toHaveBeenCalledWith(
      { requestID: "question-1" },
      { throwOnError: true },
    );
  });

  test("reports pending when a failed response remains authoritatively pending", async () => {
    const failed = {
      question: {
        reply: async () => { throw new Error("reply failed"); },
        reject: async () => { throw new Error("reject failed"); },
        list: async () => ({
          data: [{ id: "question-1", sessionID: "session-1", questions: [] }],
        }),
      },
      permission: {
        reply: async () => { throw new Error("permission failed"); },
        list: async () => ({
          data: [{
            id: "permission-1",
            sessionID: "session-1",
            permission: "read",
            patterns: [],
            metadata: {},
            always: [],
          }],
        }),
      },
    } as unknown as OpencodeClient;
    expect(await replyToQuestion(failed, "question-1", [])).toBe("pending");
    expect(await replyToPermission(failed, "permission-1", "reject")).toBe("pending");
    expect(await rejectQuestion(failed, "question-1")).toBe("pending");
  });

  test("reports gone without claiming application when reconciliation finds no request", async () => {
    const reconciled = {
      question: {
        reply: async () => { throw new Error("reply outcome unknown"); },
        reject: async () => { throw new Error("reject outcome unknown"); },
        list: async () => ({ data: [] }),
      },
      permission: {
        reply: async () => { throw new Error("permission outcome unknown"); },
        list: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(reconciled, "question-1", [["Yes"]])).toBe("gone");
    expect(await replyToPermission(reconciled, "permission-1", "once")).toBe("gone");
    expect(await rejectQuestion(reconciled, "question-1")).toBe("gone");
  });

  test("reports unknown instead of throwing when reconciliation is unavailable", async () => {
    const unavailable = {
      question: {
        reply: async () => { throw new Error("reply outcome unknown"); },
        reject: async () => { throw new Error("reject outcome unknown"); },
        list: async () => { throw new Error("question reconciliation unavailable"); },
      },
      permission: {
        reply: async () => { throw new Error("permission outcome unknown"); },
        list: async () => { throw new Error("permission reconciliation unavailable"); },
      },
    } as unknown as OpencodeClient;

    expect(await replyToQuestion(unavailable, "question-1", [["Yes"]])).toBe("unknown");
    expect(await replyToPermission(unavailable, "permission-1", "reject")).toBe("unknown");
    expect(await rejectQuestion(unavailable, "question-1")).toBe("unknown");
  });

  test("bounds reconciliation even when the pending-list client ignores cancellation", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) =>
      originalSetTimeout(handler, 0)) as typeof globalThis.setTimeout;
    try {
      const unavailable = {
        question: {
          reply: async () => { throw new Error("reply outcome unknown"); },
          list: async () => new Promise(() => {}),
        },
      } as unknown as OpencodeClient;

      expect(await replyToQuestion(unavailable, "question-1", [["Yes"]])).toBe("unknown");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
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

    const parts = (promptAsync.mock.calls[0]?.[0] as {
      parts: Array<Record<string, unknown>>;
    }).parts;
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

    const parts = (promptAsync.mock.calls[0]?.[0] as {
      parts: Array<Record<string, unknown>>;
    }).parts;
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

describe("opencode-client normalizeOpenCodeMessage providerUsage", () => {
  const tokens = {
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 40, write: 10 },
    total: 170,
  };

  function assistant(info: Record<string, unknown>) {
    return normalizeOpenCodeMessage({
      info: {
        id: "msg-1",
        role: "assistant",
        time: { created: 1_000 },
        ...info,
      },
      parts: [],
    });
  }

  test("captures the full provider counter block", () => {
    const message = assistant({
      tokens,
      cost: 0.25,
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      agent: "build",
      time: { created: 1_000, completed: 3_500 },
    });

    expect(message?.modelId).toBe("anthropic/claude-sonnet-4");
    expect(message?.providerUsage).toEqual({
      cost: 0.25,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 170,
      modelId: "anthropic/claude-sonnet-4",
      agent: "build",
      durationMs: 2_500,
    });
  });

  test("publishes the provider-confirmed model before usage counters arrive", () => {
    expect(assistant({
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    })?.modelId).toBe("openai/gpt-5.6-sol");
  });

  test("normalizes model attribution without assigning it to user messages", () => {
    expect(assistant({ modelID: "claude-sonnet-4" })?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ providerID: "  ", modelID: "claude-sonnet-4" })?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ providerID: "anthropic", modelID: "  " })?.modelId)
      .toBeUndefined();
    expect(
      normalizeOpenCodeMessage({
        info: {
          id: "msg-user",
          role: "user",
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          time: { created: 1_000 },
        },
        parts: [],
      })?.modelId,
    ).toBeUndefined();
  });

  test("attaches usage only to assistant messages that report tokens", () => {
    expect(assistant({})?.providerUsage).toBeUndefined();
    expect(assistant({ tokens: null })?.providerUsage).toBeUndefined();
    expect(
      normalizeOpenCodeMessage({
        info: { id: "msg-1", role: "user", time: { created: 1_000 }, tokens },
        parts: [],
      })?.providerUsage,
    ).toBeUndefined();
  });

  test("coerces every counter to a finite number", () => {
    expect(
      assistant({
        tokens: {
          input: "100",
          output: null,
          reasoning: "abc",
          cache: { read: "40", write: undefined },
          total: "170",
        },
        cost: "0.25",
      })?.providerUsage,
    ).toMatchObject({
      // `Number(...) || 0` turns a numeric string into a number and anything
      // unusable into zero, so one odd counter cannot poison the arithmetic.
      cost: 0,
      inputTokens: 100,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      // `total` only survives when it is already a number.
      totalTokens: undefined,
    });
  });

  test("tolerates an absent cache block", () => {
    expect(assistant({ tokens: { input: 1, output: 2 } })?.providerUsage).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("falls back to the bare model id when the provider is not named", () => {
    expect(assistant({ tokens, modelID: "claude-sonnet-4" })?.providerUsage?.modelId)
      .toBe("claude-sonnet-4");
    expect(assistant({ tokens, providerID: 7, modelID: 42 })?.providerUsage?.modelId)
      .toBe("42");
    expect(assistant({ tokens })?.providerUsage?.modelId).toBe("");
  });

  test("omits the duration until the turn reports both timestamps", () => {
    expect(assistant({ tokens })?.providerUsage?.durationMs).toBeUndefined();
    expect(
      assistant({ tokens, time: { created: 1_000, completed: "3500" } })
        ?.providerUsage?.durationMs,
    ).toBeUndefined();
  });

  test("clamps a completion timestamp that precedes the creation timestamp", () => {
    // Clock skew between the server and the rollout must never produce a
    // negative duration in the usage panel.
    expect(
      assistant({ tokens, time: { created: 5_000, completed: 1_000 } })
        ?.providerUsage?.durationMs,
    ).toBe(0);
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
    expect(summarizeOpenCodeUsage(messages, [
      { id: "openai/gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400_000 },
    ])).toBeNull();
  });

  test("returns null when the catalogue window is not positive", () => {
    expect(
      summarizeOpenCodeUsage([turn({ totalTokens: 1_000 })], [
        { ...MODELS[0]!, contextWindow: 0 },
      ]),
    ).toBeNull();
    expect(
      summarizeOpenCodeUsage([turn({ totalTokens: 1_000 })], [
        { ...MODELS[0]!, contextWindow: undefined },
      ]),
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
        [turn({
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 3_000,
          cacheWriteTokens: 500,
          reasoningTokens: 700,
        })],
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
    expect(
      summarizeOpenCodeUsage([turn({ totalTokens: 400_000 })], MODELS)?.percentUsed,
    ).toBe(100);
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
    expect(summary?.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
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
        diff: async () => ({ data: [{ file: "a.ts", additions: 3, deletions: 1, status: "modified" }] }),
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
      mcp: { status: async (args: { directory?: string }) => {
        seen.push(`mcp:${args.directory}`);
        return { data: {} };
      } },
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
        lsp: { status: async () => { throw new Error("lsp unavailable"); } },
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
    ["openrouter/anthropic/claude-sonnet-4", {
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4",
    }],
    ["  anthropic/claude-sonnet-4  ", {
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    }],
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

      await expect(forkOpenCodeSession(client, "session-1")).rejects.toThrow(
        "empty fork response",
      );
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

      await compactOpenCodeSession(
        client,
        "session-1",
        "openrouter/anthropic/claude-sonnet-4",
      );

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
        session: { revert: async () => { throw new Error("nothing to revert"); } },
      } as unknown as OpencodeClient;

      await expect(revertOpenCodeSession(client, "session-1")).rejects.toThrow(
        "nothing to revert",
      );
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
          share: async () => ({ data: { id: "session-1", share: { url: "https://share.test/s1" } } }),
        },
      } as unknown as OpencodeClient;

      expect(await shareOpenCodeSession(client, "session-1")).toBe(
        "https://share.test/s1",
      );
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
