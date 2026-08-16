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
    // Make the next query() call fail so the catalog reports the hard-coded
    // fallback source as well as its models.
    mockQuery.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });

    const catalog = await getAvailableModelCatalog();

    expect(catalog.source).toBe("fallback");
    expect(catalog.models.map((model) => model.id)).toEqual([
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
    mockExecFile.mockImplementation(((
      file: string,
      args: string[] | undefined,
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === executable && args?.[0] === "--version") {
        try {
          const stdout = typeof output === "function" ? output() : output;
          callback(null, stdout, "");
        } catch (error) {
          callback(error as Error, "", "");
        }
        return undefined as never;
      }
      return originalExecFile(
        file as never,
        args as never,
        options as never,
        callback as never,
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
        mockExecFile.mock.calls.some((call) =>
          (call[1] as string[] | undefined)?.includes("--version"),
        ),
      ).toBe(false);
    });
  });

  test("returns unknown bundled versions when the SDK manifest cannot be read", async () => {
    await withClaudeCliPath(undefined, async () => {
      mockReadFile.mockImplementationOnce(async () => {
        throw new Error("manifest unreadable");
      });

      await expect(getClaudeRuntimeVersions()).resolves.toEqual({
        sdkVersion: undefined,
        cliVersion: undefined,
      });
    });
  });

  test("returns unknown bundled versions when the SDK manifest is malformed", async () => {
    await withClaudeCliPath(undefined, async () => {
      mockReadFile.mockImplementationOnce(async () => "{");

      await expect(getClaudeRuntimeVersions()).resolves.toEqual({
        sdkVersion: undefined,
        cliVersion: undefined,
      });
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
      const call = mockExecFile.mock.calls.find(
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

  test("a real slow executable times out without blocking the event loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-version-timeout-"));
    const executable = join(directory, "slow-claude");
    await writeFile(executable, "#!/bin/sh\nexec /bin/sleep 30\n");
    await chmod(executable, 0o755);
    mockExecFile.mockImplementation(originalExecFile);

    try {
      await withClaudeCliPath(executable, async () => {
        let timerFired = false;
        setTimeout(() => {
          timerFired = true;
        }, 25);
        const startedAt = Date.now();
        const versionsPromise = getClaudeRuntimeVersions();

        await waitFor(() => timerFired, 500);
        expect(timerFired).toBe(true);

        const manifest = await readBundledManifest();
        const versions = await versionsPromise;
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
        expect(elapsedMs).toBeLessThan(10_000);
        expect(versions.cliVersion).toBe(manifest.claudeCodeVersion);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 12_000);
});



// ---------------------------------------------------------------------------
// Rate limits and usage
// ---------------------------------------------------------------------------

describe("rate_limit_event", () => {
  const sparseFiveHourEvent = {
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType: "five_hour",
      utilization: 42,
      resetsAt: Date.parse("2026-07-28T22:30:00.000Z") / 1000,
    },
  };
  const successfulUsageResult = {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 10, output_tokens: 5, context_window_tokens: 1000 },
  };

  test("publishes authoritative allocation before the first turn finishes", async () => {
    const getStructuredUsage = mock(async () => ({
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 17,
          resets_at: "2026-07-28T22:30:00.000Z",
        },
        seven_day: {
          utilization: 29,
          resets_at: "2026-08-04T10:00:00.000Z",
        },
      },
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const { events, stop } = captureEvents();
    const created = createSession("early allocation");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();

    try {
      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 17);
      const running = getSession(created.id)!;
      expect(running.status).toBe("running");
      expect(running.usage).toBeUndefined();
      expect(getStructuredUsage).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        type: "session.updated",
        sessionId: created.id,
        data: {
          rateLimits: [
            {
              label: "Five Hour",
              usedPercent: 17,
              resetsAt: "2026-07-28T22:30:00.000Z",
            },
            {
              label: "Weekly",
              usedPercent: 29,
              resetsAt: "2026-08-04T10:00:00.000Z",
            },
          ],
        },
      });
    } finally {
      stop();
      call.finish();
      await promptPromise;
    }
  });

  test("replaces a sparse mid-turn notification with structured allocation", async () => {
    let requestCount = 0;
    const getStructuredUsage = mock(async () => {
      requestCount += 1;
      return {
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: requestCount === 1 ? 10 : 37,
            resets_at: "2026-07-28T22:30:00.000Z",
          },
        },
      };
    });
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("mid-turn allocation");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();

    try {
      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 10);
      call.push({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          // Real threshold notifications can omit utilization entirely.
          resetsAt: Date.parse("2026-07-28T22:30:00.000Z") / 1000,
        },
      });

      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 37);
      expect(getSession(created.id)?.status).toBe("running");
      expect(getSession(created.id)?.usage).toBeUndefined();
      expect(getStructuredUsage).toHaveBeenCalledTimes(2);
    } finally {
      call.finish();
      await promptPromise;
    }
  });

  test("coalesces refreshes without blocking later SDK messages", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let requestCount = 0;
    const getStructuredUsage = mock(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 44 },
          seven_day: { utilization: 55 },
        },
      });
    });
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("coalesced allocation");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();

    try {
      await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveFirst !== undefined);
      for (const utilization of [11, 22, 33]) {
        call.push({
          type: "rate_limit_event",
          rate_limit_info: { rateLimitType: "five_hour", utilization },
        });
      }
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "task-after-limit",
        description: "Continued draining",
      });

      // The first control request is still parked, but the iterator has
      // already consumed the message after all three refresh signals.
      await waitFor(
        () => getSession(created.id)?.backgroundTasks?.["task-after-limit"] !== undefined,
      );
      expect(getStructuredUsage).toHaveBeenCalledTimes(1);

      resolveFirst!({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 5 } },
      });
      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 44);
      expect(getStructuredUsage).toHaveBeenCalledTimes(2);
      expect(getSession(created.id)?.rateLimits).toEqual([
        { label: "Five Hour", usedPercent: 44 },
        { label: "Weekly", usedPercent: 55 },
      ]);
    } finally {
      call.finish();
      await promptPromise;
    }
  });

  test("starts a new refresh when a signal arrives as the previous worker settles", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let requestCount = 0;
    const getStructuredUsage = mock(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 64 } },
      });
    });
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("settlement boundary");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    let pushedRefreshSignal = false;
    const stop = eventEmitter.subscribe((event) => {
      if (
        !pushedRefreshSignal
        && event.type === "session.updated"
        && event.sessionId === created.id
        && (event.data as { rateLimits?: Array<{ usedPercent?: number }> })
          .rateLimits?.[0]?.usedPercent === 5
      ) {
        pushedRefreshSignal = true;
        call.push(sparseFiveHourEvent);
      }
    });

    try {
      await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveFirst !== undefined);
      resolveFirst!({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 5 } },
      });

      await waitFor(() => getStructuredUsage.mock.calls.length === 2);
      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 64);
      expect(pushedRefreshSignal).toBe(true);
    } finally {
      stop();
      call.finish();
      await promptPromise;
    }
  });

  for (const latestResponse of ["rejected", "malformed"] as const) {
    test(`preserves a newer sparse event when the coalesced refresh is ${latestResponse}`, async () => {
      let resolveFirst: ((value: unknown) => void) | undefined;
      let requestCount = 0;
      const getStructuredUsage = mock(() => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Promise<unknown>((resolve) => {
            resolveFirst = resolve;
          });
        }
        if (latestResponse === "rejected") {
          return Promise.reject(new Error("structured usage unavailable"));
        }
        return Promise.resolve(null);
      });
      queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
        getStructuredUsage;

      const created = createSession(`stale response ${latestResponse}`);
      track(created.id);
      const promptPromise = sendPrompt(created.id, "keep working");
      const call = await nextQueryCall();

      await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveFirst !== undefined);
      call.push(sparseFiveHourEvent);
      await waitFor(() => getSession(created.id)?.rateLimits?.[0]?.usedPercent === 42);
      call.push(successfulUsageResult);
      call.finish();

      resolveFirst!({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 5 } },
      });
      await promptPromise;

      expect(getStructuredUsage).toHaveBeenCalledTimes(2);
      expect(getSession(created.id)?.rateLimits).toEqual([
        {
          label: "Five Hour",
          usedPercent: 42,
          resetsAt: "2026-07-28T22:30:00.000Z",
        },
      ]);
      expect(getSession(created.id)?.usage?.rateLimits)
        .toEqual(getSession(created.id)?.rateLimits);
    });
  }

  test("ignores a structured response after its session is removed", async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    let parsed = false;
    const getStructuredUsage = mock(() => new Promise<unknown>((resolve) => {
      resolveUsage = resolve;
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("removed during usage refresh");
    track(created.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveUsage !== undefined);
    const originalControl = created.queryControl;

    try {
      expect(deleteSession(created.id)).toBe(true);
      // Keep the detached state pointed at the old control so this exercises
      // the registry-identity guard independently of the control guard.
      created.queryControl = originalControl;
      resolveUsage!({
        rate_limits_available: true,
        get rate_limits() {
          parsed = true;
          return { five_hour: { utilization: 71 } };
        },
      });
      await waitFor(() => parsed);
      await promptPromise;

      expect(created.rateLimits).toBeUndefined();
      expect(events.some((event) =>
        event.type === "session.updated"
        && event.sessionId === created.id
        && "rateLimits" in event.data
      )).toBe(false);
    } finally {
      stop();
      call.finish();
    }
  });

  test("ignores a structured response while its session is being deleted", async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    let parsed = false;
    const getStructuredUsage = mock(() => new Promise<unknown>((resolve) => {
      resolveUsage = resolve;
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("deleting during usage refresh");
    track(created.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveUsage !== undefined);

    try {
      created.deleting = true;
      resolveUsage!({
        rate_limits_available: true,
        get rate_limits() {
          parsed = true;
          return { five_hour: { utilization: 72 } };
        },
      });
      await waitFor(() => parsed);

      expect(created.rateLimits).toBeUndefined();
      expect(events.some((event) =>
        event.type === "session.updated"
        && event.sessionId === created.id
        && "rateLimits" in event.data
      )).toBe(false);
    } finally {
      created.deleting = false;
      stop();
      call.finish();
      await promptPromise;
    }
  });

  test("ignores a structured response from a superseded query control", async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    let parsed = false;
    const getStructuredUsage = mock(() => new Promise<unknown>((resolve) => {
      resolveUsage = resolve;
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const created = createSession("superseded usage refresh");
    track(created.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    await waitFor(() => getStructuredUsage.mock.calls.length === 1 && resolveUsage !== undefined);
    const originalControl = created.queryControl;

    try {
      created.queryControl = { close: () => undefined };
      resolveUsage!({
        rate_limits_available: true,
        get rate_limits() {
          parsed = true;
          return { five_hour: { utilization: 73 } };
        },
      });
      await waitFor(() => parsed);

      expect(created.rateLimits).toBeUndefined();
      expect(events.some((event) =>
        event.type === "session.updated"
        && event.sessionId === created.id
        && "rateLimits" in event.data
      )).toBe(false);
    } finally {
      created.queryControl = originalControl;
      stop();
      call.finish();
      await promptPromise;
    }
  });

  test("replaces sparse threshold data with all structured /usage windows", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 11,
            resets_at: "2026-07-28T22:30:00.000Z",
          },
          seven_day: {
            utilization: 13,
            resets_at: "2026-08-04T10:00:00.000Z",
          },
          seven_day_opus: null,
          model_scoped: [
            {
              display_name: "Fable",
              utilization: 0,
              resets_at: "2026-08-04T10:00:00.000Z",
            },
          ],
        },
      }));

    const { session } = await runPromptWithMessages([
      {
        type: "rate_limit_event",
        // Threshold events can identify/reset a bucket without reporting its
        // current utilization — the exact shape behind the reported bug.
        rate_limit_info: {
          rateLimitType: "five_hour",
          resetsAt: Date.parse("2026-07-28T22:30:00.000Z") / 1000,
        },
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 10, output_tokens: 5, context_window_tokens: 1000 },
      },
    ]);

    expect(session.rateLimits).toEqual([
      {
        label: "Five Hour",
        usedPercent: 11,
        resetsAt: "2026-07-28T22:30:00.000Z",
      },
      {
        label: "Weekly",
        usedPercent: 13,
        resetsAt: "2026-08-04T10:00:00.000Z",
      },
      {
        label: "Weekly (Fable)",
        usedPercent: 0,
        resetsAt: "2026-08-04T10:00:00.000Z",
      },
    ]);
    expect(session.usage?.rateLimits).toEqual(session.rateLimits);
  });

  test("clears retained windows when structured usage says limits are unavailable", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => ({
        rate_limits_available: false,
        rate_limits: null,
      }));

    const { events, stop } = captureEvents();
    let session;
    try {
      ({ session } = await runPromptWithMessages([
        sparseFiveHourEvent,
        successfulUsageResult,
      ]));
    } finally {
      stop();
    }

    expect(session.rateLimits).toEqual([]);
    expect(session.usage?.rateLimits).toEqual([]);
    expect(events).toContainEqual({
      type: "session.updated",
      sessionId: session.id,
      data: {
        contextUsage: session.usage,
        rateLimits: [],
      },
    });
  });

  test("treats an empty structured limits object as an authoritative empty snapshot", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => ({
        rate_limits_available: true,
        rate_limits: {},
      }));

    const { session } = await runPromptWithMessages([
      sparseFiveHourEvent,
      successfulUsageResult,
    ]);

    expect(session.rateLimits).toEqual([]);
    expect(session.usage?.rateLimits).toEqual([]);
  });

  test("preserves sparse windows when the structured request rejects", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => {
        throw new Error("experimental request failed");
      });

    const { session } = await runPromptWithMessages([
      sparseFiveHourEvent,
      successfulUsageResult,
    ]);

    expect(session.status).toBe("idle");
    expect(session.rateLimits).toEqual([
      {
        label: "Five Hour",
        usedPercent: 42,
        resetsAt: "2026-07-28T22:30:00.000Z",
      },
    ]);
    expect(session.usage?.rateLimits).toEqual(session.rateLimits);
  });

  test("times out a non-settling structured request without blocking turn completion", async () => {
    const getStructuredUsage = mock(() => new Promise<unknown>(() => {}));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;

    const startedAt = Date.now();
    const { session } = await runPromptWithMessages([
      sparseFiveHourEvent,
      successfulUsageResult,
    ]);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      STRUCTURED_USAGE_REQUEST_TIMEOUT_MS - 50,
    );
    expect(Date.now() - startedAt).toBeLessThan(
      STRUCTURED_USAGE_REQUEST_TIMEOUT_MS + 1_000,
    );
    expect(session.status).toBe("idle");
    expect(session.rateLimits?.[0]).toMatchObject({
      label: "Five Hour",
      usedPercent: 42,
    });
    // The SDK has no cancellation primitive for get_usage. Once this turn's
    // first request times out, event and result triggers must not accumulate
    // more unresolved control requests.
    expect(getStructuredUsage).toHaveBeenCalledTimes(1);
  });

  test("preserves sparse windows for malformed structured responses", async () => {
    const malformedResponses = [
      null,
      [],
      {},
      { rate_limits_available: true, rate_limits: null },
      { rate_limits_available: false, rate_limits: {} },
      { rate_limits_available: true, rate_limits: [] },
      { rate_limits: {} },
      { rate_limits_available: "yes", rate_limits: {} },
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 101, resets_at: "not-a-date" },
        },
      },
      {
        rate_limits_available: true,
        rate_limits: { model_scoped: ["not-a-window"] },
      },
    ];
    for (const response of malformedResponses) {
      queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
        mock(async () => response);
      const { session } = await runPromptWithMessages([
        sparseFiveHourEvent,
        successfulUsageResult,
      ]);
      expect(session.rateLimits).toEqual([
        {
          label: "Five Hour",
          usedPercent: 42,
          resetsAt: "2026-07-28T22:30:00.000Z",
        },
      ]);
    }
  });

  test("validates utilization and reset fields independently", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 25,
            resets_at: "not-a-date",
          },
          seven_day: {
            utilization: Number.NaN,
            resets_at: "2026-08-04T10:00:00Z",
          },
          seven_day_oauth_apps: {
            utilization: -1,
            resets_at: "also-not-a-date",
          },
          seven_day_opus: {
            utilization: 101,
          },
          seven_day_sonnet: {
            utilization: Number.POSITIVE_INFINITY,
          },
        },
      }));

    const { session } = await runPromptWithMessages([successfulUsageResult]);

    expect(session.rateLimits).toEqual([
      {
        label: "Five Hour",
        usedPercent: 25,
      },
      {
        label: "Weekly",
        resetsAt: "2026-08-04T10:00:00.000Z",
      },
    ]);
  });

  test("parses every fixed key and removes fixed/model-scoped label collisions", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      mock(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 1 },
          seven_day: { utilization: 2 },
          seven_day_oauth_apps: { utilization: 3 },
          seven_day_opus: { utilization: 4 },
          seven_day_sonnet: { utilization: 5 },
          model_scoped: [
            { display_name: "Opus", utilization: 44 },
            { display_name: "opus", utilization: 45 },
            { display_name: "Fable", utilization: 6 },
            { display_name: "Fable", utilization: 7 },
          ],
        },
      }));

    const { session } = await runPromptWithMessages([successfulUsageResult]);

    expect(session.rateLimits).toEqual([
      { label: "Five Hour", usedPercent: 1 },
      { label: "Weekly", usedPercent: 2 },
      { label: "Weekly (OAuth Apps)", usedPercent: 3 },
      { label: "Weekly (Opus)", usedPercent: 4 },
      { label: "Weekly (Sonnet)", usedPercent: 5 },
      { label: "Weekly (Fable)", usedPercent: 6 },
    ]);
  });

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
