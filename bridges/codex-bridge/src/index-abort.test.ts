import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransformStream } from "node:stream/web";

process.env.CODEX_BRIDGE_NO_SERVER = "1";
globalThis.TransformStream = TransformStream as typeof globalThis.TransformStream;

const { app, __testing } = await import("./index.js");

type StreamEntry =
  | { done: true }
  | { value: unknown };

function createStreamController() {
  const queue: StreamEntry[] = [];
  let resolveNext: ((entry: StreamEntry) => void) | undefined;

  const enqueue = (entry: StreamEntry) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = undefined;
      resolve(entry);
      return;
    }

    queue.push(entry);
  };

  const next = async (): Promise<StreamEntry> => {
    const queued = queue.shift();
    if (queued) {
      return queued;
    }

    return new Promise((resolve) => {
      resolveNext = resolve;
    });
  };

  return {
    async *events() {
      while (true) {
        const entry = await next();
        if ("done" in entry) {
          return;
        }
        yield entry.value;
      }
    },
    push(value: unknown) {
      enqueue({ value });
    },
    close() {
      enqueue({ done: true });
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition");
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    conversationMode: "build",
    fastMode: false,
    thread: {
      runStreamed: async () => ({ events: (async function* () {})() }),
    },
    threadOptions: {},
    threadId: null,
    messages: [],
    status: "idle",
    currentItems: new Map(),
    currentItemOrder: [],
    pendingAttachments: [],
    lastAccessed: Date.now(),
    ...overrides,
  };
}

function createRestorableStaleSession(id: string) {
  return createSession({
    id,
    title: "Stale session",
    threadId: "thread-1",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "Previous prompt",
        parts: [{ type: "text", content: "Previous prompt" }],
        createdAt: "2026-04-15T10:00:00.000Z",
      },
    ],
    lastAccessed: Date.now() - 31 * 60 * 1000,
  });
}

function compactStaleSession(id: string) {
  const staleSession = createRestorableStaleSession(id);
  __testing.sessions.set(staleSession.id, staleSession);

  __testing.cleanupIdleSessions();

  expect(__testing.sessions.has(id)).toBe(false);
  expect(__testing.expiredSessions.has(id)).toBe(true);
  return staleSession;
}

async function withBridgeEnv<T>(
  fn: (env: { codexHome: string; cwd: string }) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-bridge-routes-"));
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "workspace");
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.env.CWD;
  const previousCodexPath = process.env.CODEX_PATH;

  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CWD = cwd;
  process.env.CODEX_PATH = join(root, "missing-codex");

  try {
    return await fn({ codexHome, cwd });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }

    if (previousCwd === undefined) {
      delete process.env.CWD;
    } else {
      process.env.CWD = previousCwd;
    }

    if (previousCodexPath === undefined) {
      delete process.env.CODEX_PATH;
    } else {
      process.env.CODEX_PATH = previousCodexPath;
    }

    rmSync(root, { recursive: true, force: true });
  }
}

function writePersistedThread(codexHome: string, cwd: string, threadId: string) {
  const sessionsDir = join(codexHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({
      id: threadId,
      thread_name: "Saved session",
      updated_at: "2026-04-15T10:30:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(sessionsDir, `${threadId}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadId,
          cwd,
          timestamp: "2026-04-15T10:30:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-04-15T10:31:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Saved prompt" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-04-15T10:32:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Saved answer" }],
        },
      }),
      "",
    ].join("\n"),
  );
}

