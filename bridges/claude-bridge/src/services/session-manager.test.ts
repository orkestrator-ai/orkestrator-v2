import { afterAll, afterEach, describe, expect, jest, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import * as realFs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Snapshot the real mcp-config / plugin-config modules BEFORE installing the
// stub mocks below. Bun's `mock.module(...)` is process-global, so without
// restoring on `afterAll` these stubs would leak into any later test in the
// same `bun test` run that imports the real modules. See CLAUDE.md > "Bun
// `mock.module()` Rules" > "Snapshot-and-restore pattern".
import * as realMcpConfig from "./mcp-config.js";
import * as realPluginConfig from "./plugin-config.js";
const mcpConfigSnapshot = { ...realMcpConfig };
const pluginConfigSnapshot = { ...realPluginConfig };
const childProcessSnapshot = { ...realChildProcess };
const fsSnapshot = { ...realFs };
const originalExistsSync = realFs.existsSync;
const originalExecFileSync = realChildProcess.execFileSync;
const originalSpawn = realChildProcess.spawn;

const mockExistsSync = mock((path: realFs.PathLike) => originalExistsSync(path));
const mockExecFileSync = mock(originalExecFileSync);
const mockSpawn = mock(originalSpawn);

mock.module("node:fs", () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Controllable mock for @anthropic-ai/claude-agent-sdk.query()
// ---------------------------------------------------------------------------
//
// The SDK's `query()` returns an object that is both an async iterable AND has
// methods like `supportedModels()` / `return()`. Each call here registers a
// QueryCall that the test can drive: push messages, finish the stream, or fail
// the iterator. The session-manager iterates with `for await` so the test
// retains full control over message ordering.
//
// The mock also records the `canUseTool` callback so tests can drive the
// AskUserQuestion / ExitPlanMode flows directly without simulating the full
// agent loop.

interface QueryCall {
  prompt: unknown;
  options: {
    cwd?: string;
    model?: string;
    abortController?: AbortController;
    canUseTool?: (
      toolName: string,
      input: unknown,
    ) => Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
    [key: string]: unknown;
  };
  push: (msg: unknown) => void;
  finish: () => void;
  fail: (err: Error) => void;
}

const pendingCalls: QueryCall[] = [];
const queryWaiters: Array<(call: QueryCall) => void> = [];

function nextQueryCall(timeoutMs = 1000): Promise<QueryCall> {
  return new Promise((resolve, reject) => {
    if (pendingCalls.length > 0) {
      const call = pendingCalls.shift()!;
      resolve(call);
      return;
    }
    const timer = setTimeout(() => {
      const idx = queryWaiters.indexOf(resolveWrapped);
      if (idx >= 0) queryWaiters.splice(idx, 1);
      reject(new Error("Timed out waiting for query() to be invoked"));
    }, timeoutMs);
    const resolveWrapped = (call: QueryCall) => {
      clearTimeout(timer);
      resolve(call);
    };
    queryWaiters.push(resolveWrapped);
  });
}

const mockQuery = mock((args: { prompt: unknown; options: QueryCall["options"] }) => {
  const queue: unknown[] = [];
  let pendingResolve: (() => void) | null = null;
  let finished = false;
  let error: Error | null = null;

  const wake = () => {
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r();
    }
  };

  const call: QueryCall = {
    prompt: args.prompt,
    options: args.options,
    push: (msg) => {
      queue.push(msg);
      wake();
    },
    finish: () => {
      finished = true;
      wake();
    },
    fail: (err) => {
      error = err;
      finished = true;
      wake();
    },
  };

  // Honor the abort controller so abortSession() unblocks the iterator.
  args.options?.abortController?.signal.addEventListener("abort", () => {
    finished = true;
    wake();
  });

  const waiter = queryWaiters.shift();
  if (waiter) {
    waiter(call);
  } else {
    pendingCalls.push(call);
  }

  async function* iter() {
    while (true) {
      if (error) {
        const err = error;
        error = null;
        throw err;
      }
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (finished) return;
      await new Promise<void>((r) => {
        pendingResolve = r;
      });
    }
  }

  const generator = iter();
  return Object.assign(generator, {
    supportedModels: async () => [
      {
        value: "claude-opus-mock",
        resolvedModel: "claude-opus-mock-20260701",
        displayName: "Claude Opus (mock)",
        description: "Mock model",
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"] as const,
        supportsAdaptiveThinking: true,
        supportsAutoMode: true,
      },
    ],
  });
});

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

const mockGetMcpServersForSdk = mock(async () => ({}));
const mockGetMcpServerNames = mock(async () => new Set<string>());
const mockGetPluginsForSdk = mock(async () => [] as Array<{ type: "local"; path: string }>);

mock.module("./mcp-config.js", () => ({
  getMcpServersForSdk: mockGetMcpServersForSdk,
  getMcpServerNames: mockGetMcpServerNames,
}));

mock.module("./plugin-config.js", () => ({
  getPluginsForSdk: mockGetPluginsForSdk,
}));

// Import AFTER mocks are installed so session-manager picks them up.
const sessionManager = await import("./session-manager.js");
const { eventEmitter } = await import("./event-emitter.js");
import type { SSEEvent } from "../types/index.js";

const {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  abortSession,
  getSessionMessages,
  sendPrompt,
  answerQuestion,
  dismissQuestion,
  getPendingQuestions,
  respondToPlanApproval,
  getPendingPlanApprovals,
  getSessionInitData,
  getAvailableModelCatalog,
  getAvailableModels,
  getClaudeRuntimeVersions,
  MAX_IMAGE_ATTACHMENT_BYTES,
} = sessionManager;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureEvents(): { events: SSEEvent[]; stop: () => void } {
  const events: SSEEvent[] = [];
  const unsubscribe = eventEmitter.subscribe((e) => events.push(e));
  return { events, stop: unsubscribe };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for condition");
}

const createdSessionIds: string[] = [];
function track(id: string): string {
  createdSessionIds.push(id);
  return id;
}

afterEach(() => {
  // Clean up any sessions/abortable work the test created.
  for (const id of createdSessionIds.splice(0)) {
    deleteSession(id);
  }
  pendingCalls.length = 0;
  queryWaiters.length = 0;
  mockQuery.mockClear();
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation((path) => originalExistsSync(path));
  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation(originalExecFileSync);
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(originalSpawn);
  mockGetMcpServersForSdk.mockReset();
  mockGetMcpServersForSdk.mockImplementation(async () => ({}));
  mockGetMcpServerNames.mockReset();
  mockGetMcpServerNames.mockImplementation(async () => new Set<string>());
  mockGetPluginsForSdk.mockReset();
  mockGetPluginsForSdk.mockImplementation(async () => []);
});

afterAll(() => {
  // Restore the real mcp-config / plugin-config modules so other test files
  // in the same `bun test` run get the real implementations.
  mock.module("./mcp-config.js", () => mcpConfigSnapshot);
  mock.module("./plugin-config.js", () => pluginConfigSnapshot);
  mock.module("node:child_process", () => childProcessSnapshot);
  mock.module("node:fs", () => fsSnapshot);
});

async function readSdkPrompt(call: QueryCall): Promise<unknown> {
  if (typeof call.prompt === "string") return call.prompt;
  const messages: unknown[] = [];
  for await (const message of call.prompt as AsyncIterable<unknown>) {
    messages.push(message);
  }
  return messages;
}

function createMockChildProcess(options: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: Error;
  defer?: boolean;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const complete = () => {
    if (options.error) {
      child.emit("error", options.error);
      return;
    }
    if (options.stdout) child.stdout.emit("data", Buffer.from(options.stdout));
    if (options.stderr) child.stderr.emit("data", Buffer.from(options.stderr));
    child.emit("close", options.code ?? 0);
  };

  if (!options.defer) queueMicrotask(complete);
  return { child, complete };
}

async function runPromptWithMessages(
  messages: unknown[],
  options?: Parameters<typeof sendPrompt>[2],
  prompt = "test prompt",
) {
  const session = createSession("Fixed title");
  track(session.id);
  const promptPromise = sendPrompt(session.id, prompt, options);
  const call = await nextQueryCall();
  for (const message of messages) call.push(message);
  call.finish();
  await promptPromise;
  return { session: getSession(session.id)!, call };
}

async function withWorkspaceCwd<T>(
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.CWD;
  process.env.CWD = cwd;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CWD;
    else process.env.CWD = previous;
  }
}

