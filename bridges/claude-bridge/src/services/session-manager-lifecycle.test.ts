import { afterAll, afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";


import { EventEmitter } from "node:events";


import * as realChildProcess from "node:child_process";


import * as realFs from "node:fs";


import * as realFsPromises from "node:fs/promises";


import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";


import { homedir, tmpdir } from "node:os";


import { join } from "node:path";


import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";



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


const fsPromisesSnapshot = { ...realFsPromises };


const originalExistsSync = realFs.existsSync;


const originalReadFile = realFsPromises.readFile;


const originalExecFile = realChildProcess.execFile;


const originalSpawn = realChildProcess.spawn;



const mockExistsSync = mock((path: realFs.PathLike) => originalExistsSync(path));


const mockReadFile = mock(originalReadFile);


const mockExecFile = mock(originalExecFile);


const mockSpawn = mock(originalSpawn);



mock.module("node:fs", () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));



mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readFile: mockReadFile,
}));



mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFile: mockExecFile,
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
  isClosed: () => boolean;
}



function pushSuccessfulContinuationResult(call: QueryCall): void {
  call.push({ type: "result", subtype: "success" });
}



const pendingCalls: QueryCall[] = [];


const queryWaiters: Array<(call: QueryCall) => void> = [];



/**
 * Extra members spliced onto the object `query()` returns.
 *
 * The bridge feature-detects `stopTask`, `rewindFiles`, `getContextUsage` and
 * the experimental structured-usage request with `typeof x === "function"` and
 * skips them silently when absent, so they are opt-in per test: installing
 * them unconditionally would change what every other test's turn does.
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
  let closed = false;
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
      // Match the SDK contract: close() terminates the process, so no later
      // assistant/result frame can be observed by the consumer.
      if (closed) return;
      queue.push(msg);
      wake();
    },
    finish: () => {
      finished = true;
      wake();
    },
    isClosed: () => closed,
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
    close: () => {
      closed = true;
      finished = true;
      wake();
    },
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



function installSdkModuleMock(overrides: Record<string, unknown> = {}): void {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: mockQuery,
    listSessions: mockSdkListSessions,
    getSessionInfo: mockSdkGetSessionInfo,
    getSessionMessages: mockSdkGetSessionMessages,
    deleteSession: mockSdkDeleteSession,
    renameSession: mockSdkRenameSession,
    forkSession: mockSdkForkSession,
    ...overrides,
  }));
}



installSdkModuleMock();



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


const {
  claudeSessionPreferencesDir,
  setClaudeHomeForTesting,
} = await import("./claude-home.js");


const {
  readSessionPreferences,
  updateSessionPreferences,
} = await import("./session-preferences.js");


const sessionManagerTestHome = await mkdtemp(
  join(tmpdir(), "claude-session-manager-home-"),
);


setClaudeHomeForTesting(sessionManagerTestHome);


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
  createOrRecoverSession,
  sessionIdForClientKey,
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
  getSessionActivity,
  resetSessionActivityProbeCacheForTesting,
  getSessionInitData,
  getAvailableModelCatalog,
  getAvailableModels,
  getClaudeRuntimeVersions,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_STREAM_CONTENT_BLOCK_INDEX,
  reconcilePersistedSessions,
  ensurePersistedSession,
  hydratePersistedSessionMessages,
  evictIdleHydratedTranscripts,
  getLastIdleTranscriptSweep,
  startIdleTranscriptSweep,
  IDLE_TRANSCRIPT_EVICTION_MS,
  MAX_TERMINAL_BACKGROUND_TASKS,
  STRUCTURED_USAGE_REQUEST_TIMEOUT_MS,
  deleteSessionDurably,
  renameSessionDurably,
  forkPersistedSession,
  rewindSessionFiles,
  stopBackgroundTask,
  claimPromptDispatch,
  setSessionPreferences,
  clearPromptSuggestion,
  getPromptDispatchState,
  getPromptDispatchRecordCountForTesting,
  seedSettledPromptDispatchForTesting,
  sanitizeSessionTitle,
  buildSessionTitlePrompt,
  runClaudeTitleCommand,
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



/**
 * The SDK id a client key's stable bridge alias decodes back to.
 *
 * The bridge recovers this from the alias itself instead of persisting a global
 * lookup table, so the tests have to derive it the same way.
 */
