import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_BRIDGE_NO_SERVER = "1";
// Importing index.ts otherwise spawns a real app-server child, whose environment
// refresh mutates process.env underneath these tests.
process.env.CODEX_BRIDGE_NO_ENGINE = "1";

const { __testing } = await import("./index.js");

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-index-coverage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
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
      async (threadId: string, transcriptPaths: () => Promise<readonly string[]>) => {
        metadataCalls.push({ threadId, paths: await transcriptPaths() });
        return { id: threadId, updatedAt: "2026-07-17T00:00:00.000Z" };
      },
    );

    await Promise.all([load("one"), load("two"), load("one")]);

    expect(pathLoads).toBe(1);
    expect(metadataCalls.map((call) => call.threadId)).toEqual(["one", "two", "one"]);
    expect(metadataCalls.every((call) => call.paths === paths)).toBe(true);
  });


  test("serialized SSE writer bounds its backlog and drops frames after overflow", async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const written: string[] = [];
    let overflowed = 0;
    const write = __testing.createSerializedSseWriterForTesting(
      async (event: { event: string; data: string }) => {
        if (written.length === 0) await firstWriteGate;
        written.push(event.data);
      },
      { onOverflow: () => (overflowed += 1), maxPendingFrames: 3 },
    );

    // First frame starts writing (and stalls); two more queue behind it.
    const attempts = [
      write({ event: "a", data: "1" }),
      write({ event: "a", data: "2" }),
      write({ event: "a", data: "3" }),
    ];
    // The fourth frame exceeds the cap: overflow fires once, frame is dropped.
    await write({ event: "a", data: "4" });
    expect(overflowed).toBe(1);
    // Everything after overflow is dropped too, even after the backlog drains.
    releaseFirstWrite();
    await Promise.all(attempts);
    await write({ event: "a", data: "5" });
    expect(written).toEqual(["1", "2", "3"]);
    expect(overflowed).toBe(1);
  });

  test("serialized SSE writer accepts a single oversized frame when idle", async () => {
    const written: string[] = [];
    let overflowed = 0;
    const write = __testing.createSerializedSseWriterForTesting(
      async (event: { event: string; data: string }) => {
        written.push(event.data);
      },
      { onOverflow: () => (overflowed += 1), maxPendingBytes: 4 },
    );

    await write({ event: "a", data: "larger-than-the-byte-cap" });
    expect(written).toEqual(["larger-than-the-byte-cap"]);
    expect(overflowed).toBe(0);
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
      // Stubbed: the real drain waits on the app-server child, which is covered
      // by the engine-drain tests below. This test is about timer + title order.
      async () => undefined,
    );

    handler();
    await Bun.sleep(0);

    expect(calls).toEqual([
      ["clear", timer],
      ["shutdown-titles"],
      ["exit", 0],
    ]);
  });

  test("drains the Codex engine before exiting", async () => {
    // Skipping this would leave an orphaned app-server holding the same
    // CODEX_HOME after `docker stop` or a backend-issued SIGTERM.
    const timer = { id: "cleanup" } as unknown as ReturnType<typeof setInterval>;
    const calls: unknown[] = [];

    const handler = __testing.createShutdownHandlerForTesting(
      timer,
      () => calls.push(["clear"]),
      (code: number) => calls.push(["exit", code]),
      async () => {
        calls.push(["shutdown-titles"]);
      },
      async () => {
        calls.push(["stop-engine"]);
      },
    );

    handler();
    await Bun.sleep(0);

    expect(calls).toContainEqual(["stop-engine"]);
    expect(calls.at(-1)).toEqual(["exit", 0]);
  });

  test("still exits when draining the engine fails", async () => {
    const timer = { id: "cleanup" } as unknown as ReturnType<typeof setInterval>;
    const calls: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const handler = __testing.createShutdownHandlerForTesting(
        timer,
        () => calls.push(["clear"]),
        (code: number) => calls.push(["exit", code]),
        async () => undefined,
        async () => {
          throw new Error("engine refused to stop");
        },
      );

      handler();
      await Bun.sleep(0);
    } finally {
      console.warn = originalWarn;
    }

    // A stuck child must not wedge the bridge process forever.
    expect(calls).toContainEqual(["exit", 0]);
  });

  test("a second signal during shutdown is ignored", async () => {
    const timer = { id: "cleanup" } as unknown as ReturnType<typeof setInterval>;
    const exits: number[] = [];
    let stopCalls = 0;

    const handler = __testing.createShutdownHandlerForTesting(
      timer,
      () => undefined,
      (code: number) => exits.push(code),
      async () => undefined,
      async () => {
        stopCalls += 1;
      },
    );

    handler();
    handler();
    await Bun.sleep(0);

    // Draining twice concurrently would race the process-group kill.
    expect(stopCalls).toBe(1);
    expect(exits).toEqual([0]);
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
        async () => undefined,
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

  test("passes environment-derived overrides into the AppServerEngine composition root", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const marker = { kind: "engine-marker" };

    const created = __testing.createCodexEngineForTesting(
      {
        CODEX_PATH: "/opt/codex",
        ORKESTRATOR_VERSION: "9.8.7",
        CODEX_MAX_CONCURRENT_THREADS_PER_SESSION: "11",
      },
      (options: Record<string, unknown>) => {
        capturedOptions = options;
        return marker as never;
      },
    );

    expect(created).toBe(marker as never);
    expect(capturedOptions).toMatchObject({
      codexPath: "/opt/codex",
      clientInfo: {
        name: "orkestrator",
        title: "Orkestrator",
        version: "9.8.7",
      },
      configOverrides: {
        "features.goals": "true",
        "agents.max_concurrent_threads_per_session": "11",
        "features.multi_agent_v2.max_concurrent_threads_per_session": "12",
      },
    });
  });

  test("contains engine start failures and honors the no-engine guard", async () => {
    let starts = 0;
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      const runtime = {
        start: async () => {
          starts += 1;
          throw new Error("cannot initialize");
        },
        getHealth: () => ({ codexVersion: undefined }),
      };

      await __testing.startSelectedEngineForTesting(
        { CODEX_BRIDGE_NO_ENGINE: "1" },
        runtime as never,
      );
      await __testing.startSelectedEngineForTesting({}, runtime as never);
    } finally {
      console.error = originalConsoleError;
    }

    expect(starts).toBe(1);
    expect(errors).toEqual([
      ["[codex-bridge] Failed to start the app-server engine:", "cannot initialize"],
    ]);
  });

  test("reports successful engine startup with the detected version", async () => {
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      await __testing.startSelectedEngineForTesting(
        {},
        {
          start: async () => undefined,
          getHealth: () => ({ codexVersion: "0.145.0" }),
        } as never,
      );
    } finally {
      console.error = originalConsoleError;
    }

    expect(errors).toEqual([
      ["[codex-bridge] app-server engine ready (codex 0.145.0)"],
    ]);
  });

  test("contains idle cleanup failures", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      await __testing.sweepIdleThreadsForTesting({
        sweepIdle: async () => {
          throw new Error("cleanup unavailable");
        },
      } as never);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      ["[codex-bridge] Idle sweep failed:", expect.any(Error)],
    ]);
  });

  test("contains rejected SSE keepalive writes", async () => {
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const timer = __testing.startSseKeepaliveForTesting(
      async () => {
        throw new Error("closed stream");
      },
      1,
    );

    try {
      for (let attempt = 0; attempt < 20 && errors.length === 0; attempt += 1) {
        await Bun.sleep(2);
      }
    } finally {
      clearInterval(timer);
      console.error = originalConsoleError;
    }

    expect(errors).toContainEqual([
      "[codex-bridge] Failed to write SSE keepalive:",
      expect.any(Error),
    ]);
  });

  test("writes keepalives with the latest replay cursor and an empty payload", async () => {
    jest.useFakeTimers();
    __testing.emitForTesting({
      type: "session.updated",
      sessionId: "keepalive-cursor",
    });
    const revision = __testing.eventRingForTesting().latestRevision;
    const writes: Array<{ event: string; data: string; id?: string }> = [];
    const timer = __testing.startSseKeepaliveForTesting(
      async (frame) => {
        writes.push(frame);
      },
      5,
    );

    try {
      jest.advanceTimersByTime(5);
      await Promise.resolve();
    } finally {
      clearInterval(timer);
      jest.useRealTimers();
    }

    expect(writes).toEqual([{
      event: "keepalive",
      id: String(revision),
      data: "{}",
    }]);
  });

  test("keeps an idle heartbeat floor while using the faster active cadence", async () => {
    jest.useFakeTimers();
    const idleWrites: number[] = [];
    const idleTimer = __testing.startSseKeepaliveForTesting(
      async () => {
        idleWrites.push(Date.now());
      },
      2,
      () => false,
      14,
    );
    try {
      jest.advanceTimersByTime(8);
      expect(idleWrites).toHaveLength(0);
      jest.advanceTimersByTime(6);
    } finally {
      clearInterval(idleTimer);
    }
    expect(idleWrites.length).toBeGreaterThanOrEqual(1);

    const activeWrites: number[] = [];
    const activeTimer = __testing.startSseKeepaliveForTesting(
      async () => {
        activeWrites.push(Date.now());
      },
      2,
      () => true,
      100,
    );
    try {
      jest.advanceTimersByTime(4);
    } finally {
      clearInterval(activeTimer);
      jest.useRealTimers();
    }
    expect(activeWrites.length).toBeGreaterThanOrEqual(2);
  });

  test("round-trips the bridge model cache and rejects stale or malformed caches", async () => {
    const root = temporaryRoot();
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    const cacheDir = join(root, "orkestrator-bridge");
    const cachePath = join(cacheDir, "models-cache.json");
    mkdirSync(cacheDir, { recursive: true });

    try {
      await __testing.writePersistedBridgeCache(__testing.FALLBACK_MODELS);
      await expect(__testing.readPersistedBridgeCache()).resolves.toEqual(
        __testing.FALLBACK_MODELS,
      );

      writeFileSync(cachePath, JSON.stringify({
        version: __testing.BRIDGE_MODEL_CACHE_VERSION - 1,
        models: __testing.FALLBACK_MODELS,
      }));
      await expect(__testing.readPersistedBridgeCache()).resolves.toBeNull();

      writeFileSync(cachePath, "{malformed");
      await expect(__testing.readPersistedBridgeCache()).resolves.toBeNull();

      writeFileSync(cachePath, JSON.stringify({
        version: __testing.BRIDGE_MODEL_CACHE_VERSION,
        models: [],
      }));
      await expect(__testing.readPersistedBridgeCache()).resolves.toBeNull();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("contains bridge model-cache persistence failures", async () => {
    const root = temporaryRoot();
    const blockingFile = join(root, "not-a-directory");
    writeFileSync(blockingFile, "blocked", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = blockingFile;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      await __testing.writePersistedBridgeCache(__testing.FALLBACK_MODELS);
    } finally {
      console.warn = originalWarn;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }

    expect(warnings).toEqual([
      ["[codex-bridge] Failed to persist model cache:", expect.any(String)],
    ]);
  });

  test("reads valid Codex CLI caches and contains malformed cache files", async () => {
    const root = temporaryRoot();
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    const path = join(root, "models_cache.json");

    try {
      writeFileSync(path, JSON.stringify({
        models: [{
          slug: "from-cli-cache",
          display_name: "From CLI cache",
          supported_reasoning_levels: [{ effort: "medium" }],
        }],
      }));
      await expect(__testing.readCodexCliModelCache()).resolves.toEqual([
        expect.objectContaining({ id: "from-cli-cache", name: "From CLI cache" }),
      ]);

      writeFileSync(path, "{malformed");
      await expect(__testing.readCodexCliModelCache()).resolves.toBeNull();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("contains live model lookup failures and ignores empty catalogs", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      const failure = async () => {
        throw new Error("debug models unavailable");
      };
      await expect(__testing.fetchLiveModelsFromCliForTesting(
        failure as never,
        { CODEX_PATH: "/opt/test-codex" },
      )).resolves.toBeNull();

      const empty = async () => ({ stdout: JSON.stringify({ models: [] }), stderr: "" });
      await expect(__testing.fetchLiveModelsFromCliForTesting(
        empty as never,
        { CODEX_PATH: "/opt/test-codex" },
      )).resolves.toBeNull();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      ["[codex-bridge] `codex debug models` failed:", "debug models unavailable"],
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
    expect(extract([
      {
        type: "input_text",
        text: "<recommended_plugins>\nPlease compare these plugin recommendations.",
      },
    ], "user")).toBe(
      "<recommended_plugins>\nPlease compare these plugin recommendations.",
    );
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