// ---------------------------------------------------------------------------
// Pure session-state CRUD
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  test("createSession produces a session with the expected shape and emits session.updated", () => {
    const { events, stop } = captureEvents();
    try {
      const session = createSession("My title");
      track(session.id);

      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe("My title");
      expect(session.status).toBe("idle");
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeInstanceOf(Date);

      const updated = events.find((e) => e.type === "session.updated" && e.sessionId === session.id);
      expect(updated).toBeDefined();
      expect((updated?.data as { status?: string })?.status).toBe("idle");
    } finally {
      stop();
    }
  });

  test("createSession assigns a default title when none is provided", () => {
    const session = createSession();
    track(session.id);
    expect(session.title).toMatch(/^Session /);
  });

  test("getSession and listSessions return registered sessions", () => {
    const a = createSession("alpha");
    const b = createSession("beta");
    track(a.id);
    track(b.id);

    expect(getSession(a.id)?.title).toBe("alpha");
    expect(getSession("session-does-not-exist")).toBeUndefined();

    const ids = listSessions().map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("deleteSession removes the session and returns true; subsequent deletes return false", () => {
    const session = createSession("doomed");
    expect(deleteSession(session.id)).toBe(true);
    expect(getSession(session.id)).toBeUndefined();
    expect(deleteSession(session.id)).toBe(false);
  });

  test("abortSession returns false when nothing is running", () => {
    const session = createSession("idle-session");
    track(session.id);
    expect(abortSession(session.id)).toBe(false);
  });

  test("getSessionMessages returns [] for a fresh session and [] for unknown", () => {
    const session = createSession("empty");
    track(session.id);
    expect(getSessionMessages(session.id)).toEqual([]);
    expect(getSessionMessages("session-missing")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendPrompt — happy path, errors, abort, init
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
  test("happy path: appends user + assistant message, captures sdkSessionId, ends idle", async () => {
    const session = createSession("happy");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Hello Claude");
      const call = await nextQueryCall();
      expect(call.options.includePartialMessages).toBe(true);

      // System init - sdkSessionId should be captured
      call.push({
        type: "system",
        subtype: "init",
        session_id: "sdk-session-xyz",
        mcp_servers: [],
        plugins: [],
        slash_commands: ["help"],
      });

      // Assistant message with text
      call.push({
        type: "assistant",
        uuid: "asst-uuid-1",
        message: {
          content: [{ type: "text", text: "Hi there!" }],
        },
      });

      // Successful result
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("idle");
      expect(stored.sdkSessionId).toBe("sdk-session-xyz");
      expect(stored.messages).toHaveLength(2);
      expect(stored.messages[0]?.role).toBe("user");
      expect(stored.messages[0]?.content).toBe("Hello Claude");
      expect(stored.messages[1]?.role).toBe("assistant");
      expect(stored.messages[1]?.content).toBe("Hi there!");

      const initData = getSessionInitData(session.id);
      expect(initData?.slashCommands).toEqual(["help"]);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("session.init");
      expect(eventTypes).toContain("message.updated");
      expect(eventTypes).toContain("session.idle");
    } finally {
      stop();
    }
  });

  test("streams partial assistant text before the final assistant message arrives", async () => {
    const session = createSession("streaming");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "partial-asst-1",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-asst-1",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Hello";
      });

      const streamedEvent = events.find((event) => {
        const message = (event.data as { message?: { content?: string } } | undefined)?.message;
        return event.type === "message.updated" && message?.content === "Hello";
      });
      expect(streamedEvent).toBeDefined();

      call.push({
        type: "assistant",
        uuid: "partial-asst-1",
        message: {
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("Hello final");
    } finally {
      stop();
    }
  });

  test("streams partial thinking content and preserves block order", async () => {
    const session = createSession("streaming-thinking");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Think then answer");
      const call = await nextQueryCall();

      // Thinking block at index 0.
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Reasoning..." },
        },
      });
      // Text block at index 1 - must render after the thinking block.
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Answer" },
        },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Answer";
      });

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      const thinkingPart = assistant?.parts.find((part) => part.type === "thinking");
      expect(thinkingPart?.content).toBe("Reasoning...");

      const streamedThinking = events.find((event) => {
        const message = (event.data as { message?: { parts?: { type: string; content?: string }[] } } | undefined)?.message;
        return (
          event.type === "message.updated" &&
          message?.parts?.some((part) => part.type === "thinking" && part.content === "Reasoning...")
        );
      });
      expect(streamedThinking).toBeDefined();

      call.push({
        type: "assistant",
        uuid: "partial-think-1",
        message: {
          content: [
            { type: "thinking", thinking: "Reasoning..." },
            { type: "text", text: "Answer final" },
          ],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const finalAssistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(finalAssistant?.content).toBe("Answer final");
    } finally {
      stop();
    }
  });

  // The real SDK gives every `stream_event` its own random uuid and emits one
  // non-streaming `assistant` message per content block, all sharing
  // `message.id`. Grouping by uuid therefore produced one part per delta plus a
  // duplicate copy of the finished block. These tests use that real shape.
  test("merges deltas that each arrive with a unique stream_event uuid", async () => {
    const session = createSession("streaming-unique-uuids");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-unique",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("evt-1", {
        type: "message_start",
        message: { id: "msg_stream_1", role: "assistant", content: [] },
      });
      streamEvent("evt-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("evt-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I" },
      });
      streamEvent("evt-4", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "'ll check the repo" },
      });
      streamEvent("evt-5", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " state." },
      });
      streamEvent("evt-6", { type: "content_block_stop", index: 0 });
      streamEvent("evt-7", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      streamEvent("evt-8", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Test suite is still" },
      });
      streamEvent("evt-9", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " running." },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Test suite is still running.";
      });

      const streamed = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(streamed?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      expect(streamed?.parts[0]?.content).toBe("I'll check the repo state.");
      expect(streamed?.parts[1]?.content).toBe("Test suite is still running.");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("final per-block assistant messages replace streamed blocks instead of duplicating them", async () => {
    const session = createSession("streaming-final-blocks");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Think then answer");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-final",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("s-1", {
        type: "message_start",
        message: { id: "msg_final_1", role: "assistant", content: [] },
      });
      streamEvent("s-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("s-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning" },
      });
      streamEvent("s-4", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      streamEvent("s-5", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Ans" },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Ans";
      });

      // The SDK emits one assistant message per content block, each with a fresh
      // uuid but the same API `message.id`.
      call.push({
        type: "assistant",
        uuid: "final-uuid-a",
        message: {
          id: "msg_final_1",
          content: [{ type: "thinking", thinking: "Reasoning complete." }],
        },
      });
      call.push({
        type: "assistant",
        uuid: "final-uuid-b",
        message: {
          id: "msg_final_1",
          content: [{ type: "text", text: "Answer final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      expect(assistant?.parts[0]?.content).toBe("Reasoning complete.");
      expect(assistant?.parts[1]?.content).toBe("Answer final");
      expect(assistant?.content).toBe("Answer final");
    } finally {
      stop();
    }
  });

  test("keeps chronological order across api messages in a think → tool → answer turn", async () => {
    const session = createSession("streaming-multi-message");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Run a command");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-multi",
          parent_tool_use_id: null,
          event,
        });
      };

      // First API message: thinking (index 0) then a tool_use (index 1).
      streamEvent("m-1", {
        type: "message_start",
        message: { id: "msg_multi_1", role: "assistant", content: [] },
      });
      streamEvent("m-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("m-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Need the repo state." },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-1",
        message: {
          id: "msg_multi_1",
          content: [{ type: "thinking", thinking: "Need the repo state." }],
        },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-2",
        message: {
          id: "msg_multi_1",
          content: [
            {
              type: "tool_use",
              id: "tool-multi-1",
              name: "Bash",
              input: { command: "git status --porcelain" },
            },
          ],
        },
      });
      streamEvent("m-4", { type: "message_stop" });

      call.push({
        type: "user",
        uuid: "multi-user-1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-multi-1", content: "clean" },
          ],
        },
      });

      // Second API message: the answer text.
      streamEvent("m-5", {
        type: "message_start",
        message: { id: "msg_multi_2", role: "assistant", content: [] },
      });
      streamEvent("m-6", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      streamEvent("m-7", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working tree is clean." },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-3",
        message: {
          id: "msg_multi_2",
          content: [{ type: "text", text: "Working tree is clean." }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual([
        "thinking",
        "tool-invocation",
        "text",
      ]);
      expect(assistant?.parts[0]?.content).toBe("Need the repo state.");
      expect(assistant?.parts[2]?.content).toBe("Working tree is clean.");
      expect(assistant?.content).toBe("Working tree is clean.");
    } finally {
      stop();
    }
  });

  test("rejects a second prompt while the session is already running", async () => {
    const session = createSession("busy");
    track(session.id);

    const first = sendPrompt(session.id, "first");
    const call = await nextQueryCall();

    await expect(sendPrompt(session.id, "second")).rejects.toThrow(/already processing/);

    call.finish();
    await first;
  });

  test("throws when the session id is unknown", async () => {
    await expect(sendPrompt("session-missing", "hi")).rejects.toThrow(/not found/);
  });

  test("query failure leaves session in error state and emits session.error", async () => {
    const session = createSession("will-fail");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "boom");
      const call = await nextQueryCall();
      call.fail(new Error("SDK exploded"));

      await expect(promptPromise).rejects.toThrow(/SDK exploded/);

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("error");
      expect(stored.error).toBe("SDK exploded");

      const errorEvent = events.find((e) => e.type === "session.error" && e.sessionId === session.id);
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.data as { error?: string })?.error).toBe("SDK exploded");
    } finally {
      stop();
    }
  });

  // -------------------------------------------------------------------------
  // Streamed-delta coalescing
  // -------------------------------------------------------------------------
  //
  // Deltas accumulate immediately but the expensive snapshot (ordered-part
  // rebuild + full-message emit) is deferred by STREAM_EVENT_COALESCE_MS. These
  // tests pin the two properties that makes safe: nothing is lost on any exit
  // path, and non-delta messages still observe the deltas that preceded them.

  const textDelta = (uuid: string, text: string) => ({
    type: "stream_event",
    uuid,
    session_id: "sdk-session-coalesce",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });

  const assistantContent = (sessionId: string): string | undefined =>
    getSessionMessages(sessionId).find((m) => m.role === "assistant")?.content;

  /**
   * `message.updated` carries the live `NormalizedMessage`, so a captured event
   * keeps changing as the turn mutates it. Snapshot `content` at emit time to
   * see the sequence the client actually received.
   */
  function captureAssistantContentFrames(): { frames: string[]; stop: () => void } {
    const frames: string[] = [];
    const stop = eventEmitter.subscribe((event) => {
      if (event.type !== "message.updated") return;
      const message = (event.data as { message?: { role?: string; content?: string } }).message;
      if (message?.role === "assistant") frames.push(message.content ?? "");
    });
    return { frames, stop };
  }

  /**
   * Lets the session manager drain the messages already queued on the mock
   * iterator, without reaching STREAM_EVENT_COALESCE_MS. The mock checks its
   * error/finished flags before its queue, so failing or aborting immediately
   * after a push would discard the pushed messages entirely.
   */
  const settleQueuedMessages = () => new Promise((resolve) => setTimeout(resolve, 15));

  test("coalesces a burst of deltas into a single accumulated snapshot", async () => {
    const session = createSession("coalescing");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream a burst");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "burst-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      for (const chunk of ["a", "b", "c", "d", "e"]) {
        call.push(textDelta("burst-1", chunk));
      }

      await waitFor(() => assistantContent(session.id) === "abcde");

      // The whole burst lands in one window, so it costs far fewer emits than
      // the one-per-token rebuild this replaced.
      const updates = events.filter((event) => event.type === "message.updated");
      expect(updates.length).toBeLessThan(5);
      expect(updates.length).toBeGreaterThan(0);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("a non-delta message observes every delta that preceded it", async () => {
    const session = createSession("coalescing-order");
    track(session.id);

    const { frames, stop } = captureAssistantContentFrames();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then settle");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "order-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("order-1", "streamed"));
      // Arrives well inside the coalescing window, so the pending snapshot has
      // not been published by the timer yet.
      call.push({
        type: "assistant",
        uuid: "order-1",
        message: { content: [{ type: "text", text: "streamed and final" }] },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The flush ran before the assistant message was handled, so the streamed
      // text was published in its own frame rather than being skipped over.
      expect(frames).toContain("streamed");
      expect(frames.indexOf("streamed")).toBeLessThan(
        frames.lastIndexOf("streamed and final"),
      );
      expect(assistantContent(session.id)).toBe("streamed and final");
    } finally {
      stop();
    }
  });

  test("publishes pending deltas when the SDK stream fails mid-turn", async () => {
    const session = createSession("coalescing-failure");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then explode");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "doomed-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("doomed-1", "half a sentence"));
      await settleQueuedMessages();
      // Fails inside the coalescing window: without an explicit flush on the
      // error path these deltas would never reach session.messages, and the
      // user would lose the tail of a turn they had already watched stream.
      call.fail(new Error("SDK hung up"));

      await expect(promptPromise).rejects.toThrow(/SDK hung up/);

      expect(assistantContent(session.id)).toBe("half a sentence");

      // The completed message is emitted before the terminal error frame.
      const updateIndex = events.findIndex((event) => event.type === "message.updated"
        && (event.data as { message?: { role?: string } }).message?.role === "assistant");
      const errorIndex = events.findIndex((event) => event.type === "session.error");
      expect(updateIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(updateIndex).toBeLessThan(errorIndex);
    } finally {
      stop();
    }
  });

  test("publishes pending deltas when the turn is aborted mid-stream", async () => {
    const session = createSession("coalescing-abort");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then abort");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "aborted-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("aborted-1", "interrupted text"));
      await settleQueuedMessages();
      abortSession(session.id);

      await promptPromise;

      // An interrupted turn keeps whatever streamed; the transcript is the only
      // record of it, since the SDK will not replay the turn.
      expect(assistantContent(session.id)).toBe("interrupted text");
    } finally {
      stop();
    }
  });

  test("abortSession during a running query unblocks the iterator and emits session.idle", async () => {
    const session = createSession("abort-me");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "long-running");
      const call = await nextQueryCall();
      call.push({ type: "system", subtype: "init", session_id: "sdk-1", mcp_servers: [] });

      // Wait until the iterator has started consuming.
      await waitFor(() => getSession(session.id)?.status === "running");

      const result = abortSession(session.id);
      expect(result).toBe(true);

      await promptPromise;
      expect(call.options.abortController?.signal.aborted).toBe(true);
      expect(getSession(session.id)?.status).toBe("idle");

      const idleEvents = events.filter((e) => e.type === "session.idle");
      expect(idleEvents.length).toBeGreaterThan(0);
      const aborted = idleEvents.find((e) => (e.data as { aborted?: boolean })?.aborted === true);
      expect(aborted).toBeDefined();
    } finally {
      stop();
    }
  });

  test("an aborted run cannot clobber an immediately restarted prompt", async () => {
    const session = createSession("abort-restart");
    track(session.id);
    const firstPrompt = sendPrompt(session.id, "first");
    await nextQueryCall();

    expect(abortSession(session.id)).toBe(true);
    const secondPrompt = sendPrompt(session.id, "second");
    const secondCall = await nextQueryCall();
    await firstPrompt;

    expect(session.status).toBe("running");
    expect(session.abortController).toBe(secondCall.options.abortController);

    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await secondPrompt;
    expect(session.status).toBe("idle");
  });

  test("ignores malformed stream indices and stream events without a usable message identity", async () => {
    const events = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ].map((index) => ({
      type: "stream_event",
      uuid: "bad-stream",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: "must not render" },
      },
    }));
    events.push({
      type: "stream_event",
      uuid: undefined,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "also ignored" },
      },
    } as never);

    const { session } = await runPromptWithMessages([
      ...events,
      { type: "result", subtype: "success" },
    ]);

    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  test("uses a stream uuid fallback when no message_start arrives", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "stream_event",
        uuid: "fallback-stream-id",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fallback text" },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.id).toBe("fallback-stream-id");
    expect(assistant?.content).toBe("fallback text");
  });

  test("accepts finalized assistant blocks without prior streaming and preserves ignored offsets", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "final-only",
          content: [
            { type: "unknown" },
            { type: "text", text: "after ignored block" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("after ignored block");
    expect(assistant?.parts).toEqual([
      expect.objectContaining({ type: "text", content: "after ignored block" }),
    ]);
  });

  test("builds Edit and Write diffs and ignores malformed tool identities", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "tool-message",
        message: {
          id: "tool-message",
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: { file_path: "a.ts", old_string: "before", new_string: "after" },
            },
            {
              type: "tool_use",
              id: "write-1",
              name: "Write",
              input: { file_path: "b.ts", content: "new file" },
            },
            { type: "tool_use", id: 42, name: "Bash", input: {} },
            { type: "tool_use", id: "", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "edit-1", content: "ok" },
            { type: "tool_result", tool_use_id: "write-1", content: [{ type: "text", text: "done" }] },
            { type: "tool_result", tool_use_id: 42, content: "ignored" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tools = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.filter((part) => part.type === "tool-invocation") ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      toolUseId: "edit-1",
      toolState: "success",
      toolDiff: { filePath: "a.ts", before: "before", after: "after" },
    });
    expect(tools[1]).toMatchObject({
      toolUseId: "write-1",
      toolState: "success",
      toolDiff: { filePath: "b.ts", before: "", after: "new file" },
    });
  });

  test("uses explicit Task parents across concurrent tasks and longest MCP server prefixes", async () => {
    mockGetMcpServerNames.mockImplementationOnce(async () =>
      new Set(["team", "team_tools"]),
    );
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "tasks",
          content: [
            { type: "tool_use", id: "task-a", name: "Task", input: {} },
            { type: "tool_use", id: "task-b", name: "Task", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-a",
        message: {
          id: "child",
          content: [
            { type: "tool_use", id: "child-a", name: "mcp_team_tools_search", input: {} },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const child = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.toolUseId === "child-a");
    expect(child).toMatchObject({
      parentTaskUseId: "task-a",
      isMcpTool: true,
      mcpServerName: "team_tools",
    });
  });

  test("sends valid images natively, omits empty image-only text, and escapes file metadata", async () => {
    const { call } = await runPromptWithMessages(
      [{ type: "result", subtype: "success" }],
      {
        attachments: [
          {
            type: "image",
            path: "",
            filename: "photo.jpg",
            dataUrl: "data:image/webp;base64,aGVsbG8=",
          },
          {
            type: "file",
            path: `a&b<"'.txt`,
            filename: `x&y<"'.txt`,
          },
        ],
      },
      "",
    );

    const sdkMessages = await readSdkPrompt(call) as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].message.content).toHaveLength(2);
    expect(sdkMessages[0].message.content[0]).toMatchObject({ type: "text" });
    expect((sdkMessages[0].message.content[0] as { text: string }).text).toContain(
      'path="a&amp;b&lt;&quot;&apos;.txt"',
    );
    expect(sdkMessages[0].message.content[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/webp", data: "aGVsbG8=" },
    });
  });

  test("omits the text block for a truly image-only SDK prompt", async () => {
    const { call } = await runPromptWithMessages(
      [{ type: "result", subtype: "success" }],
      {
        attachments: [{
          type: "image",
          path: "",
          filename: "photo.png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        }],
      },
      "",
    );

    const sdkMessages = await readSdkPrompt(call) as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(sdkMessages[0].message.content).toEqual([
      expect.objectContaining({ type: "image" }),
    ]);
  });

  test("rejects malformed inline image data instead of silently omitting it", async () => {
    const session = createSession("malformed-image");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      await expect(sendPrompt(session.id, "describe this", {
        attachments: [{
          type: "image",
          path: "/definitely/missing/image.png",
          dataUrl: "data:image/png;base64,not-valid!",
        }],
      })).rejects.toMatchObject({
        name: "ClaudeAttachmentError",
        code: "attachment_invalid_data",
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(events.find((event) => event.type === "session.error")?.data).toEqual({
        error: "Image attachment data must be valid base64 and no larger than 8MB.",
        code: "attachment_invalid_data",
      });
    } finally {
      stop();
    }
  });

  test("rejects an image-only prompt when no image can be decoded", async () => {
    const session = createSession("invalid-image-only");
    track(session.id);

    await expect(sendPrompt(session.id, "", {
      attachments: [{
        type: "image",
        path: "",
        dataUrl: "data:image/png;base64,not-valid!",
      }],
    })).rejects.toMatchObject({
      name: "ClaudeAttachmentError",
      code: "attachment_invalid_data",
    });
    expect(session.status).toBe("error");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("reads image attachments from disk when no data URL is supplied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-test-"));
    const imagePath = join(directory, "image.gif");
    await writeFile(imagePath, Buffer.from("gif-data"));
    try {
      const { call } = await withWorkspaceCwd(directory, () =>
        runPromptWithMessages(
          [{ type: "result", subtype: "success" }],
          { attachments: [{ type: "image", path: imagePath }] },
        ));
      const sdkMessages = await readSdkPrompt(call) as Array<{
        message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> };
      }>;
      expect(sdkMessages[0].message.content[1]?.source).toEqual({
        type: "base64",
        media_type: "image/gif",
        data: Buffer.from("gif-data").toString("base64"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects disk images outside the SDK workspace root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-boundary-"));
    const workspace = join(directory, "workspace");
    const outsideImage = join(directory, "outside.png");
    await mkdir(workspace);
    await writeFile(outsideImage, "outside");
    try {
      const session = createSession("outside-image");
      track(session.id);
      await withWorkspaceCwd(workspace, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: outsideImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_outside_workspace",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects direct, chained, and ancestor symlinks for disk images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-symlink-"));
    const workspace = join(directory, "workspace");
    const outside = join(directory, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "image.png"), "inside");
    await writeFile(join(outside, "outside.png"), "outside");
    await symlink(join(workspace, "image.png"), join(workspace, "direct.png"));
    await symlink(join(workspace, "direct.png"), join(workspace, "chain.png"));
    await symlink(outside, join(workspace, "outside-dir"));

    try {
      for (const attachmentPath of [
        join(workspace, "direct.png"),
        join(workspace, "chain.png"),
        join(workspace, "outside-dir", "outside.png"),
      ]) {
        const session = createSession("symlink-image");
        track(session.id);
        await withWorkspaceCwd(workspace, async () => {
          await expect(sendPrompt(session.id, "describe", {
            attachments: [{ type: "image", path: attachmentPath }],
          })).rejects.toMatchObject({
            name: "ClaudeAttachmentError",
            code: "attachment_symlink_not_allowed",
          });
        });
      }
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects non-regular disk image attachments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-nonfile-"));
    const imageDirectory = join(directory, "directory.png");
    await mkdir(imageDirectory);
    try {
      const session = createSession("directory-image");
      track(session.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: imageDirectory }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_not_regular_file",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an empty disk image instead of silently omitting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-empty-image-"));
    const emptyImage = join(directory, "empty.png");
    await writeFile(emptyImage, "");
    try {
      const session = createSession("empty-image");
      track(session.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: emptyImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_invalid_data",
          message: "Image attachment file is empty.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps missing disk images to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-missing-image-"));
    const missingImage = join(directory, "missing.png");
    const session = createSession("missing-image");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: missingImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_read_failed",
          message: "Image attachment could not be read safely from the workspace.",
        });
      });
      expect(events.find((event) => event.type === "session.error")?.data).toEqual({
        error: "Image attachment could not be read safely from the workspace.",
        code: "attachment_read_failed",
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports attachment_changed when a disk image mutates during the bounded read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-changed-image-"));
    const imagePath = join(directory, "changed.png");
    await writeFile(imagePath, "abc");
    const session = createSession("changed-image");
    track(session.id);
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(
          session.id,
          "describe",
          { attachments: [{ type: "image", path: imagePath }] },
          {
            afterAttachmentInitialValidation: () => writeFile(imagePath, "changed-image"),
          },
        )).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_changed",
          message: "Image attachment changed while it was being read; please attach it again.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts an image at the 8MB limit and rejects one byte over it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-image-size-"));
    const allowedImage = join(directory, "allowed.png");
    const oversizedImage = join(directory, "oversized.png");
    await writeFile(allowedImage, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES, 1));
    await writeFile(oversizedImage, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 1));
    try {
      const allowedSession = createSession("allowed-image");
      track(allowedSession.id);
      await withWorkspaceCwd(directory, async () => {
        const promptPromise = sendPrompt(allowedSession.id, "describe", {
          attachments: [{ type: "image", path: allowedImage }],
        });
        const call = await nextQueryCall();
        call.push({ type: "result", subtype: "success" });
        call.finish();
        await promptPromise;
        const sdkMessages = await readSdkPrompt(call) as Array<{
          message: { content: Array<{ source?: { data?: string } }> };
        }>;
        expect(sdkMessages[0].message.content[1]?.source?.data).toHaveLength(
          Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) * 4,
        );
      });

      const oversizedSession = createSession("oversized-image");
      track(oversizedSession.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(oversizedSession.id, "describe", {
          attachments: [{ type: "image", path: oversizedImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_too_large",
        });
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("turns non-success SDK results into observable prompt failures and clears the error on retry", async () => {
    const session = createSession("result-errors");
    track(session.id);
    const firstPrompt = sendPrompt(session.id, "first");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "result", subtype: "error_during_execution", errors: ["tool failed"] });
    firstCall.finish();

    await expect(firstPrompt).rejects.toThrow("tool failed");
    expect(session.status).toBe("error");
    expect(session.error).toBe("tool failed");

    const retry = sendPrompt(session.id, "retry");
    expect(session.error).toBeUndefined();
    const retryCall = await nextQueryCall();
    retryCall.push({ type: "result", subtype: "success" });
    retryCall.finish();
    await retry;
    expect(session.status).toBe("idle");
  });

  test("passes Agent SDK outputFormat without removing tools and stores the structured payload", async () => {
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const { events, stop } = captureEvents();
    try {
      const { session, call } = await runPromptWithMessages(
        [{
          type: "result",
          subtype: "success",
          structured_output: { summary: "Looks good" },
        }],
        { outputSchema, requestId: "structured-1" },
      );

      expect(call.options.outputFormat).toEqual({
        type: "json_schema",
        schema: outputSchema,
      });
      expect(call.options.allowedTools).toContain("Read");
      expect(call.options.allowedTools).toContain("Bash");
      expect(session.structuredOutput).toEqual({
        ok: true,
        provider: "claude",
        requestId: "structured-1",
        value: { summary: "Looks good" },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.structured-output",
        sessionId: session.id,
      }));
    } finally {
      stop();
    }
  });

  test("never accepts plaintext as a structured result and types schema retry exhaustion", async () => {
    const outputSchema = { type: "object" };
    const missingSession = createSession("missing-structured");
    track(missingSession.id);
    const missing = sendPrompt(missingSession.id, "review", {
      outputSchema,
      requestId: "structured-missing",
    });
    const missingCall = await nextQueryCall();
    missingCall.push({
      type: "assistant",
      message: { id: "msg-plain", content: [{ type: "text", text: "Looks good" }] },
    });
    missingCall.push({ type: "result", subtype: "success", result: "Looks good" });
    missingCall.finish();

    await expect(missing).rejects.toThrow("without a structured result");
    expect(missingSession.structuredOutput).toMatchObject({
      ok: false,
      error: { code: "malformed_output", retryable: true },
    });

    const exhaustedSession = createSession("exhausted");
    track(exhaustedSession.id);
    const exhausted = sendPrompt(exhaustedSession.id, "review", {
      outputSchema,
      requestId: "structured-exhausted",
    });
    const exhaustedCall = await nextQueryCall();
    exhaustedCall.push({
      type: "result",
      subtype: "error_max_structured_output_retries",
      errors: ["Could not match schema"],
    });
    exhaustedCall.finish();

    await expect(exhausted).rejects.toThrow("Could not match schema");
    expect(exhaustedSession.structuredOutput).toMatchObject({
      ok: false,
      requestId: "structured-exhausted",
      error: { code: "schema_retry_exhausted", retryable: true },
    });
  });

  test("a repeated structured request id attaches instead of launching another query", async () => {
    const session = createSession("deduplicated");
    track(session.id);
    const options = {
      outputSchema: { type: "object" },
      requestId: "structured-once",
    };
    const first = sendPrompt(session.id, "review", options);
    const call = await nextQueryCall();

    await sendPrompt(session.id, "review", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    call.push({
      type: "result",
      subtype: "success",
      structured_output: { summary: "done" },
    });
    call.finish();
    await first;

    await sendPrompt(session.id, "review", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(session.structuredOutput).toMatchObject({
      ok: true,
      requestId: "structured-once",
    });
  });

  test("forwards query configuration and captures init, compact, generic system, and context events", async () => {
    mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
      local: { command: "safe-command", args: [] },
    }));
    mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["local"]));
    mockGetPluginsForSdk.mockImplementationOnce(async () => [
      { type: "local", path: "/plugin" },
    ]);
    const { events, stop } = captureEvents();
    const previousCwd = process.env.CWD;
    process.env.CWD = "/project";
    try {
      const { session, call } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "init",
          session_id: "sdk-init",
          mcp_servers: [
            { name: "local", status: "connected", tools: ["search"] },
            { name: "plugin:extra", status: "failed", error: "offline" },
          ],
          plugins: [{ name: "plain", path: "/plain", status: "loaded" }],
          slash_commands: ["/compact"],
        },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { pre_tokens: 100, post_tokens: 20, trigger: "manual" },
        },
        { type: "system", subtype: "status", detail: "working" },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            context_window_tokens: "200k",
            model: "claude-test",
          },
        },
      ], {
        model: "claude-test",
        effort: "max",
        fastMode: true,
        permissionMode: "bypassPermissions",
      });

      expect(call.options).toMatchObject({
        cwd: "/project",
        model: "claude-test",
        effort: "max",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settings: { fastMode: true },
        resume: undefined,
        mcpServers: { local: { command: "safe-command", args: [] } },
        plugins: [{ type: "local", path: "/plugin" }],
      });
      expect(getSessionInitData(session.id)).toMatchObject({
        mcpServers: [{ name: "local", status: "connected" }],
        plugins: [
          { name: "plugin:extra", status: "failed" },
          { name: "plain", status: "loaded" },
        ],
      });
      expect(events.some((event) => event.type === "system.compact")).toBe(true);
      expect(events.some((event) => event.type === "system.message")).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.updated",
        data: { contextUsage: { usedTokens: 15, totalTokens: 200000, model: "claude-test" } },
      }));
    } finally {
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AskUserQuestion flow via canUseTool
// ---------------------------------------------------------------------------

describe("AskUserQuestion flow", () => {
  test("canUseTool registers a pending question, answerQuestion resolves it with allow", async () => {
    const session = createSession("question-flow");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "ask me");
    const call = await nextQueryCall();

    expect(typeof call.options.canUseTool).toBe("function");

    const canUseToolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [
        {
          question: "Pick a color",
          header: "Color choice",
          options: [{ label: "red" }, { label: "blue" }],
        },
      ],
    });

    // The pending question should now be visible to the API surface.
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [pending] = getPendingQuestions(session.id);
    expect(pending?.questions[0]?.question).toBe("Pick a color");

    expect(answerQuestion(pending!.id, { "Pick a color": "blue" })).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string; updatedInput?: { answers?: Record<string, string> } };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.answers).toEqual({ "Pick a color": "blue" });

    expect(getPendingQuestions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
  });

  test("answerQuestion returns false for unknown ids", () => {
    expect(answerQuestion("missing", {})).toBe(false);
  });

  test("dismissQuestion denies the SDK tool and removes the pending request", async () => {
    const session = createSession("question-dismiss");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask");
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Continue?" }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const question = getPendingQuestions(session.id)[0];

    expect(dismissQuestion(question.id)).toBe(true);
    expect(await toolPromise).toEqual({
      behavior: "deny",
      message: "User dismissed the question",
    });
    expect(getPendingQuestions(session.id)).toEqual([]);
    expect(dismissQuestion(question.id)).toBe(false);

    call.finish();
    await promptPromise;
  });

  test("abort and query failures release pending questions instead of leaving callbacks suspended", async () => {
    const abortedSession = createSession("question-abort");
    track(abortedSession.id);
    const abortedPrompt = sendPrompt(abortedSession.id, "ask");
    const abortedCall = await nextQueryCall();
    const abortedTool = abortedCall.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Abort?" }],
    });
    await waitFor(() => getPendingQuestions(abortedSession.id).length === 1);
    expect(abortSession(abortedSession.id)).toBe(true);
    expect((await abortedTool).behavior).toBe("deny");
    expect(getPendingQuestions(abortedSession.id)).toEqual([]);
    await abortedPrompt;

    const failedSession = createSession("question-failure");
    track(failedSession.id);
    const failedPrompt = sendPrompt(failedSession.id, "ask");
    const failedCall = await nextQueryCall();
    const failedTool = failedCall.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Fail?" }],
    });
    await waitFor(() => getPendingQuestions(failedSession.id).length === 1);
    failedCall.fail(new Error("query failed"));
    await expect(failedPrompt).rejects.toThrow("query failed");
    expect((await failedTool).behavior).toBe("deny");
    expect(getPendingQuestions(failedSession.id)).toEqual([]);
  });

  test("pending question and plan approval getters isolate sessions", async () => {
    const first = createSession("first");
    const second = createSession("second");
    track(first.id);
    track(second.id);
    const firstPrompt = sendPrompt(first.id, "first");
    const secondPrompt = sendPrompt(second.id, "second");
    const firstCall = await nextQueryCall();
    const secondCall = await nextQueryCall();
    const firstTool = firstCall.options.canUseTool!("AskUserQuestion", { questions: [] });
    const secondTool = secondCall.options.canUseTool!("AskUserQuestion", { questions: [] });
    await waitFor(() => getPendingQuestions().length === 2);

    expect(getPendingQuestions(first.id)).toHaveLength(1);
    expect(getPendingQuestions(second.id)).toHaveLength(1);

    for (const question of getPendingQuestions()) dismissQuestion(question.id);
    await Promise.all([firstTool, secondTool]);
    firstCall.finish();
    secondCall.finish();
    await Promise.all([firstPrompt, secondPrompt]);
  });

  test("denies and removes an unanswered question after five minutes", async () => {
    const session = createSession("question-timeout");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "ask");
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const toolPromise = call.options.canUseTool!("AskUserQuestion", {
        questions: [{ question: "Still there?" }],
      });
      await Promise.resolve();
      expect(getPendingQuestions(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      await expect(toolPromise).resolves.toEqual({
        behavior: "deny",
        message: "Question timed out after 5 minutes",
      });
      expect(getPendingQuestions(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.finish();
    await promptPromise;
    expect(events).toContainEqual(expect.objectContaining({
      type: "question.answered",
      sessionId: session.id,
      data: expect.objectContaining({ cancelled: true }),
    }));
    stop();
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode (plan approval) flow via canUseTool
// ---------------------------------------------------------------------------

describe("plan approval flow", () => {
  test("approving the plan resolves canUseTool with allow and emits plan.exit-requested", async () => {
    const session = createSession("plan-approve");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "make a plan");
      const call = await nextQueryCall();

      const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
      const [approval] = getPendingPlanApprovals(session.id);
      expect(approval?.sessionId).toBe(session.id);

      expect(respondToPlanApproval(approval!.id, true)).toBe(true);

      const result = (await canUseToolPromise) as { behavior: string };
      expect(result.behavior).toBe("allow");

      const exitEvent = events.find(
        (e) => e.type === "plan.exit-requested" && e.sessionId === session.id,
      );
      expect(exitEvent).toBeDefined();

      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("rejecting the plan resolves canUseTool with deny and includes feedback", async () => {
    const session = createSession("plan-reject");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    expect(respondToPlanApproval(approval!.id, false, "needs more detail")).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("needs more detail");

    // Finish the original turn. session-manager will then re-prompt with the
    // captured rejection feedback - serve a quick success for that re-prompt.
    call.finish();

    const repromptCall = await nextQueryCall();
    repromptCall.push({ type: "system", subtype: "init", session_id: "sdk-reprompt", mcp_servers: [] });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    expect(getSession(session.id)?.status).toBe("idle");
  });

  test("surfaces a failed plan-rejection re-prompt instead of reporting success", async () => {
    const session = createSession("reprompt-failure");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const firstCall = await nextQueryCall();
    const toolPromise = firstCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const approval = getPendingPlanApprovals(session.id)[0];
    expect(respondToPlanApproval(approval.id, false, "change it")).toBe(true);
    expect((await toolPromise).behavior).toBe("deny");
    firstCall.finish();

    const repromptCall = await nextQueryCall();
    repromptCall.fail(new Error("reprompt failed"));

    await expect(promptPromise).rejects.toThrow("reprompt failed");
    expect(session.status).toBe("error");
    expect(session.error).toBe("reprompt failed");
  });

  test("respondToPlanApproval returns false for unknown ids", () => {
    expect(respondToPlanApproval("missing", true)).toBe(false);
  });

  test("forwards permissionMode: 'plan' to the SDK so ExitPlanMode runs in real plan mode", async () => {
    const session = createSession("plan-mode-forwarded");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("plan");
    // Real plan mode does not need allowDangerouslySkipPermissions
    expect(call.options.allowDangerouslySkipPermissions).toBeFalsy();

    call.finish();
    await promptPromise;
  });

  test("approval is resolvable even if the UI responds before the SDK awaits the promise", async () => {
    const session = createSession("plan-fast-approve");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    // Kick off canUseTool but respond before awaiting it — this exercises the
    // race where the UI's approve fires synchronously after the request event.
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ok" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string };
    expect(result.behavior).toBe("allow");

    call.finish();
    await promptPromise;
  });

  // -------------------------------------------------------------------------
  // Defensive fallback: if the SDK fails ExitPlanMode despite an approval
  // (e.g. SDK plan-mode regression), the bridge should rewrite the tool
  // result to success and re-prompt Claude to continue.
  // -------------------------------------------------------------------------
  test("approved ExitPlanMode failure is overridden to success and triggers continuation re-prompt", async () => {
    const session = createSession("plan-approve-but-fail");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    call.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });

    // User approves the plan via canUseTool
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ship it" });
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    const canUseToolResult = (await canUseToolPromise) as { behavior: string };
    expect(canUseToolResult.behavior).toBe("allow");

    // Simulate the SDK emitting an assistant message containing the
    // ExitPlanMode tool_use, then a user message with a FAILED tool_result.
    call.push({
      type: "assistant",
      uuid: "asst-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-exit-1",
            name: "ExitPlanMode",
            input: { plan: "ship it" },
          },
        ],
      },
    });
    call.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-exit-1",
            content: "Error: not in plan mode",
            is_error: true,
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();

    // Bridge should have queued a continuation re-prompt — serve it.
    const repromptCall = await nextQueryCall();
    // The re-prompt should NOT be in plan mode (user has approved; Claude needs full tools)
    expect(repromptCall.options.permissionMode).not.toBe("plan");
    repromptCall.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    // Recursion guard: after the original sendPrompt resolves, there should be
    // no further queued query calls. The `_isReprompt` flag on the recursive
    // sendPrompt prevents the fallback from re-triggering on the re-prompt
    // itself.
    expect(pendingCalls.length).toBe(0);

    // The original assistant message's ExitPlanMode tool should now show success,
    // not the SDK's reported failure.
    const messages = getSession(session.id)?.messages ?? [];
    const assistantWithTool = messages.find((m) =>
      m.role === "assistant" &&
      m.parts.some((p) => p.toolName === "ExitPlanMode")
    );
    expect(assistantWithTool).toBeDefined();
    const exitPart = assistantWithTool?.parts.find((p) => p.toolName === "ExitPlanMode");
    expect(exitPart?.toolState).toBe("success");
    expect(exitPart?.toolError).toBeUndefined();
  });

  test("deleteSession releases a pending plan approval", async () => {
    const session = createSession("delete-plan");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);

    expect(deleteSession(session.id)).toBe(true);
    expect((await toolPromise).behavior).toBe("deny");
    expect(getPendingPlanApprovals(session.id)).toEqual([]);
    await promptPromise;
  });

  test("EnterPlanMode emits its event and unrelated tools pass their input through", async () => {
    const session = createSession("tool-routing");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "tools");
      const call = await nextQueryCall();
      expect(await call.options.canUseTool!("EnterPlanMode", { reason: "plan" })).toEqual({
        behavior: "allow",
        updatedInput: { reason: "plan" },
      });
      expect(await call.options.canUseTool!("Read", { file_path: "a.ts" })).toEqual({
        behavior: "allow",
        updatedInput: { file_path: "a.ts" },
      });
      call.finish();
      await promptPromise;
      expect(events.some((event) => event.type === "plan.enter-requested")).toBe(true);
    } finally {
      stop();
    }
  });

  test("denies and removes an unanswered plan approval after five minutes", async () => {
    const session = createSession("plan-timeout");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
      await Promise.resolve();
      expect(getPendingPlanApprovals(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      await expect(toolPromise).resolves.toEqual({
        behavior: "deny",
        message: "Plan approval timed out after 5 minutes",
      });
      expect(getPendingPlanApprovals(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.finish();
    await promptPromise;
    expect(events).toContainEqual(expect.objectContaining({
      type: "plan.approval-responded",
      sessionId: session.id,
      data: expect.objectContaining({ cancelled: true }),
    }));
    stop();
  });
});

describe("session titles", () => {
  test("uses the original prompt for CLI generation and clears the pending flag", async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("/claude"));
    const { child, complete } = createMockChildProcess({
      stdout: "Focused title\n",
      defer: true,
    });
    mockSpawn.mockImplementationOnce(() => child as never);

    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(session.id, "original request", {
      attachments: [{ type: "file", path: "/tmp/a.ts", filename: "a.ts" }],
    });
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    complete();
    await waitFor(() => getSession(session.id)?.title === "Focused title");

    expect(mockSpawn.mock.calls[0]?.[1]).toContain("original request");
    expect(mockSpawn.mock.calls[0]?.[1]?.join(" ")).not.toContain("attached-files");
    expect(getSession(session.id)?.titleGenerationPending).toBe(false);
  });

  test("does not overwrite an explicit title that begins with Session", async () => {
    const session = createSession("Session planning notes");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "do work");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.title).toBe("Session planning notes");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("falls back to normalized prompt text when spawn throws synchronously", async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("/claude"));
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn unavailable");
    });
    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(
      session.id,
      "build the `new thing` safely and quickly. extra sentence",
    );
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    await waitFor(() => session.titleGenerationPending === false);

    expect(session.title).toBe("Build the safely and quickly");
  });

  test("falls back when the title CLI emits an error or exits unsuccessfully", async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("/claude"));

    const errored = createMockChildProcess({
      error: new Error("child error"),
      defer: true,
    });
    mockSpawn.mockImplementationOnce(() => errored.child as never);
    const first = createSession();
    track(first.id);
    const firstPrompt = sendPrompt(first.id, "first fallback title");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "result", subtype: "success" });
    firstCall.finish();
    await firstPrompt;
    errored.complete();
    await waitFor(() => first.titleGenerationPending === false);
    expect(first.title).toBe("First fallback title");

    const unsuccessful = createMockChildProcess({
      stderr: "command failed",
      code: 1,
      defer: true,
    });
    mockSpawn.mockImplementationOnce(() => unsuccessful.child as never);
    const second = createSession();
    track(second.id);
    const secondPrompt = sendPrompt(second.id, "second fallback title");
    const secondCall = await nextQueryCall();
    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await secondPrompt;
    unsuccessful.complete();
    await waitFor(() => second.titleGenerationPending === false);
    expect(second.title).toBe("Second fallback title");
  });
});