function sdkIdForClientKey(clientSessionKey: string): string {
  const alias = sessionIdForClientKey(clientSessionKey);
  if (!alias) throw new Error("client session key did not produce a bridge id");
  return alias
    .slice("session-client-".length)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}



/**
 * Run `body` against a private Claude home, restoring the suite-wide one after.
 *
 * Durable preference files are keyed by SDK session id, so tests that write them
 * must not share a home: a leftover alias or journal entry would decide what a
 * later test's reconcile adopts.
 */
async function withTemporaryClaudeHome<T>(
  prefix: string,
  body: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  setClaudeHomeForTesting(directory);
  try {
    return await body(directory);
  } finally {
    setClaudeHomeForTesting(sessionManagerTestHome);
    await rm(directory, { recursive: true, force: true });
  }
}



const createdSessionIds: string[] = [];


function track(id: string): string {
  createdSessionIds.push(id);
  return id;
}



afterEach(() => {
  setClaudeHomeForTesting(sessionManagerTestHome);
  // Clean up any sessions/abortable work the test created.
  for (const id of createdSessionIds.splice(0)) {
    deleteSession(id);
  }
  pendingCalls.length = 0;
  queryWaiters.length = 0;
  mockQuery.mockClear();
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation((path) => originalExistsSync(path));
  mockReadFile.mockReset();
  mockReadFile.mockImplementation(originalReadFile);
  mockExecFile.mockReset();
  mockExecFile.mockImplementation(originalExecFile);
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(originalSpawn);
  mockGetMcpServersForSdk.mockReset();
  mockGetMcpServersForSdk.mockImplementation(async () => ({}));
  mockGetMcpServerNames.mockReset();
  mockGetMcpServerNames.mockImplementation(async () => new Set<string>());
  mockGetPluginsForSdk.mockReset();
  mockGetPluginsForSdk.mockImplementation(async () => []);
  resetSdkSessionStoreMocks();
  // The probe memo is keyed by SDK session id and outlives a test, so without
  // this one test's "this rollout exists" answer could serve another's.
  resetSessionActivityProbeCacheForTesting();
  installSdkModuleMock();
  queryControlOverrides = {};
});



