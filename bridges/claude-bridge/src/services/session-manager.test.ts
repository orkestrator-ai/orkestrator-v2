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

/**
 * Extra members spliced onto the object `query()` returns.
 *
 * The bridge feature-detects `stopTask`, `rewindFiles` and `getContextUsage`
 * with `typeof x === "function"` and skips them silently when absent, so they
 * are opt-in per test: installing them unconditionally would change what every
 * other test's turn does (a present `getContextUsage` rewrites the whole usage
 * snapshot).
 */
let queryControlOverrides: Record<string, unknown> = {};

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
    ...queryControlOverrides,
  });
});

// ---------------------------------------------------------------------------
// Module-level SDK session store
// ---------------------------------------------------------------------------
//
// Real RFC 4122 shapes: the bridge derives an SDK session id from the bridge
// id by pattern, so a placeholder string would never round-trip.
const PERSISTED_SDK_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SDK_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FORK_SDK_ID = "99999999-8888-4777-8666-555555555555";

// The bridge feature-detects every one of these with `typeof x === "function"`
// and silently degrades to a no-op when absent, so they have to be present as
// real functions here or the persisted-session surface is never exercised at
// all. Defaults are the empty/inert answer; each test drives the seam it needs.

type SdkSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  cwd?: string;
  createdAt?: number;
};

type SdkSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  isSidechain?: boolean;
};

const mockSdkListSessions = mock(
  async (_options?: Record<string, unknown>): Promise<SdkSessionInfo[]> => [],
);
const mockSdkGetSessionInfo = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<SdkSessionInfo | undefined> => undefined,
);
const mockSdkGetSessionMessages = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<SdkSessionMessage[]> => [],
);
const mockSdkDeleteSession = mock(
  async (_sessionId: string, _options?: Record<string, unknown>): Promise<void> => {},
);
const mockSdkRenameSession = mock(
  async (
    _sessionId: string,
    _title: string,
    _options?: Record<string, unknown>,
  ): Promise<void> => {},
);
const mockSdkForkSession = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<{ sessionId: string }> => ({ sessionId: FORK_SDK_ID }),
);

function resetSdkSessionStoreMocks(): void {
  mockSdkListSessions.mockReset();
  mockSdkListSessions.mockImplementation(async () => []);
  mockSdkGetSessionInfo.mockReset();
  mockSdkGetSessionInfo.mockImplementation(async () => undefined);
  mockSdkGetSessionMessages.mockReset();
  mockSdkGetSessionMessages.mockImplementation(async () => []);
  mockSdkDeleteSession.mockReset();
  mockSdkDeleteSession.mockImplementation(async () => {});
  mockSdkRenameSession.mockReset();
  mockSdkRenameSession.mockImplementation(async () => {});
  mockSdkForkSession.mockReset();
  mockSdkForkSession.mockImplementation(async () => ({ sessionId: FORK_SDK_ID }));
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  listSessions: mockSdkListSessions,
  getSessionInfo: mockSdkGetSessionInfo,
  getSessionMessages: mockSdkGetSessionMessages,
  deleteSession: mockSdkDeleteSession,
  renameSession: mockSdkRenameSession,
  forkSession: mockSdkForkSession,
}));

const mockGetMcpServersForSdk = mock(async () => ({}));
const mockGetMcpServerNames = mock(async () => new Set<string>());
const mockGetPluginsForSdk = mock(async () => [] as Array<{ type: "local"; path: string }>);

/**
 * `sendPrompt` resolves both halves of the MCP config in one call
 * (`getMcpRuntimeConfig`) so the underlying files are read once per prompt.
 * That is the only entry point this module uses; the two mocks above are kept
 * as the seams tests already drive with `mockImplementationOnce`, composed
 * here into the shape the real function returns.
 */
const mockGetMcpRuntimeConfig = mock(async () => ({
  servers: await mockGetMcpServersForSdk(),
  names: await mockGetMcpServerNames(),
}));

mock.module("./mcp-config.js", () => ({
  getMcpRuntimeConfig: mockGetMcpRuntimeConfig,
}));

mock.module("./plugin-config.js", () => ({
  getPluginsForSdk: mockGetPluginsForSdk,
}));

// Import AFTER mocks are installed so session-manager picks them up.
const sessionManager = await import("./session-manager.js");
const { eventEmitter } = await import("./event-emitter.js");
import type {
  BackgroundTaskSnapshot,
  MessagePatchEventData,
  NormalizedPart,
  SessionUsageSnapshot,
  SSEEvent,
} from "../types/index.js";
import {
  MAX_DIFF_SIDE_BYTES,
  MAX_TOOL_TEXT_BYTES,
  TRUNCATED_NOTICE,
} from "./part-budget.js";

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
  reconcilePersistedSessions,
  ensurePersistedSession,
  hydratePersistedSessionMessages,
  deleteSessionDurably,
  renameSessionDurably,
  forkPersistedSession,
  rewindSessionFiles,
  stopBackgroundTask,
  getStructuredPromptDispatchState,
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

