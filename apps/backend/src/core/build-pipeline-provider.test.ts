import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
} from "./build-pipeline-provider.js";
import { mimeTypeForFilename } from "./prompt-attachments.js";

const claudeConnection: BridgeConnection = {
  agent: "claude",
  baseUrl: "http://claude.test",
  authToken: "test-token",
  requestTimeoutMs: 25,
};

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

  test("lets an explicit session mode override the one the phase implies", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ sessionId: "codex-1" }),
      codexConnection,
    );

    // `preparation` and `discovery` both reach the bridge as the `review` phase,
    // which would create a read-only session — but preparation has to commit.
    await provider.createSession("review", "Prepare", { mode: "build" });
    await provider.createSession("review", "Discover", { mode: "plan" });
    await provider.createSession("review", "Unspecified");

    expect(requests.map((request) => JSON.parse(String(request.init.body)).mode))
      .toEqual(["build", "plan", "plan"]);
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
  promptCalls: Array<Record<string, unknown>>;
  setPromptError(error: unknown): void;
  client: OpencodeClient;
  readonly permissionListCallCount: number;
  permissionListCalls: Array<Record<string, unknown> | undefined>;
  permissionReplies: Array<Record<string, unknown>>;
  readonly questionListCallCount: number;
  questionListCalls: Array<Record<string, unknown> | undefined>;
  questionRejections: Array<Record<string, unknown>>;
  readonly statusCallCount: number;
  statusCalls: Array<Record<string, unknown> | undefined>;
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
  setSubscribeFailures(failures: Array<"throw" | "missing-stream">): void;
  setMessagesResponse(response: Record<string, unknown>): void;
  setAbortResponse(response: Record<string, unknown>): void;
  setCreateResponse(response: Record<string, unknown>): void;
  setPromptResponse(response: Record<string, unknown>): void;
  setStatusError(error: unknown): void;
  setStatusResponse(response: Record<string, unknown>): void;
};

function openCodeFake(): OpenCodeFake {
  const permissionReplies: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  let promptError: unknown = null;
  const questionRejections: Array<Record<string, unknown>> = [];
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
  let messagesResponse: Record<string, unknown> = { data: [] };
  let abortResponse: Record<string, unknown> = { data: true };
  let createResponse: Record<string, unknown> = { data: { id: "owned-session" } };
  let promptResponse: Record<string, unknown> = { data: true };
  let statusError: unknown = null;
  const statusCalls: Array<Record<string, unknown> | undefined> = [];
  let statusResponse: Record<string, unknown> = {
    data: { "owned-session": { type: "idle" } },
  };

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
    },
    session: {
      async create() {
        return createResponse;
      },
      async promptAsync(parameters: Record<string, unknown>) {
        promptCalls.push(parameters);
        if (promptError) throw promptError;
        return promptResponse;
      },
      async status(parameters?: Record<string, unknown>) {
        statusCalls.push(parameters);
        if (statusError) throw statusError;
        return statusResponse;
      },
      async messages() {
        return messagesResponse;
      },
      async abort() {
        return abortResponse;
      },
    },
  } as unknown as OpencodeClient;

  return {
    client,
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
    get statusCallCount() {
      return statusCalls.length;
    },
    statusCalls,
    get subscribeCallCount() {
      return subscribeCallCount;
    },
    subscriptions,
    setPromptError(error: unknown) {
      promptError = error;
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
    setSubscribeFailures(failures) {
      subscribeFailures = [...failures];
    },
    setMessagesResponse(response) {
      messagesResponse = response;
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
  };
}

function openCodeProvider(fake: OpenCodeFake, monitorRetryMs = 1) {
  return createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      monitorRetryMs,
    },
  );
}

function openCodeActivityProvider(fake: OpenCodeFake) {
  return createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    { openCodeClient: fake.client, autoAnswerRequests: false },
  );
}

describe("OpenCode build pipeline provider", () => {
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
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reports a blocked OpenCode session as waiting while status calls it an error", async () => {
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

      // The two answers disagree on purpose. `status()` says `error` because a
      // build pipeline must stop advancing on a question this provider refused
      // to answer; the sidebar's honest answer is `waiting`, because a human
      // still has to resolve it. `idle` — what this used to report — is the one
      // answer that is certainly wrong: it retires the indicator on a turn
      // nobody has resolved.
      await expect(provider.activityBatch?.(["owned-session"])).resolves.toEqual(
        new Map([["owned-session", "waiting"]]),
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("waiting");
      await expect(provider.status("owned-session")).resolves.toBe("error");

      // A wholly-blocked batch is answered from local state. Reading the global
      // session map anyway would be a round trip per sweep that cannot change
      // the answer.
      expect(fake.statusCallCount).toBe(0);
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

  test("answers only owned-session events and grants permissions once", async () => {
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
        reply: "once",
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

  test("does not monitor or answer requests for an interactive OpenCode provider", async () => {
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
        autoAnswerRequests: false,
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
            parentID: "request-1",
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
            parentID: "request-1",
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
            parentID: "request-1",
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
              parentID: "request-1",
              structured: { version: "old" },
              time: { completed: 1 },
            },
          },
          {
            info: {
              role: "assistant",
              parentID: "request-1",
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
            parentID: "request-1",
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
            parentID: "request-1",
            time: { completed: 1 },
          },
        }],
      });
      await expect(provider.structured("owned-session", "request-1")).resolves
        .toMatchObject({
          ok: false,
          error: { code: "provider_error", retryable: true },
        });
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
      // Review and verify are read-only turns, so they run in plan mode.
      mode: "plan",
    });
  });

  test.each([
    ["build", "build"],
    ["review", "plan"],
    ["verify", "plan"],
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

describe("OpenCode build pipeline provider dispatch", () => {
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

  test("carries the request id as the durable message id", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("owned-session", "Build it", {
        requestId: "request-42",
      });

      const [call] = fake.promptCalls;
      // OpenCode deduplicates on messageID, which is what makes the supervisor's
      // same-request-id retry safe instead of a second agent turn.
      expect(call!.messageID).toBe("request-42");
      expect(call!.sessionID).toBe("owned-session");
      expect(call!.agent).toBe("build");
      expect(call!.directory).toBe("/workspace");
      expect(call!.parts).toEqual([{ type: "text", text: "Build it" }]);
    } finally {
      await provider.dispose?.();
    }
  });

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

  test("passes a structured schema through as a json_schema format", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const schema = { type: "object", properties: {} } as const;
      await provider.send("owned-session", "Review it", {
        requestId: "request-1",
        schema,
      });

      expect(fake.promptCalls[0]!.format).toEqual({
        type: "json_schema",
        schema,
        retryCount: 2,
      });
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
