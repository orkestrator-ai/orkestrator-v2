import { describe, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STRUCTURED_USAGE_REQUEST_TIMEOUT_MS,
  captureEvents,
  createSession,
  deleteSession,
  eventEmitter,
  getAvailableModelCatalog,
  getAvailableModels,
  getClaudeRuntimeVersions,
  getSession,
  mockExecFile,
  mockQuery,
  mockReadFile,
  nextQueryCall,
  originalExecFile,
  queryControlOverrides,
  realFs,
  runPromptWithMessages,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

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
      expect(model?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }

    // Haiku is the fast, non-reasoning tier.
    expect(byId.get("haiku")?.supportsEffort).toBeUndefined();
  });

  test("cleans up the SDK query after success, failure, and cleanup errors", async () => {
    const successReturn = mock(async () => ({ done: true, value: undefined }));
    const successfulQuery = Object.assign((async function* () {})(), {
      supportedModels: async () => [],
      return: successReturn,
    });
    mockQuery.mockImplementationOnce(() => successfulQuery as never);
    expect(await getAvailableModels()).toEqual([]);
    expect(successReturn).toHaveBeenCalledTimes(1);

    const failedReturn = mock(async () => ({ done: true, value: undefined }));
    const failingQuery = Object.assign((async function* () {})(), {
      supportedModels: async () => {
        throw new Error("model lookup failed");
      },
      return: failedReturn,
    });
    mockQuery.mockImplementationOnce(() => failingQuery as never);
    expect((await getAvailableModels()).length).toBeGreaterThan(0);
    expect(failedReturn).toHaveBeenCalledTimes(1);

    const cleanupFailure = Object.assign((async function* () {})(), {
      supportedModels: async () => [],
      return: async () => {
        throw new Error("cleanup failed");
      },
    });
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
      await realFs.promises.readFile(new URL("./package.json", sdkEntryUrl), "utf8"),
    );
  }

  async function withClaudeCliPath<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
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

  function stubClaudeVersionOutput(executable: string, output: string | (() => never)): void {
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
      stubClaudeVersionOutput("/managed/toolchain/claude", "5.4.2 (Claude Code)\n");

      const versions = await getClaudeRuntimeVersions();

      expect(versions.cliVersion).toBe("5.4.2");
      expect(versions.sdkVersion).toBe((await readBundledManifest()).version);
      const call = mockExecFile.mock.calls.find((c) => c[0] === "/managed/toolchain/claude");
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

  test("merges a structured allocation into usage already streaming", async () => {
    let resolveUsage!: (value: unknown) => void;
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUsage = resolve;
        }),
    );

    const created = createSession("streaming structured allocation");
    track(created.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    try {
      call.push({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
        },
      });
      call.push({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 5 } },
      });
      call.push({ type: "stream_event", event: { type: "message_stop" } });
      await waitFor(() => created.inProgressUsage?.sessionTokens === 105);

      resolveUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 31 } },
      });
      await waitFor(() => created.inProgressUsage?.rateLimits?.[0]?.usedPercent === 31);
      expect(
        events.some(
          (event) =>
            event.type === "session.updated" &&
            event.sessionId === created.id &&
            (event.data as { contextUsage?: { sessionTokens?: number; rateLimits?: unknown[] } })
              .contextUsage?.sessionTokens === 105 &&
            (event.data as { contextUsage?: { rateLimits?: unknown[] } }).contextUsage?.rateLimits
              ?.length === 1,
        ),
      ).toBe(true);
    } finally {
      stop();
      call.finish();
      await promptPromise;
    }
  });

  test("merges a sparse rate-limit notification into usage already streaming", async () => {
    const created = createSession("streaming sparse allocation");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "keep working");
    const call = await nextQueryCall();
    try {
      call.push({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
        },
      });
      call.push({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 5 } },
      });
      call.push({ type: "stream_event", event: { type: "message_stop" } });
      await waitFor(() => created.inProgressUsage?.sessionTokens === 105);

      call.push({
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 47 },
      });
      await waitFor(() => created.inProgressUsage?.rateLimits?.[0]?.usedPercent === 47);
      expect(created.inProgressUsage).toMatchObject({
        sessionTokens: 105,
        rateLimits: [{ label: "Five Hour", usedPercent: 47 }],
      });
    } finally {
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
        !pushedRefreshSignal &&
        event.type === "session.updated" &&
        event.sessionId === created.id &&
        (event.data as { rateLimits?: Array<{ usedPercent?: number }> }).rateLimits?.[0]
          ?.usedPercent === 5
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
      expect(getSession(created.id)?.usage?.rateLimits).toEqual(getSession(created.id)?.rateLimits);
    });
  }

  test("ignores a structured response after its session is removed", async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    let parsed = false;
    const getStructuredUsage = mock(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUsage = resolve;
        }),
    );
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
      expect(
        events.some(
          (event) =>
            event.type === "session.updated" &&
            event.sessionId === created.id &&
            "rateLimits" in event.data,
        ),
      ).toBe(false);
    } finally {
      stop();
      call.finish();
    }
  });

  test("ignores a structured response while its session is being deleted", async () => {
    let resolveUsage: ((value: unknown) => void) | undefined;
    let parsed = false;
    const getStructuredUsage = mock(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUsage = resolve;
        }),
    );
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
      expect(
        events.some(
          (event) =>
            event.type === "session.updated" &&
            event.sessionId === created.id &&
            "rateLimits" in event.data,
        ),
      ).toBe(false);
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
    const getStructuredUsage = mock(
      () =>
        new Promise<unknown>((resolve) => {
          resolveUsage = resolve;
        }),
    );
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
      expect(
        events.some(
          (event) =>
            event.type === "session.updated" &&
            event.sessionId === created.id &&
            "rateLimits" in event.data,
        ),
      ).toBe(false);
    } finally {
      created.queryControl = originalControl;
      stop();
      call.finish();
      await promptPromise;
    }
  });

  test("replaces sparse threshold data with all structured /usage windows", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({
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
      }),
    );

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
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({
        rate_limits_available: false,
        rate_limits: null,
      }),
    );

    const { events, stop } = captureEvents();
    let session;
    try {
      ({ session } = await runPromptWithMessages([sparseFiveHourEvent, successfulUsageResult]));
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
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({
        rate_limits_available: true,
        rate_limits: {},
      }),
    );

    const { session } = await runPromptWithMessages([sparseFiveHourEvent, successfulUsageResult]);

    expect(session.rateLimits).toEqual([]);
    expect(session.usage?.rateLimits).toEqual([]);
  });

  test("preserves sparse windows when the structured request rejects", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => {
        throw new Error("experimental request failed");
      },
    );

    const { session } = await runPromptWithMessages([sparseFiveHourEvent, successfulUsageResult]);

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

    const startedAt = performance.now();
    const { session } = await runPromptWithMessages([sparseFiveHourEvent, successfulUsageResult]);

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
      STRUCTURED_USAGE_REQUEST_TIMEOUT_MS - 50,
    );
    expect(performance.now() - startedAt).toBeLessThan(STRUCTURED_USAGE_REQUEST_TIMEOUT_MS + 1_000);
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
      queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
        async () => response,
      );
      const { session } = await runPromptWithMessages([sparseFiveHourEvent, successfulUsageResult]);
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
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({
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
      }),
    );

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
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({
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
      }),
    );

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
    expect(new Date(session.rateLimits![0]!.resetsAt!).getUTCFullYear()).toBeGreaterThan(2020);
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
    expect(session.rateLimits).toEqual([{ label: "Usage", usedPercent: 5, resetsAt: undefined }]);
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
    const { session } = await runPromptWithMessages([{ type: "result", subtype: "success" }]);
    expect(session.usage).toBeUndefined();
  });

  test("keeps exact token totals when no context window can be determined", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        modelUsage: { "claude-opus-5": { inputTokens: 10, outputTokens: 5 } },
      },
    ]);
    expect(session.usage).toMatchObject({
      usedTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      lastTurnTokens: 15,
      sessionTokens: 15,
    });
    expect(session.usage).not.toHaveProperty("totalTokens");
    expect(session.usage).not.toHaveProperty("percentUsed");
  });

  test("prefers an exact context report over the token arithmetic", async () => {
    queryControlOverrides.getContextUsage = mock(async () => ({
      totalTokens: 51_200,
      maxTokens: 200_000,
      percentage: 25.6,
      model: "claude-opus-5",
      categories: [{ name: "System prompt", tokens: 1200, color: "#fff" }, { name: "bad entry" }],
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

  test("publishes a context control report when the turn has no token counters", async () => {
    queryControlOverrides.getContextUsage = mock(async () => ({
      totalTokens: 51_200,
      maxTokens: 200_000,
      percentage: 25.6,
      model: "claude-opus-5",
    }));

    const { session } = await runPromptWithMessages([{ type: "result", subtype: "success" }]);

    expect(session.usage).toMatchObject({
      usedTokens: 51_200,
      totalTokens: 200_000,
      percentUsed: 25.6,
      lastTurnTokens: 0,
      sessionTokens: 0,
      estimated: false,
    });
  });

  test("publishes a heuristic context report when raw turn counters are absent", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "result",
        subtype: "success",
        usage: { total_tokens: 51_200, max_tokens: 200_000 },
      },
    ]);

    expect(session.usage).toMatchObject({
      usedTokens: 51_200,
      totalTokens: 200_000,
      percentUsed: 25.6,
      lastTurnTokens: 0,
      sessionTokens: 0,
      estimated: true,
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