async function withControlledNewDate<T>(
  initialTime: string,
  run: (setTime: (time: string) => void) => Promise<T>,
): Promise<T> {
  const RealDate = globalThis.Date;
  let currentTime = RealDate.parse(initialTime);
  const ControlledDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        args.length > 0 ? args : [currentTime],
        newTarget,
      );
    },
  });
  globalThis.Date = ControlledDate;
  try {
    return await run((time) => {
      currentTime = RealDate.parse(time);
    });
  } finally {
    globalThis.Date = RealDate;
  }
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
  resetSdkSessionStoreMocks();
  queryControlOverrides = {};
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
          model: "claude-sonnet-4-6",
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
      expect(stored.messages[1]?.modelId).toBe("claude-sonnet-4-6");

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

  test("maps supported agents into the authoritative init snapshot", async () => {
    queryControlOverrides.supportedAgents = async () => [
      {
        name: "reviewer",
        description: "Reviews changes",
        model: "claude-opus-mock",
        ignoredProviderField: true,
      },
    ];

    const { session } = await runPromptWithMessages([
      {
        type: "system",
        subtype: "init",
        session_id: "sdk-agents",
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      },
      { type: "result", subtype: "success" },
    ]);

    expect(getSessionInitData(session.id)?.agents).toEqual([
      {
        name: "reviewer",
        description: "Reviews changes",
        model: "claude-opus-mock",
      },
    ]);
  });

  test("warns when a provider turn produces no messages or heartbeat", async () => {
    jest.useFakeTimers();
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const session = createSession("quiet provider");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "hello?");
      const call = await nextQueryCall();

      jest.advanceTimersByTime(30_001);
      expect(warn.mock.calls.some(
        ([message]) => String(message).includes("has not responded after 5 seconds"),
      )).toBe(true);
      expect(warn.mock.calls.some(
        ([message]) => String(message).includes("No SDK messages yet"),
      )).toBe(true);

      call.finish();
      await promptPromise;
    } finally {
      console.warn = originalWarn;
      jest.useRealTimers();
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
        uuid: "partial-asst-start",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "partial-asst-1",
            model: "claude-opus-5",
          },
        },
      });
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
      expect(
        (
          streamedEvent?.data as { message?: { modelId?: string } } | undefined
        )?.message?.modelId,
      ).toBe("claude-opus-5");

      call.push({
        type: "assistant",
        uuid: "partial-asst-1",
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("Hello final");
      expect(assistant?.modelId).toBe("claude-opus-5");
      expect(events.some((event) => {
        const published = (
          event.data as { message?: { modelId?: string } } | undefined
        )?.message;
        return event.type === "message.updated"
          && published?.modelId === "claude-opus-5";
      })).toBe(true);
    } finally {
      stop();
    }
  });

  test("publishes model attribution when only the final assistant record supplies it", async () => {
    const session = createSession("late model metadata");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Resolve the model later");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "late-model-start",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: "late-model-assistant" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "late-model-assistant",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "late-model-assistant",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() =>
        getSessionMessages(session.id).some(
          (message) => message.role === "assistant" && message.content === "Hello",
        ),
      );
      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();

      call.push({
        type: "assistant",
        uuid: "late-model-assistant",
        parent_tool_use_id: null,
        message: {
          id: "late-model-assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const assistant = getSessionMessages(session.id).find(
        (message) => message.role === "assistant",
      );
      expect(assistant?.content).toBe("Hello final");
      expect(assistant?.modelId).toBe("claude-sonnet-5");
      expect(events.some((event) => {
        const published = (
          event.data as { message?: { modelId?: string } } | undefined
        )?.message;
        return event.type === "message.updated"
          && published?.modelId === "claude-sonnet-5";
      })).toBe(true);
    } finally {
      stop();
    }
  });

  test.each(["", "   ", "<synthetic>"])(
    "never attributes an unusable live model id %#",
    async (model) => {
      const session = createSession("invalid live model");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "invalid-model-start",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: "invalid-model-assistant", model },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "invalid-model-assistant",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "invalid-model-assistant",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() =>
        getSessionMessages(session.id).some(
          (message) => message.role === "assistant" && message.content === "Hello",
        ),
      );
      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();

      call.push({
        type: "assistant",
        uuid: "invalid-model-assistant",
        message: {
          model,
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();
    },
  );

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

  test("records deterministic first-arrival timestamps for separate streamed blocks", async () => {
    const session = createSession("streaming-block-timestamps");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Stream two blocks");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T10:00:00.000Z", async (setTime) => {
      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-block-times",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("block-message-start", {
        type: "message_start",
        message: { id: "msg_block_times", role: "assistant", content: [] },
      });
      streamEvent("block-0-start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "First" },
      });
      await waitFor(() => {
        const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
        return parts?.[0]?.content === "First";
      });

      setTime("2026-07-26T10:03:00.000Z");
      streamEvent("block-1-start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "Second" },
      });
      await waitFor(() => {
        const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
        return parts?.[1]?.content === "Second";
      });

      const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
      expect(parts?.map((part) => part.timestamp)).toEqual([
        "2026-07-26T10:00:00.000Z",
        "2026-07-26T10:03:00.000Z",
      ]);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    });
  });

  test("preserves a thinking block start timestamp across deltas and final replacement", async () => {
    const session = createSession("streaming-thinking-timestamp");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Think carefully");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T11:00:00.000Z", async (setTime) => {
      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-thinking-time",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("thinking-message-start", {
        type: "message_start",
        message: { id: "msg_thinking_time", role: "assistant", content: [] },
      });
      streamEvent("thinking-block-start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("thinking-delta-1", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Initial" },
      });
      await waitFor(() => {
        const part = getSessionMessages(session.id)
          .find((message) => message.role === "assistant")
          ?.parts.find((candidate) => candidate.type === "thinking");
        return part?.content === "Initial";
      });

      setTime("2026-07-26T11:01:00.000Z");
      streamEvent("thinking-delta-2", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " reasoning" },
      });
      await waitFor(() => {
        const part = getSessionMessages(session.id)
          .find((message) => message.role === "assistant")
          ?.parts.find((candidate) => candidate.type === "thinking");
        return part?.content === "Initial reasoning";
      });

      setTime("2026-07-26T11:02:00.000Z");
      call.push({
        type: "assistant",
        uuid: "thinking-final",
        message: {
          id: "msg_thinking_time",
          content: [{ type: "thinking", thinking: "Final reasoning" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const thinkingPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((candidate) => candidate.type === "thinking");
      expect(thinkingPart).toMatchObject({
        content: "Final reasoning",
        timestamp: "2026-07-26T11:00:00.000Z",
      });
    });
  });

  test("timestamps a delta that arrives without a content block start", async () => {
    const session = createSession("streaming-delta-fallback");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Stream without start");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T12:00:00.000Z", async () => {
      call.push({
        type: "stream_event",
        uuid: "delta-without-start",
        session_id: "sdk-session-delta-fallback",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Recovered text" },
        },
      });
      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((message) => message.role === "assistant");
        return assistant?.content === "Recovered text";
      });

      const textPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((part) => part.type === "text");
      expect(textPart?.timestamp).toBe("2026-07-26T12:00:00.000Z");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    });
  });

  test("timestamps a final-only assistant block when no stream events arrived", async () => {
    const session = createSession("final-only-timestamp");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Answer without streaming");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T13:00:00.000Z", async () => {
      call.push({
        type: "assistant",
        uuid: "final-only",
        message: {
          id: "msg_final_only",
          content: [{ type: "text", text: "Final answer" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const textPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((part) => part.type === "text");
      expect(textPart).toMatchObject({
        content: "Final answer",
        timestamp: "2026-07-26T13:00:00.000Z",
      });
    });
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
      const streamedTextTimestamp = getSessionMessages(session.id)
        .find((m) => m.role === "assistant")
        ?.parts.find((part) => part.type === "text")
        ?.timestamp;
      expect(Number.isFinite(new Date(streamedTextTimestamp ?? "").getTime())).toBe(true);

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
      expect(assistant?.parts[1]?.timestamp).toBe(streamedTextTimestamp);
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
      expect(
        Number.isFinite(new Date(assistant?.parts[2]?.timestamp ?? "").getTime()),
      ).toBe(true);
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
   * Reconstructs the assistant content a subscriber holds after each frame.
   *
   * A turn publishes one `message.updated` and then patches it, so neither
   * event type alone shows the sequence the client sees. This applies both the
   * way the client does — including deriving `content` from the text parts,
   * which is what lets a patch avoid re-sending it.
   *
   * `message.updated` carries the live `NormalizedMessage`, which keeps
   * mutating as the turn proceeds, so content is snapshotted at emit time.
   */
  function captureAssistantContentFrames(): { frames: string[]; stop: () => void } {
    const frames: string[] = [];
    let parts: NormalizedPart[] = [];

    const contentOf = (current: NormalizedPart[]) =>
      current
        .filter((part) => part.type === "text")
        .map((part) => part.content ?? "")
        .join("");

    const stop = eventEmitter.subscribe((event) => {
      if (event.type === "message.updated") {
        const message = (event.data as {
          message?: { role?: string; content?: string; parts?: NormalizedPart[] };
        }).message;
        if (message?.role !== "assistant") return;
        parts = (message.parts ?? []).slice();
        frames.push(message.content ?? "");
        return;
      }

      if (event.type !== "message.patched") return;
      const patch = event.data as MessagePatchEventData;
      for (const { index, part } of patch.changedParts) parts[index] = part;
      parts.length = patch.partCount;
      frames.push(contentOf(parts));
    });

    return { frames, stop };
  }

  /** Frames of either kind — what the client re-renders on. */
  const messageFrames = (events: SSEEvent[]): SSEEvent[] =>
    events.filter(
      (event) => event.type === "message.updated" || event.type === "message.patched",
    );

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
      // the one-per-token rebuild this replaced. Counted across both frame
      // kinds: the first publish is a full message and the rest are patches.
      const updates = messageFrames(events);
      expect(updates.length).toBeLessThan(5);
      expect(updates.length).toBeGreaterThan(0);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("publishes each message once in full, then only the parts that changed", async () => {
    const session = createSession("patching");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream, call a tool, stream again");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "patch-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("patch-1", "before"));
      await waitFor(() => assistantContent(session.id) === "before");

      // A tool with a large result: the payload that made full frames O(turn
      // size) and must therefore appear in exactly one frame, not all of them.
      const bulkyOutput = "x".repeat(50_000);
      call.push({
        type: "assistant",
        message: {
          id: "patch-1",
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/a.ts" } }],
        },
      });
      call.push({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: bulkyOutput }],
        },
      });
      await waitFor(() =>
        getSessionMessages(session.id).some((message) =>
          message.parts.some((part) => part.toolOutput === bulkyOutput),
        ),
      );

      call.push(textDelta("patch-1", " after"));
      await waitFor(() => (assistantContent(session.id) ?? "").endsWith(" after"));

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The prompt's own user message is published as a full frame too; this
      // is about the assistant message the turn streams into.
      const frames = messageFrames(events).filter(
        (frame) =>
          frame.type === "message.patched" ||
          (frame.data as { message?: { role?: string } }).message?.role === "assistant",
      );
      const fullFrames = frames.filter((frame) => frame.type === "message.updated");
      const patches = frames.filter((frame) => frame.type === "message.patched");
      const finalMessage = getSessionMessages(session.id).find((m) => m.role === "assistant")!;

      // One full frame for the message, and everything after it is a patch.
      expect(fullFrames).toHaveLength(1);
      expect(patches.length).toBeGreaterThan(0);
      for (const patch of patches) {
        expect((patch.data as MessagePatchEventData).messageId).toBe(finalMessage.id);
      }

      // The bulky tool output crosses the wire once. Before this change it rode
      // along in every frame emitted for the rest of the turn.
      const framesCarryingOutput = frames.filter((frame) =>
        JSON.stringify(frame.data).includes(bulkyOutput),
      );
      expect(framesCarryingOutput).toHaveLength(1);

      // Replaying the frames must land a subscriber exactly where the
      // authoritative transcript is — the patches are not allowed to lose or
      // reorder anything the full frame would have carried.
      let parts: NormalizedPart[] = [];
      for (const frame of frames) {
        if (frame.type === "message.updated") {
          parts = ((frame.data as { message: { parts: NormalizedPart[] } }).message.parts).slice();
          continue;
        }
        const patch = frame.data as MessagePatchEventData;
        for (const { index, part } of patch.changedParts) parts[index] = part;
        parts.length = patch.partCount;
      }
      expect(parts).toEqual(finalMessage.parts);
    } finally {
      stop();
    }
  });

  test("numbers every published frame so a recipient can detect a missed one", async () => {
    const session = createSession("revisions");
    track(session.id);

    // `message.updated` carries the live `NormalizedMessage`, whose revision
    // keeps advancing as the turn patches it, so the revision has to be read
    // at emit time — which is also when the SSE writer serializes it.
    const revisions: (number | undefined)[] = [];
    const stop = eventEmitter.subscribe((event) => {
      if (event.type === "message.updated") {
        const message = (event.data as {
          message?: { role?: string; revision?: number };
        }).message;
        if (message?.role !== "assistant") return;
        revisions.push(message.revision);
        return;
      }
      if (event.type !== "message.patched") return;
      revisions.push((event.data as MessagePatchEventData).revision);
    });

    try {
      const promptPromise = sendPrompt(session.id, "Stream something");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "rev-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("rev-1", "one"));
      await waitFor(() => assistantContent(session.id) === "one");
      call.push(textDelta("rev-1", " two"));
      await waitFor(() => assistantContent(session.id) === "one two");
      call.push(textDelta("rev-1", " three"));
      await waitFor(() => assistantContent(session.id) === "one two three");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The full frame is revision 1 and every patch is exactly one more than
      // the frame before it. A recipient that sees a jump knows it missed a
      // frame — which, for an index-addressed patch, is the difference between
      // recovering and silently rendering the wrong transcript.
      expect(revisions.length).toBeGreaterThan(1);
      expect(revisions).toEqual(revisions.map((_, index) => index + 1));

      // The transcript carries the same revision the last frame announced, so
      // a client that recovers by refetching can rejoin the patch stream.
      const finalMessage = getSessionMessages(session.id).find((m) => m.role === "assistant")!;
      expect(finalMessage.revision).toBe(revisions[revisions.length - 1]);
    } finally {
      stop();
    }
  });

  test("bounds the payloads a session retains for the rest of its life", async () => {
    const session = createSession("budget");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "Write a big file and read a big result");
    const call = await nextQueryCall();

    // Both fields that are unbounded by construction: the whole contents of a
    // written file, and whatever a tool chose to return.
    const hugeFile = "f".repeat(MAX_DIFF_SIDE_BYTES + 5_000);
    const hugeOutput = "o".repeat(MAX_TOOL_TEXT_BYTES + 5_000);

    call.push({
      type: "assistant",
      message: {
        id: "budget-1",
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: "/big.ts", content: hugeFile },
          },
        ],
      },
    });
    call.push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "write-1", content: hugeOutput }],
      },
    });
    await waitFor(() =>
      getSessionMessages(session.id).some((message) =>
        message.parts.some((part) => part.toolUseId === "write-1" && part.toolOutput),
      ),
    );

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    const part = getSessionMessages(session.id)
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.toolUseId === "write-1")!;

    // Capped, not dropped: the head survives so the transcript still shows what
    // happened, and the marker says why the tail is missing.
    expect(part.toolOutput).toEndWith(TRUNCATED_NOTICE);
    expect(Buffer.byteLength(part.toolOutput!, "utf8")).toBeLessThan(
      MAX_TOOL_TEXT_BYTES + TRUNCATED_NOTICE.length + 8,
    );
    expect(part.toolDiff?.after).toEndWith(TRUNCATED_NOTICE);
    expect(Buffer.byteLength(part.toolDiff!.after!, "utf8")).toBeLessThan(
      MAX_DIFF_SIDE_BYTES + TRUNCATED_NOTICE.length + 8,
    );
    expect(part.toolDiff?.filePath).toBe("/big.ts");
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

  test("stamps each task tool call with the resulting task list state", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "task-message",
        message: {
          id: "task-message",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Cache threadId", description: "..." },
            },
            {
              type: "tool_use",
              id: "create-2",
              name: "TaskCreate",
              input: { subject: "Fix cache thrash", description: "..." },
            },
            {
              type: "tool_use",
              id: "update-1",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Cache threadId",
            },
            {
              type: "tool_result",
              tool_use_id: "create-2",
              content: "Task #2 created successfully: Fix cache thrash",
            },
            { type: "tool_result", tool_use_id: "update-1", content: "Updated task #1 status" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tools = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    // Each call carries the list as it stood after that call, so the renderer
    // never has to reconstruct it from neighbouring parts.
    expect(tools[0]?.taskSnapshot).toEqual({
      items: [{ id: "1", subject: "Cache threadId", status: "pending" }],
      complete: true,
      changedTaskId: "1",
    });
    expect(tools[1]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Cache threadId", status: "pending" },
      { id: "2", subject: "Fix cache thrash", status: "pending" },
    ]);
    // The update carries only {taskId, status}; the subject comes from the registry.
    expect(tools[2]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Cache threadId", status: "in_progress" },
      { id: "2", subject: "Fix cache thrash", status: "pending" },
    ]);
    // The bridge resolves the changed task, so the renderer never re-parses it.
    expect(tools[2]?.taskSnapshot?.changedTaskId).toBe("1");
  });

  test("serves the session task list from its authoritative endpoint", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "task-endpoint",
        message: {
          id: "task-endpoint",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Rehydrated task", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Rehydrated task",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    // A tab that was unmounted while this ran reads the list from the session,
    // not by replaying the transcript.
    expect(getSession(session.id)?.taskRegistry?.snapshot()).toEqual({
      items: [{ id: "1", subject: "Rehydrated task", status: "pending" }],
      complete: true,
    });
  });

  test("omits the snapshot when a task call's output cannot be parsed", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "unparsed",
        message: {
          id: "unparsed",
          content: [
            {
              type: "tool_use",
              id: "create-bad",
              name: "TaskCreate",
              input: { subject: "Never assigned an id", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-bad",
              // Succeeded, but in a shape the registry does not recognize.
              content: "Something the registry has never seen",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");

    // No snapshot at all, so the renderer shows the call itself rather than an
    // empty list it would otherwise present as fact.
    expect(tool?.toolState).toBe("success");
    expect(tool?.taskSnapshot).toBeUndefined();
    expect(getSession(session.id)?.taskRegistry?.snapshot().items).toEqual([]);
  });

  test("marks the list incomplete when it never saw a task created", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "partial",
        message: {
          id: "partial",
          content: [
            {
              type: "tool_use",
              id: "update-unknown",
              name: "TaskUpdate",
              input: { taskId: "7", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "update-unknown",
              content: "Updated task #7 status",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");

    // The task predates this registry, so its view is missing whatever came
    // before and must not be shown as the whole list.
    expect(tool?.taskSnapshot?.complete).toBe(false);
    expect(tool?.taskSnapshot?.items).toEqual([
      { id: "7", subject: "Task #7", status: "in_progress" },
    ]);
  });

  test("carries the task list across turns and ignores failed task calls", async () => {
    const session = createSession("multi-turn tasks");
    track(session.id);

    const runTurn = async (messages: unknown[]) => {
      const promptPromise = sendPrompt(session.id, "go");
      const call = await nextQueryCall();
      for (const message of messages) call.push(message);
      call.finish();
      await promptPromise;
    };

    await runTurn([
      {
        type: "assistant",
        uuid: "turn-1",
        message: {
          id: "turn-1",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Survives the turn", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Survives the turn",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    await runTurn([
      {
        type: "assistant",
        uuid: "turn-2",
        message: {
          id: "turn-2",
          content: [
            {
              type: "tool_use",
              id: "update-fail",
              name: "TaskUpdate",
              input: { taskId: "1", status: "completed" },
            },
            {
              type: "tool_use",
              id: "update-ok",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "update-fail",
              content: "Task #1 not found",
              is_error: true,
            },
            { type: "tool_result", tool_use_id: "update-ok", content: "Updated task #1 status" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const secondTurn = getSessionMessages(session.id)
      .filter((message) => message.role === "assistant")
      .at(-1);
    const tools = secondTurn?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    // The failed call left the list alone and got no snapshot at all.
    expect(tools[0]?.toolState).toBe("failure");
    expect(tools[0]?.taskSnapshot).toBeUndefined();
    // The successful one still resolves a task created in the *previous* turn,
    // and the list is still complete: nothing had to be synthesized.
    expect(tools[1]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Survives the turn", status: "in_progress" },
    ]);
    expect(tools[1]?.taskSnapshot?.complete).toBe(true);
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
          model: "claude-subagent",
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
    expect(session.messages.every((message) => message.modelId === undefined)).toBe(true);
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

  test("reports every structured prompt dispatch state", async () => {
    expect(getStructuredPromptDispatchState("missing", "request")).toBe("not-found");
    const session = createSession("dispatch state");
    track(session.id);
    expect(getStructuredPromptDispatchState(session.id, "request")).toBe("new");

    session.structuredOutputRequestId = "request";
    session.status = "running";
    expect(getStructuredPromptDispatchState(session.id, "request")).toBe("processing");

    session.status = "idle";
    session.structuredOutput = {
      ok: true,
      provider: "claude",
      requestId: "request",
      value: { done: true },
    };
    expect(getStructuredPromptDispatchState(session.id, "request")).toBe("already-processed");
    expect(getStructuredPromptDispatchState(session.id, "other")).toBe("new");
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
        mcpServers: { local: { command: "safe-command", args: [] } },
        plugins: [{ type: "local", path: "/plugin" }],
      });

      // Asserted explicitly rather than folded into the `toMatchObject` above:
      // half of these are legitimately `undefined` on this path, and
      // `toMatchObject`/`toEqual` both ignore undefined-valued keys, so an
      // option that silently stopped being forwarded would still pass there.
      expect(call.options.resume).toBeUndefined();
      expect(call.options.sessionId).toBe(session.id.slice("session-".length));
      expect(call.options.agent).toBeUndefined();
      expect(call.options.enableFileCheckpointing).toBe(true);
      expect(call.options.agentProgressSummaries).toBe(true);
      expect(call.options.promptSuggestions).toBe(false);
      expect(call.options.includePartialMessages).toBe(true);
      expect(call.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(call.options.settingSources).toEqual(["user", "project"]);
      expect(call.options.systemPrompt).toMatchObject({
        type: "preset",
        preset: "claude_code",
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

      // Pinned in full. Every field here is rendered by the UI, and an
      // `objectContaining` on four of them cannot notice the other fourteen
      // regressing — including the cache counters that Issue 12 was about.
      const usageEvent = events.find(
        (event) =>
          event.type === "session.updated"
          && (event.data as { contextUsage?: unknown })?.contextUsage !== undefined,
      );
      const contextUsage = (usageEvent?.data as { contextUsage: SessionUsageSnapshot })
        .contextUsage;
      expect(contextUsage).toEqual({
        usedTokens: 15,
        totalTokens: 200000,
        percentUsed: 0.0075,
        modelId: "claude-test",
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastTurnTokens: 15,
        sessionTokens: 15,
        costUsd: 0,
        durationMs: 0,
        apiDurationMs: 0,
        permissionDenials: 0,
        contextCategories: undefined,
        estimated: true,
        source: "claude",
        updatedAt: expect.any(String),
        rateLimits: undefined,
      });
      // `toEqual` ignores undefined-valued keys in Bun, so the key set is
      // asserted separately: without this, a field that stopped being emitted
      // entirely would still satisfy the object above.
      expect(Object.keys(contextUsage).sort()).toEqual([
        "apiDurationMs",
        "cacheReadTokens",
        "cacheWriteTokens",
        "contextCategories",
        "costUsd",
        "durationMs",
        "estimated",
        "inputTokens",
        "lastTurnTokens",
        "modelId",
        "outputTokens",
        "percentUsed",
        "permissionDenials",
        "rateLimits",
        "sessionTokens",
        "source",
        "totalTokens",
        "updatedAt",
        "usedTokens",
      ]);
      expect(getSession(session.id)?.usage).toEqual(contextUsage);
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

// ---------------------------------------------------------------------------
// Persisted session registry
// ---------------------------------------------------------------------------

const U1 = "00000000-0000-4000-8000-000000000001";
const A1 = "00000000-0000-4000-8000-000000000002";
const TOOL_RESULT_UUID = "00000000-0000-4000-8000-000000000003";
const A2 = "00000000-0000-4000-8000-000000000004";
const U2 = "00000000-0000-4000-8000-000000000005";
const U3 = "00000000-0000-4000-8000-000000000006";

/**
 * A transcript containing the shape that broke ordinal resolution: a
 * `tool_result` arrives as an empty `type:"user"` record, which normalization
 * drops and the persisted list keeps. From that point on the two lists are
 * offset by one and every positional lookup is wrong by a message.
 */
function transcriptWithToolResult(sessionId = PERSISTED_SDK_ID): SdkSessionMessage[] {
  return [
    {
      type: "user",
      uuid: U1,
      session_id: sessionId,
      message: { role: "user", content: [{ type: "text", text: "first prompt" }] },
      parent_tool_use_id: null,
    },
    {
      type: "assistant",
      uuid: A1,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } }],
      },
      parent_tool_use_id: null,
    },
    {
      type: "user",
      uuid: TOOL_RESULT_UUID,
      session_id: sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
      },
      parent_tool_use_id: null,
    },
    {
      type: "assistant",
      uuid: A2,
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
      parent_tool_use_id: null,
    },
    {
      type: "user",
      uuid: U2,
      session_id: sessionId,
      message: { role: "user", content: [{ type: "text", text: "second prompt" }] },
      parent_tool_use_id: null,
    },
  ];
}

function sdkSessionInfo(overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: PERSISTED_SDK_ID,
    summary: "Persisted session",
    lastModified: Date.parse("2026-07-01T00:00:00.000Z"),
    createdAt: Date.parse("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function materializePersistedSession(
  overrides: Partial<SdkSessionInfo> = {},
): Promise<ReturnType<typeof getSession> & object> {
  const info = sdkSessionInfo(overrides);
  mockSdkGetSessionInfo.mockImplementation(async () => info);
  const bridgeId = `session-${info.sessionId}`;
  track(bridgeId);
  const state = await ensurePersistedSession(bridgeId);
  if (!state) throw new Error("expected the session to materialize");
  return state;
}

describe("reconcilePersistedSessions", () => {
  test("asks the SDK for this directory only and drops worktree siblings", async () => {
    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({ sessionId: PERSISTED_SDK_ID, cwd: "/repo/env-a" }),
      sdkSessionInfo({ sessionId: OTHER_SDK_ID, cwd: "/repo/env-b" }),
    ]);

    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    track(`session-${PERSISTED_SDK_ID}`);
    track(`session-${OTHER_SDK_ID}`);

    expect(mockSdkListSessions).toHaveBeenCalledWith({
      dir: "/repo/env-a",
      includeProgrammatic: true,
      includeWorktrees: false,
    });
    // Every Orkestrator environment is a worktree of the same repo, so an
    // adopted sibling would be renamable, forkable and deletable from the
    // wrong environment.
    expect(getSession(`session-${PERSISTED_SDK_ID}`)).toBeDefined();
    expect(getSession(`session-${OTHER_SDK_ID}`)).toBeUndefined();
  });

  test("keeps sessions whose cwd the SDK did not report", async () => {
    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({ sessionId: PERSISTED_SDK_ID, cwd: undefined }),
    ]);

    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    track(`session-${PERSISTED_SDK_ID}`);

    expect(getSession(`session-${PERSISTED_SDK_ID}`)?.title).toBe("Persisted session");
  });

  test("adopts a new session with metadata and a deferred transcript", async () => {
    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({ customTitle: "Named by the user", cwd: "/repo/env-a" }),
    ]);

    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    const adopted = getSession(track(`session-${PERSISTED_SDK_ID}`));

    expect(adopted).toMatchObject({
      title: "Named by the user",
      status: "idle",
      sdkSessionId: PERSISTED_SDK_ID,
      persistedMessagesLoaded: false,
    });
    expect(adopted?.createdAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(adopted?.lastActivity.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // Listing must stay bounded for a large Claude home.
    expect(mockSdkGetSessionMessages).not.toHaveBeenCalled();
  });

  test("updates an existing session in place instead of replacing it", async () => {
    const existing = createSession("Local title");
    track(existing.id);
    const sdkId = existing.id.slice("session-".length);
    existing.messages.push({
      id: "msg-local",
      role: "user",
      content: "in memory",
      parts: [],
      timestamp: "2026-07-01T00:00:00.000Z",
    });

    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({ sessionId: sdkId, customTitle: "Renamed on disk", cwd: "/repo/env-a" }),
    ]);
    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });

    // Same object: replacing it would drop the transcript, task registry and
    // any in-flight turn state hanging off this session.
    expect(getSession(existing.id)).toBe(existing);
    expect(existing.title).toBe("Renamed on disk");
    expect(existing.sdkSessionId).toBe(sdkId);
    expect(existing.messages).toHaveLength(1);
  });

  test("falls back to a derived title when the SDK reports neither", async () => {
    mockSdkListSessions.mockImplementation(async () => [
      { sessionId: PERSISTED_SDK_ID, summary: "", lastModified: Date.now() },
    ]);
    await reconcilePersistedSessions();
    expect(getSession(track(`session-${PERSISTED_SDK_ID}`))?.title).toBe(
      `Session ${PERSISTED_SDK_ID.slice(-6)}`,
    );
  });

  test("keeps a generated title and writes it through to the rollout", async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("/claude"));
    const { child, complete } = createMockChildProcess({
      stdout: "Focused title\n",
      defer: true,
    });
    mockSpawn.mockImplementationOnce(() => child as never);

    // No summary on disk yet, so the bridge starts from the id-derived
    // placeholder — the state a first turn generates a title from.
    const state = await materializePersistedSession({ summary: "", cwd: "/repo/env-a" });
    expect(state.title).toBe(`Session ${PERSISTED_SDK_ID.slice(-6)}`);

    const promptPromise = sendPrompt(state.id, "make the thing");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    complete();
    await waitFor(() => state.title === "Focused title");

    // Persisted, not just held in memory: without a durable custom title the
    // reconcile below has nothing to tell this apart from a placeholder.
    expect(mockSdkRenameSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, "Focused title", {
      dir: process.env.CWD || process.cwd(),
    });

    // `summary` is effectively always set, so taking it unconditionally
    // reverted the generated title on the very next `GET /session/list`.
    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({ summary: "Do the thing well", cwd: "/repo/env-a" }),
    ]);
    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    expect(getSession(state.id)?.title).toBe("Focused title");
  });

  test("lets a summary fill a still-default title but never an explicit one", async () => {
    const placeholder = createSession();
    track(placeholder.id);
    const named = createSession("Chosen by the user");
    track(named.id);

    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({
        sessionId: placeholder.id.slice("session-".length),
        summary: "Summarized on disk",
        cwd: "/repo/env-a",
      }),
      sdkSessionInfo({
        sessionId: named.id.slice("session-".length),
        summary: "Summarized on disk",
        cwd: "/repo/env-a",
      }),
    ]);
    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });

    expect(placeholder.title).toBe("Summarized on disk");
    expect(named.title).toBe("Chosen by the user");
  });

  test("an on-disk rename still outranks the in-memory title", async () => {
    const existing = createSession("Local title");
    track(existing.id);
    mockSdkListSessions.mockImplementation(async () => [
      sdkSessionInfo({
        sessionId: existing.id.slice("session-".length),
        customTitle: "Renamed on disk",
        summary: "Summarized on disk",
        cwd: "/repo/env-a",
      }),
    ]);
    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    expect(existing.title).toBe("Renamed on disk");
  });

  test("does not resurrect a session deleted while the listing was in flight", async () => {
    const state = await materializePersistedSession({ cwd: "/repo/env-a" });
    let releaseList: ((infos: SdkSessionInfo[]) => void) | undefined;
    mockSdkListSessions.mockImplementation(
      async () => new Promise<SdkSessionInfo[]>((resolve) => {
        releaseList = resolve;
      }),
    );

    const reconcile = withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    await waitFor(() => releaseList !== undefined);

    expect(await deleteSessionDurably(state.id)).toBe(true);
    expect(getSession(state.id)).toBeUndefined();

    // This snapshot predates the deletion. Adopting it re-inserts a session
    // whose rollout is gone — and reconcile never prunes, so it would be
    // listed, openable and undeletable for the lifetime of the bridge.
    releaseList!([sdkSessionInfo({ cwd: "/repo/env-a" })]);
    await reconcile;
    expect(getSession(state.id)).toBeUndefined();

    // The tombstone orders one read against one deletion; it is not a
    // permanent ban on the id.
    mockSdkListSessions.mockImplementation(async () => [sdkSessionInfo({ cwd: "/repo/env-a" })]);
    await withWorkspaceCwd("/repo/env-a", async () => {
      await reconcilePersistedSessions();
    });
    expect(getSession(state.id)).toBeDefined();
  });

  test("propagates a listSessions failure to its caller", async () => {
    mockSdkListSessions.mockImplementation(async () => {
      throw new Error("claude home unreadable");
    });
    // The route is what must survive this (see routes/session.test.ts); the
    // service reports it rather than swallowing an unreadable Claude home.
    await expect(reconcilePersistedSessions()).rejects.toThrow("claude home unreadable");
  });
});

