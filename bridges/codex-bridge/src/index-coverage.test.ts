import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { __testing } = await import("./index.js");

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-index-coverage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  __testing.setAfterStreamEventLogForTesting(null);
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("codex bridge private boundary coverage", () => {
  test("shares one transcript path snapshot across concurrent metadata lookups", async () => {
    const paths = ["/sessions/one.jsonl", "/sessions/two.jsonl"];
    let pathLoads = 0;
    const metadataCalls: Array<{ threadId: string; paths: readonly string[] }> = [];
    const load = __testing.createSharedTranscriptMetaLoaderForTesting(
      async () => {
        pathLoads += 1;
        await Promise.resolve();
        return paths;
      },
      async (threadId: string, transcriptPaths: readonly string[]) => {
        metadataCalls.push({ threadId, paths: transcriptPaths });
        return { id: threadId, updatedAt: "2026-07-17T00:00:00.000Z" };
      },
    );

    await Promise.all([load("one"), load("two"), load("one")]);

    expect(pathLoads).toBe(1);
    expect(metadataCalls.map((call) => call.threadId)).toEqual(["one", "two", "one"]);
    expect(metadataCalls.every((call) => call.paths === paths)).toBe(true);
  });

  test("constructs normal and fast SDK threads through the default factory", () => {
    __testing.setFreshThreadFactoryForTesting(null);

    const normal = __testing.createFreshThreadForSessionForTesting({
      fastMode: false,
      threadOptions: {},
    });
    const fast = __testing.createFreshThreadForSessionForTesting({
      fastMode: true,
      threadOptions: {},
    });

    expect(normal).not.toBe(fast);
    expect(normal.runStreamed).toBeInstanceOf(Function);
    expect(fast.runStreamed).toBeInstanceOf(Function);
  });

  test("contains runtime environment executor failures", async () => {
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      await __testing.refreshRuntimeEnvironment(async () => {
        throw new Error("shell unavailable");
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(errors).toEqual([
      ["[codex-bridge] Failed to refresh runtime environment:", expect.any(Error)],
    ]);
  });

  test("creates a shutdown handler that clears its timer and title jobs before exiting", async () => {
    const timer = { id: "cleanup" } as unknown as ReturnType<typeof setInterval>;
    const calls: unknown[] = [];
    const handler = __testing.createShutdownHandlerForTesting(
      timer,
      (value: unknown) => calls.push(["clear", value]),
      (code: number) => calls.push(["exit", code]),
      async () => {
        calls.push(["shutdown-titles"]);
      },
    );

    handler();
    await Bun.sleep(0);

    expect(calls).toEqual([
      ["clear", timer],
      ["shutdown-titles"],
      ["exit", 0],
    ]);
  });

  test("exits after a title-job shutdown failure and reports the error", async () => {
    const timer = { id: "cleanup" } as unknown as ReturnType<typeof setInterval>;
    const calls: unknown[] = [];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const handler = __testing.createShutdownHandlerForTesting(
        timer,
        (value: unknown) => calls.push(["clear", value]),
        (code: number) => calls.push(["exit", code]),
        async () => {
          throw new Error("shutdown failed");
        },
      );

      handler();
      await Bun.sleep(0);
    } finally {
      console.warn = originalWarn;
    }

    expect(calls).toEqual([
      ["clear", timer],
      ["exit", 0],
    ]);
    expect(warnings).toEqual([
      ["[codex-bridge] Failed to stop session-title generation:", expect.any(Error)],
    ]);
  });

  test("starts the bridge with parsed settings and honors the no-server guard", () => {
    const calls: unknown[] = [];
    const marker = { started: true };
    const start = (options: unknown) => {
      calls.push(options);
      return marker;
    };

    expect(__testing.startBridgeServerForTesting(
      { CODEX_BRIDGE_NO_SERVER: "1" },
      start,
    )).toBeUndefined();
    expect(calls).toEqual([]);

    expect(__testing.startBridgeServerForTesting(
      { PORT: "5123", HOSTNAME: "127.0.0.1" },
      start,
    )).toBe(marker);
    expect(calls).toEqual([
      expect.objectContaining({ port: 5123, hostname: "127.0.0.1", fetch: expect.any(Function) }),
    ]);
  });

  test("normalizes raw log payloads and writes sanitized JSONL filenames", async () => {
    const root = temporaryRoot();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(__testing.sanitizeLogFileComponentForTesting("../unsafe:id%"))
      .toBe(".._unsafe_id_");
    expect(__testing.normalizeLogPayloadForTesting({ nested: [1, true] }))
      .toEqual({ nested: [1, true] });
    expect(__testing.normalizeLogPayloadForTesting(circular)).toBe("[object Object]");
    await __testing.writeCodexRawLogForTesting(
      "../unsafe:id%",
      { kind: "event", payload: __testing.normalizeLogPayloadForTesting(circular) },
      root,
    );

    const line = readFileSync(join(root, ".._unsafe_id_.jsonl"), "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      sessionId: "../unsafe:id%",
      kind: "event",
      payload: "[object Object]",
      timestamp: expect.any(String),
    });
  });

  test("contains raw log setup failures and no-ops without a log directory", async () => {
    const root = temporaryRoot();
    const blockingFile = join(root, "not-a-directory");
    writeFileSync(blockingFile, "blocked", "utf8");
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      await expect(__testing.writeCodexRawLogForTesting("session", {}, null))
        .resolves.toBeUndefined();
      await expect(__testing.writeCodexRawLogForTesting("session", {}, blockingFile))
        .resolves.toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }

    expect(errors).toContainEqual([
      "[codex-bridge] Failed to write raw Codex log:",
      expect.any(Error),
    ]);
  });

  test("extracts only valid persisted role-specific message content", () => {
    const extract = __testing.extractPersistedMessageTextForTesting;

    expect(extract("not-an-array", "assistant")).toBeNull();
    expect(extract([null, 1, { type: "input_text", text: "wrong role" }], "assistant"))
      .toBeNull();
    expect(extract([{ type: "output_text", text: "   " }], "assistant")).toBeNull();
    expect(extract([
      { type: "output_text", text: "first" },
      { type: "output_text", text: "second" },
    ], "assistant")).toBe("first\nsecond");
    expect(extract([
      { type: "input_text", text: "# AGENTS.md instructions for /tmp/repo\nignored" },
    ], "user")).toBeNull();
    expect(extract([
      {
        type: "input_text",
        text: "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
      },
    ], "user")).toBeNull();
    expect(extract([{ type: "input_text", text: "user prompt" }], "user"))
      .toBe("user prompt");
  });

  test("covers persisted metadata fallbacks, aliases, and cached blank titles", async () => {
    const root = temporaryRoot();
    const transcriptPath = join(root, "rollout-alias-thread.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({
        timestamp: "2026-07-17T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "real-thread", cwd: "/workspace" },
      }),
      "",
    ].join("\n"));

    await expect(__testing.getPersistedSessionMetaForTesting(
      "missing",
      "Fallback",
      "2026-07-17T11:00:00.000Z",
      undefined,
      [],
    )).resolves.toEqual({
      id: "missing",
      title: "Fallback",
      titleSource: "codex",
      updatedAt: "2026-07-17T11:00:00.000Z",
    });
    await expect(__testing.getPersistedSessionMetaForTesting(
      "missing",
      undefined,
      undefined,
      undefined,
      [],
    )).resolves.toBeNull();

    const aliased = await __testing.getPersistedSessionMetaForTesting(
      "alias-thread",
      "Alias title",
      undefined,
      undefined,
      [transcriptPath],
    );
    expect(aliased).toMatchObject({
      id: "alias-thread",
      title: "Alias title",
      cwd: "/workspace",
      transcriptPath,
    });

    const cachedMeta = {
      id: "cached-thread",
      title: "",
      updatedAt: "",
      transcriptPath,
    };
    const cached = await __testing.getPersistedSessionMetaForTesting(
      "cached-thread",
      "Cached fallback",
      "2026-07-17T12:00:00.000Z",
      {
        metas: [cachedMeta],
        metaByPath: new Map([[transcriptPath, cachedMeta]]),
        transcriptPathByThreadId: new Map([["cached-thread", transcriptPath]]),
      },
    );
    expect(cached).toMatchObject({
      id: "cached-thread",
      title: "Cached fallback",
      updatedAt: "2026-07-17T12:00:00.000Z",
    });

    const malformedPath = join(root, "rollout-malformed.jsonl");
    writeFileSync(malformedPath, '{"type":"event_msg","payload":{}}\n');
    await expect(__testing.getPersistedSessionMetaForTesting(
      "malformed",
      "Recovered",
      undefined,
      undefined,
      [malformedPath],
    )).resolves.toMatchObject({
      id: "malformed",
      title: "Recovered",
      transcriptPath: malformedPath,
    });
  });

  test("returns an empty persisted hydration snapshot when no transcript exists", async () => {
    const root = temporaryRoot();
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "empty-codex-home");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });

    try {
      await expect(__testing.hydrateMessagesFromPersistedSessionForTesting("missing-thread"))
        .resolves.toEqual({ messages: [], title: undefined });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("contains synchronous and asynchronous SSE subscriber failures", async () => {
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const removeSync = __testing.subscribeForTesting(() => {
      throw new Error("sync subscriber failure");
    });
    const removeAsync = __testing.subscribeForTesting(async () => {
      throw new Error("async subscriber failure");
    });

    try {
      __testing.emitForTesting({ type: "session.updated", sessionId: "session" });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      removeSync();
      removeAsync();
      console.error = originalConsoleError;
    }

    expect(errors).toEqual([
      ["[codex-bridge] Failed to notify SSE subscriber:", expect.any(Error)],
      ["[codex-bridge] Failed to notify SSE subscriber:", expect.any(Error)],
    ]);
  });

  test("guards SSE writes after closure and forwards writes while open", async () => {
    let open = false;
    const events: unknown[] = [];
    const write = __testing.createOpenSseWriterForTesting(
      () => open,
      async (event: unknown) => {
        events.push(event);
      },
    );

    await write({ event: "closed" });
    expect(events).toEqual([]);

    open = true;
    await write({ event: "open" });
    expect(events).toEqual([{ event: "open" }]);
  });

  test("handles stale and current detached prompt failures", () => {
    const stale = {
      id: "stale",
      currentTurnId: "new-turn",
      status: "running",
      error: undefined,
      pendingAttachments: [{ type: "image", path: "/tmp/image.png" }],
    };
    __testing.handlePromptFailureForTesting(stale, "old-turn", new Error("stale"));
    expect(stale).toMatchObject({
      currentTurnId: "new-turn",
      status: "running",
      error: undefined,
      pendingAttachments: [{ type: "image", path: "/tmp/image.png" }],
    });

    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const current = {
      id: "current",
      currentTurnId: "accepted-turn",
      currentTurnStartedAt: "2026-07-17T00:00:00.000Z",
      abortController: new AbortController(),
      status: "running",
      error: undefined,
      pendingAttachments: [{ type: "image", path: "/tmp/image.png" }],
    };

    try {
      __testing.handlePromptFailureForTesting(current, "accepted-turn", "not an Error");
    } finally {
      console.error = originalConsoleError;
    }

    expect(current).toMatchObject({
      currentTurnId: undefined,
      currentTurnStartedAt: undefined,
      abortController: undefined,
      status: "error",
      error: "Codex execution failed",
      pendingAttachments: [],
    });
    expect(errors).toEqual([["[codex-bridge] Prompt failed:", "not an Error"]]);
  });

  test("reads optional text files and returns undefined for missing paths", async () => {
    const root = temporaryRoot();
    const path = join(root, "present.txt");
    writeFileSync(path, "present", "utf8");

    await expect(__testing.readTextFileIfPresentForTesting(path)).resolves.toBe("present");
    await expect(__testing.readTextFileIfPresentForTesting(join(root, "missing.txt")))
      .resolves.toBeUndefined();
  });

  test("keeps the newest duplicate persisted transcript metadata", async () => {
    const root = temporaryRoot();
    const codexHome = join(root, "codex-home");
    const sessionsDir = join(codexHome, "sessions", "2026", "07", "17");
    const cwd = "/workspace";
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(codexHome, "session_index.jsonl"), "", "utf8");
    for (const [name, timestamp] of [
      ["a-old", "2026-07-17T10:00:00.000Z"],
      ["z-new", "2026-07-17T12:00:00.000Z"],
    ]) {
      writeFileSync(
        join(sessionsDir, `rollout-${name}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "duplicate-thread", cwd, timestamp },
        })}\n`,
        "utf8",
      );
    }
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      await expect(__testing.listPersistedSessionsForCwdForTesting(cwd)).resolves.toEqual([
        expect.objectContaining({
          id: "duplicate-thread",
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
      ]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("merges persisted metadata without allowing older duplicates to win", () => {
    const sessions = new Map<string, {
      id: string;
      updatedAt: string;
      transcriptPath?: string;
    }>();
    const older = {
      id: "thread",
      updatedAt: "2026-07-17T10:00:00.000Z",
      transcriptPath: "/sessions/old.jsonl",
    };
    const newer = {
      id: "thread",
      updatedAt: "2026-07-17T12:00:00.000Z",
      transcriptPath: "/sessions/new.jsonl",
    };

    __testing.mergePersistedSessionMetaForTesting(sessions, older);
    __testing.mergePersistedSessionMetaForTesting(sessions, newer);
    __testing.mergePersistedSessionMetaForTesting(sessions, older);

    expect(sessions.get("thread")).toEqual({
      ...older,
      updatedAt: newer.updatedAt,
    });
  });
});