// ---------------------------------------------------------------------------
// getAvailableModels
// ---------------------------------------------------------------------------

describe("getAvailableModels", () => {
  test("returns the SDK's supported models, mapped to ModelInfo shape", async () => {
    const models = await getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toMatchObject({
      id: "claude-opus-mock",
      resolvedModel: "claude-opus-mock-20260701",
      name: "Claude Opus (mock)",
      supportsFastMode: true,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    });
  });

  test("discovers models with the exact managed Claude executable", async () => {
    const previousClaudeCliPath = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = "/managed/toolchain/claude";
    try {
      await expect(getAvailableModelCatalog()).resolves.toMatchObject({
        source: "sdk",
        models: [{ id: "claude-opus-mock" }],
      });
      expect(mockQuery.mock.calls.at(-1)?.[0]?.options).toMatchObject({
        pathToClaudeCodeExecutable: "/managed/toolchain/claude",
      });
    } finally {
      if (previousClaudeCliPath === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = previousClaudeCliPath;
    }
  });

  test("falls back to the built-in catalog when the SDK query throws", async () => {
    // Make the next query() call fail so getAvailableModels() hits its catch
    // branch and returns the hard-coded fallback list.
    mockQuery.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });

    const models = await getAvailableModels();

    expect(models.map((m) => m.id)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5[1m]",
      "sonnet",
      "haiku",
    ]);
  });

  test("fallback marks the Opus aliases as fast-mode capable and Haiku without effort", async () => {
    mockQuery.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });

    const models = await getAvailableModels();
    const byId = new Map(models.map((m) => [m.id, m]));

    // Default currently resolves to Opus, so both Opus aliases advertise fast mode.
    expect(byId.get("default")?.supportsFastMode).toBe(true);
    expect(byId.get("opus[1m]")?.supportsFastMode).toBe(true);
    expect(models.filter((m) => m.supportsFastMode).map((m) => m.id)).toEqual([
      "default",
      "opus[1m]",
    ]);

    // Reasoning-capable models expose the full effort ladder incl. xhigh/max.
    for (const id of ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet"]) {
      const model = byId.get(id);
      expect(model?.supportsEffort).toBe(true);
      expect(model?.supportedEffortLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }

    // Haiku is the fast, non-reasoning tier.
    expect(byId.get("haiku")?.supportsEffort).toBeUndefined();
  });

  test("cleans up the SDK query after success, failure, and cleanup errors", async () => {
    const successReturn = mock(async () => ({ done: true, value: undefined }));
    const successfulQuery = Object.assign(
      (async function* () {})(),
      {
        supportedModels: async () => [],
        return: successReturn,
      },
    );
    mockQuery.mockImplementationOnce(() => successfulQuery as never);
    expect(await getAvailableModels()).toEqual([]);
    expect(successReturn).toHaveBeenCalledTimes(1);

    const failedReturn = mock(async () => ({ done: true, value: undefined }));
    const failingQuery = Object.assign(
      (async function* () {})(),
      {
        supportedModels: async () => {
          throw new Error("model lookup failed");
        },
        return: failedReturn,
      },
    );
    mockQuery.mockImplementationOnce(() => failingQuery as never);
    expect((await getAvailableModels()).length).toBeGreaterThan(0);
    expect(failedReturn).toHaveBeenCalledTimes(1);

    const cleanupFailure = Object.assign(
      (async function* () {})(),
      {
        supportedModels: async () => [],
        return: async () => {
          throw new Error("cleanup failed");
        },
      },
    );
    mockQuery.mockImplementationOnce(() => cleanupFailure as never);
    expect(await getAvailableModels()).toEqual([]);
  });
});