describe("ensurePersistedSession", () => {
  test("returns an in-memory session without consulting the SDK", async () => {
    const existing = createSession("live");
    track(existing.id);
    expect(await ensurePersistedSession(existing.id)).toBe(existing);
    expect(mockSdkGetSessionInfo).not.toHaveBeenCalled();
  });

  test("returns undefined for an id that cannot be an SDK session", async () => {
    expect(await ensurePersistedSession("session-not-a-uuid")).toBeUndefined();
    expect(mockSdkGetSessionInfo).not.toHaveBeenCalled();
  });

  test("returns undefined when the SDK has no such session", async () => {
    mockSdkGetSessionInfo.mockImplementation(async () => undefined);
    expect(await ensurePersistedSession(`session-${PERSISTED_SDK_ID}`)).toBeUndefined();
  });

  test("materializes a session from SDK metadata", async () => {
    const state = await materializePersistedSession({ customTitle: "From disk" });
    expect(state).toMatchObject({
      id: `session-${PERSISTED_SDK_ID}`,
      title: "From disk",
      status: "idle",
      sdkSessionId: PERSISTED_SDK_ID,
      persistedMessagesLoaded: false,
    });
    expect(mockSdkGetSessionInfo).toHaveBeenCalledWith(PERSISTED_SDK_ID, {
      dir: process.env.CWD || process.cwd(),
    });
  });

  test("shares one materialization between concurrent callers", async () => {
    const bridgeId = track(`session-${PERSISTED_SDK_ID}`);
    let releaseInfo: ((info: SdkSessionInfo) => void) | undefined;
    mockSdkGetSessionInfo.mockImplementation(
      async () => new Promise<SdkSessionInfo>((resolve) => {
        releaseInfo = resolve;
      }),
    );

    // A mounting tab fires GET /:id, /messages and /tasks together; each one
    // lands here. Without a shared in-flight promise every one of them reads
    // the SDK and then writes its own fresh state over the others'.
    const first = ensurePersistedSession(bridgeId);
    const second = ensurePersistedSession(bridgeId);
    await waitFor(() => releaseInfo !== undefined);
    releaseInfo!(sdkSessionInfo());

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a).toBe(getSession(bridgeId)!);
    expect(mockSdkGetSessionInfo).toHaveBeenCalledTimes(1);
  });

  test("yields to a session that was claimed while the SDK read was pending", async () => {
    const bridgeId = track(`session-${PERSISTED_SDK_ID}`);
    let releaseInfo: ((info: SdkSessionInfo) => void) | undefined;
    mockSdkGetSessionInfo.mockImplementation(
      async () => new Promise<SdkSessionInfo>((resolve) => {
        releaseInfo = resolve;
      }),
    );

    const pending = ensurePersistedSession(bridgeId);
    await waitFor(() => releaseInfo !== undefined);

    // `GET /session/list` registers the same id from the listing while the
    // point read is still in flight, and a prompt then claims it.
    mockSdkListSessions.mockImplementation(async () => [sdkSessionInfo()]);
    await reconcilePersistedSessions();
    const claimed = getSession(bridgeId)!;
    const promptPromise = sendPrompt(bridgeId, "live prompt");
    const call = await nextQueryCall();
    expect(claimed.status).toBe("running");

    releaseInfo!(sdkSessionInfo({ customTitle: "Stale metadata" }));

    // Registering a fresh idle record here would discard the running status,
    // the in-flight user message and the turn's task registry.
    expect(await pending).toBe(claimed);
    expect(getSession(bridgeId)).toBe(claimed);
    expect(claimed.status).toBe("running");
    expect(claimed.messages.at(-1)?.content).toBe("live prompt");

    call.finish();
    await promptPromise;
  });
});