describe("codex bridge abort handling", () => {
  beforeEach(() => {
    __testing.sessions.clear();
    __testing.expiredSessions.clear();
    __testing.setBeforePromptExecutionForTesting(null);
    __testing.setFreshThreadFactoryForTesting(null);
  });

  test("abort route aborts the controller and clears active turn state", async () => {
    const abortController = new AbortController();
    const session = createSession({
      id: "abort-session",
      title: "Abort me",
      status: "running",
      error: "previous error",
      abortController,
      currentTurnId: "turn-1",
      currentTurnStartedAt: "2026-04-15T10:00:00.000Z",
      pendingAttachments: [{ type: "image", path: "/tmp/screenshot.png" }],
    });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/abort-session/abort", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "aborted" });
    expect(abortController.signal.aborted).toBe(true);
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();
    expect(session.currentTurnId).toBeUndefined();
    expect(session.currentTurnStartedAt).toBeUndefined();
    expect(session.abortController).toBeUndefined();
    expect(session.pendingAttachments).toEqual([]);
  });

  test("stale stream events cannot overwrite a newer turn after abort", async () => {
    const streams: ReturnType<typeof createStreamController>[] = [];
    const signals: AbortSignal[] = [];
    const session = createSession({
      thread: {
        runStreamed: async (_input: unknown, options: { signal: AbortSignal }) => {
          signals.push(options.signal);
          const stream = createStreamController();
          streams.push(stream);
          return { events: stream.events() };
        },
      },
    });

    const firstRun = __testing.runPrompt(session, "first prompt");
    await waitUntil(() => streams.length === 1);

    session.abortController?.abort();
    session.status = "idle";
    session.error = undefined;
    session.currentTurnId = undefined;
    session.currentTurnStartedAt = undefined;
    session.abortController = undefined;
    session.pendingAttachments = [];

    const secondRun = __testing.runPrompt(session, "second prompt");
    await waitUntil(() => streams.length === 2);

    streams[0]!.push({
      type: "item.completed",
      item: { id: "old-item", type: "agent_message", text: "OLD RESPONSE" },
    });
    await firstRun;

    streams[1]!.push({
      type: "item.completed",
      item: { id: "new-item", type: "agent_message", text: "NEW RESPONSE" },
    });
    streams[1]!.close();
    await secondRun;

    const assistantContent = session.messages
      .filter((message: { role: string }) => message.role === "assistant")
      .map((message: { content: string }) => message.content)
      .join("\n");

    expect(signals[0]?.aborted).toBe(true);
    expect(assistantContent).toContain("NEW RESPONSE");
    expect(assistantContent).not.toContain("OLD RESPONSE");
    expect(session.status).toBe("idle");
  });

  test("missing rollout resume errors recover on a fresh thread with transcript context", async () => {
    let recoveryInput = "";
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => {
          throw new Error(
            "Codex Exec exited with code 1: Reading prompt from stdin...\nError: thread/resume: thread/resume failed: no rollout found for thread id old-thread",
          );
        },
      },
      messages: [
        {
          id: "review-user",
          role: "user",
          content: "Review the implementation.",
          parts: [{ type: "text", content: "Review the implementation." }],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
        {
          id: "review-assistant",
          role: "assistant",
          content: "Issue: add test coverage for the retry path.",
          parts: [{ type: "text", content: "Issue: add test coverage for the retry path." }],
          createdAt: "2026-04-15T10:01:00.000Z",
        },
      ],
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async (input: string) => {
        recoveryInput = input;
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "new-thread" };
            yield {
              type: "item.completed",
              item: { id: "recovered-item", type: "agent_message", text: "Recovered response" },
            };
            yield {
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            };
          })(),
        };
      },
    } as any));

    await __testing.runPrompt(session, "Please address all the above issues.");

    expect(session.threadId).toBe("new-thread");
    expect(session.status).toBe("idle");
    expect(recoveryInput).toContain("previous Codex thread could not be resumed");
    expect(recoveryInput).toContain("Issue: add test coverage for the retry path.");
    expect(recoveryInput).toContain("Please address all the above issues.");
    expect(
      session.messages.filter(
        (message: { role: string; content: string }) =>
          message.role === "user" && message.content === "Please address all the above issues.",
      ),
    ).toHaveLength(1);
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Recovered response",
      ),
    ).toBe(true);
  });

  test("missing rollout stream failure events recover on a fresh thread", async () => {
    let recoveryInput = "";
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: "turn.failed",
              error: {
                message: "thread/resume failed: no rollout found for thread id old-thread",
              },
            };
          })(),
        }),
      },
      messages: [
        {
          id: "previous-user",
          role: "user",
          content: "Original request",
          parts: [{ type: "text", content: "Original request" }],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async (input: string) => {
        recoveryInput = input;
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "new-thread" };
            yield {
              type: "item.completed",
              item: { id: "recovered-item", type: "agent_message", text: "Recovered from event" },
            };
          })(),
        };
      },
    } as any));

    await __testing.runPrompt(session, "Continue after stream failure.");

    expect(session.threadId).toBe("new-thread");
    expect(session.status).toBe("idle");
    expect(recoveryInput).toContain("Original request");
    expect(
      session.messages.some(
        (message: { role: string; content: string }) =>
          message.role === "assistant" && message.content === "Recovered from event",
      ),
    ).toBe(true);
  });

  test("fresh thread recovery failures leave the session errored and clean up turn state", async () => {
    const session = createSession({
      threadId: "old-thread",
      thread: {
        runStreamed: async () => {
          throw new Error("thread/resume failed: no rollout found for thread id old-thread");
        },
      },
    });

    __testing.setFreshThreadFactoryForTesting(() => ({
      runStreamed: async () => {
        throw new Error("fresh thread failed");
      },
    } as any));

    await __testing.runPrompt(session, "Recover this prompt.");

    expect(session.threadId).toBeNull();
    expect(session.status).toBe("error");
    expect(session.error).toBe("fresh thread failed");
    expect(session.currentTurnId).toBeUndefined();
    expect(session.currentTurnStartedAt).toBeUndefined();
    expect(session.abortController).toBeUndefined();
  });

  test("resume recovery prompt trims long transcripts from the front", () => {
    const prompt = __testing.buildResumeRecoveryPromptForTesting(
      [
        {
          id: "long-message",
          role: "assistant",
          content: `START_MARKER${"x".repeat(41_000)}END_MARKER`,
          parts: [],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
      "Current work",
    );

    expect(prompt).not.toContain("START_MARKER");
    expect(prompt).toContain("END_MARKER");
    expect(prompt).toContain("Current work");
  });

  test("prompt route marks a session running before async execution starts", async () => {
    const session = createSession({
      id: "route-session",
      thread: {
        runStreamed: async () => ({
          events: (async function* () {
            await new Promise(() => {});
          })(),
        }),
      },
    });
    __testing.sessions.set(session.id, session);

    const firstResponse = await app.request("/session/route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "first prompt" }),
      headers: { "Content-Type": "application/json" },
    });
    const secondResponse = await app.request("/session/route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "second prompt" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(409);
    expect(session.status).toBe("running");
    session.abortController?.abort();
  });

  test("prompt route ignores stale async setup failures after a newer turn starts", async () => {
    let rejectPromptSetup: ((error: Error) => void) | undefined;
    __testing.setBeforePromptExecutionForTesting(
      () => new Promise<void>((_resolve, reject) => {
        rejectPromptSetup = reject;
      }),
    );

    const session = createSession({ id: "stale-route-session" });
    __testing.sessions.set(session.id, session);

    const response = await app.request("/session/stale-route-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "first prompt" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(202);
    session.currentTurnId = "newer-turn";
    session.status = "running";
    session.error = undefined;

    rejectPromptSetup?.(new Error("setup failed after stale turn"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.status).toBe("running");
    expect(session.error).toBeUndefined();
    expect(session.currentTurnId).toBe("newer-turn");
  });

  test("idle cleanup compacts sessions that can be restored by the same session id", async () => {
    compactStaleSession("stale-session");

    const response = await app.request("/session/stale-session/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "idle",
      title: "Stale session",
    });
    expect(__testing.sessions.has("stale-session")).toBe(true);
    expect(__testing.expiredSessions.has("stale-session")).toBe(false);
  });

  test("restored compacted sessions preserve messages and accept config updates", async () => {
    compactStaleSession("message-session");

    const messagesResponse = await app.request("/session/message-session/messages");

    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Previous prompt",
        },
      ],
    });

    const configResponse = await app.request("/session/message-session/config", {
      method: "POST",
      body: JSON.stringify({ mode: "plan", fastMode: true }),
      headers: { "Content-Type": "application/json" },
    });

    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toEqual({ status: "updated" });
    expect(__testing.sessions.get("message-session")?.conversationMode).toBe("plan");
    expect(__testing.sessions.get("message-session")?.fastMode).toBe(true);
  });

  test("prompt and abort routes restore compacted sessions before handling requests", async () => {
    compactStaleSession("prompt-session");

    const promptResponse = await app.request("/session/prompt-session/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(promptResponse.status).toBe(400);
    expect(__testing.sessions.has("prompt-session")).toBe(true);
    expect(__testing.expiredSessions.has("prompt-session")).toBe(false);

    compactStaleSession("abort-restored-session");

    const abortResponse = await app.request("/session/abort-restored-session/abort", {
      method: "POST",
    });

    expect(abortResponse.status).toBe(200);
    expect(await abortResponse.json()).toEqual({ status: "aborted" });
    expect(__testing.sessions.has("abort-restored-session")).toBe(true);
    expect(__testing.expiredSessions.has("abort-restored-session")).toBe(false);
  });

  test("delete removes compacted sessions without restoring them", async () => {
    compactStaleSession("delete-session");

    const response = await app.request("/session/delete-session", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(__testing.sessions.has("delete-session")).toBe(false);
    expect(__testing.expiredSessions.has("delete-session")).toBe(false);
  });

  test("idle cleanup removes compacted sessions retained for more than one week", () => {
    compactStaleSession("old-compacted-session");
    compactStaleSession("recent-compacted-session");

    __testing.expiredSessions.get("old-compacted-session").compactedAt =
      Date.now() - __testing.EXPIRED_SESSION_RETENTION_MS - 60_000;
    __testing.expiredSessions.get("recent-compacted-session").compactedAt =
      Date.now() - __testing.EXPIRED_SESSION_RETENTION_MS + 60_000;

    __testing.cleanupIdleSessions();

    expect(__testing.expiredSessions.has("old-compacted-session")).toBe(false);
    expect(__testing.expiredSessions.has("recent-compacted-session")).toBe(true);
  });

  test("global routes return health, models, and slash commands", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
      writeFileSync(
        join(cwd, ".codex", "prompts", "review.md"),
        [
          "---",
          "description: Review the current branch",
          "argument_hint: <target>",
          "---",
          "Review $ARGUMENTS",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(codexHome, "models_cache.json"),
        JSON.stringify({
          models: [
            {
              slug: "test-codex-model",
              display_name: "Test Codex Model",
              supported_in_api: true,
            },
          ],
        }),
      );

      const healthResponse = await app.request("/global/health");
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: "ok", version: "1.0.0" });

      const modelsResponse = await app.request("/global/models");
      expect(modelsResponse.status).toBe(200);
      const modelsBody = await modelsResponse.json();
      expect(modelsBody.models.length).toBeGreaterThan(0);
      expect(["cache", "fallback"]).toContain(modelsBody.source);

      const commandsResponse = await app.request("/global/slash-commands");
      expect(commandsResponse.status).toBe(200);
      expect(await commandsResponse.json()).toMatchObject({
        cwd,
        commands: expect.arrayContaining([
          expect.objectContaining({ name: "/help", source: "builtin" }),
          expect.objectContaining({ name: "/models", source: "builtin" }),
          expect.objectContaining({
            name: "/review",
            description: "Review the current branch",
            argumentHint: "<target>",
            source: "prompt",
          }),
        ]),
      });
    });
  });

  test("session create, list, and resume routes cover persisted sessions", async () => {
    await withBridgeEnv(async ({ codexHome, cwd }) => {
      writePersistedThread(codexHome, cwd, "thread-1");

      const createResponse = await app.request("/session/create", {
        method: "POST",
        body: JSON.stringify({ title: "New session", mode: "plan", fastMode: true }),
        headers: { "Content-Type": "application/json" },
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.title).toBe("New session");
      expect(typeof createBody.sessionId).toBe("string");
      expect(__testing.sessions.get(createBody.sessionId)?.conversationMode).toBe("plan");
      expect(__testing.sessions.get(createBody.sessionId)?.fastMode).toBe(true);

      const listResponse = await app.request("/session/list");

      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        cwd,
        sessions: [
          {
            id: "thread-1",
            title: "Saved session",
            updatedAt: "2026-04-15T10:30:00.000Z",
          },
        ],
      });

      const resumeResponse = await app.request("/session/resume", {
        method: "POST",
        body: JSON.stringify({ threadId: "thread-1", mode: "plan" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(resumeResponse.status).toBe(201);
      const resumeBody = await resumeResponse.json();
      expect(resumeBody.threadId).toBe("thread-1");
      expect(resumeBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Saved prompt",
        "Saved answer",
      ]);
      expect(__testing.sessions.get(resumeBody.sessionId)?.conversationMode).toBe("plan");
    });
  });

  test("event subscription route sends an initial connected event", async () => {
    const controller = new AbortController();
    const response = await app.request("/event/subscribe", {
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const firstChunk = await reader!.read();
      const text = new TextDecoder().decode(firstChunk.value);

      expect(firstChunk.done).toBe(false);
      expect(text).toContain("event: connected");
      expect(text).toContain('"status":"connected"');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  });
});
