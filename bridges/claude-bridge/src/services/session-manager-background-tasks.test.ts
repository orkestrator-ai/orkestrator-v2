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



describe("background task reducer", () => {
  test("drops unresolved Bash candidates past the bound without failing the turn", async () => {
    const created = createSession("bounded Bash candidates");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run too many commands");
    const call = await nextQueryCall();
    call.push({
      type: "assistant",
      message: {
        id: "assistant-background-before-the-bound",
        content: [{
          type: "tool_use",
          id: "bash-real-background",
          name: "Bash",
          input: { command: "bun run test", run_in_background: true },
        }],
      },
    });
    call.push({
      type: "assistant",
      message: {
        id: "assistant-too-many-bash-candidates",
        content: Array.from({ length: 129 }, (_, index) => ({
          type: "tool_use",
          id: `bash-candidate-${index}`,
          name: "Bash",
          input: { command: `printf ${index}` },
        })),
      },
    });

    await waitFor(() => created.backgroundTaskCandidates?.size === 128);
    // The bound sheds the overflow only: everything up to it stays tracked and
    // the already-running background task is untouched.
    expect(created.backgroundTaskCandidates?.has("bash-candidate-127")).toBe(true);
    expect(created.backgroundTaskCandidates?.has("bash-candidate-128")).toBe(false);
    expect(created.backgroundTasks?.["pending-bash:bash-real-background"]).toMatchObject({
      status: "running",
    });

    call.finish();
    await promptPromise;
    expect(created.backgroundTaskCandidates).toBeUndefined();
  });

  test("lets a background notification resume before closing the completed turn", async () => {
    const created = createSession("held input");
    track(created.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "delegate the review");
    const call = await nextQueryCall();
    try {
      expect(typeof call.prompt).not.toBe("string");
      const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      const firstInput = await input.next();
      expect(firstInput.done).toBe(false);
      if (firstInput.done) throw new Error("Held prompt closed before sending its user message");
      expect(firstInput.value.message.content).toEqual([
        { type: "text", text: "delegate the review" },
      ]);

      let inputClosed = false;
      const inputCompletion = input.next().then((result) => {
        inputClosed = result.done === true;
        return result;
      });

      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        description: "Review the bridge",
      });
      call.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "claude-mock": {
            inputTokens: 1,
            outputTokens: 1,
            contextWindow: 200_000,
          },
        },
      });
      await waitFor(
        () =>
          getSession(created.id)?.backgroundTasks?.["agent-1"]?.status === "running"
          && getSession(created.id)?.usage !== undefined,
      );

      expect(inputClosed).toBe(false);
      expect(getSession(created.id)?.status).toBe("idle");
      expect(getSession(created.id)?.completionBlockedByBackgroundTasks).toBe(false);

      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        status: "completed",
        summary: "Review complete",
      });
      await waitFor(
        () => getSession(created.id)?.backgroundTasks?.["agent-1"]?.status === "completed",
      );
      expect(call.isClosed()).toBe(false);
      expect(inputClosed).toBe(false);
      expect(getSession(created.id)?.status).toBe("idle");

      // Claude Code injects the notification into the root loop. The first
      // assistant frame proves the released query resumed and must reclaim the
      // foreground until its own result arrives.
      call.push({
        type: "assistant",
        message: {
          id: "assistant-after-background-notification",
          role: "assistant",
          content: [{ type: "text", text: "The review is complete." }],
          stop_reason: "end_turn",
        },
        parent_tool_use_id: null,
      });
      await waitFor(() => getSession(created.id)?.status === "running");
      expect(getSession(created.id)?.turnStartedAt).toBeDefined();
      expect(inputClosed).toBe(false);

      call.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 2, output_tokens: 2 },
        modelUsage: {
          "claude-mock": {
            inputTokens: 2,
            outputTokens: 2,
            contextWindow: 200_000,
          },
        },
      });
      await waitFor(() => inputClosed);
      expect(await inputCompletion).toEqual({ done: true, value: undefined });
      expect(getSession(created.id)?.completionBlockedByBackgroundTasks).toBe(false);
      expect(events.flatMap((event) => {
        const data = event.data as { completionBlockedByBackgroundTasks?: boolean };
        return typeof data.completionBlockedByBackgroundTasks === "boolean"
          ? [data.completionBlockedByBackgroundTasks]
          : [];
      })).toEqual([false, false, false]);
      expect(getSession(created.id)?.status).toBe("running");

      call.finish();
      await promptPromise;
      expect(getSession(created.id)?.status).toBe("idle");
    } finally {
      stop();
    }
  });

  test("can release again when a resumed root turn launches another background task", async () => {
    const created = createSession("repeated background releases");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "delegate twice");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-cycle-one",
      description: "First delegated task",
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-cycle-one",
      status: "completed",
    });
    call.push({
      type: "assistant",
      message: {
        id: "assistant-cycle-two",
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "bash-cycle-two",
          name: "Bash",
          input: {
            command: "bun run build",
            description: "Second background task",
            run_in_background: true,
          },
        }],
        stop_reason: "tool_use",
      },
      parent_tool_use_id: null,
    });
    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-cycle-two",
      tool_use_id: "bash-cycle-two",
      description: "Second background task",
    });
    await waitFor(() => created.status === "running");
    call.push({ type: "result", subtype: "success" });

    await waitFor(
      () =>
        created.status === "idle"
        && created.backgroundTasks?.["task-cycle-two"]?.status === "running",
    );
    expect(created.abortController).toBeUndefined();
    expect(inputClosed).toBe(false);
    expect(call.isClosed()).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "task-cycle-two",
      tool_use_id: "bash-cycle-two",
      status: "completed",
    });
    expect(call.isClosed()).toBe(false);
    call.push({
      type: "assistant",
      message: {
        id: "assistant-cycle-final",
        role: "assistant",
        content: [{ type: "text", text: "Both tasks are complete." }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: null,
    });
    await waitFor(() => created.status === "running");
    call.push({ type: "result", subtype: "success" });

    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
    expect(created.status).toBe("idle");
    expect(created.backgroundTasks?.["task-cycle-two"]?.status).toBe("completed");
  });

  test("deleting the session closes a query retained for a continuation", async () => {
    const created = createSession("delete while retained");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "delegate then delete");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-delete",
      description: "Long review",
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-delete",
      status: "completed",
    });
    // The retained window: the continuation has not arrived, so the query is
    // deliberately still alive and no longer owns a live background task.
    await waitFor(() => created.backgroundTasks?.["agent-delete"]?.status === "completed");
    expect(call.isClosed()).toBe(false);
    expect(created.abortController).toBeUndefined();

    // Deletion is the point at which the user has said the work should stop.
    // The retained control must still be reachable, or the CLI would keep
    // writing to a rollout that has just been removed underneath it.
    expect(await deleteSessionDurably(created.id)).toBe(true);
    await waitFor(() => call.isClosed());
    await promptPromise;
  });

  test("closes a retained query when no continuation follows the notification", async () => {
    const created = createSession("continuation never arrives");
    track(created.id);
    const promptPromise = sendPrompt(
      created.id,
      "delegate to a silent provider",
      undefined,
      { retainedContinuationTimeoutMs: 25 },
    );
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-silent",
      description: "Silent task",
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-silent",
      status: "completed",
    });
    await waitFor(() => created.backgroundTasks?.["agent-silent"]?.status === "completed");
    expect(inputClosed).toBe(false);

    // Nothing further arrives. The watchdog must close the held input and the
    // retained control rather than strand the CLI child for the bridge's life.
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    await waitFor(() => call.isClosed());
    await promptPromise;
    expect(created.status).toBe("idle");
  });

  test("does not let the continuation watchdog close input while a sibling task runs", async () => {
    const created = createSession("sibling task still running");
    track(created.id);
    const promptPromise = sendPrompt(
      created.id,
      "delegate twice",
      undefined,
      { retainedContinuationTimeoutMs: 25 },
    );
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    for (const taskId of ["agent-sibling-one", "agent-sibling-two"]) {
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: taskId,
      });
    }
    call.push({ type: "result", subtype: "success" });
    await waitFor(
      () =>
        created.status === "idle"
        && created.backgroundTasks?.["agent-sibling-two"]?.status === "running",
    );

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-sibling-one",
      status: "completed",
    });
    await waitFor(
      () => created.backgroundTasks?.["agent-sibling-one"]?.status === "completed",
    );

    // The watchdog bounds a *silent* retained query. The second task is still
    // running, so closing stdin here would kill work the user is waiting on.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(inputClosed).toBe(false);
    expect(call.isClosed()).toBe(false);
    expect(created.backgroundTasks?.["agent-sibling-two"]?.status).toBe("running");

    // Once the last task settles with no continuation, the bound does apply.
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-sibling-two",
      status: "completed",
    });
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    await waitFor(() => call.isClosed());
    await promptPromise;
  });

  test("does not let an older released turn reclaim the foreground from a newer one", async () => {
    const created = createSession("two released turns");
    track(created.id);
    const firstPrompt = sendPrompt(created.id, "delegate first");
    const firstCall = await nextQueryCall();
    const firstInput =
      (firstCall.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await firstInput.next()).done).toBe(false);

    firstCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-older",
      description: "Older task",
    });
    firstCall.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    firstCall.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-older",
      status: "completed",
    });
    await waitFor(() => created.backgroundTasks?.["agent-older"]?.status === "completed");

    // Releasing exists so a follow-up turn can start while the older CLI lives.
    const secondPrompt = sendPrompt(created.id, "delegate second");
    const secondCall = await nextQueryCall();
    const secondInput =
      (secondCall.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await secondInput.next()).done).toBe(false);
    secondCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-newer",
      description: "Newer task",
    });
    secondCall.push({ type: "result", subtype: "success" });
    await waitFor(
      () =>
        created.status === "idle"
        && created.backgroundTasks?.["agent-newer"]?.status === "running",
    );

    // The older query resumes. It must not publish `running` or take abort
    // ownership: stop would then reach the wrong CLI, and the newer turn could
    // never reclaim its own foreground.
    firstCall.push({
      type: "assistant",
      message: {
        id: "assistant-older-continuation",
        role: "assistant",
        content: [{ type: "text", text: "The older task finished." }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(created.status).toBe("idle");
    expect(created.abortController).toBeUndefined();

    // The newest turn still can.
    secondCall.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-newer",
      status: "completed",
    });
    secondCall.push({
      type: "assistant",
      message: {
        id: "assistant-newer-continuation",
        role: "assistant",
        content: [{ type: "text", text: "The newer task finished too." }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: null,
    });
    await waitFor(() => created.status === "running");
    expect(created.abortController).toBeDefined();

    firstCall.push({ type: "result", subtype: "success" });
    firstCall.finish();
    await firstPrompt;
    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await secondPrompt;
    expect(created.status).toBe("idle");
  });

  test("does not let an aborted result handler reassert a hold or clobber a restart", async () => {
    let resolveUsage!: (value: unknown) => void;
    let usageRequestStarted = false;
    queryControlOverrides.getContextUsage = mock(() => {
      usageRequestStarted = true;
      return new Promise<unknown>((resolve) => {
        resolveUsage = resolve;
      });
    });

    const created = createSession("abort held result");
    track(created.id);
    const { events, stop } = captureEvents();
    const firstPrompt = sendPrompt(created.id, "delegate then abort");
    const firstCall = await nextQueryCall();
    try {
      firstCall.push({
        type: "system",
        subtype: "task_started",
        task_id: "agent-aborted",
        description: "Wait for usage",
      });
      firstCall.push({
        type: "result",
        subtype: "success",
        modelUsage: {
          "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
        },
      });
      await waitFor(() => usageRequestStarted);

      expect(abortSession(created.id)).toBe(true);
      delete queryControlOverrides.getContextUsage;
      const secondPrompt = sendPrompt(created.id, "restart immediately");
      const secondCall = await nextQueryCall();

      resolveUsage({ totalTokens: 2, maxTokens: 200_000, percentage: 0.001 });
      await firstPrompt;

      expect(getSession(created.id)?.status).toBe("running");
      expect(getSession(created.id)?.abortController).toBe(secondCall.options.abortController);
      expect(getSession(created.id)?.completionBlockedByBackgroundTasks).toBe(false);
      const abortedIdleIndex = events.findIndex((event) =>
        event.type === "session.idle"
        && (event.data as { aborted?: boolean }).aborted === true
      );
      expect(abortedIdleIndex).toBeGreaterThanOrEqual(0);
      expect(events.slice(abortedIdleIndex + 1).some((event) =>
        (event.data as { completionBlockedByBackgroundTasks?: boolean })
          .completionBlockedByBackgroundTasks === true
      )).toBe(false);

      secondCall.push({ type: "result", subtype: "success" });
      secondCall.finish();
      await secondPrompt;
      expect(getSession(created.id)?.status).toBe("idle");
      expect(getSession(created.id)?.completionBlockedByBackgroundTasks).toBe(false);
    } finally {
      stop();
    }
  });

  test("keeps the retained input open when a later turn takes ownership", async () => {
    let resolveUsage!: (value: unknown) => void;
    let usageRequestStarted = false;
    queryControlOverrides.getContextUsage = mock(() => {
      usageRequestStarted = true;
      return new Promise<unknown>((resolve) => {
        resolveUsage = resolve;
      });
    });

    const created = createSession("superseded held input");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "delegate then supersede");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    const inputCompletion = input.next();

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-superseded",
      description: "Wait for usage",
    });
    call.push({
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
      },
    });
    await waitFor(() => usageRequestStarted);

    const staleSettlement = created.finishTurnInputIfSettled;
    expect(staleSettlement).toBeFunction();
    const replacementController = new AbortController();
    created.abortController = replacementController;
    staleSettlement!();

    let inputClosed = false;
    void inputCompletion.then(() => {
      inputClosed = true;
    });
    await Bun.sleep(0);
    expect(inputClosed).toBe(false);
    expect(created.completionBlockedByBackgroundTasks).toBe(false);
    resolveUsage({ totalTokens: 2, maxTokens: 200_000, percentage: 0.001 });
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-superseded",
      status: "completed",
    });
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
    expect(created.abortController).toBe(replacementController);

    // Restore the artificial replacement ownership used to exercise the stale
    // callback branch; normal restart cleanup belongs to the replacement turn.
    created.abortController = undefined;
    created.status = "idle";
  });

  test("deleting a session closes its retained background runtime", async () => {
    const created = createSession("delete retained background runtime");
    track(created.id);
    const { stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "delegate then abort");
    const call = await nextQueryCall();
    try {
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "agent-abort-held",
        description: "Keep the turn open",
      });
      call.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
        },
      });
      await waitFor(() => created.status === "idle");

      expect(deleteSession(created.id)).toBe(true);
      call.finish();
      await promptPromise;
      expect(getSession(created.id)).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("settles retained tasks when their provider stream fails", async () => {
    const created = createSession("failed held result");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "delegate then fail");
    const call = await nextQueryCall();

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-failed",
      description: "Fail after result",
    });
    call.push({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
      },
    });
    await waitFor(() => getSession(created.id)?.status === "idle");

    call.fail(new Error("provider stream disconnected"));
    await expect(promptPromise).rejects.toThrow("provider stream disconnected");
    expect(getSession(created.id)?.status).toBe("idle");
    expect(getSession(created.id)?.completionBlockedByBackgroundTasks).toBe(false);
    expect(getSession(created.id)?.backgroundTasks?.["agent-failed"]?.status).toBe("killed");
  });

  test("clears unresolved Bash candidates and settles live tasks when the stream dies", async () => {
    const created = createSession("stream death with a pending candidate");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "background one command and run another");
    const call = await nextQueryCall();

    call.push({
      type: "assistant",
      message: {
        id: "assistant-candidate-and-task",
        content: [
          {
            type: "tool_use",
            id: "dying-background",
            name: "Bash",
            input: { command: "bun run test", run_in_background: true },
          },
          {
            type: "tool_use",
            id: "dying-candidate",
            name: "Bash",
            input: { command: "echo still running" },
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    // One live provisional task and one still-unresolved candidate, both owned
    // by the query that is about to die.
    expect(created.backgroundTasks?.["pending-bash:dying-background"]?.status).toBe("running");
    expect(created.backgroundTaskCandidates?.has("dying-candidate")).toBe(true);

    call.fail(new Error("provider stream disconnected"));
    await expect(promptPromise).rejects.toThrow("provider stream disconnected");

    // A handle that can only fail must not be retained: the candidate is
    // dropped and the task it owned is settled rather than wedged at running.
    expect(created.backgroundTaskCandidates).toBeUndefined();
    expect(created.backgroundTasks?.["pending-bash:dying-background"]).toMatchObject({
      status: "killed",
      error: "The Claude session that owned this task ended before it reported a result",
    });
    expect(created.backgroundTaskControls).toBeUndefined();
  });

  test("keeps streaming input open when a Bash launch precedes delayed lifecycle events", async () => {
    const created = createSession("structured background launch");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run the suite in the background");
    const call = await nextQueryCall();

    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-background-bash",
        content: [{
          type: "tool_use",
          id: "bash-tool-1",
          name: "Bash",
          input: {
            command: "bun run test",
            description: "Run the full test suite",
            run_in_background: true,
          },
        }],
      },
    });
    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-tool-1",
          content: "Command running in background with ID: bash-task-1",
        }],
      },
      parent_tool_use_id: null,
      tool_use_result: {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: "bash-task-1",
      },
    });
    // The real incident delivered the result before task_started. The
    // structured Bash result must already make the task live, otherwise this
    // result closes stdin and the CLI sends SIGTERM to the test process.
    call.push({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "claude-mock": {
          inputTokens: 1,
          outputTokens: 1,
          contextWindow: 200_000,
        },
      },
    });
    await waitFor(
      () =>
        getSession(created.id)?.backgroundTasks?.["bash-task-1"]?.status === "running"
        && getSession(created.id)?.usage !== undefined,
    );

    expect(getSession(created.id)?.backgroundTasks?.["bash-task-1"]).toMatchObject({
      toolUseId: "bash-tool-1",
      description: "Run the full test suite",
      status: "running",
      isBackgrounded: true,
    });
    expect(inputClosed).toBe(false);
    expect(getSession(created.id)?.status).toBe("idle");

    // A late level edge enriches/reconciles the provisional launch without
    // closing the turn or losing correlation.
    call.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{
        task_id: "bash-task-1",
        task_type: "bash",
        description: "Run the full test suite",
      }],
    });
    await waitFor(
      () => getSession(created.id)?.backgroundTasks?.["bash-task-1"]?.status === "running",
    );
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "bash-task-1",
      tool_use_id: "bash-tool-1",
      status: "completed",
      summary: "Tests passed",
    });
    pushSuccessfulContinuationResult(call);
    await waitFor(() => inputClosed);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });

    call.finish();
    await promptPromise;
    expect(getSession(created.id)?.status).toBe("idle");
    expect(getSession(created.id)?.backgroundTasks?.["bash-task-1"]?.status).toBe(
      "completed",
    );
  });

  /**
   * The SDK documents the level signal as preceding the edge bookend ("in
   * practice the level precedes them"), so the empty `background_tasks_changed`
   * lands while the released turn still owes its "I'll report back" reply.
   * Treating it as permission to tear down closed the CLI and stdin, and the
   * `task_notification` that would have resumed the model was delivered to a
   * dead process.
   */
  async function releaseTurnHoldingOneBackgroundTask(title: string) {
    const created = createSession(title);
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run the suite in the background");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    const closedState = { inputClosed: false };
    void input.next().then((result) => {
      closedState.inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-level-first",
        content: [{
          type: "tool_use",
          id: "bash-tool-lf",
          name: "Bash",
          input: { command: "bun run test", run_in_background: true },
        }],
      },
    });
    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-tool-lf",
          content: "Command running in background with ID: bash-task-lf",
        }],
      },
      parent_tool_use_id: null,
      tool_use_result: { backgroundTaskId: "bash-task-lf" },
    });
    call.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{
        task_id: "bash-task-lf",
        task_type: "bash",
        description: "Run the full test suite",
      }],
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => getSession(created.id)?.status === "idle");
    expect(closedState.inputClosed).toBe(false);
    expect(call.isClosed()).toBe(false);
    return { created, call, promptPromise, closedState };
  }

  test("an empty level signal before the edge keeps the CLI alive for the continuation", async () => {
    const { created, call, promptPromise, closedState } =
      await releaseTurnHoldingOneBackgroundTask("level before edge");

    call.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    await waitFor(
      () => getSession(created.id)?.backgroundTasks?.["bash-task-lf"] === undefined,
    );

    // Liveness is honest: the task is out of the live set, so no stale running
    // indicator can wedge. But the continuation has not arrived, so neither the
    // CLI nor its stdin may be torn down.
    expect(closedState.inputClosed).toBe(false);
    expect(call.isClosed()).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "bash-task-lf",
      tool_use_id: "bash-tool-lf",
      status: "completed",
      summary: "Tests passed",
    });
    call.push({
      type: "assistant",
      message: {
        id: "assistant-level-first-continuation",
        content: [{ type: "text", text: "The suite finished; here is the report." }],
      },
    });

    // The resumed root loop reclaims the foreground so the UI shows the report
    // being written rather than a session that silently stayed idle.
    await waitFor(() => getSession(created.id)?.status === "running");

    // The edge settles the task the level had already dropped, and the parked
    // snapshot supplies the description the edge itself never carries.
    expect(getSession(created.id)?.backgroundTasks?.["bash-task-lf"]).toMatchObject({
      status: "completed",
      description: "Run the full test suite",
      toolUseId: "bash-tool-lf",
    });

    // Closing held input ends the stream, which is what publishes the real idle
    // edge for the reclaimed turn.
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => closedState.inputClosed);
    call.finish();
    await promptPromise;
    expect(getSession(created.id)?.status).toBe("idle");
    expect(
      getSession(created.id)?.messages.some((message) =>
        message.parts.some((part) =>
          part.type === "text" && part.content.includes("here is the report")
        )
      ),
    ).toBe(true);
  });

  test("the continuation watchdog still releases a query parked by a level signal", async () => {
    const created = createSession("level before edge, no continuation");
    track(created.id);
    const promptPromise = sendPrompt(
      created.id,
      "run the suite in the background",
      undefined,
      { retainedContinuationTimeoutMs: 25 },
    );
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    const inputCompletion = input.next();

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-parked",
      description: "Parked task",
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    call.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    await waitFor(() => created.settlingBackgroundTasks !== undefined);

    // The edge never arrives. The watchdog must release the held input, the
    // retained control and the parked snapshot rather than strand the CLI child
    // and its metadata for the lifetime of the bridge.
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    await waitFor(() => created.settlingBackgroundTasks === undefined);
    expect(created.retainedQueryControls).toBeUndefined();
    call.finish();
    await promptPromise;
  });

  test("a level signal mid-turn does not park or retain anything", async () => {
    const created = createSession("level while still running");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run work in the background");
    const call = await nextQueryCall();

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "agent-midturn",
      description: "Mid-turn task",
    });
    await waitFor(() => created.backgroundTasks?.["agent-midturn"]?.status === "running");

    // No result has been published, so the turn was never released: the query
    // still owns the foreground and needs no continuation bookkeeping.
    call.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    await waitFor(() => created.backgroundTasks?.["agent-midturn"] === undefined);
    expect(created.settlingBackgroundTasks).toBeUndefined();
    expect(created.retainedQueryControls).toBeUndefined();
    expect(call.isClosed()).toBe(false);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    expect(created.status).toBe("idle");
  });

  test("holds from Bash intent before result and recovers an omitted structured task id", async () => {
    const created = createSession("provisional background launch");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "start the suite in the background");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-provisional-bash",
        content: [{
          type: "tool_use",
          id: "bash-tool-provisional",
          name: "Bash",
          input: {
            command: "bun run test",
            description: "Run tests provisionally",
            run_in_background: true,
          },
        }],
      },
    });
    call.push({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
      },
    });
    await waitFor(() => getSession(created.id)?.status === "idle");

    expect(inputClosed).toBe(false);
    expect(
      getSession(created.id)?.backgroundTasks?.["pending-bash:bash-tool-provisional"],
    ).toMatchObject({
      toolUseId: "bash-tool-provisional",
      status: "running",
    });

    // The live CLI has occasionally omitted SDKUserMessage.tool_use_result.
    // Exact built-in Bash correlation makes its provider result label a safe
    // fallback and replaces the provisional id without a liveness gap.
    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-tool-provisional",
          content: "Command running in background with ID: bash-task-fallback",
        }],
      },
      parent_tool_use_id: null,
    });
    await waitFor(() =>
      getSession(created.id)?.backgroundTasks?.["bash-task-fallback"]?.status === "running"
    );
    expect(
      getSession(created.id)?.backgroundTasks?.["pending-bash:bash-tool-provisional"],
    ).toBeUndefined();
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "bash-task-fallback",
      tool_use_id: "bash-tool-provisional",
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
  });

  test("fails and releases a provisional Bash task when its correlated result fails", async () => {
    const created = createSession("failed provisional background launch");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "start background work");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-failed-provisional",
        content: [{
          type: "tool_use",
          id: "bash-failed-provisional",
          name: "Bash",
          input: { command: "bun run test", run_in_background: true },
        }],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    expect(inputClosed).toBe(false);

    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-failed-provisional",
          content: "command failed",
          is_error: true,
        }],
      },
      tool_use_result: { backgroundTaskId: "must-not-launch" },
    });
    await waitFor(() => inputClosed);
    expect(created.backgroundTasks?.["pending-bash:bash-failed-provisional"]).toMatchObject({
      status: "failed",
      error: "The Bash invocation failed before its background task was confirmed",
    });
    expect(created.backgroundTasks?.["must-not-launch"]).toBeUndefined();
    expect(await inputCompletion).toEqual({ done: true, value: undefined });

    call.finish();
    await promptPromise;
  });

  test("rekeys multiple provisional Bash tasks from lifecycle-only evidence", async () => {
    const created = createSession("multiple lifecycle launches");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "start two background commands");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-two-provisionals",
        content: [
          {
            type: "tool_use",
            id: "bash-provisional-one",
            name: "Bash",
            input: {
              command: "bun run test",
              description: "First command",
              run_in_background: true,
            },
          },
          {
            type: "tool_use",
            id: "bash-provisional-two",
            name: "Bash",
            input: {
              command: "bun run build",
              description: "Second command",
              run_in_background: true,
            },
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    expect(Object.keys(created.backgroundTasks ?? {}).sort()).toEqual([
      "pending-bash:bash-provisional-one",
      "pending-bash:bash-provisional-two",
    ]);
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "provider-task-one",
      tool_use_id: "bash-provisional-one",
    });
    await waitFor(() => created.backgroundTasks?.["provider-task-one"] !== undefined);
    expect(created.backgroundTasks?.["pending-bash:bash-provisional-one"]).toBeUndefined();
    expect(created.backgroundTasks?.["provider-task-one"]).toMatchObject({
      toolUseId: "bash-provisional-one",
      description: "First command",
      status: "running",
    });

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "provider-task-two",
      tool_use_id: "bash-provisional-two",
      status: "completed",
    });
    await waitFor(() => created.backgroundTasks?.["provider-task-two"]?.status === "completed");
    expect(created.backgroundTasks?.["pending-bash:bash-provisional-two"]).toBeUndefined();
    expect(created.backgroundTasks?.["provider-task-two"]).toMatchObject({
      toolUseId: "bash-provisional-two",
      description: "Second command",
      status: "completed",
    });
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "provider-task-one",
      tool_use_id: "bash-provisional-one",
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
  });

  test.each(["task_progress", "task_updated"])(
    "rekeys a provisional Bash task when %s is the first lifecycle edge",
    async (subtype) => {
      const { session, finish } = await inspectDuringTurn(
        [
          {
            type: "assistant",
            message: {
              id: `assistant-${subtype}`,
              content: [{
                type: "tool_use",
                id: `tool-${subtype}`,
                name: "Bash",
                input: {
                  command: "bun run test",
                  description: `${subtype} command`,
                  run_in_background: true,
                },
              }],
            },
          },
          {
            type: "system",
            subtype,
            task_id: `task-${subtype}`,
            tool_use_id: `tool-${subtype}`,
            patch: { status: "running" },
          },
        ],
        (state) => state.backgroundTasks?.[`task-${subtype}`] !== undefined,
      );

      expect(session.backgroundTasks?.[`pending-bash:tool-${subtype}`]).toBeUndefined();
      expect(session.backgroundTasks?.[`task-${subtype}`]).toMatchObject({
        toolUseId: `tool-${subtype}`,
        description: `${subtype} command`,
        status: "running",
      });
      await finish();
    },
  );

  test.each([
    [
      "manual structured evidence",
      "Command was manually backgrounded by user with ID: manual-task",
      { backgroundedByUser: true, backgroundTaskId: "manual-task" },
      "manual-task",
    ],
    [
      "the canonical timeout label",
      "Command did not complete within its 120s timeout and was moved to the background (ID: timeout-task). Output is being written.",
      undefined,
      "timeout-task",
    ],
    [
      "array-form text blocks",
      [{ type: "text", text: "Command running in background with ID: array-task" }],
      undefined,
      "array-task",
    ],
    [
      "the alternate task id label",
      "Background task ID: alternate-task",
      undefined,
      "alternate-task",
    ],
  ])("retains a foreground Bash candidate until delayed %s arrives", async (
    _label,
    content,
    toolUseResult,
    taskId,
  ) => {
    const created = createSession(`delayed ${taskId}`);
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run a command");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: `assistant-${taskId}`,
        content: [{
          type: "tool_use",
          id: `tool-${taskId}`,
          name: "Bash",
          input: { command: "bun run test" },
        }],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    expect(created.backgroundTasks).toBeUndefined();
    expect(inputClosed).toBe(false);

    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `tool-${taskId}`,
          content,
        }],
      },
      ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
    });
    await waitFor(() => created.backgroundTasks?.[taskId]?.status === "running");
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: `tool-${taskId}`,
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
  });

  test.each([
    ["manual backgrounding", { backgroundedByUser: true }],
    ["timeout backgrounding", { timedOutAfterMs: 120_000 }],
  ])("retains missing-id %s evidence until lifecycle supplies the id", async (
    _label,
    toolUseResult,
  ) => {
    const created = createSession("missing background task id");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run a command");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-missing-background-id",
        content: [{
          type: "tool_use",
          id: "tool-missing-background-id",
          name: "Bash",
          input: { command: "bun run test" },
        }],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-missing-background-id",
          content: "Backgrounding acknowledged without an id",
        }],
      },
      tool_use_result: toolUseResult,
    });
    await Bun.sleep(0);
    expect(created.backgroundTasks).toBeUndefined();
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "late-lifecycle-task",
      tool_use_id: "tool-missing-background-id",
      description: "Late lifecycle task",
    });
    await waitFor(() => created.backgroundTasks?.["late-lifecycle-task"]?.status === "running");
    expect(inputClosed).toBe(false);
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "late-lifecycle-task",
      tool_use_id: "tool-missing-background-id",
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
  });

  // Parallel tool calls arrive as several tool_result blocks in one user
  // message. Judging the message as a whole discarded the background handoff
  // whenever Claude ran two commands at once, releasing the candidate and
  // closing stdin under the process that had just been backgrounded.
  test("keeps a batched Bash result's background handoff and releases only its sibling", async () => {
    const created = createSession("batched parallel Bash results");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run two commands");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });

    call.push({
      type: "assistant",
      message: {
        id: "assistant-batched-parallel",
        content: [
          {
            type: "tool_use",
            id: "batched-backgrounded",
            name: "Bash",
            input: { command: "bun run test", description: "Slow suite" },
          },
          {
            type: "tool_use",
            id: "batched-foreground",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    expect(created.backgroundTaskCandidates?.size).toBe(2);

    call.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "batched-backgrounded",
            content:
              "Command did not complete within its 120s timeout and was moved to the background (ID: batched-task). Output is being written.",
          },
          { type: "tool_result", tool_use_id: "batched-foreground", content: "hi" },
        ],
      },
    });

    await waitFor(() => created.backgroundTasks?.["batched-task"]?.status === "running");
    expect(created.backgroundTasks?.["batched-task"]).toMatchObject({
      toolUseId: "batched-backgrounded",
      description: "Slow suite",
    });
    // The sibling had no background evidence of its own, so only it is released.
    expect(created.backgroundTaskCandidates).toBeUndefined();
    expect(inputClosed).toBe(false);

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "batched-task",
      tool_use_id: "batched-backgrounded",
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    call.finish();
    await promptPromise;
  });

  test("releases every candidate when a batched message carries no background evidence", async () => {
    const created = createSession("batched foreground Bash results");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run two commands");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await input.next()).done).toBe(false);
    const inputCompletion = input.next();

    call.push({
      type: "assistant",
      message: {
        id: "assistant-batched-foreground",
        content: [
          { type: "tool_use", id: "plain-a", name: "Bash", input: { command: "echo a" } },
          { type: "tool_use", id: "plain-b", name: "Bash", input: { command: "echo b" } },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    call.push({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "plain-a", content: "a" },
          { type: "tool_result", tool_use_id: "plain-b", content: "b" },
        ],
      },
    });

    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    expect(created.backgroundTaskCandidates).toBeUndefined();
    expect(created.backgroundTasks).toBeUndefined();
    call.finish();
    await promptPromise;
  });

  test("never attributes a batched message's structured task id to one of its blocks", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-batched-structured",
          content: [
            { type: "tool_use", id: "ambiguous-a", name: "Bash", input: { command: "echo a" } },
            { type: "tool_use", id: "ambiguous-b", name: "Bash", input: { command: "echo b" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "ambiguous-a", content: "a" },
            { type: "tool_result", tool_use_id: "ambiguous-b", content: "b" },
          ],
        },
        // One flat object that never names the block it belongs to.
        tool_use_result: { backgroundedByUser: true, backgroundTaskId: "unattributable-task" },
      },
    ]);

    expect(session.backgroundTasks).toBeUndefined();
  });

  test("a follow-up query cannot erase tasks owned by the retained runtime", async () => {
    const created = createSession("retained runtime followed by another turn");
    track(created.id);
    const firstPrompt = sendPrompt(created.id, "start background work");
    const firstCall = await nextQueryCall();
    const firstInput = (firstCall.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await firstInput.next()).done).toBe(false);
    let firstInputClosed = false;
    const firstInputCompletion = firstInput.next().then((result) => {
      firstInputClosed = result.done === true;
      return result;
    });

    firstCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "old-runtime-task",
      description: "Owned by the first CLI",
    });
    firstCall.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");

    const secondPrompt = sendPrompt(created.id, "continue while it runs");
    const secondCall = await nextQueryCall();
    secondCall.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await secondPrompt;

    expect(created.backgroundTasks?.["old-runtime-task"]?.status).toBe("running");
    expect(firstInputClosed).toBe(false);

    firstCall.push({
      type: "system",
      subtype: "task_notification",
      task_id: "old-runtime-task",
      status: "completed",
    });
    pushSuccessfulContinuationResult(firstCall);
    expect(await firstInputCompletion).toEqual({ done: true, value: undefined });
    firstCall.finish();
    await firstPrompt;
    expect(created.backgroundTasks?.["old-runtime-task"]?.status).toBe("completed");
  });

  test("a follow-up query listing an older task does not take ownership of it", async () => {
    const created = createSession("cross-runtime task ownership");
    track(created.id);
    const firstPrompt = sendPrompt(created.id, "start background work");
    const firstCall = await nextQueryCall();
    firstCall.push({
      type: "system",
      subtype: "task_started",
      task_id: "shared-task",
      description: "Owned by the first CLI",
    });
    firstCall.push({ type: "result", subtype: "success" });
    await waitFor(() => created.status === "idle");
    const firstOwner = created.backgroundTaskControls?.get("shared-task");
    expect(firstOwner).toBeDefined();

    const secondPrompt = sendPrompt(created.id, "continue while it runs");
    const secondCall = await nextQueryCall();
    secondCall.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "shared-task", description: "Also listed by the second CLI" },
        { task_id: "second-runtime-task", description: "Started by the second CLI" },
      ],
    });
    await waitFor(() => created.backgroundTasks?.["second-runtime-task"] !== undefined);

    // Only the process that started a task can stop it: a control asked to stop
    // an id it never started answers `ok` without reaching anything.
    expect(created.backgroundTaskControls?.get("shared-task")).toBe(firstOwner);
    expect(created.backgroundTaskControls?.get("second-runtime-task")).not.toBe(firstOwner);
    expect(created.backgroundTasks?.["shared-task"]?.status).toBe("running");

    secondCall.push({
      type: "system",
      subtype: "task_notification",
      task_id: "second-runtime-task",
      status: "completed",
    });
    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await secondPrompt;

    firstCall.push({
      type: "system",
      subtype: "task_notification",
      task_id: "shared-task",
      status: "completed",
    });
    firstCall.finish();
    await firstPrompt;
    expect(created.backgroundTasks?.["shared-task"]?.status).toBe("completed");
  });

  test.each([
    ["an MCP tool", "mcp_build_run"],
    ["a dynamic tool", "CustomBackgroundRunner"],
  ])("does not mistake %s structured output for a Bash launch", async (_label, toolName) => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: `assistant-${toolName}`,
          content: [{
            type: "tool_use",
            id: "colliding-tool",
            name: toolName,
            input: { run_in_background: true },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "colliding-tool",
            content: "arbitrary third-party output",
          }],
        },
        tool_use_result: { backgroundTaskId: "collision" },
      },
    ]);

    expect(session.backgroundTasks).toBeUndefined();
  });

  test("requires structured evidence that the correlated Bash invocation backgrounded", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-foreground-bash",
          content: [{
            type: "tool_use",
            id: "foreground-bash",
            name: "Bash",
            input: { command: "bun test" },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "foreground-bash",
            content: "done",
          }],
        },
        tool_use_result: { backgroundTaskId: "unvouched-task" },
      },
    ]);

    expect(session.backgroundTasks).toBeUndefined();
  });

  // A foreground Bash tool_result *is* the command's stdout. Without provider
  // intent the label may only be believed when it is the whole result, or any
  // command that prints one (`cat` of a doc, a build log) mints a task nothing
  // will ever settle — pinning the CLI process and the session transcript.
  test.each([
    [
      "an embedded label",
      "the docs say Command running in background with ID: fake-task",
    ],
    [
      "a line-leading label inside multi-line output",
      "reading notes\nBackground task ID: fake-task\ndone",
    ],
    [
      "a label on the last line of output",
      "build ok\nCommand running in background with ID: fake-task",
    ],
    [
      "a label in one of several text blocks",
      [
        { type: "text", text: "header" },
        { type: "text", text: "Background task ID: fake-task" },
      ],
    ],
    [
      "a label preceded by output on the same line",
      "  done. Background task ID: fake-task",
    ],
  ])("does not parse %s from ordinary Bash output", async (_label, content) => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-foreground-doc-output",
          content: [{
            type: "tool_use",
            id: "foreground-doc-output",
            name: "Bash",
            input: { command: "printf docs" },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "foreground-doc-output",
            content,
          }],
        },
      },
    ]);

    expect(session.backgroundTasks).toBeUndefined();
    expect(session.backgroundTaskCandidates).toBeUndefined();
  });

  test("still accepts a provider label that is the entire tool result", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-foreground-exclusive-label",
          content: [{
            type: "tool_use",
            id: "foreground-exclusive-label",
            name: "Bash",
            input: { command: "printf docs" },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "foreground-exclusive-label",
            content: "\n  Background task ID: real-task  \n",
          }],
        },
      },
    ]);

    expect(session.backgroundTasks?.["real-task"]).toMatchObject({
      toolUseId: "foreground-exclusive-label",
      description: "printf docs",
    });
  });

  test("still parses an embedded label once provider intent is structured", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-structured-intent-embedded-label",
          content: [{
            type: "tool_use",
            id: "structured-intent-embedded-label",
            name: "Bash",
            input: { command: "bun run test" },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "structured-intent-embedded-label",
            content: "partial output\nCommand running in background with ID: trusted-task",
          }],
        },
        tool_use_result: { timedOutAfterMs: 120_000 },
      },
    ]);

    expect(session.backgroundTasks?.["trusted-task"]).toMatchObject({
      toolUseId: "structured-intent-embedded-label",
    });
  });

  test.each([
    ["null structured output", null],
    ["array structured output", [{ backgroundTaskId: "array-task" }]],
    ["missing task id", { stdout: "" }],
    ["non-string task id", { backgroundTaskId: 42 }],
    ["blank task id", { backgroundTaskId: "   " }],
    ["control character in task id", { backgroundTaskId: "bad\ntask" }],
    [
      "oversized task id",
      { backgroundTaskId: "x".repeat(513) },
    ],
  ])("ignores %s in a Bash tool result", async (_label, toolUseResult) => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-malformed-launch",
          content: [{
            type: "tool_use",
            id: "bash-malformed-launch",
            name: "Bash",
            input: { command: "bun test", run_in_background: true },
          }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "bash-malformed-launch",
            content: "result",
          }],
        },
        tool_use_result: toolUseResult,
      },
    ]);

    expect(session.backgroundTasks).toEqual({
      "pending-bash:bash-malformed-launch": expect.objectContaining({
        id: "pending-bash:bash-malformed-launch",
        status: "killed",
      }),
    });
  });

  test.each([
    [
      "no correlated result block",
      [],
    ],
    [
      "multiple candidate result ids",
      [
        { type: "tool_result", tool_use_id: "bash-ambiguous", content: "first" },
        { type: "tool_result", tool_use_id: "bash-other", content: "second" },
      ],
    ],
    [
      "duplicate correlated result blocks",
      [
        { type: "tool_result", tool_use_id: "bash-ambiguous", content: "first" },
        { type: "tool_result", tool_use_id: "bash-ambiguous", content: "duplicate" },
      ],
    ],
    [
      "a failed correlated result block",
      [{
        type: "tool_result",
        tool_use_id: "bash-ambiguous",
        content: "failed",
        is_error: true,
      }],
    ],
    [
      "an invalid correlated result id",
      [{ type: "tool_result", tool_use_id: "bad\nid", content: "invalid" }],
    ],
  ])("rejects a Bash launch with %s", async (label, content) => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-ambiguous-launch",
          content: [{
            type: "tool_use",
            id: "bash-ambiguous",
            name: "Bash",
            input: { command: "bun test", run_in_background: true },
          }],
        },
      },
      {
        type: "user",
        message: { role: "user", content },
        tool_use_result: { backgroundTaskId: "ambiguous-task" },
      },
    ]);

    expect(session.backgroundTasks?.["ambiguous-task"]).toBeUndefined();
    expect(session.backgroundTasks).toEqual({
      "pending-bash:bash-ambiguous": expect.objectContaining({
        id: "pending-bash:bash-ambiguous",
        status: label === "a failed correlated result block" ? "failed" : "killed",
      }),
    });
  });

  test.each([
    [
      "the command when description is absent",
      { command: "bun run test", run_in_background: true },
      {},
      "bun run test",
    ],
    [
      "the retained tool title when command and description are absent",
      { run_in_background: true },
      {},
      "Bash",
    ],
    [
      "the command for a user-backgrounded process",
      { command: "bun run build" },
      { backgroundedByUser: true },
      "bun run build",
    ],
    [
      "the command for a process backgrounded after its timeout",
      { command: "bun run lint" },
      { timedOutAfterMs: 30_000 },
      "bun run lint",
    ],
  ])("describes a provisional Bash launch using %s", async (
    _label,
    input,
    structuredFields,
    expectedDescription,
  ) => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "assistant",
          message: {
            id: "assistant-description-fallback",
            content: [{
              type: "tool_use",
              id: "bash-description-fallback",
              name: "Bash",
              input,
            }],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "bash-description-fallback",
              content: "backgrounded",
            }],
          },
          tool_use_result: {
            backgroundTaskId: "description-task",
            ...structuredFields,
          },
        },
      ],
      (s) => s.backgroundTasks?.["description-task"] !== undefined,
    );

    expect(session.backgroundTasks?.["description-task"]).toMatchObject({
      description: expectedDescription,
      status: "running",
    });
    await finish();
    // No lifecycle edge followed the provisional launch, so closing the only
    // provider stream must leave an honest terminal snapshot rather than a
    // task that remains live forever.
    expect(session.backgroundTasks?.["description-task"]).toMatchObject({
      status: "killed",
    });
  });

  test.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "killed"],
  ] as const)("does not resurrect a %s task when its Bash launch arrives late", async (
    notificationStatus,
    expectedStatus,
  ) => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: `assistant-late-${notificationStatus}`,
          content: [{
            type: "tool_use",
            id: "bash-late-launch",
            name: "Bash",
            input: { command: "bun test", run_in_background: true },
          }],
        },
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "late-launch-task",
        status: notificationStatus,
        summary: "already settled",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "bash-late-launch",
            content: "backgrounded",
          }],
        },
        tool_use_result: { backgroundTaskId: "late-launch-task" },
      },
    ]);

    expect(session.backgroundTasks?.["late-launch-task"]).toMatchObject({
      status: expectedStatus,
      toolUseId: "bash-late-launch",
    });
  });

  test("does not resume a paused task when its Bash launch arrives late", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "assistant",
          message: {
            id: "assistant-late-paused",
            content: [{
              type: "tool_use",
              id: "bash-late-paused",
              name: "Bash",
              input: { command: "bun test", run_in_background: true },
            }],
          },
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "paused-launch-task",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "paused-launch-task",
          patch: { status: "paused" },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "bash-late-paused",
              content: "backgrounded",
            }],
          },
          tool_use_result: { backgroundTaskId: "paused-launch-task" },
        },
      ],
      (s) => s.backgroundTasks?.["paused-launch-task"]?.toolUseId !== undefined,
    );

    expect(session.backgroundTasks?.["paused-launch-task"]).toMatchObject({
      status: "paused",
      toolUseId: "bash-late-paused",
    });
    await finish();
  });

  test("publishes a provisional launch and routes stop through its owning control", async () => {
    const stopTask = mock(async (_taskId: string) => {});
    queryControlOverrides.stopTask = stopTask;
    const { events, stop } = captureEvents();
    const created = createSession("stop provisional launch");
    track(created.id);
    try {
      const promptPromise = sendPrompt(created.id, "run in the background");
      const call = await nextQueryCall();
      call.push({
        type: "assistant",
        message: {
          id: "assistant-stop-provisional",
          content: [{
            type: "tool_use",
            id: "bash-stop-provisional",
            name: "Bash",
            input: { command: "bun test", run_in_background: true },
          }],
        },
      });
      call.push({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "bash-stop-provisional",
            content: "backgrounded",
          }],
        },
        tool_use_result: { backgroundTaskId: "stop-provisional-task" },
      });
      call.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await waitFor(
        () => getSession(created.id)?.backgroundTasks?.["stop-provisional-task"]?.status
          === "running",
      );

      expect(events.some(
        (event) =>
          event.type === "session.updated"
          && (event.data as { backgroundTasks?: Record<string, BackgroundTaskSnapshot> })
            .backgroundTasks?.["stop-provisional-task"]?.status === "running",
      )).toBe(true);
      expect(await stopBackgroundTask(created.id, "stop-provisional-task")).toEqual({ ok: true });
      expect(stopTask).toHaveBeenCalledWith("stop-provisional-task");
      expect(getSession(created.id)?.backgroundTasks?.["stop-provisional-task"]).toMatchObject({
        status: "killed",
      });

      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("records a started task as running, then settles it when the stream ends", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          tool_use_id: "agent-tool-1",
          description: "Run the suite",
        },
      ],
      (s) => s.backgroundTasks?.["task-1"] !== undefined,
    );

    expect(session.backgroundTasks?.["task-1"]).toMatchObject({
      id: "task-1",
      toolUseId: "agent-tool-1",
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

  test("accepts lifecycle correlation first reported by progress", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        { type: "system", subtype: "task_started", task_id: "task-1", description: "Build" },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          tool_use_id: "agent-tool-progress",
          description: "Building",
        },
      ],
      (s) => s.backgroundTasks?.["task-1"]?.toolUseId !== undefined,
    );

    expect(session.backgroundTasks?.["task-1"]).toMatchObject({
      toolUseId: "agent-tool-progress",
      description: "Building",
      status: "running",
    });
    await finish();
  });

  test("creates a correlated live task from progress without a start edge", async () => {
    const { session, finish } = await inspectDuringTurn(
      [{
        type: "system",
        subtype: "task_progress",
        task_id: "task-progress-only",
        tool_use_id: "agent-tool-progress-only",
        description: "Recovered progress",
      }],
      (s) => s.backgroundTasks?.["task-progress-only"] !== undefined,
    );

    expect(session.backgroundTasks?.["task-progress-only"]).toMatchObject({
      toolUseId: "agent-tool-progress-only",
      description: "Recovered progress",
      status: "running",
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
        tool_use_id: "agent-tool-orphan",
        status: "failed",
        summary: "exploded",
        output_file: "/tmp/out",
      },
    ]);

    expect(session.backgroundTasks?.["task-orphan"]).toMatchObject({
      status: "failed",
      toolUseId: "agent-tool-orphan",
      description: "exploded",
      error: "exploded",
    });
  });

  for (const { status, expected } of terminalCases) {
    for (const edgeFirst of [false, true]) {
      test(`${status} remains ${expected} when the level ${
        edgeFirst ? "follows" : "precedes"
      } its terminal edge`, async () => {
        const notification = {
          type: "system",
          subtype: "task_notification",
          task_id: "task-ordered",
          tool_use_id: "agent-tool-ordered",
          status,
          summary: status === "failed" ? "failed summary" : "done",
        };
        const level = {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        };
        const { session } = await runPromptWithMessages([
          {
            type: "system",
            subtype: "task_started",
            task_id: "task-ordered",
            description: "Ordered task",
          },
          ...(edgeFirst ? [notification, level] : [level, notification]),
        ]);

        expect(session.backgroundTasks?.["task-ordered"]).toMatchObject({
          status: expected,
          toolUseId: "agent-tool-ordered",
        });
      });
    }
  }

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

  test("background_tasks_changed replaces live membership but retains terminal history", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        { type: "system", subtype: "task_started", task_id: "task-live-old" },
        { type: "system", subtype: "task_started", task_id: "task-terminal" },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task-terminal",
          status: "failed",
          summary: "terminal failure",
        },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-live-new", task_type: "agent", description: "New" }],
        },
      ],
      (s) => s.backgroundTasks?.["task-live-new"] !== undefined,
    );

    expect(Object.keys(session.backgroundTasks ?? {}).sort()).toEqual([
      "task-live-new",
      "task-terminal",
    ]);
    expect(session.backgroundTasks?.["task-terminal"]).toMatchObject({
      status: "failed",
      error: "terminal failure",
    });
    expect(session.backgroundTasks?.["task-live-new"]).toMatchObject({
      status: "running",
      description: "New",
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

  test("bounds retained terminal lifecycle history", async () => {
    const messages = Array.from(
      { length: MAX_TERMINAL_BACKGROUND_TASKS + 7 },
      (_, index) => ({
        type: "system",
        subtype: "task_notification",
        task_id: `task-terminal-${index}`,
        status: "completed",
        summary: `Task ${index}`,
      }),
    );
    const { session } = await runPromptWithMessages(messages);

    expect(Object.keys(session.backgroundTasks ?? {})).toHaveLength(
      MAX_TERMINAL_BACKGROUND_TASKS,
    );
    expect(session.backgroundTasks?.[`task-terminal-${
      MAX_TERMINAL_BACKGROUND_TASKS + 6
    }`]).toBeDefined();
    expect(session.backgroundTasks?.["task-terminal-0"]).toBeUndefined();
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

  test.each([
    ["completed", "completed", "completed", false],
    ["failed", "failed", "failed", true],
    // `stopped` maps to the same terminal state the stop itself would write,
    // so the notification must still win rather than be re-settled behind it.
    ["stopped", "stopped", "killed", false],
    ["stopped after a rejected request", "stopped", "killed", true],
  ] as const)(
    "preserves a natural %s notification that races a pending stop",
    async (_label, notificationStatus, expectedStatus, rejectStop) => {
      let resolveStop!: () => void;
      let rejectStopRequest!: (error: Error) => void;
      let stopCalled = false;
      queryControlOverrides.stopTask = mock(() => {
        stopCalled = true;
        return new Promise<void>((resolve, reject) => {
          resolveStop = resolve;
          rejectStopRequest = reject;
        });
      });

      const session = createSession(`stop race ${_label}`);
      track(session.id);
      const promptPromise = sendPrompt(session.id, "start then stop");
      const call = await nextQueryCall();
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "stop-race-task",
        description: "Natural terminal state wins",
      });
      await waitFor(() => session.backgroundTasks?.["stop-race-task"]?.status === "running");

      const stopPromise = stopBackgroundTask(session.id, "stop-race-task");
      await waitFor(() => stopCalled);
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: "stop-race-task",
        status: notificationStatus,
        ...(notificationStatus === "failed" ? { summary: "natural failure" } : {}),
      });
      await waitFor(() => session.backgroundTasks?.["stop-race-task"]?.status === expectedStatus);
      const settledAt = session.backgroundTasks?.["stop-race-task"]?.endedAt;

      if (rejectStop) {
        rejectStopRequest(new Error("stop transport closed after notification"));
      } else {
        resolveStop();
      }
      expect(await stopPromise).toEqual({ ok: true });
      expect(session.backgroundTasks?.["stop-race-task"]).toMatchObject({
        status: expectedStatus,
        // The terminal record the notification wrote is kept verbatim; the stop
        // must not re-settle it and stamp a second end time over the real one.
        endedAt: settledAt,
        ...(notificationStatus === "failed" ? { error: "natural failure" } : {}),
      });

      call.finish();
      await promptPromise;
    },
  );

  test("stopping the last retained task closes its runtime and leaves the session idle", async () => {
    const stopTask = mock(async (_taskId: string) => {});
    queryControlOverrides.stopTask = stopTask;

    const session = createSession("stop held task");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "delegate then stop");
    const call = await nextQueryCall();
    try {
      const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      expect((await input.next()).done).toBe(false);
      const inputCompletion = input.next();

      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "task-held",
        description: "Long review",
      });
      call.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
        },
      });
      await waitFor(() =>
        session.status === "idle"
        && session.backgroundTasks?.["task-held"]?.status === "running"
      );

      expect(await stopBackgroundTask(session.id, "task-held")).toEqual({ ok: true });
      expect(stopTask).toHaveBeenCalledWith("task-held");
      expect(session.backgroundTasks?.["task-held"]?.status).toBe("killed");
      expect(session.completionBlockedByBackgroundTasks).toBe(false);
      expect(await inputCompletion).toEqual({ done: true, value: undefined });
      expect(events.flatMap((event) => {
        const data = event.data as { completionBlockedByBackgroundTasks?: boolean };
        return typeof data.completionBlockedByBackgroundTasks === "boolean"
          ? [data.completionBlockedByBackgroundTasks]
          : [];
      })).toEqual([false, false]);

      expect(session.status).toBe("idle");
      call.finish();
      await promptPromise;
      expect(session.status).toBe("idle");
    } finally {
      stop();
    }
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

  test("deletion closes a control retained only by an unresolved Bash candidate", async () => {
    const session = createSession("candidate-only control");
    track(session.id);
    const close = mock(async () => {});
    session.backgroundTaskCandidates = new Map([
      ["candidate-tool", { close }],
    ]);

    expect(deleteSession(session.id)).toBe(true);
    await waitFor(() => close.mock.calls.length === 1);
    expect(session.backgroundTaskCandidates).toBeUndefined();
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