describe("hydratePersistedSessionMessages", () => {
  test("normalizes the transcript, dropping system and empty user records", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "system",
        uuid: "system-record",
        session_id: PERSISTED_SDK_ID,
        message: { role: "system", content: "ignored" },
        parent_tool_use_id: null,
      },
      ...transcriptWithToolResult(),
    ]);

    const messages = await hydratePersistedSessionMessages(state.id);

    // The tool_result record is a `type:"user"` entry with no text, and the
    // system record is skipped outright.
    expect(messages.map((message) => message.id)).toEqual([U1, A1, A2, U2]);
    expect(messages.map((message) => message.sdkUuid)).toEqual([U1, A1, A2, U2]);
    expect(messages[1]?.parts.some((part) => part.type === "tool-invocation")).toBe(true);
    // The tool result was still applied to the tool it belongs to.
    expect(messages[1]?.parts[0]?.toolState).toBe("success");
    expect(state.persistedMessagesLoaded).toBe(true);
  });

  test("keeps only real root-assistant model attribution", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "assistant",
        uuid: "root",
        session_id: PERSISTED_SDK_ID,
        message: {
          role: "assistant",
          model: " claude-opus-5 ",
          content: [{ type: "text", text: "Root" }],
        },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        uuid: "synthetic",
        session_id: PERSISTED_SDK_ID,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "Synthetic" }],
        },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        uuid: "subagent",
        session_id: PERSISTED_SDK_ID,
        message: {
          role: "assistant",
          model: "claude-subagent",
          content: [{ type: "text", text: "Subagent" }],
        },
        parent_tool_use_id: "tool-1",
      },
      {
        type: "assistant",
        uuid: "sidechain",
        session_id: PERSISTED_SDK_ID,
        message: {
          role: "assistant",
          model: "claude-sidechain",
          content: [{ type: "text", text: "Sidechain" }],
        },
        parent_tool_use_id: null,
        isSidechain: true,
      },
      {
        type: "assistant",
        uuid: "blank",
        session_id: PERSISTED_SDK_ID,
        message: {
          role: "assistant",
          model: "   ",
          content: [{ type: "text", text: "Blank" }],
        },
        parent_tool_use_id: null,
      },
    ]);

    const messages = await hydratePersistedSessionMessages(state.id);
    expect(messages.map((message) => message.modelId)).toEqual([
      "claude-opus-5",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("generates an id for a record with no uuid and marks it unresolvable", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "user",
        uuid: "",
        session_id: PERSISTED_SDK_ID,
        message: { role: "user", content: [{ type: "text", text: "orphan" }] },
        parent_tool_use_id: null,
      },
    ]);

    const [message] = await hydratePersistedSessionMessages(state.id);
    expect(message?.id).toMatch(/^msg-/);
    // A generated id is not a transcript uuid and must never be mistaken for one.
    expect(message?.sdkUuid).toBeUndefined();
  });

  test("reads the transcript once and serves the cached copy afterwards", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());

    await hydratePersistedSessionMessages(state.id);
    await hydratePersistedSessionMessages(state.id);
    expect(mockSdkGetSessionMessages).toHaveBeenCalledTimes(1);
  });

  test("returns an empty transcript for a session that does not exist", async () => {
    expect(await hydratePersistedSessionMessages(`session-${OTHER_SDK_ID}`)).toEqual([]);
  });

  test("refuses to hydrate underneath a running turn", async () => {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const state = await materializePersistedSession();

    const promptPromise = sendPrompt(state.id, "third prompt");
    const call = await nextQueryCall();

    // The turn hydrated once on entry, then took ownership of the transcript.
    expect(mockSdkGetSessionMessages).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("running");
    const liveUserMessage = getSessionMessages(state.id).at(-1);
    expect(liveUserMessage?.content).toBe("third prompt");

    // A tab mounting mid-turn hits GET /:id/messages, which lands here. Before
    // the guard this replaced `messages` and `taskRegistry` wholesale and the
    // in-flight user message vanished from the transcript.
    const midTurn = await hydratePersistedSessionMessages(state.id);
    expect(mockSdkGetSessionMessages).toHaveBeenCalledTimes(1);
    expect(midTurn.at(-1)).toBe(liveUserMessage!);

    call.finish();
    await promptPromise;
    expect(getSessionMessages(state.id).at(-1)?.content).toBe("third prompt");
  });

  test("shares an in-flight hydration with a prompt without overwriting the live turn", async () => {
    let resolveTranscript: ((messages: SdkSessionMessage[]) => void) | undefined;
    mockSdkGetSessionMessages.mockImplementation(
      async () => new Promise<SdkSessionMessage[]>((resolve) => {
        resolveTranscript = resolve;
      }),
    );
    const state = await materializePersistedSession();

    const mountHydration = hydratePersistedSessionMessages(state.id);
    await waitFor(() => resolveTranscript !== undefined);
    const promptPromise = sendPrompt(state.id, "live prompt");

    resolveTranscript!(transcriptWithToolResult());
    const call = await nextQueryCall();
    expect(mockSdkGetSessionMessages).toHaveBeenCalledTimes(1);
    await mountHydration;
    expect(getSessionMessages(state.id).some(
      (message) => message.content === "live prompt",
    )).toBe(true);

    call.finish();
    await promptPromise;
    expect(getSessionMessages(state.id).at(-1)?.content).toBe("live prompt");
  });

  test("survives an SDK that cannot read the transcript before a prompt, and retries after", async () => {
    mockSdkGetSessionMessages.mockImplementation(async () => {
      throw new Error("transcript unreadable");
    });
    const state = await materializePersistedSession();

    const promptPromise = sendPrompt(state.id, "still works");
    const call = await nextQueryCall();
    call.finish();
    await promptPromise;

    expect(getSessionMessages(state.id).map((message) => message.content)).toEqual([
      "still works",
    ]);

    // The turn claimed the transcript for a hydration that never happened.
    // Leaving the claim set hid the whole on-disk history behind a transient
    // read failure until the bridge was restarted.
    expect(getSession(state.id)?.persistedMessagesLoaded).toBe(false);

    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const recovered = await hydratePersistedSessionMessages(state.id);
    expect(recovered.length).toBeGreaterThan(0);
    expect(getSession(state.id)?.persistedMessagesLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transcript id resolution (fork boundaries and file rewind)
// ---------------------------------------------------------------------------

describe("persisted message id resolution", () => {
  async function hydratedSession() {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const state = await materializePersistedSession();
    await hydratePersistedSessionMessages(state.id);
    return state;
  }

  const resolvableCases: Array<{ name: string; targetIndex: number; expected: string }> = [
    { name: "the first user message", targetIndex: 0, expected: U1 },
    { name: "an assistant message before the dropped tool_result", targetIndex: 1, expected: A1 },
    { name: "an assistant message after the dropped tool_result", targetIndex: 2, expected: A2 },
    { name: "the last user message", targetIndex: 3, expected: U2 },
  ];

  for (const { name, targetIndex, expected } of resolvableCases) {
    test(`forks at the exact uuid of ${name}`, async () => {
      const state = await hydratedSession();
      const target = getSessionMessages(state.id)[targetIndex]!;

      const forked = await forkPersistedSession(state.id, { upToMessageId: target.id });
      track(forked.id);

      expect(mockSdkForkSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, {
        dir: process.env.CWD || process.cwd(),
        upToMessageId: expected,
        title: undefined,
      });
    });
  }

  test("refuses an id that is not in the transcript rather than picking a neighbour", async () => {
    const state = await hydratedSession();
    await expect(
      forkPersistedSession(state.id, { upToMessageId: "msg-does-not-exist" }),
    ).rejects.toThrow("not a persisted fork boundary");
    expect(mockSdkForkSession).not.toHaveBeenCalled();
  });

  test("refuses a uuid that is not present in the transcript", async () => {
    const state = await hydratedSession();
    await expect(
      forkPersistedSession(state.id, { upToMessageId: U3 }),
    ).rejects.toThrow("not a persisted fork boundary");
  });

  test("resolves a live message through the uuid the SDK reported for it", async () => {
    const state = await hydratedSession();

    const promptPromise = sendPrompt(state.id, "third prompt");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success", user_message_uuid: U3 });
    call.finish();
    await promptPromise;

    const live = getSessionMessages(state.id).at(-1)!;
    // Locally minted, so it exists nowhere on disk: the ONLY link back to the
    // transcript is the uuid recorded from the result message.
    expect(live.id).toMatch(/^msg-/);
    expect(live.sdkUuid).toBe(U3);

    mockSdkGetSessionMessages.mockImplementation(async () => [
      ...transcriptWithToolResult(),
      {
        type: "user",
        uuid: U3,
        session_id: PERSISTED_SDK_ID,
        message: { role: "user", content: [{ type: "text", text: "third prompt" }] },
        parent_tool_use_id: null,
      },
    ]);

    const forked = await forkPersistedSession(state.id, { upToMessageId: live.id });
    track(forked.id);

    // The ordinal fallback resolved this to U2 — the *previous* user message —
    // because normalization drops the tool_result record the transcript keeps.
    expect(mockSdkForkSession).toHaveBeenCalledWith(
      PERSISTED_SDK_ID,
      expect.objectContaining({ upToMessageId: U3 }),
    );
  });

  test("refuses a live message the SDK never reported a uuid for", async () => {
    const state = await hydratedSession();

    const promptPromise = sendPrompt(state.id, "unlogged prompt");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    const live = getSessionMessages(state.id).at(-1)!;
    expect(live.sdkUuid).toBeUndefined();
    await expect(
      forkPersistedSession(state.id, { upToMessageId: live.id }),
    ).rejects.toThrow("not a persisted fork boundary");
  });
});

describe("forkPersistedSession", () => {
  test("throws not_found when the session was never materialized", async () => {
    await expect(forkPersistedSession(`session-${OTHER_SDK_ID}`)).rejects.toMatchObject({
      code: "not_found",
      message: "Session has not been materialized",
    });
  });

  test("throws conflict while a turn is running", async () => {
    const state = await materializePersistedSession();
    const promptPromise = sendPrompt(state.id, "busy");
    const call = await nextQueryCall();

    await expect(forkPersistedSession(state.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Cannot fork a running session",
    });

    call.finish();
    await promptPromise;
  });

  test("throws invalid for a boundary that is not in the transcript", async () => {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const state = await materializePersistedSession();
    await expect(
      forkPersistedSession(state.id, { upToMessageId: U3 }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  test("registers the fork and derives a title when none is given", async () => {
    const state = await materializePersistedSession({ customTitle: "Original" });
    const forked = await forkPersistedSession(state.id);
    track(forked.id);

    expect(forked).toMatchObject({
      id: `session-${FORK_SDK_ID}`,
      title: "Original (fork)",
      status: "idle",
      sdkSessionId: FORK_SDK_ID,
      persistedMessagesLoaded: false,
    });
    expect(getSession(forked.id)).toBe(forked);
    expect(mockSdkForkSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, {
      dir: process.env.CWD || process.cwd(),
      upToMessageId: undefined,
      title: undefined,
    });
  });

  test("forwards an explicit fork title", async () => {
    const state = await materializePersistedSession();
    const forked = await forkPersistedSession(state.id, { title: "Experiment" });
    track(forked.id);
    expect(forked.title).toBe("Experiment");
    expect(mockSdkForkSession).toHaveBeenCalledWith(
      PERSISTED_SDK_ID,
      expect.objectContaining({ title: "Experiment" }),
    );
  });
});

describe("renameSessionDurably and deleteSessionDurably", () => {
  test("renames on disk, in memory, and announces the new title", async () => {
    const state = await materializePersistedSession();
    const { events, stop } = captureEvents();
    try {
      expect(await renameSessionDurably(state.id, "Renamed")).toBe(true);
    } finally {
      stop();
    }

    expect(mockSdkRenameSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, "Renamed", {
      dir: process.env.CWD || process.cwd(),
    });
    expect(state.title).toBe("Renamed");
    expect(events).toContainEqual({
      type: "session.title-updated",
      sessionId: state.id,
      data: { title: "Renamed" },
    });
  });

  test("reports a missing session rather than renaming nothing", async () => {
    expect(await renameSessionDurably(`session-${OTHER_SDK_ID}`, "Nope")).toBe(false);
    expect(mockSdkRenameSession).not.toHaveBeenCalled();
  });

  test("deletes the rollout and the registry entry together", async () => {
    const state = await materializePersistedSession();
    expect(await deleteSessionDurably(state.id)).toBe(true);
    expect(mockSdkDeleteSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, {
      dir: process.env.CWD || process.cwd(),
    });
    expect(getSession(state.id)).toBeUndefined();
  });

  test("stops the active writer before deleting its rollout and serializes deletion", async () => {
    const state = await materializePersistedSession();
    const close = mock(async () => {});
    const abort = new AbortController();
    state.abortController = abort;
    state.status = "running";
    state.queryControl = { close };
    let finishDelete: (() => void) | undefined;
    mockSdkDeleteSession.mockImplementation(
      async () => new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );

    const deletion = deleteSessionDurably(state.id);
    await expect(sendPrompt(state.id, "too late")).rejects.toMatchObject({
      code: "conflict",
      message: "Session is being deleted",
    });
    await waitFor(() => finishDelete !== undefined);
    expect(abort.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(state.deleting).toBe(true);
    await expect(deleteSessionDurably(state.id)).rejects.toMatchObject({
      code: "conflict",
    });

    finishDelete!();
    await expect(deletion).resolves.toBe(true);
    expect(getSession(state.id)).toBeUndefined();
  });

  test("restores the stopped session when durable deletion fails", async () => {
    const state = await materializePersistedSession();
    state.queryControl = {
      close: async () => {
        throw new Error("close failed");
      },
    };
    mockSdkDeleteSession.mockImplementation(async () => {
      throw new Error("disk busy");
    });

    await expect(deleteSessionDurably(state.id)).rejects.toThrow("disk busy");
    expect(getSession(state.id)).toBe(state);
    expect(state).toMatchObject({ deleting: false, status: "idle" });
    expect(state.queryControl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Destructive file rewind
// ---------------------------------------------------------------------------

describe("rewindSessionFiles", () => {
  async function rewindableSession() {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const state = await materializePersistedSession();
    await hydratePersistedSessionMessages(state.id);
    return state;
  }

  test("throws not_found when the session was never materialized", async () => {
    await expect(
      rewindSessionFiles(`session-${OTHER_SDK_ID}`, U1),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("throws conflict while a turn is running", async () => {
    const state = await rewindableSession();
    const promptPromise = sendPrompt(state.id, "busy");
    const call = await nextQueryCall();

    await expect(rewindSessionFiles(state.id, U1)).rejects.toMatchObject({
      code: "conflict",
      message: "Cannot rewind a running session",
    });

    call.finish();
    await promptPromise;
  });

  test("throws invalid for a message that is not a checkpoint", async () => {
    const state = await rewindableSession();
    await expect(rewindSessionFiles(state.id, "msg-unknown")).rejects.toMatchObject({
      code: "invalid",
      message: "The selected Claude message is not a persisted checkpoint",
    });
  });

  test("reuses a live control handle instead of spawning a second CLI", async () => {
    const state = await rewindableSession();
    const liveRewind = mock(async () => ({ canRewind: true, filesChanged: ["/a"] }));
    state.queryControl = { rewindFiles: liveRewind };

    await expect(rewindSessionFiles(state.id, U1)).resolves.toEqual({
      canRewind: true,
      filesChanged: ["/a"],
    });
    expect(liveRewind).toHaveBeenCalledWith(U1, { dryRun: false });
    // Spawning a second query against the same rollout would append to the very
    // transcript the checkpoints are indexed against.
    expect(mockQuery).not.toHaveBeenCalled();
    state.queryControl = undefined;
  });

  test("forwards dryRun to the control handle for a user checkpoint", async () => {
    const state = await rewindableSession();
    const liveRewind = mock(async () => ({ canRewind: true, insertions: 0, deletions: 0 }));
    state.queryControl = { rewindFiles: liveRewind };

    await rewindSessionFiles(state.id, U2, true);
    expect(liveRewind).toHaveBeenCalledWith(U2, { dryRun: true });
    state.queryControl = undefined;
  });

  test("rejects assistant records because the SDK only accepts user checkpoints", async () => {
    const state = await rewindableSession();
    const liveRewind = mock(async () => ({ canRewind: true }));
    state.queryControl = { rewindFiles: liveRewind };

    await expect(rewindSessionFiles(state.id, A2)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(liveRewind).not.toHaveBeenCalled();
    state.queryControl = undefined;
  });

  test("fails when the SDK reports that the checkpoint cannot be rewound", async () => {
    const state = await rewindableSession();
    state.queryControl = {
      rewindFiles: async () => ({ canRewind: false, error: "Checkpoint expired" }),
    };

    await expect(rewindSessionFiles(state.id, U1)).rejects.toMatchObject({
      code: "conflict",
      message: "Checkpoint expired",
    });
    state.queryControl = undefined;
  });

  test("opens a bounded, turnless query when no handle is live", async () => {
    const state = await rewindableSession();
    const rewindFiles = mock(async () => ({ canRewind: true }));
    const returnSpy = mock(async () => ({ done: true, value: undefined }));
    queryControlOverrides.rewindFiles = rewindFiles;
    queryControlOverrides.return = returnSpy;

    const rewindPromise = rewindSessionFiles(state.id, U1);
    const call = await nextQueryCall();
    call.push({ type: "system", subtype: "init" });

    await expect(rewindPromise).resolves.toEqual({ canRewind: true });
    expect(call.options).toMatchObject({
      resume: PERSISTED_SDK_ID,
      enableFileCheckpointing: true,
      // Purely a control handle: a real turn would write to the rollout.
      maxTurns: 0,
    });
    expect(call.options.abortController).toBeInstanceOf(AbortController);
    expect(rewindFiles).toHaveBeenCalledWith(U1, { dryRun: false });
    // The transient query is closed on every exit path.
    expect(returnSpy).toHaveBeenCalled();
  });

  test("closes the transient query when the SDK cannot rewind", async () => {
    const state = await rewindableSession();
    const returnSpy = mock(async () => ({ done: true, value: undefined }));
    queryControlOverrides.return = returnSpy;

    const rewindPromise = rewindSessionFiles(state.id, U1);
    const call = await nextQueryCall();
    call.push({ type: "system", subtype: "init" });

    await expect(rewindPromise).rejects.toMatchObject({
      code: "conflict",
      message: "Installed Claude Agent SDK does not support file rewind",
    });
    expect(returnSpy).toHaveBeenCalled();
  });

  test("fails closed when the CLI never produces a message", async () => {
    const state = await rewindableSession();
    const returnSpy = mock(async () => ({ done: true, value: undefined }));
    queryControlOverrides.return = returnSpy;

    const rewindPromise = rewindSessionFiles(state.id, U1);
    const call = await nextQueryCall();
    call.finish();

    await expect(rewindPromise).rejects.toMatchObject({ code: "conflict" });
    expect(returnSpy).toHaveBeenCalled();
    expect(getSession(state.id)?.rewindInProgress).toBe(false);
  });

  test("rejects a prompt accepted while files are being restored", async () => {
    const state = await rewindableSession();
    let releaseRewind: (() => void) | null = null;
    state.queryControl = {
      rewindFiles: async () =>
        new Promise((resolve) => {
          releaseRewind = () => resolve({ canRewind: true });
        }),
    };

    const rewindPromise = rewindSessionFiles(state.id, U1);
    await waitFor(() => releaseRewind !== null);

    // `status` never leaves "idle" during a rewind, so this is the only thing
    // stopping a turn from running against a working tree mid-restore.
    expect(getSession(state.id)?.rewindInProgress).toBe(true);
    await expect(sendPrompt(state.id, "meanwhile")).rejects.toMatchObject({
      code: "conflict",
      message: "Session is restoring files from a checkpoint",
    });
    await expect(rewindSessionFiles(state.id, U1)).rejects.toMatchObject({
      code: "conflict",
      message: "A file rewind is already in progress for this session",
    });

    releaseRewind!();
    await rewindPromise;
    expect(getSession(state.id)?.rewindInProgress).toBe(false);
    state.queryControl = undefined;
  });
});

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

/**
 * Drive a turn, assert while its stream is still live, then close it.
 *
 * `running` is an intra-turn fact. The turn's `for await` is the only consumer
 * of the SDK iterator, and by the time it is done with it the provider process
 * is gone — so the bridge settles whatever was still live rather than leaving a
 * snapshot that can never change again. These tests are about the reducer, so
 * they observe it before that happens, and then assert the settling too.
 */
async function inspectDuringTurn(
  messages: unknown[],
  ready: (session: NonNullable<ReturnType<typeof getSession>>) => boolean,
): Promise<{
  session: NonNullable<ReturnType<typeof getSession>>;
  finish: () => Promise<void>;
}> {
  const created = createSession("Fixed title");
  track(created.id);
  const promptPromise = sendPrompt(created.id, "test prompt");
  const call = await nextQueryCall();
  for (const message of messages) call.push(message);
  const session = getSession(created.id)!;
  await waitFor(() => ready(session));
  return {
    session,
    finish: async () => {
      call.finish();
      await promptPromise;
    },
  };
}

describe("background task reducer", () => {
  test("records a started task as running, then settles it when the stream ends", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Run the suite",
        },
      ],
      (s) => s.backgroundTasks?.["task-1"] !== undefined,
    );

    expect(session.backgroundTasks?.["task-1"]).toMatchObject({
      id: "task-1",
      description: "Run the suite",
      status: "running",
    });
    expect(session.backgroundTasks?.["task-1"]?.startedAt).toBeNumber();

    await finish();
    // Nothing is left that could ever report a result for this task, so leaving
    // it at "running" would wedge `GET /session/:id` for the bridge's lifetime.
    expect(session.backgroundTasks?.["task-1"]).toMatchObject({ status: "killed" });
    expect(session.backgroundTasks?.["task-1"]?.endedAt).toBeNumber();
  });

  test("merges task_progress and task_updated patches", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
        { type: "system", subtype: "task_progress", task_id: "task-1" },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "task-1",
          patch: { is_backgrounded: true, description: "Build (backgrounded)" },
        },
      ],
      (s) => s.backgroundTasks?.["task-1"]?.isBackgrounded === true,
    );

    expect(session.backgroundTasks?.["task-1"]).toMatchObject({
      description: "Build (backgrounded)",
      status: "running",
      isBackgrounded: true,
    });
    await finish();
  });

  const terminalCases: Array<{
    status: string;
    expected: BackgroundTaskSnapshot["status"];
  }> = [
    { status: "completed", expected: "completed" },
    { status: "failed", expected: "failed" },
    { status: "stopped", expected: "killed" },
  ];

  for (const { status, expected } of terminalCases) {
    test(`task_notification '${status}' settles the task as ${expected}`, async () => {
      const { events, stop } = captureEvents();
      let session;
      try {
        ({ session } = await runPromptWithMessages([
          { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
          {
            type: "system",
            subtype: "task_notification",
            task_id: "task-1",
            status,
            summary: "the summary",
            output_file: "/tmp/out",
          },
        ]));
      } finally {
        stop();
      }

      // Without this edge nothing ever cleared "running" and GET /session/:id
      // reported live background work forever.
      expect(session.backgroundTasks?.["task-1"]).toMatchObject({
        status: expected,
        description: "Build",
      });
      expect(session.backgroundTasks?.["task-1"]?.endedAt).toBeNumber();
      expect(
        events.filter(
          (event) =>
            event.type === "session.updated"
            && (event.data as { backgroundTasks?: unknown })?.backgroundTasks !== undefined,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
  }

  test("task_notification for an unseen task still lands terminal", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-orphan",
        status: "failed",
        summary: "exploded",
        output_file: "/tmp/out",
      },
    ]);

    expect(session.backgroundTasks?.["task-orphan"]).toMatchObject({
      status: "failed",
      description: "exploded",
      error: "exploded",
    });
  });

  test("background_tasks_changed replaces the whole set", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
        { type: "system", subtype: "task_started", task_id: "task-2", description: "Lint" },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "task-2", task_type: "bash", description: "Lint" },
            { task_id: "task-3", task_type: "agent", description: "Research" },
          ],
        },
      ],
      (s) => s.backgroundTasks?.["task-3"] !== undefined,
    );

    // REPLACE semantics, per the SDK's own contract: a missed bookend must not
    // be able to wedge a stale running indicator.
    expect(Object.keys(session.backgroundTasks ?? {}).sort()).toEqual(["task-2", "task-3"]);
    expect(session.backgroundTasks?.["task-2"]).toMatchObject({
      description: "Lint",
      status: "running",
    });
    expect(session.backgroundTasks?.["task-3"]).toMatchObject({
      description: "Research",
      status: "running",
      isBackgrounded: true,
    });
    await finish();
  });

  test("an empty background_tasks_changed clears every task", async () => {
    const { session } = await runPromptWithMessages([
      { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
      { type: "system", subtype: "background_tasks_changed", tasks: [] },
    ]);
    expect(session.backgroundTasks).toEqual({});
  });

  test("ignores task messages with no task id", async () => {
    const { session } = await runPromptWithMessages([
      { type: "system", subtype: "task_started", description: "no id" },
      { type: "system", subtype: "task_notification", status: "completed" },
    ]);
    expect(session.backgroundTasks).toBeUndefined();
  });
});

describe("stopBackgroundTask", () => {
  test("distinguishes an unknown session from an unknown task", async () => {
    expect(await stopBackgroundTask("session-missing", "task-1")).toEqual({
      ok: false,
      reason: "session_not_found",
      message: "Session not found",
    });

    const session = createSession("no tasks");
    track(session.id);
    expect(await stopBackgroundTask(session.id, "task-1")).toEqual({
      ok: false,
      reason: "task_not_found",
      message: "Task not found",
    });
  });

  test("stops a live task and settles the snapshot without waiting for a notification", async () => {
    const stopTask = mock(async (_taskId: string) => {});
    queryControlOverrides.stopTask = stopTask;

    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Long build",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "task-1",
          patch: { is_backgrounded: true },
        },
      ],
      (s) => s.backgroundTasks?.["task-1"]?.isBackgrounded === true,
    );

    expect(await stopBackgroundTask(session.id, "task-1")).toEqual({ ok: true });
    expect(stopTask).toHaveBeenCalledWith("task-1");
    // The SDK answers a stop with a `task_notification`, but a stop issued
    // after the turn has no reader for it, so the snapshot is patched here
    // rather than left to a message that may never be consumed.
    expect(session.backgroundTasks?.["task-1"]).toMatchObject({ status: "killed" });
    await finish();
  });

  test("reports no control channel once the turn that owned the task has ended", async () => {
    const stopTask = mock(async (_taskId: string) => {});
    queryControlOverrides.stopTask = stopTask;

    const { session } = await runPromptWithMessages([
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "Long build",
      },
      {
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { is_backgrounded: true },
      },
    ]);

    // The turn's iterator is the only consumer of the stream, so once it is
    // finished with the provider process behind the handle is gone. Reporting
    // `ok` here would claim a stop that never reached anything.
    expect(session.status).toBe("idle");
    expect(session.backgroundTasks?.["task-1"]).toMatchObject({ status: "killed" });
    expect(await stopBackgroundTask(session.id, "task-1")).toEqual({
      ok: false,
      reason: "no_control_channel",
      message: "No live Claude control channel can reach this task",
    });
    expect(stopTask).not.toHaveBeenCalled();
  });

  test("routes a stop through the control that owns the task, not the newest one", async () => {
    const firstStop = mock(async () => {});
    const secondStop = mock(async () => {});
    queryControlOverrides.stopTask = firstStop;
    const session = createSession("follow-up");
    track(session.id);

    const firstPrompt = sendPrompt(session.id, "start task");
    const firstCall = await nextQueryCall();
    firstCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-old",
      description: "Old build",
    });
    await waitFor(() => getSession(session.id)?.backgroundTasks?.["task-old"] !== undefined);
    firstCall.finish();
    await firstPrompt;

    queryControlOverrides.stopTask = secondStop;
    const secondPrompt = sendPrompt(session.id, "follow up");
    const secondCall = await nextQueryCall();
    secondCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-new",
      description: "New build",
    });
    await waitFor(() => getSession(session.id)?.backgroundTasks?.["task-new"] !== undefined);

    // The second turn's control must not be handed a task it never owned.
    expect(await stopBackgroundTask(session.id, "task-old")).toEqual({
      ok: false,
      reason: "no_control_channel",
      message: "No live Claude control channel can reach this task",
    });
    expect(firstStop).not.toHaveBeenCalled();
    expect(secondStop).not.toHaveBeenCalled();

    expect(await stopBackgroundTask(session.id, "task-new")).toEqual({ ok: true });
    expect(secondStop).toHaveBeenCalledWith("task-new");

    secondCall.finish();
    await secondPrompt;
  });

  test("does not 500 when the stop lands on a closed transport", async () => {
    queryControlOverrides.stopTask = mock(async () => {
      throw new Error("Query closed before response received");
    });

    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Long build",
        },
      ],
      (s) => s.backgroundTasks?.["task-1"] !== undefined,
    );

    // A handle whose transport has gone is a conflict the user can act on, not
    // a bridge fault: the route maps `no_control_channel` to 409.
    expect(await stopBackgroundTask(session.id, "task-1")).toEqual({
      ok: false,
      reason: "no_control_channel",
      message: "No live Claude control channel can reach this task",
    });
    expect(session.backgroundTasks?.["task-1"]).toMatchObject({ status: "killed" });
    await finish();
  });

  test("tolerates a rejected query-control close during deletion", async () => {
    const session = createSession("close rejection");
    track(session.id);
    const close = mock(async () => {
      throw new Error("already closed");
    });
    session.queryControl = { close };

    expect(deleteSession(session.id)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)).toBeUndefined();
  });

  test("releases the control handle once every task has settled", async () => {
    queryControlOverrides.stopTask = mock(async () => {});

    const { session } = await runPromptWithMessages([
      { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        summary: "done",
        output_file: "/tmp/out",
      },
    ]);

    expect(session.queryControl).toBeUndefined();
    expect(await stopBackgroundTask(session.id, "task-1")).toEqual({
      ok: false,
      reason: "no_control_channel",
      message: "No live Claude control channel can reach this task",
    });
  });

  test("aborting a session drops the retained control handle", async () => {
    queryControlOverrides.stopTask = mock(async () => {});
    const session = createSession("abortable");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "start work");
    const call = await nextQueryCall();
    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Build",
    });
    await waitFor(() => getSession(session.id)?.backgroundTasks?.["task-1"] !== undefined);

    expect(abortSession(session.id)).toBe(true);
    expect(getSession(session.id)?.queryControl).toBeUndefined();

    call.finish();
    await promptPromise;
  });
});

