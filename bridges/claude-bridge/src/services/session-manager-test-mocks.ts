/**
 * Process-global module mocks shared by the `session-manager-*.test.ts` suites.
 *
 * Importing this module installs `mock.module` doubles for `node:fs`,
 * `node:fs/promises`, `node:child_process`, `@anthropic-ai/claude-agent-sdk`,
 * `./mcp-config.js` and `./plugin-config.js`, and exports the mock functions and
 * the controllable `query()` double that drive them.
 *
 * It is a separate module from `session-manager-test-harness.ts` for one
 * reason: ES modules evaluate their dependencies in source order, so the
 * harness can import this first and then import `./session-manager.js`
 * statically and still be sure the mocks were installed before the code under
 * test read them. That is what the original preamble needed a top-level
 * `await import()` for, and a top-level await would leave every `const`
 * declared after it in the temporal dead zone for importing test files.
 *
 * Snapshots of the real modules are exported so the harness can restore them on
 * `afterAll`; see CLAUDE.md > "Bun `mock.module()` Rules".
 */
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

export { realChildProcess, realFs, realFsPromises, realMcpConfig, realPluginConfig };

export const mcpConfigSnapshot = { ...realMcpConfig };

export const pluginConfigSnapshot = { ...realPluginConfig };

export const childProcessSnapshot = { ...realChildProcess };

// Annotated rather than inferred: spreading the module widens to a structural
// type that names `ReadStreamOptions`/`WriteStreamOptions`, which `node:fs`
// does not export, so the emitted declaration cannot refer to them (TS4023).
export const fsSnapshot: typeof realFs = { ...realFs };

export const fsPromisesSnapshot = { ...realFsPromises };

export const originalExistsSync = realFs.existsSync;

export const originalReadFile = realFsPromises.readFile;

export const originalExecFile = realChildProcess.execFile;

export const originalSpawn = realChildProcess.spawn;

export const mockExistsSync = mock((path: realFs.PathLike) => originalExistsSync(path));

export const mockReadFile = mock(originalReadFile);

export const mockExecFile = mock(originalExecFile);

export const mockSpawn = mock(originalSpawn);

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

export interface QueryCall {
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

export function pushSuccessfulContinuationResult(call: QueryCall): void {
  call.push({ type: "result", subtype: "success" });
}

export const pendingCalls: QueryCall[] = [];

export const queryWaiters: Array<(call: QueryCall) => void> = [];

/**
 * Extra members spliced onto the object `query()` returns.
 *
 * The bridge feature-detects `stopTask`, `rewindFiles`, `getContextUsage` and
 * the experimental structured-usage request with `typeof x === "function"` and
 * skips them silently when absent, so they are opt-in per test: installing
 * them unconditionally would change what every other test's turn does.
 */
export const queryControlOverrides: Record<string, unknown> = {};

export function nextQueryCall(timeoutMs = 1000): Promise<QueryCall> {
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

export const mockQuery = mock((args: { prompt: unknown; options: QueryCall["options"] }) => {
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
export const PERSISTED_SDK_ID = "11111111-2222-4333-8444-555555555555";

export const OTHER_SDK_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export const FORK_SDK_ID = "99999999-8888-4777-8666-555555555555";

// The bridge feature-detects every one of these with `typeof x === "function"`
// and silently degrades to a no-op when absent, so they have to be present as
// real functions here or the persisted-session surface is never exercised at
// all. Defaults are the empty/inert answer; each test drives the seam it needs.

export type SdkSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  cwd?: string;
  createdAt?: number;
};

export type SdkSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  isSidechain?: boolean;
};

export const mockSdkListSessions = mock(
  async (_options?: Record<string, unknown>): Promise<SdkSessionInfo[]> => [],
);

export const mockSdkGetSessionInfo = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<SdkSessionInfo | undefined> => undefined,
);

export const mockSdkGetSessionMessages = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<SdkSessionMessage[]> => [],
);

export const mockSdkDeleteSession = mock(
  async (_sessionId: string, _options?: Record<string, unknown>): Promise<void> => {},
);

export const mockSdkRenameSession = mock(
  async (
    _sessionId: string,
    _title: string,
    _options?: Record<string, unknown>,
  ): Promise<void> => {},
);

export const mockSdkForkSession = mock(
  async (
    _sessionId: string,
    _options?: Record<string, unknown>,
  ): Promise<{ sessionId: string }> => ({ sessionId: FORK_SDK_ID }),
);

export function resetSdkSessionStoreMocks(): void {
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

export function installSdkModuleMock(overrides: Record<string, unknown> = {}): void {
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

export const mockGetMcpServersForSdk = mock(async () => ({}));

export const mockGetMcpServerNames = mock(async () => new Set<string>());

export const mockGetPluginsForSdk = mock(async () => [] as Array<{ type: "local"; path: string }>);

/**
 * `sendPrompt` resolves both halves of the MCP config in one call
 * (`getMcpRuntimeConfig`) so the underlying files are read once per prompt.
 * That is the only entry point this module uses; the two mocks above are kept
 * as the seams tests already drive with `mockImplementationOnce`, composed
 * here into the shape the real function returns.
 */
export const mockGetMcpRuntimeConfig = mock(async () => ({
  servers: await mockGetMcpServersForSdk(),
  names: await mockGetMcpServerNames(),
}));

mock.module("./mcp-config.js", () => ({
  getMcpRuntimeConfig: mockGetMcpRuntimeConfig,
}));

mock.module("./plugin-config.js", () => ({
  getPluginsForSdk: mockGetPluginsForSdk,
}));
