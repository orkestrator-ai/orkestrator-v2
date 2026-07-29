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

function httpProvider(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
) {
  const requests: RequestRecord[] = [];
  const provider = createBuildPipelineProvider(claudeConnection, {
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
      permissionMode: "bypassPermissions",
      attachments: [{
        type: "image",
        source: { media_type: "image/webp", data: "AA==" },
      }],
    });
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
      async promptAsync() {
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
    questionRejections,
    subscriptions,
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