// ---------------------------------------------------------------------------
// Rate limits and usage
// ---------------------------------------------------------------------------

describe("rate_limit_event", () => {
  test("retains a window that arrives before any turn has completed", async () => {
    const { events, stop } = captureEvents();
    let session;
    try {
      // No `result` message: `usage` never exists, which is exactly when the
      // old handler discarded every window it was told about.
      ({ session } = await runPromptWithMessages([
        {
          type: "rate_limit_event",
          rate_limit_info: {
            rateLimitType: "five_hour",
            utilization: 42,
            // Epoch SECONDS, as the CLI reports them.
            resetsAt: Date.parse("2026-07-26T18:00:00.000Z") / 1000,
          },
        },
      ]));
    } finally {
      stop();
    }

    expect(session.usage).toBeUndefined();
    expect(session.rateLimits).toEqual([
      {
        label: "Five Hour",
        usedPercent: 42,
        resetsAt: "2026-07-26T18:00:00.000Z",
      },
    ]);
    // Reading seconds as milliseconds put every window in 1970, which the UI
    // renders as a limit that reset decades ago.
    expect(
      new Date(session.rateLimits![0]!.resetsAt!).getUTCFullYear(),
    ).toBeGreaterThan(2020);
    expect(events).toContainEqual({
      type: "session.updated",
      sessionId: session.id,
      data: { rateLimits: session.rateLimits },
    });
  });

  test("accepts a reset instant already expressed in milliseconds", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "seven_day",
          utilization: 12,
          resetsAt: Date.parse("2026-07-26T18:00:00.000Z"),
        },
      },
    ]);

    // Above the 1e12 threshold no real reset instant is ambiguous, so a future
    // SDK that switches units does not silently produce year-33658 timestamps.
    expect(session.rateLimits).toEqual([
      { label: "Seven Day", usedPercent: 12, resetsAt: "2026-07-26T18:00:00.000Z" },
    ]);
  });

  test("drops a reset instant no Date can represent", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", resetsAt: Number.MAX_SAFE_INTEGER },
      },
    ]);
    expect(session.rateLimits).toEqual([
      { label: "Five Hour", usedPercent: undefined, resetsAt: undefined },
    ]);
  });

  test("deduplicates by label and keeps distinct windows", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 10 },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "seven_day", utilization: 20 },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 55 },
      },
    ]);

    expect(session.rateLimits).toEqual([
      { label: "Seven Day", usedPercent: 20, resetsAt: undefined },
      { label: "Five Hour", usedPercent: 55, resetsAt: undefined },
    ]);
  });

  test("defaults the label and omits an absent reset time", async () => {
    const { session } = await runPromptWithMessages([
      { type: "rate_limit_event", rate_limit_info: { utilization: 5 } },
    ]);
    expect(session.rateLimits).toEqual([
      { label: "Usage", usedPercent: 5, resetsAt: undefined },
    ]);
  });

  test("ignores an event with no rate limit payload", async () => {
    const { session } = await runPromptWithMessages([{ type: "rate_limit_event" }]);
    expect(session.rateLimits).toBeUndefined();
  });

  test("carries retained windows into the usage snapshot the turn produces", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 10, output_tokens: 5, context_window_tokens: 1000 },
      },
    ]);

    expect(session.usage?.rateLimits).toEqual([
      { label: "Five Hour", usedPercent: 42, resetsAt: undefined },
    ]);
  });

  test("merges a window into an existing snapshot without dropping it", async () => {
    const session = createSession("late limit");
    track(session.id);

    const first = sendPrompt(session.id, "one");
    const firstCall = await nextQueryCall();
    firstCall.push({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5, context_window_tokens: 1000 },
    });
    firstCall.finish();
    await first;
    expect(getSession(session.id)?.usage?.rateLimits).toBeUndefined();

    const second = sendPrompt(session.id, "two");
    const secondCall = await nextQueryCall();
    secondCall.push({
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 88 },
    });
    await waitFor(() => (getSession(session.id)?.rateLimits?.length ?? 0) > 0);
    expect(getSession(session.id)?.usage?.rateLimits).toEqual([
      { label: "Five Hour", usedPercent: 88, resetsAt: undefined },
    ]);
    secondCall.finish();
    await second;
  });
});

