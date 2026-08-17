import { describe, expect, mock, test } from "bun:test";
import { OPEN_CODE_MESSAGE_HISTORY_LIMIT } from "@orkestrator/protocol/opencode-message-id";
import { createNativeAgentProvider, PromptRejectedError, ProviderUnavailableError } from "./native-agent-provider.js";
import { waitUntil, deferred, expectedOpenCodeMessageId, openCodeFake, openCodeProvider, openCodeActivityProvider } from "./agent-provider-test-support.js";

describe("OpenCode provider runtime", () => {
  test.each([["permission"], ["question"]] as const)(
    "cleans up the answering request id after an OpenCode %s response fails",
    async (requestType) => {
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      try {
        await provider.createSession("build", "Build task");
        await waitUntil(() => fake.subscriptions.length === 1);
        const event = {
          type: `${requestType}.asked`,
          properties: { id: "same-request", sessionID: "owned-session" },
        };
        if (requestType === "permission") {
          fake.setPermissionReplyResponse({ error: { message: "failed" } });
        } else {
          fake.setQuestionRejectResponse({ error: { message: "failed" } });
        }
        fake.subscriptions[0]!.push(event);
        await waitUntil(() =>
          (requestType === "permission"
            ? fake.permissionReplies
            : fake.questionRejections).length === 1
        );

        if (requestType === "permission") {
          fake.setPermissionReplyResponse({ data: true });
        } else {
          fake.setQuestionRejectResponse({ data: true });
        }
        await waitUntil(() => fake.subscriptions.length >= 2);
        fake.subscriptions[1]!.push(event);
        await waitUntil(() =>
          (requestType === "permission"
            ? fake.permissionReplies
            : fake.questionRejections).length === 2
        );
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("serializes reconciliation when sessions register concurrently", async () => {
    const fake = openCodeFake();
    fake.setPending([
      { id: "permission-a", sessionID: "restored-a" },
      { id: "permission-b", sessionID: "restored-b" },
    ], []);
    const gate = deferred();
    const provider = openCodeProvider(fake);
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.setPendingReadGate(gate.promise);
      provider.registerSession?.("restored-a");
      await waitUntil(() => fake.permissionListCallCount === 1);
      provider.registerSession?.("restored-b");
      gate.resolve();

      await waitUntil(() => fake.permissionListCallCount === 2);
      expect(fake.questionListCallCount).toBe(2);
      expect(fake.permissionReplies.map(({ requestID }) => requestID).sort())
        .toEqual(["permission-a", "permission-b"]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not monitor or answer requests when OpenCode auto-answering is omitted", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [{ id: "permission-1", sessionID: "owned-session" }],
      [{ id: "question-1", sessionID: "owned-session" }],
    );
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
      },
    );

    try {
      await provider.createSession("build", "Interactive task");
      expect(fake.subscriptions).toHaveLength(0);
      expect(fake.permissionReplies).toHaveLength(0);
      expect(fake.questionRejections).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("unblocks an owned OpenCode session when its question is answered elsewhere", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "question.asked",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.questionRejections.length === 1);
      await expect(provider.status("owned-session")).resolves.toBe("error");

      stream.push({
        type: "question.replied",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });
      stream.push({
        type: "permission.asked",
        properties: { id: "after-reply", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.permissionReplies.length === 1);
      await expect(provider.status("owned-session")).resolves.toBe("idle");
    } finally {
      await provider.dispose?.();
    }
  });

  test("reconnects after an event stream ends and dispose stops monitoring", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.close();
    await waitUntil(() => fake.subscriptions.length >= 2);

    await provider.dispose?.();
    const subscriptionsAtDispose = fake.subscriptions.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.subscriptions).toHaveLength(subscriptionsAtDispose);
  });

  test("dispose interrupts a pending monitor reconnect delay", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake, 1_000);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 1));

    await provider.dispose?.();
    expect(fake.subscriptions).toHaveLength(1);
  });

  test("surfaces SDK error envelopes from transcript and abort calls", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setMessagesResponse({ error: { message: "failed" } });
      await expect(provider.messages("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      await expect(provider.structured("owned-session", "request"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);

      fake.setAbortResponse({ error: { message: "failed" } });
      await expect(provider.abort("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("returns OpenCode transcripts, normalizes malformed data, and aborts successfully", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setMessagesResponse({ data: [{ info: { role: "assistant" } }] });
      await expect(provider.messages("owned-session")).resolves.toEqual([
        { info: { role: "assistant" } },
      ]);

      fake.setMessagesResponse({ data: "invalid" });
      await expect(provider.messages("owned-session")).resolves.toEqual([]);
      await expect(provider.abort("owned-session")).resolves.toBeUndefined();
      expect(fake.messageCalls).toEqual([
        { sessionID: "owned-session" },
        { sessionID: "owned-session" },
      ]);
      expect(fake.abortCalls).toEqual([{ sessionID: "owned-session" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("hydrates bounded OpenCode child-session transcripts in the authoritative snapshot", async () => {
    const fake = openCodeFake();
    fake.setMessagesHandler(async (parameters) => {
      if (parameters?.sessionID === "child-session") {
        return { data: [{
          info: {
            id: "child-message",
            role: "assistant",
            time: { created: 2 },
          },
          parts: [{ id: "child-text", type: "text", text: "Child finished" }],
        }] };
      }
      return { data: [{
        info: {
          id: "root-message",
          role: "assistant",
          time: { created: 1 },
        },
        parts: [{
          id: "task-part",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            title: "Inspect files",
            input: { description: "Inspect files", agent: "explore" },
            metadata: { sessionId: "child-session" },
          },
        }],
      }] };
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(fake.messageCalls).toEqual([
        { sessionID: "owned-session", limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
        { sessionID: "child-session", limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      ]);
      expect(snapshot?.messages).toEqual([expect.objectContaining({
        id: "root-message",
        parts: [expect.objectContaining({
          type: "subagent",
          subagentId: "child-session",
          subagentName: "Inspect files",
          subagentRole: "explore",
          subagentActions: [expect.objectContaining({
            type: "text",
            content: "Child finished",
          })],
          subagentActionCount: 0,
        })],
      })]);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    [
      { name: "MessageAbortedError", data: { message: "Aborted" } },
      { status: "idle", notices: [{ kind: "stopped", message: "Query stopped by user." }] },
    ],
    [
      { name: "ProviderError", data: { message: "Model unavailable" } },
      {
        status: "error",
        phase: "error",
        error: "Model unavailable",
        notices: [{ kind: "error", message: "Model unavailable" }],
      },
    ],
  ] as const)("normalizes OpenCode terminal message state", async (error, expected) => {
    const fake = openCodeFake();
    fake.setMessagesResponse({
      data: [{
        info: {
          id: "assistant-terminal",
          role: "assistant",
          error,
          time: { created: 1, completed: 2 },
        },
        parts: [],
      }],
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.interactiveSnapshot?.("owned-session"))
        .resolves.toMatchObject(expected);
    } finally {
      await provider.dispose?.();
    }
  });

  test("projects and caches the live OpenCode model catalog with session metadata", async () => {
    const fake = openCodeFake();
    const providerList = mock(async () => ({
      data: {
        providers: [{
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-sonnet": {
              name: "Claude Sonnet",
              variants: {
                high: {},
                disabled: { disabled: true },
              },
              limit: { context: 200_000 },
              capabilities: { input: { image: true } },
            },
          },
        }],
        default: {
          providerID: "opencode",
          modelID: "claude-sonnet",
          variant: "high",
        },
      },
    }));
    Object.assign(fake.client as object, { provider: { list: providerList } });
    fake.setSessionGetResponse("owned-session", {
      data: {
        id: "owned-session",
        directory: "/workspace",
        title: "Shared investigation",
        share: { url: "https://share.opencode.test/live" },
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([{
        platform: "opencode",
        id: "opencode/claude-sonnet",
        label: "Claude Sonnet",
        providerLabel: "opencode",
        reasoning: [
          { id: "default", label: "Default" },
          { id: "high", label: "High" },
        ],
        defaultReasoningId: "default",
        supportsSpeed: false,
        // OpenCode has primary agents, not a Build/Plan permission mode.
        supportsMode: false,
        contextWindow: 200_000,
        supportsImageInput: true,
      }]);
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(snapshot).toMatchObject({
        title: "Shared investigation",
        shareUrl: "https://share.opencode.test/live",
        composer: {
          selectedModelId: "opencode/claude-sonnet",
          selectedReasoningId: "high",
          models: [{
            id: "opencode/claude-sonnet",
            contextWindow: 200_000,
            supportsImageInput: true,
          }],
        },
      });
      await provider.modelCatalog?.();
      expect(providerList).toHaveBeenCalledTimes(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("only exposes providers OpenCode reports as connected", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              {
                id: "hpc-ai",
                name: "HPC-AI",
                models: {
                  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
                },
              },
              {
                id: "opencode",
                name: "OpenCode",
                models: { "kimi-k2.7": { name: "Kimi K2.7" } },
              },
            ],
            connected: ["opencode"],
            default: {
              providerID: "hpc-ai",
              modelID: "deepseek/deepseek-v4-flash",
            },
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
      // The disconnected default must not survive after its model was removed.
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(snapshot?.composer?.selectedModelId).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  // Connectivity is a *picker* filter. The durable cache deliberately outlives
  // it, so a provider the user authenticates later is still offered by launch
  // dialogs before an environment starts another bridge.
  test("keeps disconnected providers in the raw catalogue for the durable cache", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              {
                id: "hpc-ai",
                name: "HPC-AI",
                models: { "deepseek-v4-flash": { name: "DeepSeek V4 Flash" } },
              },
              {
                id: "opencode",
                name: "OpenCode",
                models: { "kimi-k2.7": { name: "Kimi K2.7" } },
              },
            ],
            connected: ["opencode"],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
      await expect(provider.rawModelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "hpc-ai/deepseek-v4-flash" }),
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
      // The filtered and unfiltered catalogues share one cache slot, so the
      // second read must not be served the first read's entry.
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  // An allowlist configured empty means "unrestricted", which is the exact key
  // `rawModelCatalog` passes. Without the connectivity flag in the cache key the
  // picker would be served the deliberately unfiltered durable-cache entry.
  test("does not serve the unfiltered raw catalogue to an unrestricted picker", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "hpc-ai", models: { "deepseek-v4-flash": {} } },
              { id: "opencode", models: { "kimi-k2.7": {} } },
            ],
            connected: ["opencode"],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => [],
    });
    try {
      await expect(provider.rawModelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "hpc-ai/deepseek-v4-flash" }),
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reads connected providers reported as objects", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "hpc-ai", models: { "deepseek-v4-flash": {} } },
              { id: "opencode", models: { "kimi-k2.7": {} } },
            ],
            connected: [{ id: "opencode" }, { id: "" }, null],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds the connected provider list it will honour", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [{ id: "opencode", models: { "kimi-k2.7": {} } }],
            // The 512-entry bound drops everything past the cap, including the
            // one provider that actually holds the selectable model.
            connected: [
              ...Array.from({ length: 512 }, (_unused, index) => `filler-${index}`),
              "opencode",
            ],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode"],
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("treats an empty connected provider list as authoritative", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [{
              id: "opencode",
              models: { "kimi-k2.7": { name: "Kimi K2.7" } },
            }],
            connected: [],
          },
        })),
      },
      config: {
        providers: mock(async () => ({
          data: {
            providers: [{
              id: "opencode",
              models: { "kimi-k2.7": { name: "Kimi K2.7" } },
            }],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([]);
    } finally {
      await provider.dispose?.();
    }
  });

  /** A catalogue whose unmanaged providers alone exceed the 512-model cap. */
  const crowdedOpenCodeCatalog = () => ({
    data: {
      providers: [
        {
          id: "hpc-ai",
          name: "HPC-AI",
          models: Object.fromEntries(
            Array.from({ length: 600 }, (_unused, index) => [
              `flood-${index}`,
              { name: `Flood ${index}` },
            ]),
          ),
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          models: { "kimi-k2.5": { name: "Kimi K2.5" } },
        },
        {
          id: "opencode",
          name: "OpenCode",
          models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } },
        },
        {
          id: "opencode-go",
          name: "OpenCode Go",
          models: { "grok-code": { name: "Grok Code" } },
        },
      ],
      default: { providerID: "hpc-ai", modelID: "flood-0" },
    },
  });

  test("excludes unmanaged providers before the model cap can hide the managed ones", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    // The unmanaged provider is listed first and alone exceeds the 512-model
    // budget, so filtering after truncation would return nothing selectable.
    const provider = openCodeActivityProvider(fake);
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.map((model) => model.id)).toEqual([
        "opencode/claude-sonnet-5",
        "opencode-go/grok-code",
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("shares the picker budget so an allowlisted sibling cannot hide opencode-go", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            providers: [
              {
                id: "opencode",
                name: "OpenCode",
                models: Object.fromEntries(
                  Array.from({ length: 600 }, (_unused, index) => [
                    `zen-${index}`,
                    { name: `Zen ${index}` },
                  ]),
                ),
              },
              {
                id: "opencode-go",
                name: "OpenCode",
                models: {
                  "deepseek-v4-flash": { name: "opencode-go/deepseek-v4-flash" },
                  "deepseek-v4-pro": { name: "opencode-go/deepseek-v4-pro" },
                },
              },
            ],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.some((model) => model.id === "opencode-go/deepseek-v4-flash")).toBe(true);
      expect(models?.some((model) => model.id === "opencode-go/deepseek-v4-pro")).toBe(true);
      expect(models?.find((model) => model.id === "opencode-go/deepseek-v4-flash")).toMatchObject({
        label: "deepseek-v4-flash",
        providerLabel: "opencode-go",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("drops an OpenCode default that names an excluded provider", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    fake.setSessionGetResponse("owned-session", {
      data: { id: "owned-session", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      // Pre-selecting `hpc-ai/flood-0` would name a model the picker cannot show.
      expect(snapshot?.composer?.selectedModelId).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("honours a configured allowlist and re-filters when it changes", async () => {
    const fake = openCodeFake();
    const providerList = mock(async () => crowdedOpenCodeCatalog());
    Object.assign(fake.client as object, { provider: { list: providerList } });
    let allowed: string[] = ["openrouter"];
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => allowed,
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "openrouter/kimi-k2.5" }),
      ]);
      // A settings edit must not be served the previously cached catalogue.
      allowed = ["opencode-go"];
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode-go/grok-code" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps the bounded raw catalogue available for durable cache refreshes", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            providers: [
              {
                id: "opencode",
                name: "OpenCode",
                models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } },
              },
              {
                id: "openrouter",
                name: "OpenRouter",
                models: { "kimi-k2.5": { name: "Kimi K2.5" } },
              },
            ],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode"],
    });
    try {
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/claude-sonnet-5" }),
      ]);
      await expect(provider.rawModelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/claude-sonnet-5" }),
        expect.objectContaining({ id: "openrouter/kimi-k2.5" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  // The raw catalogue is unfiltered by design, so its bounds are otherwise spent
  // in OpenCode's own listing order. A real catalogue runs to thousands of
  // models, which truncated the managed pair out of the durable cache entirely
  // and left the picker with nothing selectable for the configured providers.
  test("normalizes the configured providers before the raw catalogue caps", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode", "opencode-go"],
    });
    try {
      const raw = await provider.rawModelCatalog?.();
      expect(raw?.slice(0, 2).map((model) => model.id)).toEqual([
        "opencode/claude-sonnet-5",
        "opencode-go/grok-code",
      ]);
      // Still unfiltered: a provider the user authenticates later has to remain
      // in the durable cache, it just no longer displaces the managed pair.
      expect(raw?.some((model) => model.id.startsWith("hpc-ai/"))).toBe(true);
      expect(raw?.length).toBe(512);
    } finally {
      await provider.dispose?.();
    }
  });

  test("re-prioritizes the raw catalogue when the allowlist changes", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    let allowed: string[] = ["opencode"];
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => allowed,
    });
    try {
      await expect((await provider.rawModelCatalog?.())?.[0]?.id)
        .toBe("opencode/claude-sonnet-5");
      // The priority list decides which providers survive the caps, so the
      // pre-edit entry cannot answer a read that passed a different one.
      allowed = ["openrouter"];
      await expect((await provider.rawModelCatalog?.())?.[0]?.id)
        .toBe("openrouter/kimi-k2.5");
    } finally {
      await provider.dispose?.();
    }
  });

  // The allowlist governs what the picker offers, not what OpenCode can serve.
  // Judging dispatch against the filtered catalogue rejected a model the user
  // had already chosen — a stored default especially — as "not connected".
  test("dispatches a connected model whose provider is not on the allowlist", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              {
                id: "hpc-ai",
                models: { "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" } },
              },
              { id: "opencode", models: { "kimi-k2.7": { name: "Kimi K2.7" } } },
            ],
            connected: ["hpc-ai", "opencode"],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode"],
    });
    try {
      await provider.send("owned-session", "prompt", {
        requestId: "request-1",
        model: "hpc-ai/deepseek/deepseek-v4-flash",
      });
      expect(fake.promptCalls).toHaveLength(1);
      // The picker itself stays filtered.
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("dispatches a connected model beyond the normalized catalogue cap", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => {
          const catalog = crowdedOpenCodeCatalog();
          return {
            data: {
              ...catalog.data,
              connected: ["hpc-ai"],
            },
          };
        }),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode"],
    });
    try {
      await provider.send("owned-session", "prompt", {
        requestId: "request-1",
        // `hpc-ai` advertises 600 models in this fixture. Dispatchability must
        // inspect the requested model directly instead of the first 512 models
        // retained for picker and durable-cache reads.
        model: "hpc-ai/flood-599",
      });
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  // Relaxing the cap must not relax the lookup itself. Without this the whole
  // model-existence half of the check could be deleted and the suite would
  // still pass on the connectivity half alone.
  test("still rejects a model its connected provider does not advertise", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "hpc-ai", models: { "deepseek-v4-flash": {} } },
              { id: "opencode", models: { "kimi-k2.7": {} } },
            ],
            connected: ["hpc-ai", "opencode"],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
    });
    try {
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
        // The provider is connected; this model is simply not one of its.
        model: "hpc-ai/retired-v3",
      })).rejects.toBeInstanceOf(PromptRejectedError);
      expect(fake.promptCalls).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });

  // Dispatchability parses `connected` itself rather than reusing the
  // catalogue's pass, so the object form needs pinning on this path too.
  test("dispatches when connectivity is reported as provider objects", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "hpc-ai", models: { "deepseek-v4-flash": {} } },
              { id: "opencode", models: { "kimi-k2.7": {} } },
            ],
            connected: [{ id: "hpc-ai" }, { id: "" }, null],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["opencode"],
    });
    try {
      await provider.send("owned-session", "prompt", {
        requestId: "request-1",
        model: "hpc-ai/deepseek-v4-flash",
      });
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("still rejects a model whose provider OpenCode reports disconnected", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              {
                id: "hpc-ai",
                models: { "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" } },
              },
              { id: "opencode", models: { "kimi-k2.7": { name: "Kimi K2.7" } } },
            ],
            connected: ["opencode"],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
    });
    try {
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
        model: "hpc-ai/deepseek/deepseek-v4-flash",
      })).rejects.toBeInstanceOf(PromptRejectedError);
      expect(fake.promptCalls).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("treats an empty allowlist as unrestricted", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => [],
    });
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.some((model) => model.id.startsWith("hpc-ai/"))).toBe(true);
    } finally {
      await provider.dispose?.();
    }
  });

  test("falls back to the managed default when the allowlist cannot be read", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    // A failed config read must not widen the catalogue to every provider.
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => {
        throw new Error("config unavailable");
      },
    });
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.map((model) => model.id)).toEqual([
        "opencode/claude-sonnet-5",
        "opencode-go/grok-code",
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("re-filters the composer catalogue when the allowlist changes", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => crowdedOpenCodeCatalog()) },
    });
    fake.setSessionGetResponse("owned-session", {
      data: { id: "owned-session", directory: "/workspace" },
    });
    let allowed: string[] = ["openrouter"];
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => allowed,
    });
    try {
      const before = await provider.interactiveSnapshot?.("owned-session");
      expect(before?.composer?.models?.map((model) => model.id))
        .toEqual(["openrouter/kimi-k2.5"]);

      // The composer reads through a second, session-scoped cache. A settings
      // edit has to invalidate that one too, or the picker keeps the pre-edit
      // catalogue for a whole TTL without ever consulting the filter.
      allowed = ["opencode-go"];
      const after = await provider.interactiveSnapshot?.("owned-session");
      expect(after?.composer?.models?.map((model) => model.id))
        .toEqual(["opencode-go/grok-code"]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("excludes unmanaged providers before the provider cap can hide them", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            providers: [
              // The 128-provider ceiling is reached long before `opencode` is
              // seen, so filtering after truncation would return nothing.
              ...Array.from({ length: 200 }, (_unused, index) => ({
                id: `flood-${index}`,
                name: `Flood ${index}`,
                models: { model: { name: "Model" } },
              })),
              {
                id: "opencode",
                name: "OpenCode",
                models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } },
              },
            ],
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.map((model) => model.id)).toEqual([
        "opencode/claude-sonnet-5",
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("still bounds the provider scan when the allowlist is unrestricted", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            providers: Array.from({ length: 200 }, (_unused, index) => ({
              id: `flood-${index}`,
              name: `Flood ${index}`,
              models: { model: { name: "Model" } },
            })),
          },
        })),
      },
    });
    const provider = openCodeActivityProvider(fake, {
      resolveOpenCodeModelProviders: () => [],
    });
    try {
      const models = await provider.modelCatalog?.();
      // Filtering moved ahead of the cap; the cap itself must still apply.
      expect(models?.length).toBe(128);
    } finally {
      await provider.dispose?.();
    }
  });

  test("maps OpenCode status and prompt error envelopes", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(provider.status("owned-session")).resolves.toBe("idle");
      // OpenCode keys its session map by directory. Reading it without this
      // connection's own worktree returns another workspace's map, in which
      // every live session of this one looks missing.
      expect(fake.statusCalls).toEqual([{ directory: "/workspace" }]);
      fake.setStatusResponse({
        data: { "owned-session": { type: "busy" } },
      });
      await expect(provider.status("owned-session")).resolves.toBe("running");
      fake.setStatusResponse({
        data: { "owned-session": { type: "retry" } },
      });
      await expect(provider.status("owned-session")).resolves.toBe("running");
      fake.setStatusResponse({
        data: { "owned-session": { type: "unexpected" } },
      });
      await expect(provider.status("owned-session")).resolves.toBe("error");
      await expect(provider.status("missing-session")).resolves.toBe("missing");
      // Not just the first read: every status read is scoped to the worktree.
      expect(fake.statusCalls).toEqual(
        Array.from({ length: 5 }, () => ({ directory: "/workspace" })),
      );
      expect(fake.sessionListCallCount).toBe(0);
      expect(fake.sessionGetCallCount).toBe(1);

      fake.setPromptResponse({ error: { message: "rejected" } });
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
      })).rejects.toBeInstanceOf(PromptRejectedError);

      fake.setPromptResponse({
        error: { message: "session restarting" },
        response: new Response(null, { status: 404 }),
      });
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-2",
      })).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("wraps malformed and failed OpenCode status reads as unavailable", async () => {
    for (const response of [
      { data: undefined },
      { error: { message: "failed" } },
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse(response);
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.status("owned-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("wraps a thrown OpenCode status read as unavailable", async () => {
    const fake = openCodeFake();
    fake.setStatusError(new Error("status failed"));
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.statusCalls).toEqual([{ directory: "/workspace" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reads completed, pending, and failed OpenCode structured output", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: expectedOpenCodeMessageId("request-1"),
            structured: { complete: true },
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: expectedOpenCodeMessageId("request-1"),
            structured: { complete: true },
            time: {},
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toBeNull();

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: expectedOpenCodeMessageId("request-1"),
            error: { message: "failed" },
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: false,
          error: { code: "provider_error", retryable: true },
        });

      fake.setMessagesResponse({ data: "invalid" });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toBeNull();

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: "other-request",
            structured: { complete: true },
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toBeNull();
    } finally {
      await provider.dispose?.();
    }
  });

  test("uses the newest matching structured result and distinguishes null from missing", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setMessagesResponse({
        data: [
          {
            info: {
              role: "assistant",
              parentID: expectedOpenCodeMessageId("request-1"),
              structured: { version: "old" },
              time: { completed: 1 },
            },
          },
          {
            info: {
              role: "assistant",
              parentID: expectedOpenCodeMessageId("request-1"),
              structured: { version: "new" },
              time: { completed: 2 },
            },
          },
        ],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { version: "new" } });

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: expectedOpenCodeMessageId("request-1"),
            structured: null,
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: null });

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID: expectedOpenCodeMessageId("request-1"),
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: false,
          error: { code: "malformed_output", retryable: true },
        });
    } finally {
      await provider.dispose?.();
    }
  });

  test("parses correlated JSON text when OpenCode structured formats are disabled", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const parentID = expectedOpenCodeMessageId("request-1");
      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID,
            time: { completed: 1 },
          },
          parts: [{ type: "text", text: '{"complete":true}' }],
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID,
            time: { completed: 1 },
          },
          parts: [{ type: "text", text: '```json\n{"complete":false}\n```' }],
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: false } });

      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID,
            time: { completed: 1 },
          },
          parts: [{ type: "text", text: "Here is the result: {\"complete\":true}" }],
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });
    } finally {
      await provider.dispose?.();
    }
  });

  test("recovers a prose-wrapped JSON document without interpreting arbitrary prose", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const parentID = expectedOpenCodeMessageId("request-1");
      const reply = (text: string) => ({
        data: [{
          info: {
            role: "assistant",
            parentID,
            time: { completed: 1 },
          },
          parts: [{ type: "text", text }],
        }],
      });

      // A trailing summary after the required JSON value is the common recovery case.
      fake.setMessagesResponse(reply('{"complete":true}\n\nAll checks passed.'));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      // A lead-in sentence before the JSON value.
      fake.setMessagesResponse(reply('The result is {"complete":false}'));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: false } });

      // The last well-formed document wins when prose contains several.
      fake.setMessagesResponse(reply('Example {"nope":1}. Answer {"complete":true}.'));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      // Nested values belong to the outer schema result and must not replace it
      // merely because their opening delimiter occurs later in the response.
      fake.setMessagesResponse(reply(
        'Result: {"complete":true,"commandsRun":[{"command":"bun test","result":"passed"}]} Done.',
      ));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: true,
          value: {
            complete: true,
            commandsRun: [{ command: "bun test", result: "passed" }],
          },
        });

      fake.setMessagesResponse(reply(
        'Candidates: [{"id":1,"metadata":{"selected":false}},{"id":2}] Done.',
      ));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: true,
          value: [
            { id: 1, metadata: { selected: false } },
            { id: 2 },
          ],
        });

      // A multiline document inside a fence, and a fence without the trailing
      // newline before the closing backticks, are still recovered.
      fake.setMessagesResponse(reply('```json\n{\n  "complete": false\n}\n```'));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: false } });

      fake.setMessagesResponse(reply('```json\n{"complete":true}```'));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      // Streaming can split a message across several text parts; joining them
      // must still recover the document.
      fake.setMessagesResponse({
        data: [{
          info: {
            role: "assistant",
            parentID,
            time: { completed: 1 },
          },
          parts: [
            { type: "text", text: 'Here is the result: {"compl' },
            { type: "reasoning", text: "ignored" },
            { type: "text", text: 'ete":true}' },
          ],
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      // Bare JSON primitives pass through for the workflow layer to validate.
      fake.setMessagesResponse(reply("true"));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: true });

      fake.setMessagesResponse(reply("42"));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: 42 });

      // Prose with no JSON document is still rejected rather than guessed.
      fake.setMessagesResponse(reply("I could not verify the build."));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: false,
          error: { code: "malformed_output", retryable: true },
        });

      fake.setMessagesResponse(reply(
        "<thinking>{ incomplete schema sketch\n{\"fromThought\":true}</thinking>\n{\"complete\":true}",
      ));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      fake.setMessagesResponse(reply(
        "{\"complete\":true}\n<thinking>{\"fromThought\":true}</thinking>",
      ));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });

      // An annotated opening tag still marks the trace.
      fake.setMessagesResponse(reply(
        "{\"complete\":true}\n<thinking type=\"reflection\">{\"fromThought\":true}</thinking>",
      ));
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });
    } finally {
      await provider.dispose?.();
    }
  });

  test("skips malformed and unrelated entries around a matching structured result", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const parentID = expectedOpenCodeMessageId("request-1");
      fake.setMessagesResponse({
        data: [
          null,
          { info: null },
          { info: { role: "user", id: parentID } },
          {
            info: {
              role: "assistant",
              parentID,
              structured: { complete: true },
              time: { completed: 1 },
            },
          },
          42,
          {
            info: {
              role: "assistant",
              parentID: "unrelated",
              structured: { complete: false },
              time: { completed: 2 },
            },
          },
        ],
      });

      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({ ok: true, value: { complete: true } });
      expect(fake.messageCalls.at(-1)).toEqual({
        sessionID: "owned-session",
        limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("looks up structured output by the exact mapped request id", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "First", { requestId: "foo" });
      await provider.send("owned-session", "Second", { requestId: "msg_foo" });
      const [fooMessageId, nativeLookingMessageId] = fake.promptCalls.map(
        ({ messageID }) => messageID,
      );
      expect(fooMessageId).not.toBe(nativeLookingMessageId);

      fake.setMessagesResponse({
        data: [
          {
            info: {
              role: "assistant",
              parentID: fooMessageId,
              structured: { request: "foo" },
              time: { completed: 1 },
            },
          },
          {
            info: {
              role: "assistant",
              parentID: nativeLookingMessageId,
              structured: { request: "msg_foo" },
              time: { completed: 2 },
            },
          },
        ],
      });

      await expect(provider.structured("owned-session", "foo")).resolves
        .toMatchObject({ ok: true, value: { request: "foo" } });
      await expect(provider.structured("owned-session", "msg_foo")).resolves
        .toMatchObject({ ok: true, value: { request: "msg_foo" } });
    } finally {
      await provider.dispose?.();
    }
  });
});