afterAll(async () => {
  // Restore the real mcp-config / plugin-config modules so other test files
  // in the same `bun test` run get the real implementations.
  mock.module("./mcp-config.js", () => mcpConfigSnapshot);
  mock.module("./plugin-config.js", () => pluginConfigSnapshot);
  mock.module("node:child_process", () => childProcessSnapshot);
  mock.module("node:fs", () => fsSnapshot);
  mock.module("node:fs/promises", () => fsPromisesSnapshot);
  setClaudeHomeForTesting(null);
  await rm(sessionManagerTestHome, { recursive: true, force: true });
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



// ---------------------------------------------------------------------------
// Pure session-state CRUD
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  test("reports no idle transcript sweep before the first sweep runs", () => {
    expect(getLastIdleTranscriptSweep()).toBeUndefined();
  });

  test("reports no init data for missing or uninitialized sessions", () => {
    const session = createSession("not initialized");
    track(session.id);

    expect(getSessionInitData(session.id)).toBeUndefined();
    expect(getSessionInitData("session-missing")).toBeUndefined();
  });

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

  test("createSession reuses one session for the same client key", () => {
    const first = createSession("First title", "env-env-1:startup-agent");
    const second = createSession("Second title", "env-env-1:startup-agent");
    track(first.id);

    expect(first.id).toMatch(/^session-client-/);
    expect(second).toBe(first);
    expect(second.title).toBe("First title");
    expect(
      listSessions().filter((session) => session.id === first.id),
    ).toHaveLength(1);
  });

  test("recovers a client-key session onto the same SDK rollout after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-client-session-restart-"));
    setClaudeHomeForTesting(directory);
    const clientSessionKey = "env-env-1:startup-agent";
    const first = createSession("Startup agent", clientSessionKey);
    track(first.id);
    try {
      const sdkSessionId = sessionIdForClientKey(clientSessionKey)
        ?.slice("session-client-".length)
        .replace(
          /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
          "$1-$2-$3-$4-$5",
        );
      expect(sdkSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      if (!sdkSessionId) throw new Error("client session key did not produce an SDK id");

      const firstPrompt = sendPrompt(first.id, "Inspect the workspace");
      const firstCall = await nextQueryCall();
      expect(firstCall.options.sessionId).toBe(sdkSessionId);
      expect(firstCall.options.resume).toBeUndefined();
      firstCall.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      firstCall.push({ type: "result", subtype: "success" });
      firstCall.finish();
      await firstPrompt;

      expect(await readSessionPreferences(sdkSessionId)).toMatchObject({
        clientSessionBridgeId: first.id,
      });

      // Simulate the in-memory registry disappearing while the SDK rollout and
      // bridge-owned preference file survive.
      expect(deleteSession(first.id)).toBe(true);
      mockSdkGetSessionInfo.mockImplementation(async (id) =>
        id === sdkSessionId
          ? sdkSessionInfo({
              sessionId: sdkSessionId,
              customTitle: "Recovered startup agent",
            })
          : undefined);

      const recovered = await createOrRecoverSession(
        "Ignored retry title",
        clientSessionKey,
      );
      expect(recovered).toMatchObject({
        id: first.id,
        sdkSessionId,
        title: "Recovered startup agent",
      });

      const followUp = sendPrompt(recovered.id, "Continue the work");
      const followUpCall = await nextQueryCall();
      expect(followUpCall.options.resume).toBe(sdkSessionId);
      expect(followUpCall.options.sessionId).toBeUndefined();
      followUpCall.push({ type: "result", subtype: "success" });
      followUpCall.finish();
      await followUp;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sessionIdForClientKey refuses keys that cannot carry a stable identity", () => {
    // A refused key falls back to a random session id: the caller loses
    // recovery rather than deriving an id from something unusable.
    expect(sessionIdForClientKey(undefined)).toBeUndefined();
    expect(sessionIdForClientKey(42 as unknown as string)).toBeUndefined();
    expect(sessionIdForClientKey("")).toBeUndefined();
    expect(sessionIdForClientKey("  \t\n  ")).toBeUndefined();
    expect(sessionIdForClientKey("x".repeat(513))).toBeUndefined();

    // The boundary length is accepted, and its payload must still be a valid v4
    // UUID or the SDK id could not be recovered from the bridge id.
    expect(sessionIdForClientKey("x".repeat(512))).toMatch(
      /^session-client-[0-9a-f]{32}$/,
    );
    expect(sdkIdForClientKey("x".repeat(512))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("createOrRecoverSession creates an unkeyed session without consulting the SDK", async () => {
    const session = await createOrRecoverSession("Untracked");
    track(session.id);

    expect(session.id).toMatch(
      /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.title).toBe("Untracked");
    // With no client key there is no durable identity to point-read.
    expect(mockSdkGetSessionInfo).not.toHaveBeenCalled();
  });

  test("createOrRecoverSession creates the stable id on a first launch", async () => {
    await withTemporaryClaudeHome("claude-first-launch-", async () => {
      const clientSessionKey = "env-env-1:startup-agent";
      // Nothing on disk yet — the ordinary first launch of a startup agent.
      mockSdkGetSessionInfo.mockImplementation(async () => undefined);

      const session = await createOrRecoverSession(
        "Startup agent",
        clientSessionKey,
      );
      track(session.id);

      expect(session.id).toBe(sessionIdForClientKey(clientSessionKey));
      expect(session.title).toBe("Startup agent");
      expect(session.status).toBe("idle");
      // No rollout, so no durable identity yet and nothing to persist under it.
      expect(session.sdkSessionId).toBeUndefined();
      expect(
        await readSessionPreferences(sdkIdForClientKey(clientSessionKey)),
      ).toBeUndefined();

      // A retried launch must join the same conversation, not mint a second.
      expect(
        await createOrRecoverSession("Ignored retry title", clientSessionKey),
      ).toBe(session);
      expect(
        listSessions().filter((entry) => entry.id === session.id),
      ).toHaveLength(1);
    });
  });

  test("createOrRecoverSession converges concurrent callers on one session state", async () => {
    await withTemporaryClaudeHome("claude-concurrent-recover-", async () => {
      const clientSessionKey = "env-env-1:startup-agent";
      const alias = track(sessionIdForClientKey(clientSessionKey)!);
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      let releaseInfo: ((info: SdkSessionInfo) => void) | undefined;
      mockSdkGetSessionInfo.mockImplementation(
        async () => new Promise<SdkSessionInfo>((resolve) => {
          releaseInfo = resolve;
        }),
      );

      // Two tabs mounting at once, or a launch retried before the first read
      // returned. A second SessionState here is the duplicate session tab.
      const first = createOrRecoverSession("First", clientSessionKey);
      const second = createOrRecoverSession("Second", clientSessionKey);
      await waitFor(() => releaseInfo !== undefined);
      releaseInfo!(sdkSessionInfo({
        sessionId: sdkSessionId,
        customTitle: "From disk",
      }));

      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(a.id).toBe(alias);
      expect(getSession(alias)).toBe(a);
      expect(mockSdkGetSessionInfo).toHaveBeenCalledTimes(1);
      expect(
        listSessions().filter((entry) => entry.sdkSessionId === sdkSessionId),
      ).toHaveLength(1);
    });
  });

  test("persists no metadata for a session with neither plan mode nor a client key", async () => {
    await withTemporaryClaudeHome("claude-metadata-noop-", async () => {
      const session = createSession("no durable metadata");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);

      const promptPromise = sendPrompt(session.id, "go");
      const call = await nextQueryCall();
      call.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      expect(session.sdkSessionId).toBe(sdkSessionId);
      // The first init is where a durable key appears, but this session has
      // nothing to store under it. Writing `{}` would leave a file that later
      // reads cannot tell apart from a real stored preference.
      expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();
    });
  });

  test("fails a client-key turn whose alias cannot be journaled, with no plan mode set", async () => {
    await withTemporaryClaudeHome("claude-alias-refused-", async (directory) => {
      const clientSessionKey = "env-env-1:startup-agent";
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      const session = createSession("Startup agent", clientSessionKey);
      track(session.id);
      const preferencesDirectory = join(
        directory,
        ".claude",
        "orkestrator",
        "session-preferences",
      );
      await mkdir(preferencesDirectory, { recursive: true });
      await writeFile(
        join(preferencesDirectory, `${sdkSessionId}.json`),
        "{",
        "utf-8",
      );

      const promptPromise = sendPrompt(session.id, "Inspect the workspace");
      const call = await nextQueryCall();
      call.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      call.finish();

      // Intent: the alias is written for every client-key session, not only for
      // one that has already toggled plan mode, so this refusal is reachable
      // with `planMode` still undefined. Failing the turn is deliberate —
      // continuing would drop the alias and the next reconcile would adopt this
      // rollout a second time under `session-<uuid>`.
      await expect(promptPromise).rejects.toThrow(
        "refusing to overwrite the durable prompt journal",
      );
      expect(session.status).toBe("error");
      expect(session.planMode).toBeUndefined();
    });
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

  test("setSessionPreferences rejects an unknown session", async () => {
    await expect(
      setSessionPreferences("session-does-not-exist", { planMode: true }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Session not found",
    });
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

  test("clears prompt suggestions authoritatively and emits the removal", () => {
    const session = createSession("suggestion");
    track(session.id);
    session.promptSuggestion = "Try the next step";
    const { events, stop } = captureEvents();
    try {
      expect(clearPromptSuggestion(session.id)).toBe(true);
      expect(session.promptSuggestion).toBeUndefined();
      const removalEvent = {
        type: "session.updated",
        sessionId: session.id,
        data: { promptSuggestion: null },
      } as const;
      expect(events).toContainEqual(removalEvent);
      expect(clearPromptSuggestion(session.id)).toBe(true);
      expect(events.filter((event) =>
        event.type === removalEvent.type
        && event.sessionId === removalEvent.sessionId
        && (event.data as { promptSuggestion?: string | null }).promptSuggestion === null
      )).toHaveLength(1);
      expect(clearPromptSuggestion("session-missing")).toBe(false);
    } finally {
      stop();
    }
  });

  test("durably deduplicates stable prompt request ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-journal-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let promptTask: Promise<void> | undefined;

      expect(
        await claimPromptDispatch(
          session.id,
          "initial-prompt:env-1:tab-1",
          () => {
            promptTask = sendPrompt(session.id, "Launch once", {
              requestId: "initial-prompt:env-1:tab-1",
            });
            return promptTask;
          },
        ),
      ).toBe("claimed");
      expect(
        await claimPromptDispatch(
          session.id,
          "initial-prompt:env-1:tab-1",
          async () => {
            throw new Error("duplicate dispatch must not start");
          },
        ),
      ).toBe("duplicate");
      expect(
        await readSessionPreferences(sdkSessionId),
      ).toMatchObject({
        dispatchedRequestIds: ["initial-prompt:env-1:tab-1"],
      });

      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptTask;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("claimPromptDispatch reports an unknown session without starting work", async () => {
    const dispatch = mock(async () => {});

    await expect(
      claimPromptDispatch("session-does-not-exist", "request-missing", dispatch),
    ).resolves.toBe("not-found");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "deleting",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.deleting = true;
      },
      message: "Session is being deleted",
    },
    {
      name: "running",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.status = "running";
        session.structuredOutputRequestId = "different-request";
      },
      message: "Session is already processing a prompt",
    },
    {
      name: "rewinding files",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.rewindInProgress = true;
      },
      message: "Session is restoring files from a checkpoint",
    },
  ])("claimPromptDispatch rejects a $name session before persisting", async ({
    prepare,
    message,
  }) => {
    await withTemporaryClaudeHome("claude-dispatch-guard-", async () => {
      const session = createSession("guarded dispatch");
      track(session.id);
      prepare(session);
      const dispatch = mock(async () => {});

      await expect(
        claimPromptDispatch(session.id, "request-guarded", dispatch),
      ).rejects.toMatchObject({ code: "conflict", message });
      expect(dispatch).not.toHaveBeenCalled();
      expect(session.dispatchedRequestIds?.has("request-guarded")).not.toBe(true);
      expect(
        await readSessionPreferences(session.id.slice("session-".length)),
      ).toBeUndefined();
    });
  });

  test("reserves a stable-id turn before its durable claim yields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-race-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      let promptTask: Promise<void> | undefined;

      const claim = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-race",
        () => {
          promptTask = sendPrompt(session.id, "Launch once", {
            requestId: "initial-prompt:env-1:tab-race",
          });
          return promptTask;
        },
      );

      expect(getSession(session.id)?.status).toBe("running");
      await expect(
        sendPrompt(session.id, "Competing prompt"),
      ).rejects.toThrow("already processing");
      await expect(claim).resolves.toBe("claimed");

      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptTask;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("same-id concurrent claims join the deferred durable outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-join-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const firstDispatch = mock(async () => {});
      const duplicateDispatch = mock(async () => {});

      const first = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join",
        firstDispatch,
        { beforePersistence: () => persistenceGate },
      );
      expect(session.status).toBe("running");
      expect(typeof session.turnStartedAt).toBe("string");
      const duplicate = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join",
        duplicateDispatch,
      );
      let duplicateSettled = false;
      void duplicate.then(
        () => {
          duplicateSettled = true;
        },
        () => {
          duplicateSettled = true;
        },
      );

      await Promise.resolve();
      expect(duplicateSettled).toBe(false);
      expect(firstDispatch).not.toHaveBeenCalled();
      expect(duplicateDispatch).not.toHaveBeenCalled();

      releasePersistence!();
      await expect(first).resolves.toBe("claimed");
      await expect(duplicate).resolves.toBe("duplicate");
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(duplicateDispatch).not.toHaveBeenCalled();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("same-id concurrent claims share a deferred persistence failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-join-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const firstDispatch = mock(async () => {});
      const duplicateDispatch = mock(async () => {});

      const first = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join-failure",
        firstDispatch,
        { beforePersistence: () => persistenceGate },
      );
      const duplicate = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join-failure",
        duplicateDispatch,
      );

      releasePersistence!();
      const [firstResult, duplicateResult] = await Promise.allSettled([
        first,
        duplicate,
      ]);
      expect(firstResult.status).toBe("rejected");
      expect(duplicateResult.status).toBe("rejected");
      expect(firstDispatch).not.toHaveBeenCalled();
      expect(duplicateDispatch).not.toHaveBeenCalled();
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.status).toBe("idle");
      expect(session.dispatchedRequestIds?.has(
        "initial-prompt:env-1:tab-join-failure",
      )).toBe(false);
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("durable deletion waits for an invalidated claim to roll back on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-delete-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const dispatch = mock(async () => {});

      const claim = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-delete",
        dispatch,
        { beforePersistence: () => persistenceGate },
      );
      const deletion = deleteSessionDurably(session.id);
      expect(session.deleting).toBe(true);

      releasePersistence!();
      await expect(claim).rejects.toMatchObject({ code: "conflict" });
      await expect(deletion).resolves.toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();
      expect(getSession(session.id)).toBeUndefined();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("post-write invalidation removes the request id from the durable journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-invalidate-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const dispatch = mock(async () => {});

      const claim = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-invalidate",
        dispatch,
        { beforePersistence: () => persistenceGate },
      );
      expect(deleteSession(session.id)).toBe(true);

      releasePersistence!();
      await expect(claim).rejects.toMatchObject({ code: "conflict" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the turn reservation when request-id persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");

      await expect(
        claimPromptDispatch(
          session.id,
          "initial-prompt:env-1:tab-failure",
          async () => {},
        ),
      ).rejects.toBeTruthy();

      expect(getSession(session.id)?.status).toBe("idle");
      expect(getSession(session.id)?.turnStartedAt).toBeUndefined();
      expect(getSession(session.id)?.dispatchedRequestIds?.has(
        "initial-prompt:env-1:tab-failure",
      )).toBe(false);
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the durable claim when dispatch cannot start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-start-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      session.status = "error";
      session.turnStartedAt = "2026-01-01T00:00:00.000Z";
      const sdkSessionId = session.id.slice("session-".length);

      await expect(
        claimPromptDispatch(
          session.id,
          "initial-prompt:env-1:tab-start",
          () => {
            throw new Error("dispatch refused");
          },
        ),
      ).rejects.toThrow("dispatch refused");

      expect(session.status).toBe("error");
      expect(session.turnStartedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(session.dispatchedRequestIds?.has(
        "initial-prompt:env-1:tab-start",
      )).toBe(false);
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back when prompt preparation fails before the SDK query starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-prequery-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      const requestId = "initial-prompt:env-1:tab-prequery";
      const missingImage = join(directory, "missing.png");

      const claim = withWorkspaceCwd(directory, () =>
        claimPromptDispatch(session.id, requestId, () => {
          let resolveStarted: (() => void) | undefined;
          let rejectStarted: ((error: unknown) => void) | undefined;
          const started = new Promise<void>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
          });
          const completion = sendPrompt(
            session.id,
            "Describe this image",
            {
              requestId,
              attachments: [{ type: "image", path: missingImage }],
            },
            { onQueryStarted: () => resolveStarted?.() },
          );
          void completion.catch((error) => rejectStarted?.(error));
          return { started, completion };
        }),
      );

      await expect(claim).rejects.toMatchObject({
        name: "ClaudeAttachmentError",
        code: "attachment_read_failed",
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(session.status).toBe("idle");
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.dispatchedRequestIds?.has(requestId)).toBe(false);
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
      expect(getPromptDispatchState(session.id, requestId)).toBe("new");
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("acknowledges explicit plan mode only after it is durable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-mode-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan");
      track(session.id);
      const { events, stop } = captureEvents();
      try {
        const updated = await setSessionPreferences(session.id, {
          planMode: true,
        });
        expect(updated.planMode).toBe(true);
      } finally {
        stop();
      }

      expect(await readSessionPreferences(
        session.id.slice("session-".length),
      )).toEqual({ planMode: true });
      expect(events).toContainEqual({
        type: "session.updated",
        sessionId: session.id,
        data: { planMode: true },
      });
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the previous plan mode authoritative when persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan");
      track(session.id);
      session.planMode = false;
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
      const { events, stop } = captureEvents();
      try {
        await expect(
          setSessionPreferences(session.id, { planMode: true }),
        ).rejects.toBeTruthy();
      } finally {
        stop();
      }

      expect(session.planMode).toBe(false);
      expect(events).not.toContainEqual({
        type: "session.updated",
        sessionId: session.id,
        data: { planMode: true },
      });
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restores a claimed turn when plan-mode persistence fails before SDK startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-startup-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan startup");
      track(session.id);
      const requestId = "initial-prompt:env-1:plan-startup-failure";

      const claim = claimPromptDispatch(session.id, requestId, () => {
        const completion = (async () => {
          await rm(join(directory, ".claude"), {
            recursive: true,
            force: true,
          });
          await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
          await sendPrompt(session.id, "Plan this", {
            permissionMode: "plan",
            requestId,
          });
        })();
        return { started: completion, completion };
      });

      await expect(claim).rejects.toBeTruthy();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(session.status).toBe("idle");
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.abortController).toBeUndefined();
      expect(session.persistedMessagesLoaded).toBeUndefined();
      expect(session.dispatchedRequestIds?.has(requestId)).toBe(false);
      expect(getPromptDispatchState(session.id, requestId)).toBe("new");
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