describe("claude usage snapshot", () => {
  test("counts cache reads on a resumed turn", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 5,
            outputTokens: 200,
            cacheReadInputTokens: 120000,
            contextWindow: 200000,
          },
        },
      },
    ]);

    // The heuristic walk reaches modelUsage, where it can only see
    // input + output. Reporting 120k of cached context as ~205 tokens
    // understated the context gauge by three orders of magnitude.
    expect(session.usage).toMatchObject({
      usedTokens: 120205,
      totalTokens: 200000,
      cacheReadTokens: 120000,
      inputTokens: 5,
      outputTokens: 200,
      lastTurnTokens: 120205,
      modelId: "claude-opus-5",
    });
    expect(session.usage?.percentUsed).toBeCloseTo(60.1025, 4);
  });

  test("counts cache writes too", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 400,
            contextWindow: 10000,
            costUSD: 0.25,
          },
        },
      },
    ]);

    expect(session.usage).toMatchObject({
      usedTokens: 530,
      cacheWriteTokens: 400,
      lastTurnTokens: 530,
      costUsd: 0.25,
    });
  });

  test("accumulates counters across turns while context stays a level", async () => {
    const session = createSession("accumulating");
    track(session.id);
    const turn = {
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 70,
          contextWindow: 1000,
        },
      },
      total_cost_usd: 0.5,
      duration_ms: 100,
      duration_api_ms: 80,
      permission_denials: [{ tool_name: "Bash" }],
    };

    for (let index = 0; index < 2; index += 1) {
      const promptPromise = sendPrompt(session.id, `turn ${index}`);
      const call = await nextQueryCall();
      call.push(turn);
      call.finish();
      await promptPromise;
    }

    expect(getSession(session.id)?.usage).toMatchObject({
      // A level, not a running total: this is the size of the context now.
      usedTokens: 100,
      totalTokens: 1000,
      inputTokens: 20,
      outputTokens: 40,
      cacheReadTokens: 140,
      lastTurnTokens: 100,
      sessionTokens: 200,
      costUsd: 1,
      durationMs: 200,
      apiDurationMs: 160,
      permissionDenials: 2,
    });
  });

  test("publishes nothing when a turn reports no tokens", async () => {
    const { session } = await runPromptWithMessages([
      { type: "result", subtype: "success" },
    ]);
    expect(session.usage).toBeUndefined();
  });

  test("publishes nothing when no context window can be determined", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: { "claude-opus-5": { inputTokens: 10, outputTokens: 5 } },
      },
    ]);
    expect(session.usage).toBeUndefined();
  });

  test("prefers an exact context report over the token arithmetic", async () => {
    queryControlOverrides.getContextUsage = mock(async () => ({
      totalTokens: 51_200,
      maxTokens: 200_000,
      percentage: 25.6,
      model: "claude-opus-5",
      categories: [
        { name: "System prompt", tokens: 1200, color: "#fff" },
        { name: "bad entry" },
      ],
    }));

    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-opus-5": { inputTokens: 5, outputTokens: 5, contextWindow: 1 },
        },
      },
    ]);

    expect(session.usage).toMatchObject({
      usedTokens: 51_200,
      totalTokens: 200_000,
      percentUsed: 25.6,
      estimated: false,
      contextCategories: [{ name: "System prompt", tokens: 1200, color: "#fff" }],
    });
  });

  test("falls back to arithmetic when the context request fails", async () => {
    queryControlOverrides.getContextUsage = mock(async () => {
      throw new Error("control channel closed");
    });

    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 5,
            outputTokens: 200,
            cacheReadInputTokens: 120000,
            contextWindow: 200000,
          },
        },
      },
    ]);

    expect(session.usage).toMatchObject({ usedTokens: 120205, estimated: true });
  });
});