describe("getClaudeRuntimeVersions", () => {
  async function readBundledManifest(): Promise<{
    version?: string;
    claudeCodeVersion?: string;
  }> {
    const sdkEntryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    return JSON.parse(
      await realFs.promises.readFile(
        new URL("./package.json", sdkEntryUrl),
        "utf8",
      ),
    );
  }

  async function withClaudeCliPath<T>(
    value: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = process.env.CLAUDE_CLI_PATH;
    if (value === undefined) delete process.env.CLAUDE_CLI_PATH;
    else process.env.CLAUDE_CLI_PATH = value;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = previous;
    }
  }

  function stubClaudeVersionOutput(
    executable: string,
    output: string | (() => never),
  ): void {
    mockExecFileSync.mockImplementation(((file: string, args?: string[]) => {
      if (file === executable && args?.[0] === "--version") {
        return typeof output === "function" ? output() : output;
      }
      return originalExecFileSync(
        file as never,
        args as never,
      ) as never;
    }) as never);
  }

  test("reports the bundled SDK/CLI version when no managed executable is set", async () => {
    await withClaudeCliPath(undefined, async () => {
      const manifest = await readBundledManifest();
      const versions = await getClaudeRuntimeVersions();

      expect(versions.sdkVersion).toBe(manifest.version);
      expect(versions.cliVersion).toBe(manifest.claudeCodeVersion);
      // The managed CLI is not probed when CLAUDE_CLI_PATH is unset.
      expect(
        mockExecFileSync.mock.calls.some((call) =>
          (call[1] as string[] | undefined)?.includes("--version"),
        ),
      ).toBe(false);
    });
  });

  test("parses the managed CLI --version output when configured", async () => {
    await withClaudeCliPath("/managed/toolchain/claude", async () => {
      stubClaudeVersionOutput(
        "/managed/toolchain/claude",
        "5.4.2 (Claude Code)\n",
      );

      const versions = await getClaudeRuntimeVersions();

      expect(versions.cliVersion).toBe("5.4.2");
      expect(versions.sdkVersion).toBe((await readBundledManifest()).version);
      const call = mockExecFileSync.mock.calls.find(
        (c) => c[0] === "/managed/toolchain/claude",
      );
      expect(call?.[1]).toEqual(["--version"]);
    });
  });

  test("falls back to the bundled version when the managed CLI probe throws", async () => {
    await withClaudeCliPath("/managed/toolchain/claude", async () => {
      stubClaudeVersionOutput("/managed/toolchain/claude", () => {
        throw new Error("spawn ENOENT");
      });

      const manifest = await readBundledManifest();
      const versions = await getClaudeRuntimeVersions();

      expect(versions.cliVersion).toBe(manifest.claudeCodeVersion);
      expect(versions.sdkVersion).toBe(manifest.version);
    });
  });

  test("falls back to the bundled version when --version has no semver token", async () => {
    await withClaudeCliPath("/managed/toolchain/claude", async () => {
      stubClaudeVersionOutput("/managed/toolchain/claude", "nightly-build\n");

      const manifest = await readBundledManifest();
      const versions = await getClaudeRuntimeVersions();

      expect(versions.cliVersion).toBe(manifest.claudeCodeVersion);
    });
  });
});
