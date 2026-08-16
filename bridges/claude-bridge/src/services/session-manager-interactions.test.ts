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
// AskUserQuestion flow via canUseTool
// ---------------------------------------------------------------------------

describe("AskUserQuestion flow", () => {
  test("pins AskUserQuestion as parked in canUseTool under bypassPermissions", async () => {
    const session = createSession("question-flow");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "ask me", {
      permissionMode: "bypassPermissions",
    });
    const call = await nextQueryCall();

    expect(typeof call.options.canUseTool).toBe("function");
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);

    const requestedAt = Date.now();
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
    expect(pending?.expiresAt).toBeGreaterThanOrEqual(requestedAt + 5 * 60 * 1000);
    expect(pending?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

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

  test("logs question settlement metadata without answer content", async () => {
    const session = createSession("question-log-redaction");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask privately");
    const call = await nextQueryCall();
    const canUseToolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Private question", header: "Private", options: [] }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [pending] = getPendingQuestions(session.id);
    const privateAnswer = "private-answer-that-must-not-be-logged";
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(answerQuestion(pending!.id, { "Private question": privateAnswer })).toBe(true);
      await expect(canUseToolPromise).resolves.toMatchObject({ behavior: "allow" });

      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(privateAnswer);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Answering question",
        { requestId: pending!.id, answerCount: 1 },
      ]);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Received question answers",
        { questionId: pending!.id, answerCount: 1 },
      ]);
    } finally {
      logSpy.mockRestore();
    }

    call.finish();
    await promptPromise;
  });

  test("denies duplicate question text instead of overwriting one answer", async () => {
    const session = createSession("duplicate-question-text");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask twice");
    const call = await nextQueryCall();

    await expect(call.options.canUseTool!("AskUserQuestion", {
      questions: [
        { question: "Same question?", header: "First", options: [] },
        { question: "Same question?", header: "Second", options: [] },
      ],
    })).resolves.toEqual({
      behavior: "deny",
      message:
        "AskUserQuestion contains duplicate question text. Ask the questions again with distinct wording.",
    });
    expect(getPendingQuestions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
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

      const requestedAt = Date.now();
      const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
      const [approval] = getPendingPlanApprovals(session.id);
      expect(approval?.sessionId).toBe(session.id);
      expect(approval?.expiresAt).toBeGreaterThanOrEqual(requestedAt + 5 * 60 * 1000);
      expect(approval?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

      expect(respondToPlanApproval(approval!.id, true)).toBe(true);

      const result = (await canUseToolPromise) as { behavior: string };
      expect(result.behavior).toBe("allow");
      expect(session.planMode).toBe(false);
      expect(await readSessionPreferences(
        session.id.slice("session-".length),
      )).toMatchObject({ planMode: false });

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
    const originalTurnStartedAt = session.turnStartedAt;
    expect(typeof originalTurnStartedAt).toBe("string");

    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    const privateFeedback = "needs more detail";
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    let result: { behavior: string; message?: string };
    try {
      expect(respondToPlanApproval(approval!.id, false, privateFeedback)).toBe(true);
      result = (await canUseToolPromise) as { behavior: string; message?: string };

      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(privateFeedback);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Responding to plan approval",
        {
          requestId: approval!.id,
          approved: false,
          hasFeedback: true,
        },
      ]);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Plan approval result",
        {
          approvalId: approval!.id,
          approved: false,
          hasFeedback: true,
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain(privateFeedback);

    // Finish the original turn. session-manager will then re-prompt with the
    // captured rejection feedback - serve a quick success for that re-prompt.
    call.finish();

    const repromptCall = await nextQueryCall();
    expect(session.turnStartedAt).toBe(originalTurnStartedAt);
    repromptCall.push({ type: "system", subtype: "init", session_id: "sdk-reprompt", mcp_servers: [] });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    expect(getSession(session.id)?.status).toBe("idle");
    expect(getSession(session.id)?.turnStartedAt).toBeUndefined();
  });

  test("rejecting a plan without feedback denies it and requests a generic revision", async () => {
    const session = createSession("plan-reject-without-feedback");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    expect(respondToPlanApproval(approval!.id, false)).toBe(true);
    await expect(toolPromise).resolves.toEqual({
      behavior: "deny",
      message: "User rejected the plan. No specific feedback was provided. Please revise your approach based on this feedback.",
    });
    call.finish();

    const repromptCall = await nextQueryCall();
    expect(repromptCall.options.permissionMode).toBe("plan");
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();
    await promptPromise;

    const sdkMessages = await readSdkPrompt(repromptCall) as Array<{
      message: { role: string; content: Array<{ type: string; text: string }> };
    }>;
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0]?.message.role).toBe("user");
    expect(sdkMessages[0]?.message.content[0]?.text).toContain(
      "I don't approve it as-is. Please revise your approach.",
    );
    expect(getPendingPlanApprovals(session.id)).toEqual([]);
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

  test("abort and query failures release pending plan approvals", async () => {
    const abortedSession = createSession("plan-abort");
    track(abortedSession.id);
    const abortedPrompt = sendPrompt(abortedSession.id, "plan", { permissionMode: "plan" });
    const abortedCall = await nextQueryCall();
    const abortedTool = abortedCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(abortedSession.id).length === 1);

    expect(abortSession(abortedSession.id)).toBe(true);
    await expect(abortedTool).resolves.toEqual({
      behavior: "deny",
      message: "Session terminated",
    });
    expect(getPendingPlanApprovals(abortedSession.id)).toEqual([]);
    await abortedPrompt;

    const failedSession = createSession("plan-query-failure");
    track(failedSession.id);
    const failedPrompt = sendPrompt(failedSession.id, "plan", { permissionMode: "plan" });
    const failedCall = await nextQueryCall();
    const failedTool = failedCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(failedSession.id).length === 1);

    failedCall.fail(new Error("query failed"));
    await expect(failedPrompt).rejects.toThrow("query failed");
    await expect(failedTool).resolves.toEqual({
      behavior: "deny",
      message: "Session terminated",
    });
    expect(getPendingPlanApprovals(failedSession.id)).toEqual([]);
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
      expect(session.planMode).toBe(true);
      expect(await readSessionPreferences(
        session.id.slice("session-".length),
      )).toMatchObject({ planMode: true });
      call.finish();
      await promptPromise;
      expect(events.some((event) => event.type === "plan.enter-requested")).toBe(true);
    } finally {
      stop();
    }
  });

  test("denies EnterPlanMode when its durable preference cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-enter-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("enter-plan-failure");
      track(session.id);
      const { events, stop } = captureEvents();
      try {
        const promptPromise = sendPrompt(session.id, "tools", {
          permissionMode: "default",
        });
        const call = await nextQueryCall();
        await writeFile(join(directory, ".claude"), "not a directory", "utf-8");

        const result = await call.options.canUseTool!(
          "EnterPlanMode",
          { reason: "plan" },
        );
        expect(result.behavior).toBe("deny");
        expect(result.message).toContain("could not be persisted safely");
        expect(session.planMode).toBeUndefined();
        expect(events.some((event) => event.type === "plan.enter-requested")).toBe(false);

        call.finish();
        await promptPromise;
      } finally {
        stop();
      }
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps plan mode enabled when an approved exit cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-exit-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("exit-plan-failure");
      track(session.id);
      session.planMode = true;
      const { events, stop } = captureEvents();
      try {
        const promptPromise = sendPrompt(session.id, "tools", {
          permissionMode: "default",
        });
        const call = await nextQueryCall();
        const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
        await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
        await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
        const approval = getPendingPlanApprovals(session.id)[0];
        expect(respondToPlanApproval(approval.id, true)).toBe(true);

        const result = await toolPromise;
        expect(result.behavior).toBe("deny");
        expect(result.message).toContain("could not be exited safely");
        expect(session.planMode).toBe(true);
        expect(events.some((event) => event.type === "plan.exit-requested")).toBe(false);

        call.finish();
        await promptPromise;
      } finally {
        stop();
      }
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
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