describe("prompt suggestions", () => {
  test("records a suggestion the turn produced", async () => {
    const { session } = await runPromptWithMessages([
      { type: "prompt_suggestion", suggestion: "  Run the tests  " },
    ]);
    expect(session.promptSuggestion).toBe("Run the tests");
  });

  test("ignores a blank suggestion", async () => {
    const { session } = await runPromptWithMessages([
      { type: "prompt_suggestion", suggestion: "   " },
    ]);
    expect(session.promptSuggestion).toBeUndefined();
  });

  test("clears the previous suggestion when the next turn starts", async () => {
    const session = createSession("suggesting");
    track(session.id);

    const first = sendPrompt(session.id, "one");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "prompt_suggestion", suggestion: "Run the tests" });
    firstCall.finish();
    await first;
    expect(getSession(session.id)?.promptSuggestion).toBe("Run the tests");

    const { events, stop } = captureEvents();
    try {
      const second = sendPrompt(session.id, "two");
      const secondCall = await nextQueryCall();

      // Nothing else clears it, and GET /session/:id replays the snapshot on
      // every mount, restore and reconnect — so a consumed suggestion would be
      // resurrected turns later.
      expect(getSession(session.id)?.promptSuggestion).toBeUndefined();
      const cleared = events.find(
        (event) =>
          event.type === "session.updated"
          && event.sessionId === session.id
          && (event.data as object | undefined) !== undefined
          && "promptSuggestion" in (event.data as object),
      );
      // The client tests for presence of the key, not truthiness, so an
      // explicit `undefined` is the clear signal.
      expect(cleared).toBeDefined();
      expect((cleared?.data as { promptSuggestion?: string }).promptSuggestion).toBeUndefined();

      secondCall.finish();
      await second;
    } finally {
      stop();
    }

    expect(getSession(session.id)?.promptSuggestion).toBeUndefined();
  });
});
