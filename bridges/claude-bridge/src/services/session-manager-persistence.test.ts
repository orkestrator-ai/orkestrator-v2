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



describe("reconcilePersistedSessions", () => {
  test("does nothing when the installed SDK has no listSessions API", async () => {
    installSdkModuleMock({ listSessions: undefined });

    await expect(reconcilePersistedSessions()).resolves.toBeUndefined();
    expect(mockSdkListSessions).not.toHaveBeenCalled();
  });

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

  test("reconciles a persisted client-key rollout under its stable alias", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-reconcile-client-alias-"));
    setClaudeHomeForTesting(directory);
    const clientSessionKey = "env-env-1:startup-agent";
    const alias = sessionIdForClientKey(clientSessionKey)!;
    const sdkSessionId = alias
      .slice("session-client-".length)
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    try {
      await updateSessionPreferences(sdkSessionId, {
        clientSessionBridgeId: alias,
      });
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({ sessionId: sdkSessionId, cwd: "/repo/env-a" }),
      ]);

      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      track(alias);

      expect(getSession(alias)).toMatchObject({ sdkSessionId });
      expect(getSession(`session-${sdkSessionId}`)).toBeUndefined();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ignores a persisted alias that decodes to a different rollout", async () => {
    await withTemporaryClaudeHome("claude-reconcile-foreign-alias-", async () => {
      // A stale alias left by an earlier client key, or one planted by hand.
      // Adopting it would file this rollout under the id a different
      // conversation's tab asks for.
      const foreignAlias = sessionIdForClientKey("env-env-2:other-agent")!;
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        clientSessionBridgeId: foreignAlias,
      });
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({ cwd: "/repo/env-a" }),
      ]);

      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      track(`session-${PERSISTED_SDK_ID}`);
      track(foreignAlias);

      expect(getSession(`session-${PERSISTED_SDK_ID}`)).toMatchObject({
        sdkSessionId: PERSISTED_SDK_ID,
      });
      expect(getSession(foreignAlias)).toBeUndefined();
    });
  });

  test("matches a persisted alias against the SDK id case-insensitively", async () => {
    await withTemporaryClaudeHome("claude-reconcile-alias-case-", async () => {
      const clientSessionKey = "env-env-1:startup-agent";
      const alias = sessionIdForClientKey(clientSessionKey)!;
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      await updateSessionPreferences(sdkSessionId, {
        clientSessionBridgeId: alias,
      });
      // An alias only ever encodes lower-case hex, so an SDK that reports the
      // rollout id in upper case must still resolve to this same conversation.
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({
          sessionId: sdkSessionId.toUpperCase(),
          cwd: "/repo/env-a",
        }),
      ]);

      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      track(alias);
      track(`session-${sdkSessionId.toUpperCase()}`);

      expect(getSession(alias)).toMatchObject({
        sdkSessionId: sdkSessionId.toUpperCase(),
      });
      expect(getSession(`session-${sdkSessionId.toUpperCase()}`)).toBeUndefined();
    });
  });

  test("re-asserts a client-key alias whose only durable write failed", async () => {
    await withTemporaryClaudeHome("claude-alias-reassert-", async (directory) => {
      const clientSessionKey = "env-env-1:startup-agent";
      const alias = sessionIdForClientKey(clientSessionKey)!;
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      const first = createSession("Startup agent", clientSessionKey);
      track(first.id);

      // The alias is written exactly once, on the first turn's init. Break that
      // one write: the preference directory cannot be created underneath a file.
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
      const failing = sendPrompt(first.id, "Inspect the workspace");
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
      await expect(failing).rejects.toBeTruthy();

      await rm(join(directory, ".claude"));
      expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();

      // Restart: the registry is empty but the rollout and its alias-less
      // preferences survive. `sdkSessionId` is now derived from the alias, so
      // init will never report a durable-identity change again.
      expect(deleteSession(first.id)).toBe(true);
      mockSdkGetSessionInfo.mockImplementation(async (id) =>
        id === sdkSessionId
          ? sdkSessionInfo({ sessionId: sdkSessionId, customTitle: "Recovered" })
          : undefined);
      const recovered = await createOrRecoverSession(
        "Ignored retry title",
        clientSessionKey,
      );
      expect(recovered.id).toBe(alias);
      expect(await readSessionPreferences(sdkSessionId)).toMatchObject({
        clientSessionBridgeId: alias,
      });

      // Without that repair the alias stays absent and this listing adopts the
      // same conversation a second time under `session-<uuid>`.
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({ sessionId: sdkSessionId, cwd: "/repo/env-a" }),
      ]);
      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      track(`session-${sdkSessionId}`);

      expect(getSession(alias)).toBe(recovered);
      expect(getSession(`session-${sdkSessionId}`)).toBeUndefined();
      expect(
        listSessions().filter((entry) => entry.sdkSessionId === sdkSessionId),
      ).toHaveLength(1);
    });
  });

  test("rehydrates durable plan mode and suppresses a journaled request after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-reconcile-preferences-"));
    setClaudeHomeForTesting(directory);
    try {
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        planMode: true,
        dispatchedRequestIds: ["initial-prompt:after-restart"],
      });
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({ cwd: "/repo/env-a" }),
      ]);

      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      const id = track(`session-${PERSISTED_SDK_ID}`);
      const adopted = getSession(id);
      expect(adopted?.planMode).toBe(true);
      expect(adopted?.dispatchedRequestIds).toEqual(
        new Set(["initial-prompt:after-restart"]),
      );

      const dispatch = mock(async () => {});
      await expect(
        claimPromptDispatch(id, "initial-prompt:after-restart", dispatch),
      ).resolves.toBe("duplicate");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("blocks stable-id prompts when the durable journal is corrupt after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-reconcile-corrupt-journal-"));
    setClaudeHomeForTesting(directory);
    try {
      const preferencesDirectory = join(
        directory,
        ".claude",
        "orkestrator",
        "session-preferences",
      );
      await mkdir(preferencesDirectory, { recursive: true });
      await writeFile(
        join(preferencesDirectory, `${PERSISTED_SDK_ID}.json`),
        "{",
        "utf-8",
      );
      mockSdkListSessions.mockImplementation(async () => [
        sdkSessionInfo({ cwd: "/repo/env-a" }),
      ]);

      await withWorkspaceCwd("/repo/env-a", async () => {
        await reconcilePersistedSessions();
      });
      const id = track(`session-${PERSISTED_SDK_ID}`);
      expect(getSession(id)).toMatchObject({
        planMode: true,
        dispatchJournalUnavailable: true,
      });

      const dispatch = mock(async () => {});
      await expect(
        claimPromptDispatch(id, "initial-prompt:unsafe-retry", dispatch),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("durable prompt journal is unavailable"),
      });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
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

  test("bounds stale-list deletion tombstones to the newest 128 sessions", async () => {
    await withTemporaryClaudeHome("claude-reconcile-tombstone-cap-", async () => {
      const infos = Array.from({ length: 129 }, (_, index) =>
        sdkSessionInfo({
          sessionId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
          summary: `Persisted session ${index}`,
          cwd: "/repo/env-a",
        }));
      mockSdkListSessions.mockImplementation(async () => infos);
      await withWorkspaceCwd("/repo/env-a", reconcilePersistedSessions);
      for (const info of infos) track(`session-${info.sessionId}`);

      let releaseStaleList: ((value: SdkSessionInfo[]) => void) | undefined;
      mockSdkListSessions.mockImplementation(
        async () => new Promise<SdkSessionInfo[]>((resolve) => {
          releaseStaleList = resolve;
        }),
      );
      const staleReconcile = withWorkspaceCwd(
        "/repo/env-a",
        reconcilePersistedSessions,
      );
      await waitFor(() => releaseStaleList !== undefined);

      for (const info of infos) {
        await expect(
          deleteSessionDurably(`session-${info.sessionId}`),
        ).resolves.toBe(true);
      }
      releaseStaleList!(infos);
      await staleReconcile;

      // The fixed-size history intentionally lets the oldest deletion age out,
      // while every deletion still inside the 128-entry window suppresses its
      // pre-deletion row from this stale SDK snapshot.
      expect(getSession(`session-${infos[0]!.sessionId}`)).toBeDefined();
      expect(getSession(`session-${infos[1]!.sessionId}`)).toBeUndefined();
      expect(getSession(`session-${infos.at(-1)!.sessionId}`)).toBeUndefined();
    });
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

  test("clears a rejected materialization so a later point read can retry", async () => {
    const bridgeId = track(`session-${PERSISTED_SDK_ID}`);
    mockSdkGetSessionInfo
      .mockImplementationOnce(async () => {
        throw new Error("metadata temporarily unavailable");
      })
      .mockImplementation(async () => sdkSessionInfo({ customTitle: "Recovered" }));

    await expect(ensurePersistedSession(bridgeId)).rejects.toThrow(
      "metadata temporarily unavailable",
    );
    await expect(ensurePersistedSession(bridgeId)).resolves.toMatchObject({
      id: bridgeId,
      title: "Recovered",
      sdkSessionId: PERSISTED_SDK_ID,
    });
    expect(mockSdkGetSessionInfo).toHaveBeenCalledTimes(2);
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

  test("materializes durable preferences with the point-read session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-materialize-preferences-"));
    setClaudeHomeForTesting(directory);
    try {
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        planMode: false,
        dispatchedRequestIds: ["request-from-disk"],
      });
      const state = await materializePersistedSession();
      expect(state.planMode).toBe(false);
      expect(state.dispatchedRequestIds).toEqual(
        new Set(["request-from-disk"]),
      );
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
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

  test("rehydrates correlated terminal background-task lifecycle records", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "system",
        uuid: "task-start",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Review",
          timestamp: "2026-07-28T10:00:00.000Z",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "task-progress",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          tool_use_id: "tool-agent-1",
          description: "Reviewing",
          timestamp: "2026-07-28T10:01:00.000Z",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "task-end",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "failed",
          summary: "Review failed",
          timestamp: "2026-07-28T10:02:00.000Z",
        },
        parent_tool_use_id: null,
      },
    ]);

    await hydratePersistedSessionMessages(state.id);

    expect(state.backgroundTasks?.["task-1"]).toMatchObject({
      id: "task-1",
      toolUseId: "tool-agent-1",
      description: "Reviewing",
      status: "failed",
      error: "Review failed",
      startedAt: Date.parse("2026-07-28T10:00:00.000Z"),
      endedAt: Date.parse("2026-07-28T10:02:00.000Z"),
    });
  });

  test("settles persisted live tasks after process loss, including older records without tool ids", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "system",
        uuid: "old-start",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_started",
          task_id: "task-old",
          description: "Older task",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "orphan-progress",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_progress",
          task_id: "task-progress-only",
          tool_use_id: "tool-progress",
          description: "Recovered from progress",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "orphan-notification",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-notification-only",
          tool_use_id: "tool-notification",
          status: "completed",
          summary: "Done",
        },
        parent_tool_use_id: null,
      },
    ]);

    await hydratePersistedSessionMessages(state.id);

    expect(state.backgroundTasks?.["task-old"]).toMatchObject({
      status: "killed",
      description: "Older task",
    });
    expect(state.backgroundTasks?.["task-old"]?.toolUseId).toBeUndefined();
    expect(state.backgroundTasks?.["task-progress-only"]).toMatchObject({
      status: "killed",
      toolUseId: "tool-progress",
      description: "Recovered from progress",
    });
    expect(state.backgroundTasks?.["task-notification-only"]).toMatchObject({
      status: "completed",
      toolUseId: "tool-notification",
      description: "Done",
    });
  });

  test("does not treat malformed persisted notifications as successful completion", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "system",
        uuid: "started-before-invalid-notification",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_started",
          task_id: "task-invalid-terminal",
          description: "Still unresolved",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "missing-status",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-invalid-terminal",
          summary: "Must not imply success",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "unknown-status",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-unknown-terminal",
          status: "succeeded",
          summary: "Unknown status",
        },
        parent_tool_use_id: null,
      },
    ]);

    await hydratePersistedSessionMessages(state.id);

    expect(state.backgroundTasks?.["task-invalid-terminal"]).toMatchObject({
      status: "killed",
      description: "Still unresolved",
    });
    expect(state.backgroundTasks?.["task-unknown-terminal"]).toBeUndefined();
  });

  test("sanitizes malformed persisted lifecycle fields before publishing snapshots", async () => {
    const state = await materializePersistedSession();
    const beforeHydration = Date.now();
    const longSummary = `\u0000${"a".repeat(4_095)}😀`;
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "system",
        uuid: "malformed-start",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_started",
          task_id: " task-malformed ",
          tool_use_id: 42,
          description: { text: "not a string" },
          timestamp: Number.POSITIVE_INFINITY,
          patch: {
            status: "finished",
            description: ["not", "text"],
            end_time: Number.POSITIVE_INFINITY,
            error: { message: "not text" },
            is_backgrounded: "true",
          },
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "valid-failure-with-hostile-optionals",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-malformed",
          tool_use_id: "tool\u0000poisoned",
          status: "failed",
          summary: longSummary,
          timestamp: "9999-12-31T23:59:59.999Z",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "invalid-task-id",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: `task-${"x".repeat(600)}`,
          status: "completed",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "backwards-start",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_started",
          task_id: "task-backwards",
          timestamp: "2026-07-28T10:02:00.000Z",
        },
        parent_tool_use_id: null,
      },
      {
        type: "system",
        uuid: "backwards-notification",
        session_id: PERSISTED_SDK_ID,
        message: {
          type: "system",
          subtype: "task_notification",
          task_id: "task-backwards",
          status: "completed",
          timestamp: "2026-07-28T10:00:00.000Z",
        },
        parent_tool_use_id: null,
      },
    ]);

    await hydratePersistedSessionMessages(state.id);

    const snapshot = state.backgroundTasks?.["task-malformed"];
    expect(snapshot).toMatchObject({
      id: "task-malformed",
      status: "failed",
    });
    expect(snapshot?.toolUseId).toBeUndefined();
    expect(snapshot?.description).toBe(snapshot?.error);
    expect(snapshot?.error).not.toContain("\u0000");
    expect(snapshot?.error?.length).toBeLessThanOrEqual(4_096);
    expect(snapshot?.error?.charCodeAt((snapshot.error?.length ?? 0) - 1))
      .not.toBeGreaterThanOrEqual(0xd800);
    expect(snapshot?.startedAt).toBeGreaterThanOrEqual(beforeHydration);
    expect(snapshot?.startedAt).toBeLessThanOrEqual(Date.now());
    expect(snapshot?.endedAt).toBeGreaterThanOrEqual(beforeHydration);
    expect(snapshot?.endedAt).toBeLessThanOrEqual(Date.now());
    expect(state.backgroundTasks?.["task-backwards"]).toMatchObject({
      status: "completed",
      startedAt: Date.parse("2026-07-28T10:02:00.000Z"),
    });
    expect(state.backgroundTasks?.["task-backwards"]?.endedAt).toBeUndefined();
    expect(Object.keys(state.backgroundTasks ?? {}).sort()).toEqual([
      "task-backwards",
      "task-malformed",
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



describe("evictIdleHydratedTranscripts", () => {
  let hydratedSessionSequence = 0;

  async function hydratedIdleSession() {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    hydratedSessionSequence += 1;
    const state = await materializePersistedSession({
      sessionId: `11111111-2222-4333-8444-${hydratedSessionSequence
        .toString(16)
        .padStart(12, "0")}`,
    });
    await hydratePersistedSessionMessages(state.id);
    return state;
  }

  function markStale(state: { lastAccessedAt?: number }) {
    state.lastAccessedAt = Date.now() - IDLE_TRANSCRIPT_EVICTION_MS - 1;
  }

  test("drops a stale hydrated transcript and re-hydrates on the next read", async () => {
    const state = await hydratedIdleSession();
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.taskRegistry).toBeDefined();
    markStale(state);

    expect(evictIdleHydratedTranscripts()).toEqual([state.id]);
    expect(state.messages).toEqual([]);
    expect(state.taskRegistry).toBeUndefined();
    expect(state.persistedMessagesLoaded).toBe(false);

    // The next read is indistinguishable from a first read after restart.
    const rehydrated = await hydratePersistedSessionMessages(state.id);
    expect(rehydrated.map((message) => message.id)).toEqual([U1, A1, A2, U2]);
    expect(state.persistedMessagesLoaded).toBe(true);
    expect(mockSdkGetSessionMessages).toHaveBeenCalledTimes(2);
  });

  test("keeps a transcript that was read recently", async () => {
    const state = await hydratedIdleSession();
    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  test("a read refreshes the idle clock", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    getSessionMessages(state.id);
    expect(evictIdleHydratedTranscripts()).toEqual([]);
  });

  test("falls back to last activity when an older session has no access clock", async () => {
    const state = await hydratedIdleSession();
    state.lastAccessedAt = undefined;
    state.lastActivity = new Date(Date.now() - IDLE_TRANSCRIPT_EVICTION_MS - 1);

    expect(evictIdleHydratedTranscripts()).toEqual([state.id]);
  });

  test("keeps sessions claimed by destructive or hydration work", async () => {
    const deleting = await hydratedIdleSession();
    markStale(deleting);
    deleting.deleting = true;

    const rewinding = await hydratedIdleSession();
    markStale(rewinding);
    rewinding.rewindInProgress = true;

    const abortable = await hydratedIdleSession();
    markStale(abortable);
    abortable.abortController = new AbortController();

    const hydrating = await hydratedIdleSession();
    markStale(hydrating);
    hydrating.persistedHydration = new Promise(() => {});

    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(deleting.messages.length).toBeGreaterThan(0);
    expect(rewinding.messages.length).toBeGreaterThan(0);
    expect(abortable.messages.length).toBeGreaterThan(0);
    expect(hydrating.messages.length).toBeGreaterThan(0);
  });

  test("keeps sessions with live background task state or controls", async () => {
    const controlled = await hydratedIdleSession();
    markStale(controlled);
    controlled.backgroundTaskControls = new Map([
      ["task-controlled", { close: () => undefined }],
    ]);

    const running = await hydratedIdleSession();
    markStale(running);
    running.backgroundTasks = {
      "task-running": {
        id: "task-running",
        status: "running",
        startedAt: Date.now(),
      },
    };

    const candidate = await hydratedIdleSession();
    markStale(candidate);
    candidate.backgroundTaskCandidates = new Map([
      ["bash-candidate", { close: () => undefined }],
    ]);

    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(controlled.messages.length).toBeGreaterThan(0);
    expect(running.messages.length).toBeGreaterThan(0);
    expect(candidate.messages.length).toBeGreaterThan(0);
  });

  test("keeps a transcript referenced by a pending question", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    const promptPromise = sendPrompt(state.id, "ask");
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Keep this transcript?" }],
    });
    await waitFor(() => getPendingQuestions(state.id).length === 1);

    // Isolate the interaction guard from the running-turn guards. Production
    // normally has all of these at once, but each is independently required
    // because cleanup ordering can clear the control fields first.
    state.status = "idle";
    state.abortController = undefined;
    state.queryControl = undefined;
    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);

    const [question] = getPendingQuestions(state.id);
    expect(dismissQuestion(question!.id)).toBe(true);
    expect((await toolPromise).behavior).toBe("deny");
    call.finish();
    await promptPromise;
  });

  test("keeps a transcript referenced by a pending plan approval", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    const promptPromise = sendPrompt(state.id, "plan", {
      permissionMode: "plan",
    });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", {
      plan: "Keep this transcript",
    });
    await waitFor(() => getPendingPlanApprovals(state.id).length === 1);

    state.status = "idle";
    state.abortController = undefined;
    state.queryControl = undefined;
    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);

    const [approval] = getPendingPlanApprovals(state.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    expect((await toolPromise).behavior).toBe("allow");
    call.finish();
    await promptPromise;
  });

  test("does not mark an already-empty hydrated session for rehydration", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    state.messages = [];
    state.taskRegistry = undefined;

    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(state.persistedMessagesLoaded).toBe(true);
  });

  test("never evicts a running session", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    state.status = "running";
    try {
      expect(evictIdleHydratedTranscripts()).toEqual([]);
    } finally {
      state.status = "idle";
    }
  });

  test("never evicts a session holding a query control", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    state.queryControl = { close: () => undefined };
    try {
      expect(evictIdleHydratedTranscripts()).toEqual([]);
    } finally {
      state.queryControl = undefined;
    }
  });

  test("keeps a streamed transcript when its replay-safety clock is unknown", async () => {
    // A turn that ran here leaves `revision` counters on its messages, which a
    // reconnecting SSE client resumes patches from; hydration from disk cannot
    // reproduce them.
    const state = await hydratedIdleSession();
    markStale(state);
    state.messages[state.messages.length - 1]!.revision = 3;
    expect(evictIdleHydratedTranscripts()).toEqual([]);
  });

  test("evicts a streamed transcript after its replay-safety window expires", async () => {
    const state = await hydratedIdleSession();
    const now = Date.now();
    state.lastAccessedAt = now - IDLE_TRANSCRIPT_EVICTION_MS - 1;
    state.messages[state.messages.length - 1]!.revision = 3;
    state.lastStreamedRevisionAt = now - IDLE_TRANSCRIPT_EVICTION_MS - 1;

    expect(evictIdleHydratedTranscripts(now)).toEqual([state.id]);
    expect(state.messages).toEqual([]);
    expect(state.persistedMessagesLoaded).toBe(false);
  });

  test("keeps a recently streamed transcript even when its last read is stale", async () => {
    const state = await hydratedIdleSession();
    const now = Date.now();
    state.lastAccessedAt = now - IDLE_TRANSCRIPT_EVICTION_MS - 1;
    state.messages[state.messages.length - 1]!.revision = 3;
    state.lastStreamedRevisionAt = now - IDLE_TRANSCRIPT_EVICTION_MS + 1;

    expect(evictIdleHydratedTranscripts(now)).toEqual([]);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  test("never evicts a session that was not hydrated from disk", async () => {
    // A fresh in-memory session has no rollout to re-hydrate from; dropping
    // its messages would lose them outright.
    const state = createSession("in-memory");
    track(state.id);
    state.messages.push({
      id: "msg-live",
      role: "user",
      content: "hello",
      parts: [],
      timestamp: new Date().toISOString(),
    });
    markStale(state);
    expect(evictIdleHydratedTranscripts()).toEqual([]);
    expect(state.messages).toHaveLength(1);
  });

  test("reports the complete result of the most recent sweep", async () => {
    const stale = await hydratedIdleSession();
    markStale(stale);
    const recent = await hydratedIdleSession();

    expect(evictIdleHydratedTranscripts()).toContain(stale.id);
    expect(recent.messages.length).toBeGreaterThan(0);
    expect(getLastIdleTranscriptSweep()).toEqual(expect.objectContaining({
      scanned: expect.any(Number),
      evicted: 1,
      skipped: expect.objectContaining({
        "recently-read": expect.any(Number),
      }),
    }));
  });

  test("periodic sweep timer evicts stale hydrated transcripts", async () => {
    const state = await hydratedIdleSession();
    markStale(state);
    const timer = startIdleTranscriptSweep(5);
    try {
      expect(timer.hasRef()).toBe(false);
      await waitFor(() => state.persistedMessagesLoaded === false);
      expect(state.messages).toEqual([]);
      expect(getLastIdleTranscriptSweep()?.evicted).toBeGreaterThanOrEqual(1);
    } finally {
      clearInterval(timer);
    }
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

  test("throws conflict when the installed SDK cannot fork sessions", async () => {
    const state = await materializePersistedSession();
    installSdkModuleMock({ forkSession: undefined });

    await expect(forkPersistedSession(state.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Installed Claude Agent SDK does not support session forking",
    });
    expect(mockSdkForkSession).not.toHaveBeenCalled();
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

  test("leaves the in-memory title unchanged when durable rename is rejected", async () => {
    const state = await materializePersistedSession({ customTitle: "Original" });
    mockSdkRenameSession.mockRejectedValueOnce(new Error("rename denied"));
    const { events, stop } = captureEvents();
    try {
      await expect(renameSessionDurably(state.id, "Rejected")).rejects.toThrow(
        "rename denied",
      );
    } finally {
      stop();
    }

    expect(state.title).toBe("Original");
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "session.title-updated",
      sessionId: state.id,
    }));
  });

  test("deletes the rollout and the registry entry together", async () => {
    const state = await materializePersistedSession();
    await updateSessionPreferences(PERSISTED_SDK_ID, {
      planMode: true,
      dispatchedRequestIds: ["initial-prompt:env-1:tab-1"],
    });
    const baseline = getPromptDispatchRecordCountForTesting();
    const prompt = sendPrompt(state.id, "run before delete", {
      requestId: "durable-delete-cleanup",
    });
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success", result: "done" });
    call.finish();
    await prompt;
    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline + 1);

    expect(await deleteSessionDurably(state.id)).toBe(true);
    expect(mockSdkDeleteSession).toHaveBeenCalledWith(PERSISTED_SDK_ID, {
      dir: process.env.CWD || process.cwd(),
    });
    expect(await readSessionPreferences(PERSISTED_SDK_ID)).toBeUndefined();
    expect(getSession(state.id)).toBeUndefined();
    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline);
  });

  test("deletes preferences for a session before its first SDK turn", async () => {
    const state = createSession("not started");
    track(state.id);
    await setSessionPreferences(state.id, { planMode: true });
    const sdkSessionId = state.id.slice("session-".length);

    expect(await deleteSessionDurably(state.id)).toBe(true);
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
    expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();
    expect(getSession(state.id)).toBeUndefined();
  });

  test("cleans up bridge state when the installed SDK has no durable delete", async () => {
    const state = await materializePersistedSession();
    await updateSessionPreferences(PERSISTED_SDK_ID, { planMode: true });
    installSdkModuleMock({ deleteSession: undefined });

    await expect(deleteSessionDurably(state.id)).resolves.toBe(true);
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
    expect(await readSessionPreferences(PERSISTED_SDK_ID)).toBeUndefined();
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
    state.turnStartedAt = "2026-01-01T00:00:00.000Z";
    state.completionBlockedByBackgroundTasks = true;
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
    expect(state.turnStartedAt).toBeUndefined();
    expect(state.completionBlockedByBackgroundTasks).toBe(false);
    expect(state.queryControl).toBeUndefined();

    const prompt = sendPrompt(state.id, "try again");
    const call = await nextQueryCall();
    expect(typeof state.turnStartedAt).toBe("string");
    expect(state.turnStartedAt).not.toBe("2026-01-01T00:00:00.000Z");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("keeps a deleted rollout absent when preference cleanup fails and lets retry finish cleanup", async () => {
    const state = await materializePersistedSession();
    const preferencePath = join(
      claudeSessionPreferencesDir(),
      `${PERSISTED_SDK_ID}.json`,
    );
    await rm(preferencePath, { recursive: true, force: true });
    await mkdir(preferencePath, { recursive: true });

    await expect(deleteSessionDurably(state.id)).rejects.toBeTruthy();
    expect(mockSdkDeleteSession).toHaveBeenCalledTimes(1);
    expect(getSession(state.id)).toBeUndefined();

    await rm(preferencePath, { recursive: true, force: true });
    mockSdkGetSessionInfo.mockImplementation(async () => undefined);
    await expect(deleteSessionDurably(state.id)).resolves.toBe(false);
    expect(await readSessionPreferences(PERSISTED_SDK_ID)).toBeUndefined();
    expect(mockSdkDeleteSession).toHaveBeenCalledTimes(1);
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

  test("times out and closes a transient query that never produces a message", async () => {
    const state = await rewindableSession();
    const returnSpy = mock(async () => ({ done: true, value: undefined }));
    queryControlOverrides.return = returnSpy;
    // Warm the dynamic SDK import before faking timers; Bun otherwise leaves
    // the import continuation behind the fake-timer boundary.
    await import("@anthropic-ai/claude-agent-sdk");

    jest.useFakeTimers();
    try {
      const rewindPromise = rewindSessionFiles(state.id, U1);
      for (let attempt = 0; attempt < 1_000 && mockQuery.mock.calls.length === 0; attempt += 1) {
        jest.advanceTimersByTime(0);
        await Promise.resolve();
      }
      expect(mockQuery).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_000);
      await expect(rewindPromise).rejects.toMatchObject({
        code: "conflict",
        message: "Timed out opening the Claude session for file rewind",
      });
      expect(returnSpy).toHaveBeenCalledTimes(1);
      expect(getSession(state.id)?.rewindInProgress).toBe(false);
    } finally {
      jest.useRealTimers();
    }
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
