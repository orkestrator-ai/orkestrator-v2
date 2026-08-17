import { afterEach,describe,expect,mock,test } from "bun:test";


import {
abortSession,
checkClientHealth,
checkHealth,
createClient,
createSession,
deleteSession,
getAvailableSlashCommands,
getModelsWithDefaults,
getSessionMessages,
getSessionStatus,
listSessions,
lookupSessionStatus,
type OpencodeClient
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



const noProviderCatalog = {
  provider: {
    list: async () => {
      throw new Error("provider catalog unavailable");
    },
  },
};



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

  test("shortens a provider-qualified display name without changing the model id", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [{
              id: "opencode-go",
              models: {
                "deepseek-v4-flash": {
                  id: "deepseek-v4-flash",
                  name: "opencode-go/deepseek-v4-flash",
                },
              },
            }],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await getModelsWithDefaults(client);

    expect(result.models).toEqual([{
      id: "opencode-go/deepseek-v4-flash",
      name: "deepseek-v4-flash",
      provider: "opencode-go",
    }]);
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
