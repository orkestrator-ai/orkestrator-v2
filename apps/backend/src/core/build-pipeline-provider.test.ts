import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
} from "./build-pipeline-provider.js";

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
) {
  const requests: RequestRecord[] = [];
  const provider = createBuildPipelineProvider(connection, {
    fetch: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { provider, requests };
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
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      prompt: "Build it",
      requestId: "request-1",
      fastMode: true,
      permissionMode: "bypassPermissions",
      attachments: [{
        type: "image",
        source: { media_type: "image/webp", data: "AA==" },
      }],
    });
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
  permissionReplies: Array<Record<string, unknown>>;
  questionRejections: Array<Record<string, unknown>>;
  subscriptions: EventHarness[];
  setPending(
    permissions: Array<Record<string, unknown>>,
    questions: Array<Record<string, unknown>>,
  ): void;
  setMessagesResponse(response: Record<string, unknown>): void;
  setAbortResponse(response: Record<string, unknown>): void;
  setPromptResponse(response: Record<string, unknown>): void;
  setStatusResponse(response: Record<string, unknown>): void;
};

function openCodeFake(): OpenCodeFake {
  const permissionReplies: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  let promptError: unknown = null;
  const questionRejections: Array<Record<string, unknown>> = [];
  const subscriptions: EventHarness[] = [];
  let pendingPermissions: Array<Record<string, unknown>> = [];
  let pendingQuestions: Array<Record<string, unknown>> = [];
  let messagesResponse: Record<string, unknown> = { data: [] };
  let abortResponse: Record<string, unknown> = { data: true };
  let promptResponse: Record<string, unknown> = { data: true };
  let statusResponse: Record<string, unknown> = {
    data: { "owned-session": { type: "idle" } },
  };

  const client = {
    event: {
      async subscribe(
        _parameters: unknown,
        options: { signal: AbortSignal },
      ) {
        const harness = eventHarness(options.signal);
        subscriptions.push(harness);
        return { stream: harness.stream };
      },
    },
    permission: {
      async list() {
        return { data: pendingPermissions };
      },
      async reply(parameters: Record<string, unknown>) {
        permissionReplies.push(parameters);
        return { data: true };
      },
    },
    question: {
      async list() {
        return { data: pendingQuestions };
      },
      async reject(parameters: Record<string, unknown>) {
        questionRejections.push(parameters);
        return { data: true };
      },
    },
    session: {
      async create() {
        return { data: { id: "owned-session" } };
      },
      async promptAsync(parameters: Record<string, unknown>) {
        promptCalls.push(parameters);
        if (promptError) throw promptError;
        return promptResponse;
      },
      async status() {
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
    permissionReplies,
    promptCalls,
    questionRejections,
    subscriptions,
    setPromptError(error: unknown) {
      promptError = error;
    },
    setPending(permissions, questions) {
      pendingPermissions = permissions;
      pendingQuestions = questions;
    },
    setMessagesResponse(response) {
      messagesResponse = response;
    },
    setAbortResponse(response) {
      abortResponse = response;
    },
    setPromptResponse(response) {
      promptResponse = response;
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

describe("OpenCode build pipeline provider", () => {
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

  test("maps OpenCode status and prompt error envelopes", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(provider.status("owned-session")).resolves.toBe("idle");
      fake.setStatusResponse({
        data: { "owned-session": { type: "busy" } },
      });
      await expect(provider.status("owned-session")).resolves.toBe("running");
      await expect(provider.status("missing-session")).resolves.toBe("missing");

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
      () => Response.json({ messages: [] }),
      codexConnection,
    );

    await provider.messages("codex/../admin");

    expect(requests[0]!.url).toBe(
      "http://codex.test/session/codex%2F..%2Fadmin/messages",
    );
  });
});

describe("OpenCode build pipeline provider dispatch", () => {
  test("treats a thrown promptAsync as retryable rather than a rejection", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setPromptError(new Error("socket hang up"));

      // The distinction matters: PromptRejectedError fails the build, while
      // ProviderUnavailableError keeps the durable attempt and retries the same
      // request id. A dropped connection may already have delivered the turn.
      await expect(provider.send("owned-session", "prompt", {
        requestId: "request-1",
      })).rejects.toBeInstanceOf(ProviderUnavailableError);
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
