import { describe, expect, test } from "bun:test";
import { AmbiguousPromptDispatchError, PromptRejectedError, ProviderUnavailableError, readProviderStatus } from "./native-agent-provider.js";
import { claudeConnection, codexConnection, cursorConnection, grokConnection, httpProvider } from "./agent-provider-test-support.js";

describe("HTTP bridge provider", () => {
  const operations = {
    create: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.createSession("build", "Build task"),
    send: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.send("session-1", "Build it", { requestId: "request-1" }),
    status: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.status("session-1"),
    messages: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.messages("session-1"),
    structured: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.structured("session-1", "request-1"),
    abort: (provider: ReturnType<typeof httpProvider>["provider"]) =>
      provider.abort("session-1"),
  };

  test("creates sessions with authenticated, agent-specific payloads", async () => {
    const { provider, requests } = httpProvider(() =>
      Response.json({ sessionId: "session-1" }));

    await expect(provider.createSession("build", "Build task")).resolves.toBe(
      "session-1",
    );
    const request = requests[0]!;
    expect(request.url).toBe("http://claude.test/session/create");
    expect(new Headers(request.init.headers).get(
      "X-Orkestrator-Claude-Token",
    )).toBe("test-token");
    expect(JSON.parse(String(request.init.body))).toEqual({ title: "Build task" });
  });

  test.each([
    ["cursor" as const, cursorConnection],
    ["grok" as const, grokConnection],
  ])("lists and resumes %s ACP sessions through the bridge", async (_agent, connection) => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/list")) {
        return Response.json({ sessions: [{
          id: "opaque-session",
          title: "Previous work",
          updatedAt: "2026-08-14T20:00:00.000Z",
          messageCount: 7,
        }] });
      }
      if (url.endsWith("/session/resume")) {
        return Response.json({ sessionId: "bridge-session" }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }, connection);

    await expect(provider.listResumableSessions?.()).resolves.toEqual([{
      sessionId: "opaque-session",
      title: "Previous work",
      updatedAt: "2026-08-14T20:00:00.000Z",
      detail: "7 messages",
    }]);
    await expect(provider.resumeSession?.("opaque-session", {
      modelId: "model-a",
      reasoningId: "high",
      mode: "plan",
      fastMode: true,
    })).resolves.toBe("bridge-session");

    expect(requests.map((request) => [request.url, request.init.method ?? "GET"]))
      .toEqual([
        [`${connection.baseUrl}/session/list`, "GET"],
        [`${connection.baseUrl}/session/resume`, "POST"],
      ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      sessionId: "opaque-session",
      modelId: "model-a",
      reasoningId: "high",
      mode: "plan",
      fastMode: true,
    });
  });

  for (const [agent, connection] of [
    ["cursor" as const, cursorConnection],
    ["grok" as const, grokConnection],
  ] as const) {
    test(`rejects malformed ${agent} ACP session responses`, async () => {
      const malformedList = httpProvider(
        (url) => url.endsWith("/session/list")
          ? Response.json({ sessions: "not-an-array" })
          : new Response(null, { status: 404 }),
        connection,
      );
      await expect(malformedList.provider.listResumableSessions?.())
        .rejects.toBeInstanceOf(ProviderUnavailableError);

      const malformedResume = httpProvider(
        (url) => url.endsWith("/session/resume")
          ? Response.json({ status: "idle" }, { status: 201 })
          : new Response(null, { status: 404 }),
        connection,
      );
      await expect(malformedResume.provider.resumeSession?.("opaque-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    });

    test(`surfaces why ${agent} cannot list its own ACP sessions`, async () => {
      const { provider } = httpProvider(
        (url) => url.endsWith("/session/list")
          ? Response.json(
            { error: `${agent} cannot list resumable ACP sessions` },
            { status: 410 },
          )
          : new Response(null, { status: 404 }),
        connection,
      );

      // A bare "HTTP 410" tells the user nothing actionable; the bridge's own
      // explanation has to survive the hop.
      await expect(provider.listResumableSessions?.())
        .rejects.toThrow(`${agent} cannot list resumable ACP sessions`);
    });
  }

  test("treats a successful empty structured result as pending", async () => {
    const { provider } = httpProvider(() =>
      Response.json({ structuredOutput: null }));

    await expect(provider.structured("session-1", "request-1")).resolves.toBeNull();
  });

  test("does not disguise structured-output transport failures as pending", async () => {
    for (const status of [404, 429, 500]) {
      const { provider } = httpProvider(() => new Response(null, { status }));
      const promise = provider.structured("session-1", "request-1");
      if (status >= 429) {
        await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
      } else {
        await expect(promise).rejects.toThrow(`failed (HTTP ${status})`);
      }
    }
  });

  for (const status of [408, 425, 429, 500]) {
    test(`classifies HTTP ${status} as transient for every operation`, async () => {
      for (const operation of Object.values(operations)) {
        const { provider } = httpProvider(() => new Response(null, { status }));
        await expect(operation(provider))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      }
    });
  }

  test("keeps semantic 4xx responses out of reconnect recovery", async () => {
    const missing = httpProvider(() => new Response(null, { status: 404 }));
    await expect(missing.provider.status("session-1")).resolves.toBe("missing");

    const rejected = httpProvider(() => new Response(null, { status: 400 }));
    await expect(rejected.provider.send("session-1", "Build it", {
      requestId: "request-1",
    })).rejects.toBeInstanceOf(PromptRejectedError);

    for (const operation of [
      operations.create,
      operations.messages,
      operations.structured,
      operations.abort,
    ]) {
      const { provider } = httpProvider(() => new Response(null, { status: 400 }));
      let caught: unknown;
      try {
        await operation(provider);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("maps prompt rejection separately from a transient dispatch failure", async () => {
    const rejected = httpProvider(() => new Response(null, { status: 400 }));
    await expect(rejected.provider.send("s", "prompt", { requestId: "r" }))
      .rejects.toBeInstanceOf(PromptRejectedError);

    const unavailable = httpProvider(() => new Response(null, { status: 503 }));
    await expect(unavailable.provider.send("s", "prompt", { requestId: "r" }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    for (const status of [404, 409]) {
      const raced = httpProvider(() => new Response(null, { status }));
      await expect(raced.provider.send("s", "prompt", { requestId: "r" }))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    }

    const ambiguous = httpProvider(() => {
      throw new Error("socket closed");
    });
    await expect(ambiguous.provider.send("s", "prompt", { requestId: "r" }))
      .rejects.toBeInstanceOf(AmbiguousPromptDispatchError);
  });

  test("reads status and messages, dispatches prompts, and aborts sessions", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/session%2F1")) {
        return Response.json({ status: "running" });
      }
      if (url.endsWith("/messages")) {
        return Response.json({ messages: [{ role: "assistant" }] });
      }
      return Response.json({});
    });

    await expect(provider.status("session/1")).resolves.toBe("running");
    await expect(provider.messages("session/1")).resolves.toEqual([
      { role: "assistant" },
    ]);
    await provider.send("session/1", "Build it", {
      requestId: "request-1",
      fastMode: true,
      images: [{ filename: "screen.webp", data: "AA==" }],
    });
    await provider.abort("session/1");

    expect(requests.map((request) => request.url)).toEqual([
      "http://claude.test/session/session%2F1",
      "http://claude.test/session/session%2F1/messages",
      "http://claude.test/session/session%2F1/prompt",
      "http://claude.test/session/session%2F1/abort",
    ]);
    // Every bridge validator requires `path`: the Claude route rejects the whole
    // request without one and the Codex route silently drops the entry. So a
    // base64 image is staged into the workspace and attached by path.
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      prompt: "Build it",
      requestId: "request-1",
      fastMode: true,
      permissionMode: "bypassPermissions",
      attachments: [{
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/screen.webp",
        filename: "screen.webp",
        dataUrl: "data:image/webp;base64,AA==",
      }],
    });
  });

  test("projects Claude's authoritative plan mode in the interactive snapshot", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      return Response.json({ status: "idle", title: "Claude's title", planMode: true });
    });

    await expect(provider.interactiveSnapshot?.("session-1")).resolves.toMatchObject({
      status: "idle",
      title: "Claude's title",
      controls: { mode: "plan" },
    });
  });

  test("routes Claude background-task stop and prompt-suggestion dismissal", async () => {
    const { provider, requests } = httpProvider(() => new Response(null, { status: 204 }));

    await provider.stopBackgroundTask?.("session/1", "task/1");
    await provider.dismissSuggestedPrompt?.("session/1");

    expect(requests.map((request) => [request.url, request.init.method])).toEqual([
      ["http://claude.test/session/session%2F1/tasks/task%2F1/stop", "POST"],
      ["http://claude.test/session/session%2F1/prompt-suggestion", "DELETE"],
    ]);
  });

  test.each([
    ["claude" as const, claudeConnection],
    ["codex" as const, codexConnection],
  ])("reads %s activity from one dedicated observation request", async (
    _agent,
    connection,
  ) => {
    for (const state of ["idle", "working", "waiting", "missing"] as const) {
      const { provider, requests } = httpProvider(
        () => Response.json({ activity: state }),
        connection,
      );

      await expect(provider.activity?.("session/1")).resolves.toBe(state);
      // One request, and specifically not the tab-facing status or
      // pending-input routes: those refresh the bridge's liveness clocks, which
      // a two-second poll would use to pin every transcript in memory forever.
      expect(requests.map((request) => request.url)).toEqual([
        `${connection.baseUrl}/session/session%2F1/activity`,
      ]);
    }
  });

  test.each([
    ["claude" as const, claudeConnection],
    ["codex" as const, codexConnection],
  ])("rejects a malformed %s activity snapshot", async (_agent, connection) => {
    for (const body of [{}, { activity: "busy" }, { activity: null }]) {
      const { provider } = httpProvider(() => Response.json(body), connection);
      // Coercing an unrecognized token to `idle` would retire the indicator on
      // a turn that is still running.
      await expect(provider.activity?.("session-1"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test.each([
    ["claude" as const, 404, false, claudeConnection],
    ["claude" as const, 400, false, claudeConnection],
    ["claude" as const, 503, true, claudeConnection],
    ["codex" as const, 404, false, codexConnection],
    ["codex" as const, 400, false, codexConnection],
    ["codex" as const, 503, true, codexConnection],
  ])("surfaces a non-success %s activity read (HTTP %i)", async (
    _agent,
    status,
    isUnavailable,
    connection,
  ) => {
    const { provider } = httpProvider(
      () => new Response(null, { status }),
      connection,
    );

    let caught: unknown;
    try {
      await provider.activity?.("session-1");
    } catch (error) {
      caught = error;
    }
    // 404 must throw rather than resolve to `missing`. The route reports an
    // unknown session in-band, so a 404 means the route is absent — an older
    // bridge — and resolving it as `missing` would delete a live mapping.
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof ProviderUnavailableError).toBe(isUnavailable);
  });

  test("defaults sessions to build mode and accepts an explicit override", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("review", "Prepare", { mode: "build" });
    await provider.createSession("review", "Discover", { mode: "plan" });
    await provider.createSession("review", "Unspecified");

    expect(requests.map((request) => JSON.parse(String(request.init.body)).mode))
      .toEqual(["build", "plan", "build"]);
  });

  test("refuses base64 images when nothing can stage them", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      claudeConnection,
      { stageImages: false },
    );

    // Silently dropping the image would leave a prompt that references a picture
    // the agent was never given.
    await expect(provider.send("session-1", "Look", {
      requestId: "request-1",
      images: [{ filename: "screen.png", data: "AA==" }],
    })).rejects.toBeInstanceOf(PromptRejectedError);
    expect(requests).toHaveLength(0);
  });

  test("forwards per-prompt Claude options ahead of the connection defaults", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      { ...claudeConnection, model: "connection-model", effort: "low" },
    );

    await provider.send("session-1", "Ship it", {
      requestId: "request-1",
      model: "prompt-model",
      effort: "high",
      subAgent: "reviewer",
      includeLocalSettings: true,
      promptSuggestions: false,
    });

    // A queued prompt carries the model, sub-agent and settings the user chose;
    // falling back to the connection default would silently change the model.
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: "prompt-model",
      effort: "high",
      agent: "reviewer",
      includeLocalSettings: true,
      promptSuggestions: false,
    });
  });

  test("attaches already-staged attachments without restaging them", async () => {
    const { provider, requests, staged } = httpProvider(
      () => new Response(null, { status: 204 }),
    );

    await provider.send("session-1", "Review this", {
      requestId: "request-1",
      attachments: [{
        type: "image",
        path: "/workspace/shot.png",
        filename: "shot.png",
        dataUrl: "data:image/png;base64,AA==",
      }],
    });

    expect(staged).toEqual([]);
    expect(JSON.parse(String(requests[0]!.init.body)).attachments).toEqual([{
      type: "image",
      path: "/workspace/shot.png",
      filename: "shot.png",
      dataUrl: "data:image/png;base64,AA==",
    }]);
  });

  test("keeps queued Claude plan turns in plan permission mode", async () => {
    const { provider, requests } = httpProvider(() =>
      new Response(null, { status: 204 }));

    await provider.send("session-1", "Inspect only", {
      requestId: "request-plan",
      mode: "plan",
    });

    expect(JSON.parse(String(requests[0]!.init.body)).permissionMode).toBe("plan");
  });

  test("rejects malformed session creation responses", async () => {
    const { provider } = httpProvider(() => Response.json({}));
    await expect(provider.createSession("build", "Build task"))
      .rejects.toThrow("malformed session");
  });

  test("forwards session idempotency and per-session codex model settings", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("build", "Build task", {
      clientSessionKey: "pipeline:task:attempt",
      model: "gpt-override",
      effort: "medium",
    });

    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      title: "Build task",
      model: "gpt-override",
      modelReasoningEffort: "medium",
      mode: "build",
      clientSessionKey: "pipeline:task:attempt",
    });
  });

  test("forwards an HTTP structured schema and omits an empty attachment list", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
    );
    const schema = { type: "object", properties: {} } as const;

    await provider.send("session-1", "Review it", {
      requestId: "request-1",
      schema,
    });

    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body.outputSchema).toEqual(schema);
    expect(body.attachments).toBeUndefined();
  });

  test("maps every valid HTTP status and malformed status to the provider contract", async () => {
    for (const [wireStatus, expected] of [
      ["running", "running"],
      ["idle", "idle"],
      ["error", "error"],
      ["unknown", "error"],
      [undefined, "error"],
    ] as const) {
      const { provider } = httpProvider(() => Response.json({ status: wireStatus }));
      await expect(provider.status("session-1")).resolves.toBe(expected);
    }
  });

  test("preserves the bridge failure detail from an errored session", async () => {
    const { provider } = httpProvider(() => Response.json({
      status: "error",
      error: "stream disconnected before completion",
    }), codexConnection);

    await expect(provider.status("session-1")).rejects.toThrow(
      "The codex session failed: stream disconnected before completion",
    );
  });

  test("preserves the session failure detail from the claude session route", async () => {
    const { provider } = httpProvider(() => Response.json({
      status: "error",
      error: "claude declined mid-turn",
    }));

    await expect(provider.status("session-1")).rejects.toThrow(
      "The claude session failed: claude declined mid-turn",
    );
  });

  test("readProviderStatus reports a failed turn as data instead of a throw", async () => {
    const { provider } = httpProvider(() => Response.json({
      status: "error",
      error: "Selected model is at capacity. Please try a different model.",
    }), codexConnection);

    await expect(readProviderStatus(provider, "session-1")).resolves.toEqual({
      status: "error",
      error: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("readProviderStatus still rejects a transport fault", async () => {
    const { provider } = httpProvider(
      () => new Response("boom", { status: 500 }),
      codexConnection,
    );

    await expect(readProviderStatus(provider, "session-1")).rejects.toThrow();
  });

  test("falls back to a plain error status when the session failure detail is empty", async () => {
    const { provider } = httpProvider(() => Response.json({
      status: "error",
      error: "   ",
    }), codexConnection);

    await expect(provider.status("session-1")).resolves.toBe("error");
  });

  test("maps missing and malformed HTTP transcripts to an empty list", async () => {
    const missing = httpProvider(() => new Response(null, { status: 404 }));
    await expect(missing.provider.messages("session-1")).resolves.toEqual([]);

    const malformed = httpProvider(() => Response.json({ messages: "invalid" }));
    await expect(malformed.provider.messages("session-1")).resolves.toEqual([]);
  });

  test("returns successful structured output and escapes its request id", async () => {
    const result = {
      ok: true,
      provider: "claude",
      requestId: "request/1",
      value: { complete: true },
    } as const;
    const { provider, requests } = httpProvider(() =>
      Response.json({ structuredOutput: result }));

    await expect(provider.structured("session/1", "request/1")).resolves.toEqual(
      result,
    );
    expect(requests[0]!.url).toBe(
      "http://claude.test/session/session%2F1/structured-output?requestId=request%2F1",
    );
  });

  test("aborts a bridge request after the configured deadline", async () => {
    const { provider } = httpProvider((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        }, { once: true });
      }));

    await expect(provider.status("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

