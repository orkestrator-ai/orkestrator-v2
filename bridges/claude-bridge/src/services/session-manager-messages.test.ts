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
      // JSON preserves null, so it is the explicit wire-level clear signal.
      expect(cleared).toBeDefined();
      expect((cleared?.data as { promptSuggestion?: string | null }).promptSuggestion).toBeNull();

      secondCall.finish();
      await second;
    } finally {
      stop();
    }

    expect(getSession(session.id)?.promptSuggestion).toBeUndefined();
  });
});
