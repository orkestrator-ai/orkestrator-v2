import { describe, expect, mock, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import {
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
} from "@orkestrator/protocol/opencode-message-id";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
  type ProviderDependencies,
  type ProviderSessionRegistration,
} from "./build-pipeline-provider.js";
import { mimeTypeForFilename } from "./prompt-attachments.js";

const claudeConnection: BridgeConnection = {
  agent: "claude",
  baseUrl: "http://claude.test",
  authToken: "test-token",
  requestTimeoutMs: 25,
};

/** Mirrors `MAX_BODY_BYTES` in `bridges/acp-bridge/src/index.ts`. */
const ACP_BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;

type RequestRecord = {
  url: string;
  init: RequestInit;
};

const codexConnection: BridgeConnection = {
  agent: "codex",
  baseUrl: "http://codex.test",
  authToken: "codex-token",
  model: "gpt-5-codex",
  effort: "high",
  requestTimeoutMs: 25,
};

function httpProvider(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  connection: BridgeConnection = claudeConnection,
  options: { stageImages?: boolean } = {},
) {
  const requests: RequestRecord[] = [];
  const staged: TaskSnapshotImage[][] = [];
  const provider = createBuildPipelineProvider(connection, {
    fetch: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    stageImages: options.stageImages === false
      ? undefined
      : async (images) => {
          staged.push([...images]);
          return images.map((image) => ({
            type: "image" as const,
            path: `/workspace/.orkestrator/initial-prompt/${image.filename}`,
            filename: image.filename,
            dataUrl:
              `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
          }));
        },
  });
  return { provider, requests, staged };
}

function waitUntil(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (assertion()) {
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for provider activity"));
      } else {
        setTimeout(check, 1);
      }
    };
    check();
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function expectedOpenCodeMessageId(requestId: string): string {
  const encoded = Array.from(
    { length: requestId.length },
    (_, index) => requestId.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("");
  return `msg_00000000000000000000000000_ork_${encoded}`;
}

function declineResolution(request: AgentInteractionRequest): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "decline",
    resolvedAt: Math.max(Date.now(), request.createdAt),
  };
}

function answerResolution(request: AgentInteractionRequest): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "answer",
    resolvedAt: Math.max(Date.now(), request.createdAt),
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      answers: request.presentation.questions.map((question) => ({
        questionId: question.id,
        ...(question.options[0]
          ? { optionIds: [question.options[0].id] }
          : { freeText: "safe answer" }),
      })),
    },
  };
}

function freeTextResolution(
  request: AgentInteractionRequest,
  value: string,
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "answer",
    resolvedAt: Math.max(Date.now(), request.createdAt),
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      answers: [{
        questionId: request.presentation.questions[0]!.id,
        freeText: value,
      }],
    },
  };
}

describe("HTTP build pipeline provider", () => {
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

describe("provider-neutral interaction adapters", () => {
  test("Claude snapshots and exact response mapping satisfy the shared contract", async () => {
    const expiresAt = Date.now() + 60_000;
    let questions: Array<Record<string, unknown>> = [{
      id: "question-1",
      sessionId: "session-1",
      expiresAt,
      questions: [{
        question: "Choose",
        header: "Choice",
        options: [
          { label: "same", value: "exact-provider-value", description: "first" },
          { label: "same", description: "second" },
          { label: "comma,value" },
        ],
        multiSelect: true,
      }],
    }];
    let approvals: Array<Record<string, unknown>> = [{
      id: "approval-1",
      sessionId: "session-1",
      expiresAt,
    }];
    const upstream: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals });
      if (url.includes("/questions/question-1/answer")) {
        upstream.push({ url, body: JSON.parse(String(init.body)) });
        questions = [];
        return Response.json({ status: "answered" });
      }
      if (url.includes("/plan-approvals/approval-1/respond")) {
        upstream.push({ url, body: JSON.parse(String(init.body)) });
        approvals = [];
        return Response.json({ status: "rejected" });
      }
      return Response.json({ status: "idle" });
    });
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
    });
    const first = await provider.interactions!.listPendingInteractions("session-1");
    expect(first.requests.map((request) => request.kind)).toEqual([
      "question",
      "plan-approval",
    ]);
    expect(first.requests[0]!.origin).toBe("build-pipeline");
    expect(first.requests[0]!.presentation.questions[0]!.options.map((option) => option.id))
      .toEqual(["q0:o0", "q0:o1", "q0:o2"]);

    // A cached/adopted provider may be registered again, but a live request
    // keeps the policy it was presented under instead of switching owners.
    provider.registerSession?.("session-1", {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      phase: "chat",
    });
    expect((await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!.origin).toBe("build-pipeline");

    const question = first.requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "other-session",
      question.id,
      answerResolution(question),
    )).resolves.toMatchObject({ result: "rejected" });
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      question.id,
      answerResolution(question),
    )).resolves.toMatchObject({ result: "applied" });
    expect(upstream[0]!.body).toEqual({ answers: [["exact-provider-value"]] });

    const approval = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      { ...declineResolution(approval), feedback: "Add rollback steps" },
    )).resolves.toMatchObject({ result: "applied" });
    expect(upstream[1]!.body).toEqual({
      approved: false,
      feedback: "Add rollback steps",
    });
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      declineResolution(approval),
    )).resolves.toMatchObject({ result: "stale" });
  });

  test("lets the first real registration replace an implicit placeholder", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? {
            questions: [{
              id: "question-1",
              expiresAt,
              questions: [{ question: "Choose", options: [] }],
            }],
          }
        : { approvals: [] },
    ));

    // Reading a snapshot for an unknown session registers it implicitly with
    // DEFAULT_SESSION_REGISTRATION. That placeholder is not a decision, so it
    // must not out-rank the authoritative registration that follows — first
    // -write-wins protects a real policy from being flipped, not a default from
    // being filled in. Locking here would silently leave an unattended build
    // session on the interactive policy, where it stops auto-resolving.
    const implicit = await provider.interactions!.listPendingInteractions("session-1");
    expect(implicit.requests[0]!.origin).toBe("interactive-native");

    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    const afterRegistration = await provider.interactions!
      .listPendingInteractions("session-1");
    expect(afterRegistration.requests[0]!.origin).toBe("build-pipeline");
    const internal = provider as unknown as {
      interactionTracker: {
        registration(sessionId: string): ProviderSessionRegistration;
      };
    };
    expect(internal.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A second registration still cannot flip the live session back.
    provider.registerSession?.("session-1", {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    });
    expect(internal.interactionTracker.registration("session-1")).toMatchObject({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    });
  });

  test("fills in registration metadata a first caller did not know", async () => {
    const { provider } = httpProvider(() => Response.json({
      questions: [],
      approvals: [],
    }));
    const internal = provider as unknown as {
      interactionTracker: {
        registration(sessionId: string): ProviderSessionRegistration;
      };
    };

    // The activity sweep registers without a phase; the interaction reconciler
    // registers with one. Whichever lands first must not cost the other its
    // fields, so long as origin and policy agree.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
    });
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    expect(internal.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A recorded fence is never replaced: it identifies the generation that
    // owns any request already in flight.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-2",
      fence: "pipeline:build:2",
    });
    expect(internal.interactionTracker.registration("session-1")).toMatchObject({
      workflowId: "workflow-1",
      fence: "pipeline:build:1",
    });
  });

  test("Codex recovers from snapshots, rejects stale generations, and resolves once", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let approvals: Array<Record<string, unknown>> = [{
      approvalId: "approval-1",
      kind: "command",
      requestedAt,
      expiresAt,
      command: "safe-command",
    }];
    let interactions: Array<Record<string, unknown>> = [{
      interactionId: "question-1",
      kind: "question",
      requestedAt,
      expiresAt,
      generation: 1,
      questions: [{
        id: "language",
        header: "Language",
        question: "Choose",
        isOther: true,
        isSecret: false,
        options: [{ label: "TypeScript" }],
      }],
    }];
    const gate = deferred();
    let approvalResponses = 0;
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      if (url.includes("/approvals/approval-1")) {
        approvalResponses += 1;
        await gate.promise;
        approvals = [];
        return Response.json({ status: "applied", decision: JSON.parse(String(init.body)).decision });
      }
      if (url.includes("/interactions/question-1")) {
        interactions = [];
        return Response.json({ status: "applied" });
      }
      return Response.json({ status: "idle" });
    }, codexConnection);
    provider.registerSession?.("session-1", {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "discovery",
    });
    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map((request) => request.kind)).toEqual([
      "command-approval",
      "question",
    ]);
    const approval = snapshot.requests[0]!;
    const firstResolution = provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      declineResolution(approval),
    );
    await waitUntil(() => approvalResponses === 1);
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      declineResolution(approval),
    )).resolves.toMatchObject({ result: "already-resolved" });
    gate.resolve();
    await expect(firstResolution).resolves.toMatchObject({ result: "applied" });
    expect(approvalResponses).toBe(1);

    const question = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    expect(question.presentation.questions[0]?.multiple).toBe(false);
    interactions = [];
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      question.id,
      answerResolution(question),
    )).resolves.toMatchObject({ result: "stale" });
  });

  test("Codex presents actionable approval scope and round-trips every MCP variant", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let approvals: Array<Record<string, unknown>> = [
      {
        approvalId: "command-1",
        kind: "command",
        requestedAt,
        expiresAt,
        reason: "Needs package metadata",
        command: "bun install",
        cwd: "/workspace",
        networkHost: "registry.npmjs.org",
        actionable: true,
        supportsApproveForSession: true,
      },
      {
        approvalId: "file-1",
        kind: "file-change",
        requestedAt,
        expiresAt,
        changes: [{ path: "/workspace/a.ts", kind: "update" }],
        grantRoot: "/workspace",
        actionable: true,
      },
      {
        approvalId: "permission-1",
        kind: "permissions",
        requestedAt,
        expiresAt,
        permissions: { network: true, fileSystem: false },
        actionable: true,
      },
    ];
    let interactions: Array<Record<string, unknown>> = [
      {
        interactionId: "form-1",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        message: "Choose a region",
        schema: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
      },
      {
        interactionId: "url-1",
        kind: "mcp-url",
        requestedAt,
        expiresAt,
        message: "Authorize",
        url: "https://example.test/authorize",
      },
    ];
    const responses: Array<{ id: string; body: unknown }> = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      const approvalId = approvals.find(({ approvalId }) => url.endsWith(`/${approvalId}`))
        ?.approvalId as string | undefined;
      if (approvalId) {
        responses.push({ id: approvalId, body: JSON.parse(String(init.body)) });
        approvals = approvals.filter((entry) => entry.approvalId !== approvalId);
        return Response.json({ status: "applied" });
      }
      const interactionId = interactions.find(({ interactionId }) =>
        url.endsWith(`/${interactionId}`))?.interactionId as string | undefined;
      if (interactionId) {
        responses.push({ id: interactionId, body: JSON.parse(String(init.body)) });
        interactions = interactions.filter((entry) => entry.interactionId !== interactionId);
        return Response.json({ status: "applied" });
      }
      return new Response(null, { status: 404 });
    }, codexConnection);

    const first = await provider.interactions!.listPendingInteractions("session-1");
    expect(first.requests.map(({ kind }) => kind)).toEqual([
      "command-approval",
      "file-approval",
      "permission",
      "mcp-form",
      "mcp-url",
    ]);
    expect(first.requests[0]!.presentation.body).toContain("Reason: Needs package metadata");
    expect(first.requests[0]!.presentation.body).toContain("Command: bun install");
    expect(first.requests[0]!.presentation.body).toContain("Network host: registry.npmjs.org");
    expect(first.requests[0]!.presentation.approveForSessionLabel)
      .toBe("Approve for session");
    expect(first.requests[1]!.presentation.body).toContain("Change: update: /workspace/a.ts");
    expect(first.requests[2]!.presentation.body).toContain("Permissions: network");
    expect(first.requests[3]!.presentation.questions).toHaveLength(1);
    expect(first.requests[3]!.presentation.questions[0]!.description)
      .toContain('"region"');

    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      first.requests[0]!.id,
      {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: first.requests[0]!.id,
        sessionId: first.requests[0]!.sessionId,
        action: "approve-for-session",
        resolvedAt: Math.max(Date.now(), first.requests[0]!.createdAt),
      },
    )).resolves.toMatchObject({ result: "applied" });
    for (const approval of first.requests.slice(1, 3)) {
      await expect(provider.interactions!.resolveInteraction(
        "session-1",
        approval!.id,
        answerResolution(approval!),
      )).resolves.toMatchObject({ result: "applied" });
    }
    const form = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests.find(({ kind }) => kind === "mcp-form")!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      form.id,
      freeTextResolution(form, JSON.stringify({ region: "eu-west-1" })),
    )).resolves.toMatchObject({ result: "applied" });
    const urlRequest = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests.find(({ kind }) => kind === "mcp-url")!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      urlRequest.id,
      answerResolution(urlRequest),
    )).resolves.toMatchObject({ result: "applied" });

    expect(responses).toEqual([
      { id: "command-1", body: { decision: "approve-for-session" } },
      { id: "file-1", body: { decision: "approve" } },
      { id: "permission-1", body: { decision: "approve" } },
      { id: "form-1", body: { action: "accept", content: { region: "eu-west-1" } } },
      { id: "url-1", body: { action: "accept" } },
    ]);
  });

  test("Codex isolates malformed siblings and degrades large file and MCP payloads", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const approvals = [
      { approvalId: "bad", kind: "future", requestedAt, expiresAt },
      {
        approvalId: "files",
        kind: "file-change",
        requestedAt,
        expiresAt,
        changes: Array.from({ length: 64 }, (_, index) => ({
          path: `/workspace/file-${index}.ts`,
          kind: "update",
        })),
      },
    ];
    let interactions: Array<Record<string, unknown>> = [
      {
        interactionId: "form",
        kind: "mcp-form",
        requestedAt,
        expiresAt,
        message: "x".repeat(20_000),
      },
      {
        interactionId: "question",
        kind: "question",
        requestedAt,
        expiresAt,
        questions: [{
          id: "language",
          question: "Choose",
          options: [{ label: "TypeScript" }],
        }],
      },
    ];
    let answerBody: unknown;
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      if (url.includes("/interactions/question")) {
        answerBody = JSON.parse(String(init.body));
        interactions = interactions.filter(({ interactionId }) => interactionId !== "question");
        return Response.json({ status: "applied" });
      }
      return Response.json({ status: "applied" });
    }, codexConnection);

    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map(({ kind }) => kind)).toEqual([
      "file-approval",
      "mcp-form",
      "question",
    ]);
    const file = snapshot.requests[0]!;
    const form = snapshot.requests[1]!;
    const question = snapshot.requests[2]!;
    expect(file.presentation.body).toContain("… and 16 more files");
    expect(form.presentation.body?.length).toBe(AGENT_INTERACTION_LIMITS.maxTextLength);
    expect(form.presentation.questions[0]!.description).toBe("{}");
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      question.id,
      answerResolution(question),
    )).resolves.toMatchObject({ result: "applied" });
    expect(answerBody).toEqual({
      action: "accept",
      answers: { language: ["TypeScript"] },
    });
  });

  test("HTTP bridge questions remain pending without using the OpenCode observation hook", async () => {
    const requestedAt = Date.now();
    let observations = 0;
    let writes = 0;
    const provider = createBuildPipelineProvider(codexConnection, {
      fetch: (async (input, init = {}) => {
        const url = String(input);
        if (init.method && init.method !== "GET") writes += 1;
        return Response.json(url.endsWith("/approvals")
          ? { approvals: [] }
          : {
              interactions: [{
                interactionId: "question",
                kind: "question",
                requestedAt,
                expiresAt: requestedAt + 60_000,
                questions: [{ id: "q1", question: "Continue?", options: [] }],
              }],
            });
      }) as typeof fetch,
      onInteractionObservation: () => {
        observations += 1;
      },
    });
    await expect(provider.interactions!.listPendingInteractions("session-1"))
      .resolves.toMatchObject({
        requests: [expect.objectContaining({ kind: "question" })],
      });
    expect(observations).toBe(0);
    expect(writes).toBe(0);
  });

  test("Codex refuses positive approval and malformed MCP form content without actionable detail", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const approvals = [{
      approvalId: "missing-detail",
      kind: "file-change",
      requestedAt,
      expiresAt,
      reason: "Change requested",
      actionable: true,
    }];
    const interactions = [{
      interactionId: "form-1",
      kind: "mcp-form",
      requestedAt,
      expiresAt,
      schema: { type: "object", properties: {} },
    }];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      writes += 1;
      return Response.json({ status: "applied" });
    }, codexConnection);
    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    const approval = snapshot.requests.find(({ kind }) => kind === "file-approval")!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      approval.id,
      answerResolution(approval),
    )).resolves.toMatchObject({ result: "rejected" });
    const form = snapshot.requests.find(({ kind }) => kind === "mcp-form")!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      form.id,
      freeTextResolution(form, "not json"),
    )).resolves.toMatchObject({ result: "rejected" });
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      form.id,
      freeTextResolution(form, JSON.stringify(["not", "an", "object"])),
    )).resolves.toMatchObject({ result: "rejected" });
    expect(writes).toBe(0);

    const malformedFileChange = httpProvider((url) => Response.json(
      url.endsWith("/approvals")
        ? {
            approvals: [{
              approvalId: "malformed-file",
              kind: "file-change",
              requestedAt,
              expiresAt,
              changes: [{}],
              actionable: true,
            }],
          }
        : { interactions: [] },
    ), codexConnection);
    await expect(malformedFileChange.provider.interactions!
      .listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test("OpenCode lists input and authorization without auto-answering and preserves values", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [{
        id: "permission-1",
        sessionID: "owned-session",
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      }],
      [{
        id: "question-1",
        sessionID: "owned-session",
        questions: [{
          question: "Choose",
          header: "Choice",
          options: [{ label: "comma,value", description: "kept intact" }],
          multiple: false,
          custom: true,
        }],
      }],
    );
    const provider = openCodeActivityProvider(fake);
    provider.registerSession?.("owned-session", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
    });
    const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
    expect(snapshot.requests.map((request) => request.kind)).toEqual([
      "question",
      "permission",
    ]);
    expect(fake.permissionReplies).toEqual([]);
    expect(fake.questionRejections).toEqual([]);

    const question = snapshot.requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "owned-session",
      question.id,
      answerResolution(question),
    )).resolves.toMatchObject({ result: "applied" });
    expect(fake.questionReplies[0]).toMatchObject({
      requestID: "question-1",
      answers: [["comma,value"]],
    });
    const permission = (await provider.interactions!.listPendingInteractions("owned-session"))
      .requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "owned-session",
      permission.id,
      declineResolution(permission),
    )).resolves.toMatchObject({ result: "applied" });
    expect(fake.permissionReplies[0]).toMatchObject({
      requestID: "permission-1",
      reply: "reject",
    });
    await provider.dispose?.();
  });

  test("OpenCode preserves multi-select and free text, presents permission scope, and resolves once", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [{
        id: "permission-1",
        sessionID: "owned-session",
        permission: "edit",
        patterns: ["src/**", "package.json"],
        metadata: {},
        always: ["src/**"],
      }],
      [{
        id: "question-1",
        sessionID: "owned-session",
        questions: [{
          question: "Choose targets",
          header: "Targets",
          options: [{ label: "one" }, { label: "two" }],
          multiple: true,
          custom: true,
        }],
      }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const first = await provider.interactions!.listPendingInteractions("owned-session");
      const question = first.requests.find(({ kind }) => kind === "question")!;
      const q = question.presentation.questions[0]!;
      const answer: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: question.id,
        sessionId: question.sessionId,
        action: "answer",
        resolvedAt: Math.max(Date.now(), question.createdAt),
        answer: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: question.id,
          sessionId: question.sessionId,
          answers: [{
            questionId: q.id,
            optionIds: q.options.map(({ id }) => id),
            freeText: "custom, value",
          }],
        },
      };
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        question.id,
        answer,
      )).resolves.toMatchObject({ result: "applied" });
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        question.id,
        answer,
      )).resolves.toMatchObject({ result: "stale" });
      expect(fake.questionReplies).toHaveLength(1);
      expect(fake.questionReplies[0]).toMatchObject({
        requestID: "question-1",
        answers: [["one", "two", "custom, value"]],
      });

      const permission = (await provider.interactions!
        .listPendingInteractions("owned-session")).requests[0]!;
      expect(permission.presentation.body).toContain("Permission: edit");
      expect(permission.presentation.body).toContain("Resource: src/**");
      expect(permission.presentation.body).toContain("Resource: package.json");
      expect(permission.presentation.approveForSessionLabel).toBe("Always allow");
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        permission.id,
        {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: permission.id,
          sessionId: permission.sessionId,
          action: "approve-for-session",
          resolvedAt: Math.max(Date.now(), permission.createdAt),
        },
      )).resolves.toMatchObject({ result: "applied" });
      expect(fake.permissionReplies[0]).toMatchObject({
        requestID: "permission-1",
        reply: "always",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode serializes concurrent resolution of the same interaction", async () => {
    const fake = openCodeFake();
    fake.setPending([], [{
      id: "question-1",
      sessionID: "owned-session",
      questions: [{ question: "Choose", options: [] }],
    }]);
    const provider = openCodeActivityProvider(fake);
    const gate = deferred();
    fake.setQuestionReplyGate(gate.promise);
    try {
      const request = (await provider.interactions!
        .listPendingInteractions("owned-session")).requests[0]!;
      const first = provider.interactions!.resolveInteraction(
        "owned-session",
        request.id,
        answerResolution(request),
      );
      await waitUntil(() => fake.questionReplies.length === 1);
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        request.id,
        answerResolution(request),
      )).resolves.toMatchObject({ result: "already-resolved" });
      gate.resolve();
      await expect(first).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionReplies).toHaveLength(1);
    } finally {
      gate.resolve();
      await provider.dispose?.();
    }
  });

  test("OpenCode reconciles ambiguous interaction writes without guessing", async () => {
    for (const [applied, expected] of [
      [true, "applied"],
      [false, "provider-unavailable"],
    ] as const) {
      const fake = openCodeFake();
      fake.setPending([], [{
        id: "question-1",
        sessionID: "owned-session",
        questions: [{ question: "Choose", options: [] }],
      }]);
      const provider = openCodeActivityProvider(fake);
      try {
        const request = (await provider.interactions!
          .listPendingInteractions("owned-session")).requests[0]!;
        fake.setQuestionReplyFailure(new TypeError("connection reset"), applied);
        await expect(provider.interactions!.resolveInteraction(
          "owned-session",
          request.id,
          answerResolution(request),
        )).resolves.toMatchObject({ result: expected });
        expect(fake.questionReplies).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode rejects unscoped positive permissions and maps question cancel to reject", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [{
        id: "permission-1",
        sessionID: "owned-session",
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      }],
      [{
        id: "question-1",
        sessionID: "owned-session",
        questions: [{ question: "Continue?", options: [], custom: true }],
      }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
      const permission = snapshot.requests.find(({ kind }) => kind === "permission")!;
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        permission.id,
        answerResolution(permission),
      )).resolves.toMatchObject({ result: "rejected" });
      expect(fake.permissionReplies).toHaveLength(0);

      const question = snapshot.requests.find(({ kind }) => kind === "question")!;
      await expect(provider.interactions!.resolveInteraction(
        "owned-session",
        question.id,
        {
          ...declineResolution(question),
          action: "cancel",
        },
      )).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionRejections).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode fails closed on malformed, globally oversized, and overlong-id list payloads", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ data: {} }, { data: [] }],
      [{ data: [{
        id: "permission-1",
        sessionID: "owned-session",
        permission: "edit",
        patterns: [123],
        metadata: {},
        always: [],
      }] }, { data: [] }],
      [{ data: [{
        id: "permission-1",
        sessionID: "owned-session",
        permission: "edit",
        patterns: ["x".repeat(300_000)],
        metadata: {},
        always: [],
      }] }, { data: [] }],
      [{ data: [] }, { data: [{
        id: "x".repeat(513),
        sessionID: "owned-session",
        questions: [{ question: "Choose", options: [] }],
      }] }],
    ];
    for (const [permissions, questions] of cases) {
      const fake = openCodeFake();
      fake.setPendingReadResponses(permissions, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.interactions!.listPendingInteractions("owned-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode ignores malformed foreign entries and tolerates an absent list payload", async () => {
    const fake = openCodeFake();
    fake.setPendingReadResponses({ data: [{
      id: "permission-foreign",
      sessionID: "x".repeat(513),
      permission: "edit",
      patterns: ["x".repeat(300_000)],
    }] }, { data: null });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.interactions!.listPendingInteractions("owned-session"))
        .resolves.toMatchObject({ requests: [] });
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
    } finally {
      await provider.dispose?.();
    }
  });

  test("all adapters fail closed on malformed or oversized authoritative snapshots", async () => {
    const oversized = "x".repeat(300_000);
    const claude = httpProvider(() => new Response(oversized));
    await expect(claude.provider.interactions!.listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const codex = httpProvider((url) => url.endsWith("/approvals")
      ? Response.json({ approvals: [{ approvalId: "bad", kind: "future" }] })
      : Response.json({ interactions: [] }), codexConnection);
    await expect(codex.provider.interactions!.listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const fake = openCodeFake();
    fake.setPending([], [{ id: "bad", sessionID: "session-1", questions: [] }]);
    const opencode = openCodeActivityProvider(fake);
    await expect(opencode.interactions!.listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await opencode.dispose?.();

    const malformedClaudeQuestion = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? {
            questions: [{
              id: "bad-question",
              questions: [{ question: "Choose", options: [{}] }],
            }],
          }
        : { approvals: [] },
    ));
    await expect(malformedClaudeQuestion.provider.interactions!
      .listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const now = Date.now();
    const malformedCodexQuestion = httpProvider((url) => Response.json(
      url.endsWith("/approvals")
        ? { approvals: [] }
        : {
            interactions: [{
              interactionId: "bad-question",
              kind: "question",
              requestedAt: now,
              expiresAt: now + 60_000,
              questions: [{ id: "q1", options: [] }],
            }],
          }
    ), codexConnection);
    await expect(malformedCodexQuestion.provider.interactions!
      .listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const malformedOpenCodeQuestion = openCodeFake();
    malformedOpenCodeQuestion.setPending([], [{
      id: "bad-option",
      sessionID: "session-1",
      questions: [{ question: "Choose", options: [{}] }],
    }]);
    const malformedOpenCodeProvider = openCodeActivityProvider(
      malformedOpenCodeQuestion,
    );
    await expect(malformedOpenCodeProvider.interactions!
      .listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await malformedOpenCodeProvider.dispose?.();

    for (const body of ["{", null] as const) {
      const malformed = httpProvider(() => new Response(body, { status: 200 }));
      await expect(malformed.provider.interactions!
        .listPendingInteractions("session-1"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("HTTP adapters bound the combined snapshot and scope opaque IDs to a session", async () => {
    const combinedOversized = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? { questions: [], padding: "x".repeat(140_000) }
        : { approvals: [], padding: "x".repeat(140_000) },
    ));
    await expect(combinedOversized.provider.interactions!.listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const expiresAt = Date.now() + 60_000;
    const responses: string[] = [];
    const scoped = httpProvider((url) => {
      const sessionId = url.includes("session-a") ? "session-a" : "session-b";
      if (url.endsWith("/questions")) {
        return Response.json({
          questions: [{
            id: "same-provider-id",
            expiresAt,
            questions: [{ question: sessionId, options: [] }],
          }],
        });
      }
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      responses.push(url);
      return Response.json({ status: "answered" });
    });
    const requestA = (await scoped.provider.interactions!
      .listPendingInteractions("session-a")).requests[0]!;
    const requestB = (await scoped.provider.interactions!
      .listPendingInteractions("session-b")).requests[0]!;
    expect(requestA.id).not.toBe(requestB.id);
    await expect(scoped.provider.interactions!.resolveInteraction(
      "session-a",
      requestB.id,
      answerResolution(requestB),
    )).resolves.toMatchObject({ result: "rejected" });
    expect(responses).toEqual([]);
  });

  test("HTTP interaction snapshots keep stable revisions and advance on every authoritative reset", async () => {
    const expiresAt = Date.now() + 60_000;
    let questions: Array<Record<string, unknown>> = [];
    const { provider } = httpProvider((url) => Response.json(
      url.endsWith("/questions") ? { questions } : { approvals: [] },
    ));
    const empty = await provider.interactions!.listPendingInteractions("session-1");
    const sameEmpty = await provider.interactions!.listPendingInteractions("session-1");
    expect(sameEmpty.revision).toBe(empty.revision);

    questions = [{
      id: "question-1",
      expiresAt,
      questions: [{ question: "Choose", options: [] }],
    }];
    const pending = await provider.interactions!.listPendingInteractions("session-1");
    const samePending = await provider.interactions!.listPendingInteractions("session-1");
    expect(pending.revision).toBe(empty.revision + 1);
    expect(samePending.revision).toBe(pending.revision);
    expect(samePending.requests[0]!.revision).toBe(pending.revision);

    questions = [];
    const reset = await provider.interactions!.listPendingInteractions("session-1");
    expect(reset.revision).toBe(pending.revision + 1);
    expect(reset.requests).toEqual([]);
  });

  test("bounds tracker sessions, interaction identities, and pending snapshots", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider(() => Response.json({ questions: [], approvals: [] }));
    const internal = provider as unknown as {
      interactionTracker: {
        registrations: Map<string, ProviderSessionRegistration>;
        firstSeenAt: Map<string, number>;
        interactionSessions: Map<string, string>;
        registration(sessionId: string): ProviderSessionRegistration;
        firstSeen(interactionId: string, fallback?: number): number;
        sessionFor(interactionId: string): string | undefined;
        snapshot(
          sessionId: string,
          requests: AgentInteractionRequest[],
        ): unknown;
      };
      providerInteractionIds: Map<string, unknown>;
      mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest;
    };
    for (let index = 0; index < 1_025; index += 1) {
      provider.registerSession?.(`session-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: `phase-${index}`,
      });
    }
    expect(internal.interactionTracker.registrations.size).toBe(1_024);
    expect(internal.interactionTracker.registration("session-0").origin)
      .toBe("interactive-native");
    expect(internal.interactionTracker.registration("session-1024").phase)
      .toBe("phase-1024");

    let oldestInteractionId = "";
    let newestInteractionId = "";
    let newestSessionId = "";
    for (let offset = 0; offset < 4_097; offset += 64) {
      const trackerSessionId = `tracker-session-${Math.floor(offset / 64)}`;
      const batch = Array.from(
        { length: Math.min(64, 4_097 - offset) },
        (_, batchIndex) => {
          const index = offset + batchIndex;
          const mapped = internal.mapClaudeQuestion(trackerSessionId, {
            id: `question-${index}`,
            expiresAt,
            questions: [{ question: `Question ${index}`, options: [] }],
          });
          internal.interactionTracker.firstSeen(mapped.id, index);
          oldestInteractionId ||= mapped.id;
          newestInteractionId = mapped.id;
          newestSessionId = trackerSessionId;
          return mapped;
        },
      );
      internal.interactionTracker.snapshot(trackerSessionId, batch);
    }
    expect(internal.providerInteractionIds.size).toBe(4_096);
    expect(internal.interactionTracker.firstSeenAt.size).toBe(4_096);
    expect(internal.interactionTracker.interactionSessions.size).toBe(4_096);
    expect(internal.providerInteractionIds.has(oldestInteractionId)).toBe(false);
    expect(internal.interactionTracker.firstSeenAt.has(oldestInteractionId)).toBe(false);
    expect(internal.interactionTracker.sessionFor(oldestInteractionId)).toBeUndefined();
    expect(internal.providerInteractionIds.has(newestInteractionId)).toBe(true);
    expect(internal.interactionTracker.firstSeenAt.has(newestInteractionId)).toBe(true);
    expect(internal.interactionTracker.sessionFor(newestInteractionId)).toBe(newestSessionId);

    const tooMany = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? {
            questions: Array.from({ length: 65 }, (_, index) => ({
              id: `question-${index}`,
              expiresAt,
              questions: [{ question: `Question ${index}`, options: [] }],
            })),
          }
        : { approvals: [] },
    ));
    await expect(tooMany.provider.interactions!
      .listPendingInteractions("session-1"))
      .resolves.toMatchObject({ requests: expect.any(Array) });
  });

  test("accepts a new policy only after a tracked session is evicted", async () => {
    const { provider } = httpProvider(() => Response.json({ questions: [], approvals: [] }));
    const internal = provider as unknown as {
      interactionTracker: {
        registrations: Map<string, ProviderSessionRegistration>;
        registration(sessionId: string): ProviderSessionRegistration;
      };
    };
    const unattended: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    };
    provider.registerSession?.("session-0", unattended);
    // The whole registration round-trips, not just origin/policy: unattended
    // adoption is decided from the workflow ownership fence.
    expect(internal.interactionTracker.registration("session-0")).toEqual(unattended);

    // One insert past MAX_TRACKED_INTERACTION_SESSIONS drops the oldest entry,
    // which is the session registered first.
    for (let index = 1; index <= 1_024; index += 1) {
      provider.registerSession?.(`filler-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    }
    expect(internal.interactionTracker.registrations.size).toBe(1_024);
    expect(internal.interactionTracker.registrations.has("session-0")).toBe(false);

    // First-write-wins protects a *live* entry. Once evicted there is no policy
    // left to preserve, so the next registration is accepted outright.
    const interactive: ProviderSessionRegistration = {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      phase: "chat",
      workflowId: "workflow-2",
      provider: "claude",
      fence: 2,
    };
    provider.registerSession?.("session-0", interactive);
    expect(internal.interactionTracker.registration("session-0")).toEqual(interactive);
  });

  test("rejects oversized HTTP identities before retaining tracker state", async () => {
    const oversizedId = "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1);
    const { provider } = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? {
            questions: [{
              id: oversizedId,
              questions: [{ question: "Choose", options: [] }],
            }],
          }
        : { approvals: [] },
    ));
    const internal = provider as unknown as {
      providerInteractionIds: Map<string, unknown>;
      interactionTracker: {
        fingerprints: Map<string, string>;
        revisions: Map<string, number>;
        interactionSessions: Map<string, string>;
      };
    };

    await expect(provider.interactions!.listPendingInteractions("session-1"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(internal.providerInteractionIds.size).toBe(0);
    expect(internal.interactionTracker.fingerprints.size).toBe(0);
    expect(internal.interactionTracker.revisions.size).toBe(0);
    expect(internal.interactionTracker.interactionSessions.size).toBe(0);
  });

  test.each([
    [404, "stale"],
    [409, "stale"],
    [503, "provider-unavailable"],
    [400, "rejected"],
    [204, "provider-unavailable"],
  ] as const)("classifies an HTTP %s interaction response as %s", async (
    responseStatus,
    expected,
  ) => {
    const expiresAt = Date.now() + 60_000;
    const questions = [{
      id: "question-1",
      expiresAt,
      questions: [{ question: "Choose", options: [] }],
    }];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      writes += 1;
      return new Response(null, { status: responseStatus });
    });
    const request = (await provider.interactions!
      .listPendingInteractions("session-1")).requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      request.id,
      answerResolution(request),
    )).resolves.toMatchObject({ result: expected });
    expect(writes).toBe(1);
  });

  test("reconciles ambiguous HTTP interaction writes and rejects expired resolutions", async () => {
    const createdAt = Date.now() - 120_000;
    let questions: Array<Record<string, unknown>> = [{
      id: "question-1",
      expiresAt: Date.now() + 60_000,
      questions: [{ question: "Choose", options: [] }],
    }];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      writes += 1;
      questions = [];
      throw new TypeError("connection reset");
    });
    const request = (await provider.interactions!
      .listPendingInteractions("session-1")).requests[0]!;
    await expect(provider.interactions!.resolveInteraction(
      "session-1",
      request.id,
      answerResolution(request),
    )).resolves.toMatchObject({ result: "applied" });
    expect(writes).toBe(1);

    const expiredQuestions = [{
      id: "expired",
      expiresAt: createdAt + 1,
      questions: [{ question: "Too late", options: [] }],
    }];
    const expiredProvider = httpProvider((url) => Response.json(
      url.endsWith("/questions")
        ? { questions: expiredQuestions }
        : { approvals: [] },
    )).provider;
    const expired = (await expiredProvider.interactions!
      .listPendingInteractions("session-1")).requests[0]!;
    await expect(expiredProvider.interactions!.resolveInteraction(
      "session-1",
      expired.id,
      answerResolution(expired),
    )).resolves.toMatchObject({ result: "stale" });
  });

  test("fails closed when HTTP interaction write reconciliation cannot prove application", async () => {
    const expiresAt = Date.now() + 60_000;
    const question = {
      id: "question-1",
      expiresAt,
      questions: [{ question: "Choose", options: [] }],
    };
    for (const successfulWrite of [false, true]) {
      let wrote = false;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/questions")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ questions: [question] });
        }
        if (url.endsWith("/plan-approvals")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ approvals: [] });
        }
        wrote = true;
        if (!successfulWrite) throw new TypeError("connection reset");
        return Response.json({ status: "answered" });
      });
      const request = (await provider.interactions!
        .listPendingInteractions("session-1")).requests[0]!;
      await expect(provider.interactions!.resolveInteraction(
        "session-1",
        request.id,
        answerResolution(request),
      )).resolves.toMatchObject({ result: "provider-unavailable" });
    }
  });
});

type EventHarness = {
  stream: AsyncIterable<unknown>;
  push(value: unknown): void;
  close(): void;
};

function eventHarness(signal: AbortSignal): EventHarness {
  const queued: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  };
  // A signal that was already aborted before subscribe() ran never fires the
  // event, so listening alone would leave the stream open forever and hang the
  // dispose() that did the aborting. A real SSE client rejects outright here.
  if (signal.aborted) closed = true;
  signal.addEventListener("abort", close, { once: true });
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (queued.length > 0) {
              return Promise.resolve({ done: false, value: queued.shift() });
            }
            if (closed) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else queued.push(value);
    },
    close,
  };
}

type OpenCodeFake = {
  abortCalls: Array<Record<string, unknown> | undefined>;
  createCalls: Array<Record<string, unknown> | undefined>;
  messageCalls: Array<Record<string, unknown> | undefined>;
  promptCalls: Array<Record<string, unknown>>;
  commandDispatchCalls: Array<Record<string, unknown>>;
  commandListCalls: Array<Record<string, unknown> | undefined>;
  setCommandListResponse(response: { data?: unknown[] }): void;
  setPromptError(error: unknown): void;
  setPromptGate(gate: Promise<void> | null): void;
  client: OpencodeClient;
  readonly permissionListCallCount: number;
  permissionListCalls: Array<Record<string, unknown> | undefined>;
  permissionReplies: Array<Record<string, unknown>>;
  readonly questionListCallCount: number;
  questionListCalls: Array<Record<string, unknown> | undefined>;
  questionRejections: Array<Record<string, unknown>>;
  questionReplies: Array<Record<string, unknown>>;
  readonly statusCallCount: number;
  statusCalls: Array<Record<string, unknown> | undefined>;
  statusOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly sessionGetCallCount: number;
  sessionGetCalls: Array<Record<string, unknown>>;
  sessionGetOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly sessionListCallCount: number;
  sessionListCalls: Array<Record<string, unknown> | undefined>;
  sessionListOptions: Array<{ signal?: AbortSignal } | undefined>;
  readonly subscribeCallCount: number;
  subscriptions: EventHarness[];
  setPending(
    permissions: Array<Record<string, unknown>>,
    questions: Array<Record<string, unknown>>,
  ): void;
  setPendingReadGate(gate: Promise<void> | null): void;
  setPendingReadResponses(
    permissions: Record<string, unknown> | null,
    questions: Record<string, unknown> | null,
  ): void;
  setPendingReadErrors(
    permissions: unknown | null,
    questions: unknown | null,
  ): void;
  setPermissionReplyResponse(response: Record<string, unknown>): void;
  setQuestionRejectResponse(response: Record<string, unknown>): void;
  setQuestionReplyResponse(response: Record<string, unknown>): void;
  setQuestionReplyGate(gate: Promise<void>): void;
  setQuestionReplyFailure(error: unknown, applied: boolean): void;
  setSubscribeFailures(failures: Array<"throw" | "missing-stream">): void;
  setMessagesResponse(response: Record<string, unknown>): void;
  setMessagesHandler(
    handler: ((parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null,
  ): void;
  setAbortResponse(response: Record<string, unknown>): void;
  setCreateResponse(response: Record<string, unknown>): void;
  setPromptResponse(response: Record<string, unknown>): void;
  setStatusError(error: unknown): void;
  setStatusResponse(response: Record<string, unknown>): void;
  setSessionListError(error: unknown): void;
  setSessionListResponse(response: Record<string, unknown>): void;
  setSessionGetError(error: unknown): void;
  setSessionGetResponse(
    sessionId: string,
    response: Record<string, unknown>,
  ): void;
};

function openCodeFake(): OpenCodeFake {
  const abortCalls: Array<Record<string, unknown> | undefined> = [];
  const createCalls: Array<Record<string, unknown> | undefined> = [];
  const messageCalls: Array<Record<string, unknown> | undefined> = [];
  const permissionReplies: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const commandDispatchCalls: Array<Record<string, unknown>> = [];
  const commandListCalls: Array<Record<string, unknown> | undefined> = [];
  let commandListResponse: { data?: unknown[] } = { data: [] };
  let promptError: unknown = null;
  let promptGate: Promise<void> | null = null;
  const questionRejections: Array<Record<string, unknown>> = [];
  const questionReplies: Array<Record<string, unknown>> = [];
  const subscriptions: EventHarness[] = [];
  let subscribeCallCount = 0;
  let subscribeFailures: Array<"throw" | "missing-stream"> = [];
  let permissionListCallCount = 0;
  let questionListCallCount = 0;
  const permissionListCalls: Array<Record<string, unknown> | undefined> = [];
  const questionListCalls: Array<Record<string, unknown> | undefined> = [];
  let pendingPermissions: Array<Record<string, unknown>> = [];
  let pendingQuestions: Array<Record<string, unknown>> = [];
  let pendingReadGate: Promise<void> | null = null;
  let permissionListResponse: Record<string, unknown> | null = null;
  let questionListResponse: Record<string, unknown> | null = null;
  let permissionListError: unknown = null;
  let questionListError: unknown = null;
  let permissionReplyResponse: Record<string, unknown> = { data: true };
  let questionRejectResponse: Record<string, unknown> = { data: true };
  let questionReplyResponse: Record<string, unknown> = { data: true };
  let questionReplyGate: Promise<void> = Promise.resolve();
  let questionReplyFailure: { error: unknown; applied: boolean } | null = null;
  let messagesResponse: Record<string, unknown> = { data: [] };
  let messagesHandler:
    ((parameters?: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | null = null;
  let abortResponse: Record<string, unknown> = { data: true };
  let createResponse: Record<string, unknown> = { data: { id: "owned-session" } };
  let promptResponse: Record<string, unknown> = { data: true };
  let statusError: unknown = null;
  const statusCalls: Array<Record<string, unknown> | undefined> = [];
  const statusOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  let statusResponse: Record<string, unknown> = {
    data: { "owned-session": { type: "idle" } },
  };
  let sessionListError: unknown = null;
  const sessionListCalls: Array<Record<string, unknown> | undefined> = [];
  const sessionListOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  let sessionListResponse: Record<string, unknown> = {
    data: [{ id: "owned-session" }],
  };
  let sessionGetError: unknown = null;
  const sessionGetCalls: Array<Record<string, unknown>> = [];
  const sessionGetOptions: Array<{ signal?: AbortSignal } | undefined> = [];
  const sessionGetResponses = new Map<string, Record<string, unknown>>();

  const client = {
    event: {
      async subscribe(
        _parameters: unknown,
        options: { signal: AbortSignal },
      ) {
        subscribeCallCount += 1;
        const failure = subscribeFailures.shift();
        if (failure === "throw") throw new Error("subscribe failed");
        if (failure === "missing-stream") return { data: true };
        const harness = eventHarness(options.signal);
        subscriptions.push(harness);
        return { stream: harness.stream };
      },
    },
    permission: {
      async list(parameters?: Record<string, unknown>) {
        permissionListCallCount += 1;
        permissionListCalls.push(parameters);
        await pendingReadGate;
        if (permissionListError) throw permissionListError;
        return permissionListResponse ?? { data: pendingPermissions };
      },
      async reply(parameters: Record<string, unknown>) {
        permissionReplies.push(parameters);
        if (!permissionReplyResponse.error) {
          pendingPermissions = pendingPermissions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return permissionReplyResponse;
      },
    },
    question: {
      async list(parameters?: Record<string, unknown>) {
        questionListCallCount += 1;
        questionListCalls.push(parameters);
        await pendingReadGate;
        if (questionListError) throw questionListError;
        return questionListResponse ?? { data: pendingQuestions };
      },
      async reject(parameters: Record<string, unknown>) {
        questionRejections.push(parameters);
        if (!questionRejectResponse.error) {
          pendingQuestions = pendingQuestions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return questionRejectResponse;
      },
      async reply(parameters: Record<string, unknown>) {
        questionReplies.push(parameters);
        await questionReplyGate;
        if (questionReplyFailure) {
          if (questionReplyFailure.applied) {
            pendingQuestions = pendingQuestions.filter(
              ({ id }) => id !== parameters.requestID,
            );
          }
          throw questionReplyFailure.error;
        }
        if (!questionReplyResponse.error) {
          pendingQuestions = pendingQuestions.filter(
            ({ id }) => id !== parameters.requestID,
          );
        }
        return questionReplyResponse;
      },
    },
    session: {
      async create(parameters?: Record<string, unknown>) {
        createCalls.push(parameters);
        return createResponse;
      },
      async promptAsync(parameters: Record<string, unknown>) {
        promptCalls.push(parameters);
        await promptGate;
        if (promptError) throw promptError;
        return promptResponse;
      },
      async status(
        parameters?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        statusCalls.push(parameters);
        statusOptions.push(options);
        if (statusError) throw statusError;
        return statusResponse;
      },
      async list(
        parameters?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        sessionListCalls.push(parameters);
        sessionListOptions.push(options);
        if (sessionListError) throw sessionListError;
        return sessionListResponse;
      },
      async get(
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) {
        sessionGetCalls.push(parameters);
        sessionGetOptions.push(options);
        if (sessionGetError) throw sessionGetError;
        const sessionId = String(parameters.sessionID ?? "");
        return sessionGetResponses.get(sessionId)
          ?? (sessionId === "owned-session"
            ? { data: { id: sessionId, directory: "/workspace" } }
            : { error: { name: "NotFound" }, response: { status: 404 } });
      },
      async messages(parameters?: Record<string, unknown>) {
        messageCalls.push(parameters);
        if (messagesHandler) return messagesHandler(parameters);
        return messagesResponse;
      },
      async abort(parameters?: Record<string, unknown>) {
        abortCalls.push(parameters);
        return abortResponse;
      },
      async command(parameters: Record<string, unknown>) {
        commandDispatchCalls.push(parameters);
        return promptResponse;
      },
    },
    command: {
      async list(parameters?: Record<string, unknown>) {
        commandListCalls.push(parameters);
        return commandListResponse;
      },
    },
  } as unknown as OpencodeClient;

  return {
    abortCalls,
    client,
    commandDispatchCalls,
    commandListCalls,
    setCommandListResponse(response: { data?: unknown[] }) {
      commandListResponse = response;
    },
    createCalls,
    messageCalls,
    get permissionListCallCount() {
      return permissionListCallCount;
    },
    permissionListCalls,
    permissionReplies,
    promptCalls,
    get questionListCallCount() {
      return questionListCallCount;
    },
    questionListCalls,
    questionRejections,
    questionReplies,
    get statusCallCount() {
      return statusCalls.length;
    },
    statusCalls,
    statusOptions,
    get sessionGetCallCount() {
      return sessionGetCalls.length;
    },
    sessionGetCalls,
    sessionGetOptions,
    get sessionListCallCount() {
      return sessionListCalls.length;
    },
    sessionListCalls,
    sessionListOptions,
    get subscribeCallCount() {
      return subscribeCallCount;
    },
    subscriptions,
    setPromptError(error: unknown) {
      promptError = error;
    },
    setPromptGate(gate) {
      promptGate = gate;
    },
    setPending(permissions, questions) {
      pendingPermissions = permissions;
      pendingQuestions = questions;
    },
    setPendingReadGate(gate) {
      pendingReadGate = gate;
    },
    setPendingReadResponses(permissions, questions) {
      permissionListResponse = permissions;
      questionListResponse = questions;
    },
    setPendingReadErrors(permissions, questions) {
      permissionListError = permissions;
      questionListError = questions;
    },
    setPermissionReplyResponse(response) {
      permissionReplyResponse = response;
    },
    setQuestionRejectResponse(response) {
      questionRejectResponse = response;
    },
    setQuestionReplyResponse(response) {
      questionReplyResponse = response;
    },
    setQuestionReplyGate(gate) {
      questionReplyGate = gate;
    },
    setQuestionReplyFailure(error, applied) {
      questionReplyFailure = { error, applied };
    },
    setSubscribeFailures(failures) {
      subscribeFailures = [...failures];
    },
    setMessagesResponse(response) {
      messagesResponse = response;
    },
    setMessagesHandler(handler) {
      messagesHandler = handler;
    },
    setAbortResponse(response) {
      abortResponse = response;
    },
    setCreateResponse(response) {
      createResponse = response;
    },
    setPromptResponse(response) {
      promptResponse = response;
    },
    setStatusError(error) {
      statusError = error;
    },
    setStatusResponse(response) {
      statusResponse = response;
    },
    setSessionListError(error) {
      sessionListError = error;
    },
    setSessionListResponse(response) {
      sessionListResponse = response;
    },
    setSessionGetError(error) {
      sessionGetError = error;
    },
    setSessionGetResponse(sessionId, response) {
      sessionGetResponses.set(sessionId, response);
    },
  };
}

function openCodeProvider(
  fake: OpenCodeFake,
  monitorRetryMs = 1,
  messageIds = new OpenCodeMessageIdCoordinator(),
) {
  return createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: messageIds,
      monitorRetryMs,
      // Exercises the isolated compatibility responder. Production providers
      // default this off and build pipelines use the common journaled resolver.
      autoAnswerRequests: true,
    },
  );
}

function openCodeActivityProvider(
  fake: OpenCodeFake,
  dependencies: Pick<
    ProviderDependencies,
    "now" | "openCodeExistenceCacheTtlMs"
  > = {},
) {
  return createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      autoAnswerRequests: false,
      ...dependencies,
    },
  );
}

describe("OpenCode build pipeline provider", () => {
  test("treats a status-map omission as idle when the session still exists", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionGetResponse("omitted-session", {
      data: { id: "omitted-session", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("omitted-session")).resolves.toBe("idle");
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(0);
      expect(fake.sessionGetCalls).toEqual([{
        sessionID: "omitted-session",
        directory: "/workspace",
      }]);
      expect(fake.statusOptions[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fake.sessionGetOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await provider.dispose?.();
    }
  });

  test("batches omitted idle and genuinely deleted OpenCode sessions", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: [{ id: "existing-session" }] });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.([
        "existing-session",
        "deleted-session",
        "existing-session",
      ])).resolves.toEqual(new Map([
        ["existing-session", "idle"],
        ["deleted-session", "missing"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reports provider unavailability when OpenCode existence cannot be read", async () => {
    for (const failure of [
      { error: { message: "failed" } },
      new Error("connection reset"),
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      if (failure instanceof Error) fake.setSessionListError(failure);
      else fake.setSessionListResponse(failure);
      fake.setSessionGetError(new Error("exact read failed"));
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("omitted-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
        await expect(provider.activityBatch?.(["omitted-session"]))
          .resolves.toEqual(new Map([["omitted-session", "idle"]]));
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("falls back to exact reads for malformed or oversized session lists", async () => {
    for (const response of [
      { data: {} },
      { data: [{}] },
      { data: [{ id: "" }] },
      { data: [{ id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1) }] },
      {
        data: Array.from({ length: 1_026 }, (_, index) => ({
          id: `session-${index}`,
        })),
      },
      {
        data: [{
          id: "foreign-session",
          title: "x".repeat(4 * 1024 * 1024 + 1),
        }],
      },
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      fake.setSessionListResponse(response);
      fake.setSessionGetResponse("omitted-session", {
        data: { id: "omitted-session", directory: "/workspace" },
      });
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.activityBatch?.(["omitted-session"]))
          .resolves.toEqual(new Map([["omitted-session", "idle"]]));
        expect(fake.sessionGetCalls).toEqual([{
          sessionID: "omitted-session",
          directory: "/workspace",
        }]);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("does not infer deletion from a truncated OpenCode session list", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: Array.from({ length: 1_025 }, (_, index) => ({
        id: `other-session-${index}`,
      })),
    });
    fake.setSessionGetResponse("omitted-session", {
      data: { id: "omitted-session", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("omitted-session"))
        .resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
      expect(fake.sessionGetCalls[0]).toEqual({
        sessionID: "omitted-session",
        directory: "/workspace",
      });
      expect(fake.sessionGetOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await provider.dispose?.();
    }
  });

  test("uses exact 404s for deletion even when the bounded list page is full", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: Array.from({ length: 1_025 }, (_, index) => ({
        id: `other-session-${index}`,
      })),
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("deleted-session"))
        .resolves.toBe("missing");
      expect(fake.sessionGetCalls).toEqual([{
        sessionID: "deleted-session",
        directory: "/workspace",
      }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reuses positive existence snapshots within the TTL and refreshes after expiry", async () => {
    let now = 1_000;
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: [{}, { id: "idle-session" }, { id: "" }],
    });
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      openCodeExistenceCacheTtlMs: 100,
    });
    try {
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(0);
      expect(fake.sessionListCalls[0]).toEqual({
        directory: "/workspace",
        limit: 1_025,
      });
      expect(fake.sessionListOptions[0]?.signal).toBeInstanceOf(AbortSignal);

      now += 101;
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("strong status bypasses positive activity caches and sees later deletion", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: [{ id: "session-that-deletes" }] });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("session-that-deletes"))
        .resolves.toBe("idle");
      await expect(provider.status("session-that-deletes"))
        .resolves.toBe("missing");
      await expect(provider.activity?.("session-that-deletes"))
        .resolves.toBe("missing");
      expect(fake.sessionGetCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not cache negative existence across strong status reads", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("recreated-session")).resolves.toBe("missing");
      fake.setSessionGetResponse("recreated-session", {
        data: { id: "recreated-session", directory: "/workspace" },
      });
      await expect(provider.status("recreated-session")).resolves.toBe("idle");
      expect(fake.sessionGetCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps non-404 and malformed exact existence reads unavailable", async () => {
    const oversized = {
      data: {
        id: "target",
        directory: "/workspace",
        title: "x".repeat(4 * 1024 * 1024 + 1),
      },
    };
    for (const response of [
      { error: { name: "BadRequest" }, response: { status: 400 } },
      { error: { name: "ServerError" }, response: { status: 500 } },
      { data: {} },
      { data: { id: "target" } },
      { data: { id: "target", directory: "/another-worktree" } },
      { data: { id: "different-session", directory: "/workspace" } },
      oversized,
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      fake.setSessionGetResponse("target", response);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("target")).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: {
            name: "ProviderUnavailableError",
            message: "OpenCode session existence is unavailable for target",
          },
        });
      } finally {
        await provider.dispose?.();
      }
    }

    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionGetError(new Error("connection reset"));
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("target"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps resolved busy activity when omitted-session probes fail", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: { busy: { type: "busy" } } });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetError(new Error("get unavailable"));
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.(["busy", "unresolved"]))
        .resolves.toEqual(new Map([
          ["unresolved", "idle"],
          ["busy", "working"],
        ]));
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("falls back from a failed list to an exact successful existence read", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetResponse("target", {
      data: { id: "target", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("backs off failed activity existence probes without weakening strong status", async () => {
    let now = 1_000;
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetError(new Error("get unavailable"));
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      openCodeExistenceCacheTtlMs: 100,
    });
    try {
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);

      await expect(provider.status("target"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.sessionGetCallCount).toBe(2);

      now += 101;
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(2);
      expect(fake.sessionGetCallCount).toBe(3);
    } finally {
      await provider.dispose?.();
    }
  });

  test("caps exact activity probes to one rotating concurrency wave", async () => {
    const sessionIds = Array.from(
      { length: 20 },
      (_, index) => `missing-${index}`,
    );
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    const provider = openCodeActivityProvider(fake);
    try {
      const first = await provider.activityBatch?.(sessionIds);
      expect(fake.sessionGetCallCount).toBe(8);
      expect(first?.get("missing-0")).toBe("missing");
      expect(first?.get("missing-8")).toBe("idle");

      const second = await provider.activityBatch?.(sessionIds);
      expect(fake.sessionGetCallCount).toBe(16);
      expect(second?.get("missing-0")).toBe("idle");
      expect(second?.get("missing-8")).toBe("missing");
    } finally {
      await provider.dispose?.();
    }
  });

  test("handles more than 1024 tracked sessions in one bounded activity read", async () => {
    const sessionIds = Array.from(
      { length: 1_025 },
      (_, index) => `session-${index}`,
    );
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: sessionIds.map((id) => ({ id })) });
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.(sessionIds);
      expect(activity?.size).toBe(1_025);
      expect(activity?.get("session-0")).toBe("idle");
      expect(activity?.get("session-1024")).toBe("idle");
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("ignores malformed foreign status entries but validates requested entries", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        tracked: { type: "busy" },
        foreign: { type: 3 },
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("tracked")).resolves.toBe("running");
      fake.setStatusResponse({ data: { tracked: { type: 3 } } });
      await expect(provider.status("tracked"))
        .rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: {
            message: "OpenCode status read contains a malformed entry",
          },
        });
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds OpenCode lifecycle identities and status payload count and bytes", async () => {
    const maximumId = "m".repeat(AGENT_INTERACTION_LIMITS.maxIdLength);
    const boundaryFake = openCodeFake();
    boundaryFake.setStatusResponse({
      data: { [maximumId]: { type: "busy" } },
    });
    const boundaryProvider = openCodeActivityProvider(boundaryFake);
    try {
      await expect(boundaryProvider.status(maximumId)).resolves.toBe("running");
    } finally {
      await boundaryProvider.dispose?.();
    }

    for (const sessionId of [
      "",
      "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1),
    ]) {
      const fake = openCodeFake();
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status(sessionId)).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: { message: "OpenCode lifecycle read contains a malformed identity" },
        });
      } finally {
        await provider.dispose?.();
      }
    }

    for (const data of [
      Object.fromEntries(Array.from(
        { length: 4_097 },
        (_, index) => [`foreign-${index}`, { type: "idle" }],
      )),
      {
        foreign: {
          type: "idle",
          padding: "x".repeat(
            AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes + 1,
          ),
        },
      },
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data });
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("tracked")).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          cause: { message: "OpenCode status read is oversized" },
        });
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("reports busy OpenCode sessions with pending input as waiting", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: { "owned-session": { type: "busy" } },
    });
    fake.setPending(
      [{ id: "permission-other", sessionID: "other-session" }],
      [{ id: "question-owned", sessionID: "owned-session" }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("owned-session")).resolves.toBe("waiting");
      fake.setPending(
        [{ id: "permission-other", sessionID: "other-session" }],
        [],
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
      fake.setPending(
        [{ id: "permission-owned", sessionID: "owned-session" }],
        [],
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("waiting");
    } finally {
      await provider.dispose?.();
    }
  });

  test("batches multiple OpenCode sessions from one global snapshot", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        "busy-session": { type: "busy" },
        "retry-session": { type: "retry" },
        "idle-session": { type: "idle" },
      },
    });
    fake.setPending(
      [
        { id: "permission-owned", sessionID: "retry-session" },
        { id: "permission-other", sessionID: "other-session" },
      ],
      [{ id: "question-owned", sessionID: "busy-session" }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.([
        "busy-session",
        "retry-session",
        "idle-session",
        "missing-session",
        "busy-session",
      ]);

      expect(activity).toEqual(new Map([
        ["idle-session", "idle"],
        ["missing-session", "missing"],
        ["busy-session", "waiting"],
        ["retry-session", "waiting"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
      expect(fake.statusCalls).toEqual([{ directory: "/workspace" }]);
      expect(fake.questionListCalls).toEqual([{ directory: "/workspace" }]);
      expect(fake.permissionListCalls).toEqual([{ directory: "/workspace" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("short-circuits OpenCode pending reads when every session is non-running", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        "idle-session": { type: "idle" },
        "error-session": { type: "unexpected" },
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.([
        "idle-session",
        "error-session",
        "missing-session",
      ]);

      expect(activity).toEqual(new Map([
        ["idle-session", "idle"],
        ["error-session", "idle"],
        ["missing-session", "missing"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("returns an empty OpenCode activity batch without upstream reads", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.([])).resolves.toEqual(new Map());
      expect(fake.statusCallCount).toBe(0);
      expect(fake.sessionListCallCount).toBe(0);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("makes a successfully auto-rejected OpenCode question terminal instead of blocked", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.questionRejections.length === 1);

      // The reject removed the provider request. Keeping a local `blocked`
      // marker here would park the pipeline forever on a card nobody can answer.
      await expect(provider.activityBatch?.(["owned-session"])).resolves.toEqual(
        new Map([["owned-session", "idle"]]),
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("idle");
      await expect(provider.status("owned-session")).resolves.toBe("error");
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds and disposes terminal OpenCode question latches", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    const internal = provider as unknown as {
      failedQuestionSessions: Set<string>;
      ownedSessions: Set<string>;
      handleRequest(raw: unknown): Promise<void>;
    };
    for (let index = 0; index < 1_025; index += 1) {
      const sessionId = `failed-session-${index}`;
      internal.ownedSessions.add(sessionId);
      await internal.handleRequest({
        type: "question.rejected",
        properties: { sessionID: sessionId },
      });
    }
    expect(internal.failedQuestionSessions.size).toBe(1_024);
    expect(internal.failedQuestionSessions.has("failed-session-0")).toBe(false);
    expect(internal.failedQuestionSessions.has("failed-session-1024")).toBe(true);

    await provider.dispose?.();
    expect(internal.failedQuestionSessions.size).toBe(0);
  });

  test("records OpenCode auto-responses before applying them and isolates diagnostic failures", async () => {
    const fake = openCodeFake();
    const events: Array<{ state: string; kind: string }> = [];
    let releaseDurableDetection!: () => void;
    const durableDetection = new Promise<void>((resolve) => {
      releaseDurableDetection = resolve;
    });
    const provider = createBuildPipelineProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: async (event) => {
        events.push({ state: event.state, kind: event.kind });
        if (event.kind === "permission") throw new Error("diagnostics unavailable");
        if (event.kind === "question" && event.state === "detected") {
          await durableDetection;
        }
      },
    });
    try {
      await provider.createSession("build", "Build task", {
        interaction: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
        },
      });
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => events.some((event) =>
        event.kind === "question" && event.state === "detected"
      ));
      expect(fake.questionRejections).toEqual([]);
      await waitUntil(() => fake.permissionReplies.length === 1);
      await expect(provider.status("owned-session")).resolves.toBe("blocked");
      releaseDurableDetection();
      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies).toHaveLength(1);
      expect(events).toHaveLength(4);
      for (const kind of ["permission", "question"] as const) {
        expect(events.findIndex((event) =>
          event.kind === kind && event.state === "detected"
        )).toBeLessThan(events.findIndex((event) =>
          event.kind === kind && event.state === "withdrawn"
        ));
      }
    } finally {
      await provider.dispose?.();
    }
  });

  test("reports a withdrawn OpenCode auto-response as an error provider state", async () => {
    const fake = openCodeFake();
    const events: Array<{
      kind: string;
      state: string;
      providerState?: string;
    }> = [];
    const provider = createBuildPipelineProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        events.push({
          kind: event.kind,
          state: event.state,
          providerState: event.providerState,
        });
      },
    });
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.permissionReplies.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.questionRejections.length === 1);
      await waitUntil(() => events.length === 4);

      // `native-agent-service` projects this field straight onto the session
      // (`event.providerState ?? "running"`). A provider-owned rejection is
      // terminal, so `running` would leave the card spinning on a request the
      // provider has already refused and nobody else will answer.
      expect(events).toEqual([
        { kind: "permission", state: "detected", providerState: undefined },
        { kind: "permission", state: "withdrawn", providerState: "error" },
        { kind: "question", state: "detected", providerState: undefined },
        { kind: "question", state: "withdrawn", providerState: "error" },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("carries the full workflow registration on every OpenCode observation", async () => {
    const fake = openCodeFake();
    const registration: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "pipeline-1",
      provider: "opencode",
      fence: "pipeline-1:build:3:abc",
    };
    const observed: ProviderSessionRegistration[] = [];
    const provider = createBuildPipelineProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        observed.push(event.registration);
      },
    });
    try {
      await provider.createSession("build", "Build task", {
        interaction: registration,
      });
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      await waitUntil(() => observed.length === 2);

      // The observer decides adoption from the workflow ownership fence, so the
      // fence and its owning workflow have to survive the round trip alongside
      // the origin/policy pair.
      expect(observed).toEqual([registration, registration]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps the original workflow fence when an OpenCode session is registered again", async () => {
    const fake = openCodeFake();
    const original: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "pipeline-1",
      provider: "opencode",
      fence: "pipeline-1:build:3:abc",
    };
    const observed: ProviderSessionRegistration[] = [];
    const provider = createBuildPipelineProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        observed.push(event.registration);
      },
    });
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      provider.registerSession?.("restored-session", original);
      // A cached or restored provider re-asserts its metadata on every pass. It
      // must not move a live session onto a newer generation, and above all not
      // switch it from unattended to interactive.
      provider.registerSession?.("restored-session", {
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        phase: "chat",
        workflowId: "pipeline-2",
        provider: "opencode",
        fence: "pipeline-2:build:4:def",
      });
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "restored-session" },
      });
      await waitUntil(() => observed.length >= 1);

      expect(observed[0]).toEqual(original);
    } finally {
      await provider.dispose?.();
    }
  });

  test("leaves an OpenCode question pending when durable detection fails", async () => {
    const fake = openCodeFake();
    const provider = createBuildPipelineProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        if (event.kind === "question" && event.state === "detected") {
          throw new Error("durable failure write failed");
        }
      },
    });
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.subscribeCallCount >= 2);
      expect(fake.questionRejections).toEqual([]);
      await expect(provider.status("owned-session")).resolves.toBe("blocked");
    } finally {
      await provider.dispose?.();
    }
  });

  test("rejects an OpenCode activity snapshot that omits the requested session", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake);
    try {
      // `activityBatch` answers for every id it is given, so a gap is a broken
      // provider rather than a missing session. Defaulting to `missing` would
      // turn that bug into a deleted session mapping.
      provider.activityBatch = async () => new Map();
      await expect(provider.activity?.("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["question", "envelope"],
    ["permission", "envelope"],
    ["question", "throw"],
    ["permission", "throw"],
  ] as const)("wraps OpenCode %s list %s failures as unavailable", async (
    requestType,
    failureType,
  ) => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    if (failureType === "envelope") {
      fake.setPendingReadResponses(
        requestType === "permission" ? { error: { message: "failed" } } : null,
        requestType === "question" ? { error: { message: "failed" } } : null,
      );
    } else {
      fake.setPendingReadErrors(
        requestType === "permission" ? new Error("failed") : null,
        requestType === "question" ? new Error("failed") : null,
      );
    }
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.statusCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds OpenCode activity snapshots and accepts a maximum-length identity", async () => {
    const invalidQuestionResponses: Array<Record<string, unknown>> = [
      {
        data: Array.from({ length: 4_097 }, (_, index) => ({
          id: `question-${index}`,
          sessionID: "owned-session",
        })),
      },
      {
        data: [{
          id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1),
          sessionID: "owned-session",
        }],
      },
    ];
    for (const questions of invalidQuestionResponses) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      fake.setPendingReadResponses({ data: [] }, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.activity?.("owned-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }

    const boundary = openCodeFake();
    boundary.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    boundary.setPendingReadResponses({ data: [] }, {
      data: [{
        id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength),
        sessionID: "owned-session",
      }],
    });
    const boundaryProvider = openCodeActivityProvider(boundary);
    try {
      await expect(boundaryProvider.activity?.("owned-session"))
        .resolves.toBe("waiting");
    } finally {
      await boundaryProvider.dispose?.();
    }
  });

  test("constructs the OpenCode SDK client with bridge auth and directory", async () => {
    const fake = openCodeFake();
    const factoryCalls: unknown[] = [];
    const provider = createBuildPipelineProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "factory-token",
        directory: "/workspace/project",
      },
      {
        openCodeClientFactory: ((options: unknown) => {
          factoryCalls.push(options);
          return fake.client;
        }) as never,
        autoAnswerRequests: false,
      },
    );

    try {
      expect(factoryCalls).toEqual([{
        baseUrl: "http://opencode.test",
        directory: "/workspace/project",
        headers: {
          Authorization: `Basic ${
            Buffer.from("opencode:factory-token").toString("base64")
          }`,
          "X-Orkestrator-OpenCode-Token": "factory-token",
        },
      }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("wraps empty and failed OpenCode session creation responses as unavailable", async () => {
    for (const response of [
      { data: {} },
      { error: { message: "failed" } },
    ]) {
      const fake = openCodeFake();
      fake.setCreateResponse(response);
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.createSession("build", "Build task"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("scopes OpenCode session creation to the requested title", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(provider.createSession("build", "Build task")).resolves.toBe(
        "owned-session",
      );
      expect(fake.createCalls).toEqual([{ title: "Build task" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("answers only owned-session events and denies unexpected permissions", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "permission.asked",
        properties: { id: "unrelated-p", sessionID: "other", always: ["*"] },
      });
      stream.push({
        type: "permission.asked",
        properties: { id: "owned-p", sessionID: "owned-session", always: ["*"] },
      });
      stream.push({
        type: "question.asked",
        properties: { id: "unrelated-q", sessionID: "other" },
      });
      stream.push({
        type: "question.asked",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });

      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies).toEqual([{
        requestID: "owned-p",
        directory: "/workspace",
        reply: "reject",
      }]);
      expect(fake.questionRejections).toEqual([{
        requestID: "owned-q",
        directory: "/workspace",
      }]);
      await expect(provider.status("owned-session")).resolves.toBe("error");
    } finally {
      await provider.dispose?.();
    }
  });

  test("reconciles pending requests for a restored owned session", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        { id: "owned-p", sessionID: "restored", always: ["*"] },
        { id: "other-p", sessionID: "other", always: ["*"] },
      ],
      [
        { id: "owned-q", sessionID: "restored" },
        { id: "other-q", sessionID: "other" },
      ],
    );
    const provider = openCodeProvider(fake);
    try {
      provider.registerSession?.("restored");
      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies.map((call) => call.requestID)).toEqual([
        "owned-p",
      ]);
      expect(fake.questionRejections.map((call) => call.requestID)).toEqual([
        "owned-q",
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([["throw"], ["missing-stream"]] as const)(
    "reconnects after an OpenCode subscribe %s failure",
    async (failure) => {
      const fake = openCodeFake();
      fake.setSubscribeFailures([failure]);
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscribeCallCount >= 2);
        expect(fake.subscriptions).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test.each([["permission"], ["question"]] as const)(
    "recovers after an OpenCode pending %s list failure",
    async (requestType) => {
      const fake = openCodeFake();
      fake.setPending(
        requestType === "permission"
          ? [{ id: "pending-request", sessionID: "restored" }]
          : [],
        requestType === "question"
          ? [{ id: "pending-request", sessionID: "restored" }]
          : [],
      );
      fake.setPendingReadResponses(
        requestType === "permission" ? { error: { message: "failed" } } : null,
        requestType === "question" ? { error: { message: "failed" } } : null,
      );
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscriptions.length === 1);
        provider.registerSession?.("restored");
        await waitUntil(() =>
          fake.permissionListCallCount >= 1 && fake.questionListCallCount >= 1
        );

        fake.setPendingReadResponses(null, null);
        fake.subscriptions[0]!.close();
        if (requestType === "permission") {
          await waitUntil(() => fake.permissionReplies.length === 1);
        } else {
          await waitUntil(() => fake.questionRejections.length === 1);
        }
        expect(fake.subscriptions.length).toBeGreaterThanOrEqual(2);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("legacy reconciliation fails closed on malformed and oversized collections, then recovers", async () => {
    const invalidPermissionResponses: Array<Record<string, unknown>> = [
      { data: null },
      {
        data: Array.from({ length: 4_097 }, (_, index) => ({
          id: `permission-${index}`,
          sessionID: "restored",
        })),
      },
    ];
    for (const invalidPermissions of invalidPermissionResponses) {
      const fake = openCodeFake();
      fake.setPending([{
        id: "pending-request",
        sessionID: "restored",
      }], []);
      fake.setPendingReadResponses(invalidPermissions, { data: [] });
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscriptions.length === 1);
        provider.registerSession?.("restored");
        await waitUntil(() => fake.permissionListCallCount >= 1);
        expect(fake.permissionReplies).toEqual([]);

        fake.setPendingReadResponses(null, null);
        fake.subscriptions[0]!.close();
        await waitUntil(() => fake.permissionReplies.length === 1);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("legacy reconciliation accepts a maximum-length request identity", async () => {
    const fake = openCodeFake();
    const requestId = "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength);
    fake.setPending([{ id: requestId, sessionID: "restored" }], []);
    const provider = openCodeProvider(fake);
    try {
      provider.registerSession?.("restored");
      await waitUntil(() => fake.permissionReplies.length === 1);
      expect(fake.permissionReplies[0]!.requestID).toBe(requestId);
    } finally {
      await provider.dispose?.();
    }
  });

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
    const provider = createBuildPipelineProvider(
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
          id: "anthropic",
          name: "Anthropic",
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
          providerID: "anthropic",
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
        id: "anthropic/claude-sonnet",
        label: "Claude Sonnet",
        providerLabel: "Anthropic",
        reasoning: [
          { id: "default", label: "Default" },
          { id: "high", label: "High" },
        ],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: true,
        contextWindow: 200_000,
        supportsImageInput: true,
      }]);
      const snapshot = await provider.interactiveSnapshot?.("owned-session");
      expect(snapshot).toMatchObject({
        title: "Shared investigation",
        shareUrl: "https://share.opencode.test/live",
        composer: {
          selectedModelId: "anthropic/claude-sonnet",
          selectedReasoningId: "high",
          models: [{
            id: "anthropic/claude-sonnet",
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

describe("HTTP build pipeline provider (codex)", () => {
  test("authenticates with the codex header and its own session payload", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession("review", "Review Session");

    const [request] = requests;
    expect(request!.url).toBe("http://codex.test/session/create");
    const headers = new Headers(request!.init.headers);
    expect(headers.get("X-Orkestrator-Codex-Token")).toBe("codex-token");
    expect(headers.get("X-Orkestrator-Claude-Token")).toBeNull();
    expect(JSON.parse(String(request!.init.body))).toEqual({
      title: "Review Session",
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
      mode: "build",
    });
  });

  test.each([
    ["build", "build"],
    ["review", "build"],
    ["verify", "build"],
    ["fix", "build"],
    ["pr", "build"],
    ["resolve-conflicts", "build"],
  ] as const)("runs the %s stage in %s mode", async (phase, mode) => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    await provider.createSession(phase, "Session");

    expect(JSON.parse(String(requests[0]!.init.body)).mode).toBe(mode);
  });

  test("reads status from the codex-specific endpoint", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ status: "running" }),
      codexConnection,
    );

    expect(await provider.status("codex-1")).toBe("running");
    // Claude answers status from /session/:id; codex has a dedicated route, and
    // asking the wrong one returns a body with no status at all.
    expect(requests[0]!.url).toBe("http://codex.test/session/codex-1/status");
  });

  test("projects Codex's authoritative session config in the interactive snapshot", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/config")) {
        return Response.json({
          model: "gpt-5.6",
          modelReasoningEffort: "high",
          mode: "plan",
          fastMode: true,
          durable: true,
        });
      }
      if (url.endsWith("/runtime-health")) {
        return Response.json({
          engine: { state: "ready", codexVersion: "0.145.0" },
          mcp: { data: [{ name: "docs" }] },
          skills: { data: [{ skills: [{ name: "review" }] }] },
          hooks: { data: [{ hooks: [{ eventName: "preTurn" }] }] },
          notices: [{ message: "Using fallback config" }],
        });
      }
      return Response.json({
        status: "idle",
        title: "Codex's title",
        phase: "idle",
        engineGeneration: 2,
        messageRevision: 7,
      });
    }, codexConnection);

    await expect(provider.interactiveSnapshot?.("codex-1")).resolves.toMatchObject({
      status: "idle",
      title: "Codex's title",
      controls: {
        modelId: "gpt-5.6",
        reasoningId: "high",
        mode: "plan",
        fastMode: true,
      },
      runtime: {
        mcpServers: 1,
        skills: 1,
        hooks: 1,
        state: "ready",
        version: "0.145.0",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://codex.test/session/codex-1/status",
      "http://codex.test/session/codex-1/messages",
      "http://codex.test/session/codex-1/config",
      "http://codex.test/session/codex-1/runtime-health",
    ]);
  });

  test("sends codex attachments as data URLs without claude-only options", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      codexConnection,
    );

    await provider.send("codex-1", "Build it", {
      requestId: "request-1",
      fastMode: false,
      images: [{ filename: "shot.jpeg", data: "AAAA" }],
    });

    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body.attachments).toEqual([{
      type: "image",
      path: "/workspace/.orkestrator/initial-prompt/shot.jpeg",
      filename: "shot.jpeg",
      dataUrl: "data:image/jpeg;base64,AAAA",
    }]);
    expect(body.fastMode).toBe(false);
    // permissionMode/model/effort are claude prompt options; codex takes its
    // model at session creation and would reject them here.
    expect(body.permissionMode).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.effort).toBeUndefined();
  });

  test("switches an idle codex review session to build mode before addressing", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          model: "gpt-5-codex",
          modelReasoningEffort: "high",
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ status: "updated", durable: true });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("review-1", "Address the findings", {
      requestId: "request-address",
      mode: "build",
    });
    await provider.send("review-1", "Continue addressing", {
      requestId: "request-continue",
      mode: "build",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/prompt",
      "http://codex.test/session/review-1/prompt",
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
      mode: "build",
      fastMode: false,
    });
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      prompt: "Address the findings",
      requestId: "request-address",
    });
    // A successful durable reconciliation becomes authoritative local state;
    // repeating the same mode must not pay another config read/write round trip.
    expect(JSON.parse(String(requests[3]!.init.body))).toMatchObject({
      prompt: "Continue addressing",
      requestId: "request-continue",
    });
  });

  test("sends immediately when a newly created codex session keeps its mode", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/session/create")) {
        return Response.json({ sessionId: "build-1" });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    const sessionId = await provider.createSession("build", "Build");
    await provider.send(sessionId, "Implement it", {
      requestId: "request-build",
      mode: "build",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/create",
      "http://codex.test/session/build-1/prompt",
    ]);
    expect(requests.some(({ url }) => url.endsWith("/config"))).toBe(false);
  });

  test("skips a durable mode update when the codex session already matches", async () => {
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/config")) {
        return Response.json({
          model: "gpt-5-codex",
          modelReasoningEffort: "high",
          mode: "build",
          fastMode: false,
          durable: true,
        });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("review-1", "Address the findings", {
      requestId: "request-address",
      mode: "build",
    });

    expect(requests.map(({ url, init }) => [url, init.method ?? "GET"])).toEqual([
      ["http://codex.test/session/review-1/config", "GET"],
      ["http://codex.test/session/review-1/prompt", "POST"],
    ]);
  });

  test("retries the same durable request id after reconciling codex mode", async () => {
    let promptAttempts = 0;
    const { provider, requests } = httpProvider((url) => {
      if (url.endsWith("/config")) {
        return Response.json({
          mode: "build",
          fastMode: false,
          durable: true,
        });
      }
      promptAttempts += 1;
      if (promptAttempts === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    const options = {
      requestId: "request-address",
      mode: "build" as const,
    };
    await expect(provider.send("review-1", "Address the findings", options))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.send("review-1", "Address the findings", options))
      .resolves.toBeUndefined();

    const promptBodies = requests
      .filter(({ url }) => url.endsWith("/prompt"))
      .map(({ init }) => JSON.parse(String(init.body)));
    expect(promptBodies).toHaveLength(2);
    expect(promptBodies.map(({ requestId }) => requestId)).toEqual([
      "request-address",
      "request-address",
    ]);
  });

  test("updates a matching but non-durable codex config and suppresses the prompt when persistence fails", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "build",
          fastMode: true,
          durable: false,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ status: "updated", durable: false });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await expect(provider.send("review-1", "Address the findings", {
      requestId: "request-address",
      mode: "build",
    })).rejects.toThrow("not durably persisted");

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/review-1/config",
      "http://codex.test/session/review-1/config",
    ]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      mode: "build",
      fastMode: true,
    });
  });

  test.each([
    ["invalid JSON", () => new Response("{", {
      headers: { "Content-Type": "application/json" },
    }), SyntaxError],
    ["missing durability", () => Response.json({ status: "updated" }),
      ProviderUnavailableError],
  ] as const)(
    "rejects a codex config update with %s and suppresses the prompt",
    async (_case, updateResponse, errorType) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (url.endsWith("/config") && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        return updateResponse();
      }, codexConnection);

      await expect(provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      })).rejects.toBeInstanceOf(errorType);
      expect(requests).toHaveLength(2);
      expect(requests.some(({ url }) => url.endsWith("/prompt"))).toBe(false);
    },
  );

  test.each([[404], [409], [408], [425], [429], [500]])(
    "treats codex config-read HTTP %i as retryable and does not dispatch",
    async (status) => {
      const { provider, requests } = httpProvider(
        () => new Response(null, { status }),
        codexConnection,
      );

      await expect(provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      })).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests.map(({ url }) => url)).toEqual([
        "http://codex.test/session/review-1/config",
      ]);
    },
  );

  test("keeps a semantic codex config-read failure out of retry recovery", async () => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 400 }),
      codexConnection,
    );

    const promise = provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    });
    await expect(promise).rejects.toThrow("Codex config read failed (HTTP 400)");
    await expect(promise).rejects.not.toBeInstanceOf(ProviderUnavailableError);
    expect(requests).toHaveLength(1);
  });

  test.each([[404], [409], [408], [425], [429], [500]])(
    "treats codex config-update HTTP %i as retryable and does not dispatch",
    async (status) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (url.endsWith("/config") && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        return new Response(null, { status });
      }, codexConnection);

      await expect(provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      })).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests.map(({ url }) => url)).toEqual([
        "http://codex.test/session/review-1/config",
        "http://codex.test/session/review-1/config",
      ]);
    },
  );

  test("keeps a semantic codex config-update failure out of retry recovery", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      return new Response(null, { status: 400 });
    }, codexConnection);

    const promise = provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    });
    await expect(promise).rejects.toThrow("Codex config update failed (HTTP 400)");
    await expect(promise).rejects.not.toBeInstanceOf(ProviderUnavailableError);
    expect(requests).toHaveLength(2);
  });

  test.each([
    ["mode", { mode: "invalid", fastMode: false, durable: true }],
    ["fastMode", { mode: "build", fastMode: "false", durable: true }],
    ["durable", { mode: "build", fastMode: false, durable: "true" }],
    ["model", { mode: "build", model: 42, fastMode: false, durable: true }],
    ["modelReasoningEffort", {
      mode: "build",
      modelReasoningEffort: 42,
      fastMode: false,
      durable: true,
    }],
  ] as const)("rejects malformed codex config field %s before dispatch", async (
    _field,
    body,
  ) => {
    const { provider, requests } = httpProvider(
      () => Response.json(body),
      codexConnection,
    );

    await expect(provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    })).rejects.toThrow("malformed session config");
    expect(requests).toHaveLength(1);
  });

  test("rejects invalid codex config JSON before dispatch", async () => {
    const { provider, requests } = httpProvider(
      () => new Response("{", {
        headers: { "Content-Type": "application/json" },
      }),
      codexConnection,
    );

    await expect(provider.send("review-1", "Address", {
      requestId: "request-address",
      mode: "build",
    })).rejects.toBeInstanceOf(SyntaxError);
    expect(requests).toHaveLength(1);
  });

  test.each(["read", "update"] as const)(
    "maps a codex config %s network failure to unavailable and suppresses dispatch",
    async (failurePoint) => {
      const { provider, requests } = httpProvider((url, init) => {
        if (failurePoint === "update" && url.endsWith("/config")
          && init.method !== "POST") {
          return Response.json({
            mode: "plan",
            fastMode: false,
            durable: true,
          });
        }
        throw new Error("socket closed");
      }, codexConnection);

      await expect(provider.send("review-1", "Address", {
        requestId: "request-address",
        mode: "build",
      })).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(requests).toHaveLength(failurePoint === "read" ? 1 : 2);
      expect(requests.some(({ url }) => url.endsWith("/prompt"))).toBe(false);
    },
  );

  test("escapes the session id in codex config reconciliation and prompt routes", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/config") && init.method !== "POST") {
        return Response.json({
          mode: "plan",
          fastMode: false,
          durable: true,
        });
      }
      if (url.endsWith("/config")) {
        return Response.json({ durable: true });
      }
      return new Response(null, { status: 204 });
    }, codexConnection);

    await provider.send("codex/../admin", "Address", {
      requestId: "request-address",
      mode: "build",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/codex%2F..%2Fadmin/config",
      "http://codex.test/session/codex%2F..%2Fadmin/config",
      "http://codex.test/session/codex%2F..%2Fadmin/prompt",
    ]);
  });

  test.each([
    ["shot.png", "image/png"],
    ["shot.jpg", "image/jpeg"],
    ["shot.jpeg", "image/jpeg"],
    ["shot.gif", "image/gif"],
    ["shot.webp", "image/webp"],
    ["no-extension", "image/png"],
  ])("maps %s to %s", async (filename, mime) => {
    const { provider, requests } = httpProvider(
      () => new Response(null, { status: 204 }),
      codexConnection,
    );

    await provider.send("codex-1", "Build it", {
      requestId: "request-1",
      images: [{ filename, data: "AAAA" }],
    });

    expect(JSON.parse(String(requests[0]!.init.body)).attachments[0].dataUrl)
      .toBe(`data:${mime};base64,AAAA`);
  });

  test("escapes session ids in every codex route", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ messages: [], activity: "idle", structuredOutput: null }),
      codexConnection,
    );

    await provider.messages("codex/../admin");
    // The activity route is polled for every session in every environment, so
    // it is the route most likely to be reached with an id no bridge vetted.
    await provider.activity?.("codex/../admin");
    await provider.structured("codex/../admin", "request-1");

    expect(requests.map(({ url }) => url)).toEqual([
      "http://codex.test/session/codex%2F..%2Fadmin/messages",
      "http://codex.test/session/codex%2F..%2Fadmin/activity",
      "http://codex.test/session/codex%2F..%2Fadmin/structured-output?requestId=request-1",
    ]);
  });
});

describe("HTTP build pipeline provider (ACP)", () => {
  const cursorConnection: BridgeConnection = {
    agent: "cursor",
    baseUrl: "http://cursor.test",
    authToken: "cursor-token",
    requestTimeoutMs: 25,
  };

  test("uses bearer auth and exposes ACP permissions to the fail-closed monitor", async () => {
    let pending = true;
    const { provider, requests } = httpProvider((url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer cursor-token");
      if (url.endsWith("/approvals/approval-1")) {
        expect(JSON.parse(String(init.body))).toEqual({ decision: "deny" });
        pending = false;
        return Response.json({ resolved: true });
      }
      if (url.endsWith("/approvals")) {
        return Response.json({
          approvals: pending ? [{
            approvalId: "approval-1",
            kind: "permissions",
            permissions: { fileSystem: true },
            actionable: true,
            requestedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }] : [],
        });
      }
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      return Response.json({ sessionId: "cursor-1" });
    }, cursorConnection);

    await provider.createSession("review", "Cursor review");
    const snapshot = await provider.interactions!.listPendingInteractions("cursor-1");
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0]).toMatchObject({ provider: "cursor", kind: "permission" });
    const outcome = await provider.interactions!.resolveInteraction(
      "cursor-1",
      snapshot.requests[0]!.id,
      declineResolution(snapshot.requests[0]!),
    );
    expect(outcome.result).toBe("applied");
    expect(requests[0]?.url).toBe("http://cursor.test/session/create");
  });

  test("forwards ACP composer options on session creation and prompt dispatch", async () => {
    const { provider, requests } = httpProvider((url) =>
      url.endsWith("/session/create")
        ? Response.json({ sessionId: "cursor-1" })
        : Response.json({ accepted: true }, { status: 202 }), cursorConnection);

    await provider.createSession("build", "Configured Cursor", {
      clientSessionKey: "env-1:tab-1",
      model: "composer-2.5",
      effort: "high",
      mode: "plan",
      fastMode: true,
    });
    await provider.send("cursor-1", "Do the work", {
      requestId: "request-1",
      model: "gpt-5.5",
      effort: "medium",
      mode: "build",
      fastMode: false,
    });

    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      title: "Configured Cursor",
      clientSessionKey: "env-1:tab-1",
      model: "composer-2.5",
      reasoningEffort: "high",
      mode: "plan",
      fastMode: true,
    });
    expect(requests[1]?.url).toBe("http://cursor.test/session/cursor-1/prompt");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      prompt: "Do the work",
      requestId: "request-1",
      fastMode: false,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      mode: "build",
    });
  });

  test("stages and forwards image attachments to the ACP prompt route", async () => {
    const { provider, requests } = httpProvider((url) =>
      url.endsWith("/session/create")
        ? Response.json({ sessionId: "cursor-1" })
        : Response.json({ accepted: true }, { status: 202 }), cursorConnection);

    await provider.createSession("build", "Cursor");
    // Both ACP agents read inline image content blocks, so an attachment is
    // dispatched like any other provider's rather than refused here.
    await provider.send("cursor-1", "Look at this", {
      requestId: "request-1",
      attachments: [{ type: "image", path: "/workspace/shot.png", filename: "shot.png" }],
      images: [{ filename: "pasted.png", data: "AA==" }],
    });

    // Exact, not partial: the staged `dataUrl` must be gone. The ACP bridge
    // reads the workspace file itself and ignores it, and its request body is
    // capped, so forwarding a copy only costs that budget.
    expect(JSON.parse(String(requests[1]?.init.body)).attachments).toEqual([
      { type: "image", path: "/workspace/shot.png", filename: "shot.png" },
      {
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/pasted.png",
        filename: "pasted.png",
      },
    ]);
  });

  test("keeps a staged image out of the ACP prompt body", async () => {
    const { provider, requests } = httpProvider((url) =>
      url.endsWith("/session/create")
        ? Response.json({ sessionId: "cursor-1" })
        : Response.json({ accepted: true }, { status: 202 }), cursorConnection);

    await provider.createSession("build", "Cursor");
    // 3MB of image data: inside the ACP bridge's 8MB per-image ceiling, and far
    // outside its request-body limit if the data URL travelled alongside the
    // path. A screenshot this size used to come back as a terminal HTTP 413.
    await provider.send("cursor-1", "Look at this", {
      requestId: "request-1",
      images: [{ filename: "pasted.png", data: "A".repeat(4 * 1024 * 1024) }],
    });

    const body = String(requests[1]?.init.body);
    expect(Buffer.byteLength(body)).toBeLessThan(ACP_BRIDGE_MAX_BODY_BYTES);
    expect(JSON.parse(body).attachments).toEqual([{
      type: "image",
      path: "/workspace/.orkestrator/initial-prompt/pasted.png",
      filename: "pasted.png",
    }]);
  });

  test("surfaces the bounded ACP session-creation error detail", async () => {
    const { provider } = httpProvider(
      () => Response.json(
        { error: "Authentication required" },
        { status: 500 },
      ),
      cursorConnection,
    );

    await expect(provider.createSession("build", "Cursor"))
      .rejects.toThrow(
        "cursor session creation is temporarily unavailable (HTTP 500): Authentication required",
      );
  });
});

describe("OpenCode build pipeline provider dispatch", () => {
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
    const provider = createBuildPipelineProvider(
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
    const qualified = createBuildPipelineProvider(
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
