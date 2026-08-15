import { describe, expect, mock, test } from "bun:test";
import { OPEN_CODE_MESSAGE_HISTORY_LIMIT, OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { AmbiguousPromptDispatchError, createNativeAgentProvider, PromptRejectedError, ProviderUnavailableError } from "./native-agent-provider.js";
import { waitUntil, deferred, openCodeFake, openCodeProvider } from "./agent-provider-test-support.js";

describe("OpenCode provider dispatch", () => {
  test("rejects a disconnected model before creating a user-only turn", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              {
                id: "hpc-ai",
                models: {
                  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
                },
              },
              {
                id: "opencode",
                models: { "kimi-k2.7": { name: "Kimi K2.7" } },
              },
            ],
            connected: ["opencode"],
          },
        })),
      },
    });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
        model: "hpc-ai/deepseek/deepseek-v4-flash",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        autoAnswerRequests: false,
        resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
      },
    );
    try {
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
      })).rejects.toThrow(
        "The selected OpenCode model is not connected or is no longer available",
      );
      expect(fake.messageCalls).toHaveLength(0);
      expect(fake.promptCalls).toHaveLength(0);
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  // The availability preflight reads a *secondary* endpoint. Failing the prompt
  // when that read fails would let one flaky `/provider` response block every
  // dispatch, which is worse than the stuck turn the preflight guards against.
  // Only a catalogue that was actually read may reject a send.
  test.each([
    [
      "an unreachable provider catalogue",
      () => Promise.reject(new Error("provider list unavailable")),
    ],
    [
      "an error envelope from the provider catalogue",
      async () => ({ error: { message: "provider list failed" } }),
    ],
    [
      "a provider catalogue that reports nothing",
      async () => ({ data: {} }),
    ],
  ] as const)("dispatches despite %s", async (_label, list) => {
    const fake = openCodeFake();
    const providerList = mock(list);
    Object.assign(fake.client as object, { provider: { list: providerList } });
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
        model: "hpc-ai/deepseek/deepseek-v4-flash",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        autoAnswerRequests: false,
        resolveOpenCodeModelProviders: () => ["hpc-ai", "opencode"],
      },
    );
    try {
      await provider.send("owned-session", "prompt", { requestId: "request-1" });
      expect(providerList).toHaveBeenCalledTimes(1);
      expect(fake.promptCalls).toHaveLength(1);
      expect(fake.promptCalls[0]).toMatchObject({
        sessionID: "owned-session",
        model: { providerID: "hpc-ai", modelID: "deepseek/deepseek-v4-flash" },
      });
    } finally {
      await provider.dispose?.();
    }
  });

  // A degenerate preflight read must not be published into the composer cache.
  // Caching it would suppress the `config.providers` fallback for a whole TTL
  // and empty the model picker for a user whose send just succeeded.
  test("does not let a degenerate preflight read empty the composer catalogue", async () => {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: { list: mock(async () => ({ data: {} })) },
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
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
        model: "opencode/kimi-k2.7",
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        autoAnswerRequests: false,
        resolveOpenCodeModelProviders: () => ["opencode"],
      },
    );
    try {
      await provider.send("owned-session", "prompt", { requestId: "request-1" });
      expect(fake.promptCalls).toHaveLength(1);
      await expect(provider.modelCatalog?.()).resolves.toEqual([
        expect.objectContaining({ id: "opencode/kimi-k2.7" }),
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds targeted transcript reads at the SDK boundary", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setMessagesResponse({
        data: [{ info: { id: "latest", role: "assistant" }, parts: [] }],
      });
      await expect(provider.messages("owned-session", { limit: 4 })).resolves
        .toHaveLength(1);
      expect(fake.messageCalls).toEqual([{ sessionID: "owned-session", limit: 4 }]);

      fake.setMessagesResponse({ data: Array.from({ length: 5 }, () => null) });
      await expect(provider.messages("owned-session", { limit: 4 }))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not dispatch from unavailable or malformed authoritative history", async () => {
    for (const response of [
      { error: { message: "history unavailable" } },
      { data: { messages: [] } },
      {
        data: Array.from(
          { length: OPEN_CODE_MESSAGE_HISTORY_LIMIT + 1 },
          () => null,
        ),
      },
    ]) {
      const fake = openCodeFake();
      fake.setMessagesResponse(response);
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.send("owned-session", "prompt", {
          requestId: "request-1",
        })).rejects.toBeInstanceOf(ProviderUnavailableError);
        expect(fake.promptCalls).toHaveLength(0);
        expect(fake.messageCalls).toEqual([{
          sessionID: "owned-session",
          limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT,
        }]);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("runs a recognized OpenCode command as a command, not as prompt text", async () => {
    const fake = openCodeFake();
    fake.setCommandListResponse({ data: [{ name: "plan", description: "Plan work" }] });
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "/plan ship the release\nwith notes", {
        requestId: "request-1",
        allowProviderCommands: true,
      });
      expect(fake.promptCalls).toHaveLength(0);
      expect(fake.commandDispatchCalls).toHaveLength(1);
      expect(fake.commandDispatchCalls[0]).toMatchObject({
        sessionID: "owned-session",
        command: "plan",
        // Newlines survive: rebuilding arguments from split tokens flattened a
        // pasted diff or multi-line spec into one line.
        arguments: "ship the release\nwith notes",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("dispatches OpenCode's built-in commands without provider discovery", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      // `/command` only lists configurable commands, so `/init` is known from
      // the built-in table rather than from discovery.
      await provider.send("owned-session", "/init", {
        requestId: "request-1",
        allowProviderCommands: true,
      });
      expect(fake.commandDispatchCalls[0]).toMatchObject({
        command: "init",
        // Required by the server: dropping the key answers 400.
        arguments: "",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps a slash-prefixed workflow prompt literal", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "/init", { requestId: "request-1" });
      expect(fake.commandDispatchCalls).toHaveLength(0);
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("sends an unrecognized slash prompt to the model", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "/not-a-command do the thing", {
        requestId: "request-1",
        allowProviderCommands: true,
      });
      expect(fake.commandDispatchCalls).toHaveLength(0);
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("merges OpenCode built-in commands with discovered ones", async () => {
    const fake = openCodeFake();
    fake.setCommandListResponse({ data: [{ name: "deploy", description: "Ship it" }] });
    const provider = openCodeProvider(fake);
    try {
      const commands = await provider.slashCommands?.() ?? [];
      const names = commands.map((command) => command.name);
      expect(names).toContain("/deploy");
      expect(names).toContain("/init");
      expect(names).toContain("/undo");
    } finally {
      await provider.dispose?.();
    }
  });

  test("treats a thrown promptAsync as retryable rather than a rejection", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setPromptError(new Error("socket hang up"));

      // The distinction matters: PromptRejectedError fails the build, while
      // AmbiguousPromptDispatchError keeps the durable attempt and retries the
      // same request id. A dropped connection may already have delivered the turn.
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
      })).rejects.toBeInstanceOf(AmbiguousPromptDispatchError);
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
      })).rejects.not.toBeInstanceOf(PromptRejectedError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("orders caller-owned IDs between consecutive OpenCode turns", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const sessionId = "ses_fcd9281c1001abcdefghijklmn";
      await provider.send(sessionId, "First", {
        requestId: "zz",
      });
      const first = fake.promptCalls[0]?.messageID;
      if (typeof first !== "string") {
        throw new Error("OpenCode prompt omitted its message ID");
      }
      const firstTime = BigInt(`0x${first.slice(4, 16)}`);
      const assistantTime = ((firstTime + 0x1000n) & 0xffffffffffffn)
        .toString(16)
        .padStart(12, "0");
      const assistant = `msg_${assistantTime}hsJUIHGDARuWRB`;
      fake.setMessagesResponse({
        data: [
          { info: { id: first, role: "user" } },
          { info: { id: assistant, role: "assistant", parentID: first } },
        ],
      });
      await provider.send(sessionId, "Second", { requestId: "aa" });
      const second = fake.promptCalls[1]?.messageID;
      if (typeof second !== "string") {
        throw new Error("OpenCode prompt omitted its second message ID");
      }

      expect(first < assistant).toBe(true);
      expect(assistant < second).toBe(true);
      expect(second).toMatch(/^msg_[0-9a-f]{12}z{14}[0-9a-f]{12}_ork_/);
      expect(fake.promptCalls[1]).toMatchObject({
        sessionID: sessionId,
        agent: "build",
        directory: "/workspace",
        parts: [{ type: "text", text: "Second" }],
      });
      expect(fake.messageCalls).toEqual([
        { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
        { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("serializes same-session allocation and dispatch across provider instances", async () => {
    const coordinator = new OpenCodeMessageIdCoordinator();
    const firstFake = openCodeFake();
    const secondFake = openCodeFake();
    const gate = deferred();
    firstFake.setPromptGate(gate.promise);
    const firstProvider = openCodeProvider(firstFake, 1, coordinator);
    const secondProvider = openCodeProvider(secondFake, 1, coordinator);
    try {
      const first = firstProvider.send("shared-session", "First", { requestId: "zz" });
      await waitUntil(() => firstFake.promptCalls.length === 1);
      const second = secondProvider.send("shared-session", "Second", { requestId: "aa" });
      await Promise.resolve();

      expect(secondFake.messageCalls).toHaveLength(0);
      gate.resolve();
      await Promise.all([first, second]);

      const firstId = firstFake.promptCalls[0]?.messageID;
      const secondId = secondFake.promptCalls[0]?.messageID;
      expect(typeof firstId).toBe("string");
      expect(typeof secondId).toBe("string");
      expect((firstId as string) < (secondId as string)).toBe(true);
      expect(firstFake.messageCalls[0]).toEqual({
        sessionID: "shared-session",
        limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT,
      });
      expect(secondFake.messageCalls[0]).toEqual({
        sessionID: "shared-session",
        limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT,
      });

      await secondProvider.send("shared-session", "Retry", { requestId: "aa" });
      expect(secondFake.promptCalls[1]?.messageID).toBe(secondId);
    } finally {
      gate.resolve();
      await firstProvider.dispose?.();
      await secondProvider.dispose?.();
    }
  });

  test("maps aliased-looking request ids distinctly and retries stably", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "First attempt", {
        requestId: "foo",
      });
      const firstId = fake.promptCalls[0]?.messageID;
      fake.setMessagesResponse({ data: [{ info: { id: firstId, role: "user" } }] });
      await provider.send("owned-session", "Retry", { requestId: "foo" });
      fake.setMessagesResponse({
        data: [
          { info: { id: firstId, role: "user" } },
          { info: { id: "msg_ffffffffffffzzzzzzzzzzzzzz", role: "assistant" } },
        ],
      });
      await provider.send("owned-session", "Different request", {
        requestId: "msg_foo",
      });

      const [first, retry, nativeLooking] = fake.promptCalls.map(
        ({ messageID }) => messageID,
      );
      expect(retry).toBe(first);
      expect(nativeLooking).not.toBe(first);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each(["", "   "])(
    "rejects a blank request id before dispatch (%j)",
    async (requestId) => {
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.send("owned-session", "Build it", { requestId }))
          .rejects.toBeInstanceOf(TypeError);

        expect(fake.promptCalls).toHaveLength(0);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("dispatches queued OpenCode plan turns to the plan agent", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "Inspect only", {
        requestId: "request-plan",
        mode: "plan",
      });

      expect(fake.promptCalls[0]!.agent).toBe("plan");
    } finally {
      await provider.dispose?.();
    }
  });

  test("uses exact execution-agent and variant overrides for continuations", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "Continue", {
        requestId: "request-recovery",
        mode: "plan",
        executionAgent: "reviewer",
        effort: "high",
      });

      expect(fake.promptCalls[0]).toMatchObject({
        agent: "reviewer",
        variant: "high",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("sends images as data-url file parts alongside the prompt", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "Build it", {
        requestId: "request-1",
        images: [{ filename: "diagram.webp", data: "BBBB" }],
      });

      expect(fake.promptCalls[0]!.parts).toEqual([
        { type: "text", text: "Build it" },
        {
          type: "file",
          mime: "image/webp",
          filename: "diagram.webp",
          url: "data:image/webp;base64,BBBB",
        },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("puts a structured schema in the prompt without poisoning OpenCode transcripts", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const schema = { type: "object", properties: {} } as const;
      await provider.send("owned-session", "Review it", {
        requestId: "request-1",
        schema,
      });

      expect(fake.promptCalls[0]!.format).toBeUndefined();
      expect(fake.promptCalls[0]!.parts).toEqual([{
        type: "text",
        text: expect.stringContaining(JSON.stringify(schema)),
      }]);
      expect(String((fake.promptCalls[0]!.parts as Array<{ text?: string }>)[0]?.text))
        .toContain("Return only one JSON value matching this JSON Schema");
    } finally {
      await provider.dispose?.();
    }
  });

  test("sends staged attachments with per-prompt model and effort overrides", async () => {
    const fake = openCodeFake();
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
        model: "fallback/model",
        effort: "low",
      },
      { openCodeClient: fake.client, monitorRetryMs: 1 },
    );
    try {
      await provider.send("owned-session", "Inspect the file", {
        requestId: "request-attachment",
        model: "anthropic/claude/sonnet",
        effort: "high",
        attachments: [{
          type: "file",
          path: "/workspace/image.gif",
        }],
      });

      expect(fake.promptCalls[0]).toMatchObject({
        model: {
          providerID: "anthropic",
          modelID: "claude/sonnet",
        },
        variant: "high",
        parts: [
          { type: "text", text: "Inspect the file" },
          {
            type: "file",
            mime: "image/gif",
            url: "file:///workspace/image.gif",
          },
        ],
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps the file part when an attachment-only prompt has no text", async () => {
    // Reachable since the startup launch began dispatching image-only prompts.
    // The generated SDK type allows an empty `text`, and the file part is what
    // actually carries the turn; pinned here so a change to either is visible.
    const fake = openCodeFake();
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      { openCodeClient: fake.client, monitorRetryMs: 1 },
    );
    try {
      await provider.send("owned-session", "", {
        requestId: "request-image-only",
        attachments: [{
          type: "image",
          path: "/workspace/only.png",
          filename: "only.png",
        }],
      });

      expect(fake.promptCalls[0]?.parts).toEqual([
        { type: "text", text: "" },
        {
          type: "file",
          mime: "image/png",
          filename: "only.png",
          url: "file:///workspace/only.png",
        },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([[409], [408], [425], [429], [500]])(
    "maps OpenCode prompt HTTP %i to a retryable dispatch failure",
    async (status) => {
      const fake = openCodeFake();
      fake.setPromptResponse({
        error: { message: "temporarily unavailable" },
        response: new Response(null, { status }),
      });
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.send("owned-session", "prompt", {
          requestId: "request-1",
        })).rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("splits a provider-qualified model and omits an unqualified one", async () => {
    const fake = openCodeFake();
    const qualified = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
        model: "anthropic/claude/sonnet",
      },
      { openCodeClient: fake.client, monitorRetryMs: 1 },
    );
    try {
      await qualified.send("owned-session", "prompt", { requestId: "r1" });
      // Only the first segment is the provider; the rest is the model id, which
      // itself contains slashes.
      expect(fake.promptCalls[0]!.model).toEqual({
        providerID: "anthropic",
        modelID: "claude/sonnet",
      });
    } finally {
      await qualified.dispose?.();
    }

    const bare = openCodeProvider(fake);
    try {
      await bare.send("owned-session", "prompt", { requestId: "r2" });
      expect(fake.promptCalls[1]!.model).toBeUndefined();
    } finally {
      await bare.dispose?.();
    }
  });
});
