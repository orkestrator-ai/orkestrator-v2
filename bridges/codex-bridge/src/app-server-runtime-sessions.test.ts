import { afterEach, beforeEach, describe, test, expect } from "bun:test";


import { EventEmitter } from "node:events";


import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";


import { tmpdir } from "node:os";


import { join } from "node:path";


import {
  AppServerRuntime,
  DEFAULT_THREAD_IDLE_MS,
  estimateOrderedEventBytes,
  MAX_PENDING_EVENTS_PER_TURN,
  MAX_PENDING_TURNS,
  MAX_RECOVERED_CONTEXT_CHARS,
  mergeRateLimitWindows,
  messageSnapshotIntervalMs,
  normalizedMessageSnapshotChars,
  type RuntimeSseEvent,
} from "./app-server-runtime.js";


import { AppServerEngine } from "./engine/app-server-engine.js";


import type { AppServerSupervisorOptions } from "./app-server/process-supervisor.js";


import { FakeReadable, FakeWritable } from "./app-server/testing/fake-app-server.js";


import { MAX_LOCAL_MESSAGES, phaseToExternalStatus } from "./sessions/thread-registry.js";


import {
  BRIDGE_SESSION_REGISTRY_VERSION,
  BridgeSessionStore,
  hashCwd,
} from "./sessions/persistence.js";


import { DispatchJournal } from "./sessions/dispatch-journal.js";


import { persistSessionTitle } from "./session-titles.js";


import { getTranscriptCatalogInvalidationCountForTesting } from "./history/rollout.js";


import { AppServerProcessExitError, AppServerTimeoutError } from "./app-server/errors.js";


import type {
  EngineEvent,
  EngineRateLimitWindow,
  EngineRateLimitWindowUpdate,
} from "./engine/types.js";



/**
 * Returned by a handler to model a request app-server never answers — the exact
 * shape of an ambiguous dispatch, where the write may have landed but no response
 * ever arrives.
 */
const NO_RESPONSE = Symbol("no-response");



async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}



function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}



async function captureConsoleErrors(
  work: (errors: unknown[][]) => Promise<void>,
): Promise<unknown[][]> {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await work(errors);
    return errors;
  } finally {
    console.error = original;
  }
}



/** Scripted app-server child, driven by a per-method handler map. */
class ScriptedChild extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = { setEncoding() {}, on() {} };
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(
    readonly pid: number,
    private readonly handlers: Record<string, (params: Record<string, unknown>) => unknown>,
  ) {
    super();
    const write = this.stdin.write.bind(this.stdin);
    this.stdin.write = (chunk: string, callback?: (error?: Error | null) => void) => {
      const result = write(chunk, callback);
      queueMicrotask(() => this.answer(chunk));
      return result;
    };
  }

  waitForRequest(method: string, occurrence = 1): Promise<void> {
    const countRequests = () =>
      this.requests.filter((request) => request.method === method).length;
    if (countRequests() >= occurrence) return Promise.resolve();
    return new Promise((resolve) => {
      const onRequest = () => {
        if (countRequests() < occurrence) return;
        this.off("request", onRequest);
        resolve();
      };
      this.on("request", onRequest);
    });
  }

  private answer(chunk: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(chunk.trim());
    } catch {
      return;
    }
    const method = String(message.method ?? "");
    if (!method) return;
    this.requests.push({ method, params: (message.params ?? {}) as Record<string, unknown> });
    this.emit("request");
    if (message.id === undefined) return;

    const handler = this.handlers[method];
    if (!handler) {
      this.stdout.pushMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown ${method}` },
      });
      return;
    }
    const respondWithError = (error: unknown) => {
      this.stdout.pushMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: (error as { rpcCode?: number }).rpcCode ?? -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    };

    try {
      const result = handler((message.params ?? {}) as Record<string, unknown>);
      if (result === NO_RESPONSE) return;
      // A handler may answer late, which is how a test models a slow app-server
      // without stalling the whole read loop.
      if (result instanceof Promise) {
        void result.then(
          (resolved) => {
            if (resolved === NO_RESPONSE) return;
            this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result: resolved });
          },
          respondWithError,
        );
        return;
      }
      this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      respondWithError(error);
    }
  }

  notify(method: string, params: unknown): void {
    this.stdout.pushMessage({ jsonrpc: "2.0", method, params });
  }

  kill(): boolean {
    this.exit(null, "SIGTERM");
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit("exit", code, signal);
  }
}



function threadPayload(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    sessionId: id,
    cwd: "/tmp/ws",
    preview: "preview text",
    source: "appServer",
    parentThreadId: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    name: null,
    turns: [],
    ...extra,
  };
}



const BASE_HANDLERS: Record<string, (params: Record<string, unknown>) => unknown> = {
  initialize: () => ({
    userAgent: "orkestrator/0.145.0 (test)",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "macos",
  }),
  "thread/start": () => ({ thread: threadPayload("thread-1") }),
  // Recovery re-subscribes the thread on the replacement child.
  "thread/resume": (params) => ({
    thread: threadPayload(String(params.threadId ?? "thread-1")),
  }),
  "turn/start": () => ({ turn: { id: "turn-1" } }),
  "turn/interrupt": () => ({}),
  "thread/unsubscribe": () => ({}),
  "thread/name/set": () => ({}),
  "thread/list": () => ({ data: [], nextCursor: null }),
  "model/list": () => ({ data: [], nextCursor: null }),
  "thread/read": () => ({ thread: threadPayload("thread-1") }),
};



interface Harness {
  runtime: AppServerRuntime;
  engine: AppServerEngine;
  events: RuntimeSseEvent[];
  children: ScriptedChild[];
  child: () => ScriptedChild;
  drain: () => Promise<void>;
  waitForEvent: (predicate: (event: RuntimeSseEvent) => boolean) => Promise<RuntimeSseEvent>;
}



let codexHome = "";


let previousCodexHome: string | undefined;


let previousCwd: string | undefined;



beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "ork-runtime-"));
  // The rollout parser resolves CODEX_HOME/CWD from the environment. Without
  // this the tests would scan the developer's real ~/.codex — slow, and the
  // results would depend on their local session history.
  previousCodexHome = process.env.CODEX_HOME;
  previousCwd = process.env.CWD;
  process.env.CODEX_HOME = codexHome;
  process.env.CWD = "/tmp/ws";
});



afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
});



async function harness(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  options: {
    generateTitle?: (prompt: string) => Promise<string>;
    now?: () => number;
    threadIdleMs?: number;
    sessionRetentionMs?: number;
    sweepIntervalMs?: number;
    environmentDrainTimeoutMs?: number;
    ambiguousRecoveryTimeoutMs?: number;
    compactionTimeoutMs?: number;
    orderedEventMaxCount?: number;
    orderedEventMaxBytes?: number;
    initialPromptRetryDelayMs?: number;
    dispatchJournalMaxRecords?: number;
    dispatchJournalMaxBytes?: number;
    fingerprintEnvironment?: () => string;
    /** Uses the production adaptive cadence instead of deterministic immediate publishes. */
    adaptiveCoalesce?: boolean;
    /** Leaves `runtime.start()` to the caller, so startup itself can be observed. */
    deferStart?: boolean;
  } = {},
): Promise<Harness> {
  const merged = { ...BASE_HANDLERS, ...handlers };
  const children: ScriptedChild[] = [];
  let index = 0;

  const engine = new AppServerEngine({
    codexPath: "/fake/codex",
    cwd: "/tmp/ws",
    codexHome,
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    interruptTimeoutMs: 30,
    supervisorOverrides: {
      pidFileEnabled: false,
      shutdownGraceMs: 5,
      backoffScheduleMs: [1],
      refreshEnvironment: async () => undefined,
      ...(options.fingerprintEnvironment
        ? { fingerprintEnvironment: options.fingerprintEnvironment }
        : {}),
      spawnProcess: (() => {
        index += 1;
        const child = new ScriptedChild(2000 + index, merged);
        children.push(child);
        return child;
      }) as unknown as AppServerSupervisorOptions["spawnProcess"],
    },
  });

  const events: RuntimeSseEvent[] = [];
  const eventWaiters = new Set<{
    predicate: (event: RuntimeSseEvent) => boolean;
    resolve: (event: RuntimeSseEvent) => void;
  }>();
  const runtime = new AppServerRuntime({
    engine,
    codexHome,
    cwd: "/tmp/ws",
    emit: (event) => {
      events.push(event);
      for (const waiter of eventWaiters) {
        if (!waiter.predicate(event)) continue;
        eventWaiters.delete(waiter);
        waiter.resolve(event);
      }
    },
    loadCachedModels: async () => ({
      models: [{ id: "cached-model", name: "Cached", reasoningEfforts: [], reasoningOptions: [] } as never],
      source: "cache",
    }),
    // Deltas are published on a cadence; zero keeps most tests deterministic.
    ...(options.adaptiveCoalesce ? {} : { coalesceIntervalMs: 0 }),
    generateTitle: options.generateTitle,
    ...(options.now ? { now: options.now } : {}),
    ...(options.threadIdleMs !== undefined ? { threadIdleMs: options.threadIdleMs } : {}),
    ...(options.sessionRetentionMs !== undefined
      ? { sessionRetentionMs: options.sessionRetentionMs }
      : {}),
    // Tests drive the sweep explicitly rather than waiting on a timer.
    sweepIntervalMs: options.sweepIntervalMs ?? 0,
    ...(options.environmentDrainTimeoutMs !== undefined
      ? { environmentDrainTimeoutMs: options.environmentDrainTimeoutMs }
      : {}),
    ...(options.ambiguousRecoveryTimeoutMs !== undefined
      ? { ambiguousRecoveryTimeoutMs: options.ambiguousRecoveryTimeoutMs }
      : {}),
    ...(options.compactionTimeoutMs !== undefined
      ? { compactionTimeoutMs: options.compactionTimeoutMs }
      : {}),
    ...(options.orderedEventMaxCount !== undefined
      ? { orderedEventMaxCount: options.orderedEventMaxCount }
      : {}),
    ...(options.orderedEventMaxBytes !== undefined
      ? { orderedEventMaxBytes: options.orderedEventMaxBytes }
      : {}),
    ...(options.initialPromptRetryDelayMs !== undefined
      ? { initialPromptRetryDelayMs: options.initialPromptRetryDelayMs }
      : {}),
    ...(options.dispatchJournalMaxRecords !== undefined
      ? { dispatchJournalMaxRecords: options.dispatchJournalMaxRecords }
      : {}),
    ...(options.dispatchJournalMaxBytes !== undefined
      ? { dispatchJournalMaxBytes: options.dispatchJournalMaxBytes }
      : {}),
  });
  if (options.deferStart !== true) await runtime.start();

  /**
   * Settles the notification queue *and* the async work it kicks off.
   *
   * Finalization (journal write, render, SSE) is intentionally not awaited by the
   * transport — that is what keeps app-server's outbound queue from stalling — so
   * the test has to let those tasks land before asserting.
   */
  const drain = async () => {
    await engine.getSupervisor().notificationQueue.drainAll();
    await runtime.drainPendingWork();
  };

  const waitForEvent = (predicate: (event: RuntimeSseEvent) => boolean) =>
    new Promise<RuntimeSseEvent>((resolve) => {
      eventWaiters.add({ predicate, resolve });
    });

  return {
    runtime,
    engine,
    events,
    children,
    child: () => children.at(-1)!,
    drain,
    waitForEvent,
  };
}



/** Writes a rollout with real `turn_context` boundaries, as Codex does. */
function writeRolloutWithTurns(
  threadId: string,
  turns: Array<{ turnId: string; user: string; assistant: string; model?: string }>,
): void {
  const sessionsDir = join(codexHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const records: unknown[] = [
    {
      type: "session_meta",
      payload: { id: threadId, cwd: "/tmp/ws", timestamp: "2026-07-25T12:00:00.000Z" },
    },
  ];
  for (const turn of turns) {
    records.push({
      type: "turn_context",
      payload: {
        turn_id: turn.turnId,
        cwd: "/tmp/ws",
        ...(turn.model ? { model: turn.model } : {}),
      },
    });
    records.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: turn.user }],
      },
    });
    records.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: turn.assistant }],
      },
    });
  }
  writeFileSync(
    join(sessionsDir, `${threadId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}



describe("same thread in two tabs", () => {
  test("both tabs share one canonical transcript", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-7") }),
    });

    const first = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    const second = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(h.runtime.getStatus(first!.sessionId)?.messageRevision).toBe(0);
    expect(h.runtime.getStatus(second!.sessionId)?.messageRevision).toBe(0);

    await h.runtime.prompt(first!.sessionId, {
      prompt: "from tab A",
      requestId: "req-1",
      attachments: [],
    });

    // Tab B sees tab A's message because they share the ThreadContext.
    const messagesB = (await h.runtime.getMessages(second!.sessionId))!;
    expect(messagesB.some((message) => message.content === "from tab A")).toBe(true);
    expect(h.runtime.getStatus(first!.sessionId)?.messageRevision).toBe(1);
    expect(h.runtime.getStatus(second!.sessionId)?.messageRevision).toBe(1);

    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-7",
      turnId: "turn-1",
      itemId: "answer",
      delta: "shared answer",
    });
    await h.drain();
    const firstStreamingRevision = h.runtime.getStatus(first!.sessionId)!.messageRevision;
    expect(firstStreamingRevision).toBeGreaterThan(1);
    expect(h.runtime.getStatus(second!.sessionId)?.messageRevision).toBe(firstStreamingRevision);
  });

  test("a second tab cannot start an overlapping turn", async () => {
    const h = await harness({ "thread/resume": () => ({ thread: threadPayload("thread-7") }) });
    const a = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    const b = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });

    await h.runtime.prompt(a!.sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    const outcome = await h.runtime.prompt(b!.sessionId, {
      prompt: "y",
      requestId: "req-2",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  /**
   * Two persisted records may legitimately point at one thread, and a restored
   * session never passes through `attach`. Every emit path iterates
   * `bridgeSessionIds`, so a session missing from that set gets no status, no
   * messages and no approval cards — not even for prompts it sends itself.
   */
  test("a restored session joins the thread another session already holds", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    for (const bridgeSessionId of ["session-one", "session-two"]) {
      await store.upsert(
        store.toRecord({
          bridgeSessionId,
          threadId: "thread-shared",
          cwd: "/tmp/ws",
          config: { mode: "build", sandbox: "danger-full-access" },
        }),
      );
    }

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-shared") }),
    });

    expect(await h.runtime.getMessages("session-one")).toEqual([]);
    expect(await h.runtime.getMessages("session-two")).toEqual([]);
    expect(h.runtime.getRegistry().getThread("thread-shared")!.bridgeSessionIds.size).toBe(2);

    h.events.length = 0;
    await h.runtime.prompt("session-two", { prompt: "x", requestId: "req-1", attachments: [] });
    const notified = new Set(
      h.events.filter((event) => event.type === "session.updated").map((event) => event.sessionId),
    );
    expect([...notified].sort()).toEqual(["session-one", "session-two"]);
  });

  test("closing one tab keeps the thread subscribed for the other", async () => {
    const h = await harness({ "thread/resume": () => ({ thread: threadPayload("thread-7") }) });
    const a = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });
    const b = await h.runtime.resumeSession({ threadId: "thread-7", mode: "build" });

    expect(await h.runtime.deleteSession(a!.sessionId)).toBe(true);
    expect(h.child().requests.some((r) => r.method === "thread/unsubscribe")).toBe(false);

    expect(await h.runtime.deleteSession(b!.sessionId)).toBe(true);
    const methods = h.child().requests.map((r) => r.method);
    expect(methods).toContain("thread/unsubscribe");
    // Deleting would destroy the user's conversation and its descendants.
    expect(methods).not.toContain("thread/delete");
  });
});



describe("environment refresh", () => {
  test("re-resumes an idle loaded thread before dispatching on a controlled restart", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      {
        "thread/resume": (params) => ({
          thread: threadPayload(String(params.threadId)),
        }),
      },
      { fingerprintEnvironment: () => fingerprint },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-before-refresh",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    expect(h.runtime.getStatus(sessionId)?.phase).toBe("idle");

    fingerprint = "sha256:two";
    expect((await h.runtime.prompt(sessionId, {
      prompt: "after refresh",
      requestId: "req-after-refresh",
      attachments: [],
    })).ok).toBe(true);

    expect(h.children).toHaveLength(2);
    const replacementMethods = h.child().requests.map((request) => request.method);
    expect(replacementMethods.indexOf("thread/resume")).toBeGreaterThanOrEqual(0);
    expect(replacementMethods.indexOf("thread/resume")).toBeLessThan(
      replacementMethods.indexOf("turn/start"),
    );
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      engineGeneration: 2,
    });
  });

  test("waits for active work in another thread before restarting the shared child", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      {
        "thread/resume": (params) => ({
          thread: threadPayload(String(params.threadId)),
        }),
      },
      { fingerprintEnvironment: () => fingerprint },
    );
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "long task",
      requestId: "req-a",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-2", mode: "build" });
    fingerprint = "sha256:two";

    let settled = false;
    const pending = h.runtime.prompt(second!.sessionId, {
      prompt: "next task",
      requestId: "req-b",
      attachments: [],
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(h.children).toHaveLength(1);

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    expect((await pending).ok).toBe(true);
    expect(h.children).toHaveLength(2);
  });

  test("a child death terminates the drain and settles after generation recovery", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      {
        "thread/resume": (params) => ({
          thread: threadPayload(String(params.threadId)),
        }),
      },
      { fingerprintEnvironment: () => fingerprint },
    );
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "long task",
      requestId: "req-a",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-2", mode: "build" });
    fingerprint = "sha256:two";

    const pending = h.runtime.prompt(second!.sessionId, {
      prompt: "after crash",
      requestId: "req-b",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.child().exit(1);

    const outcome = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("environment drain did not settle")), 500),
      ),
    ]);
    expect(outcome.ok).toBe(true);
    expect(h.children).toHaveLength(2);
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(true);
  });

  /**
   * The drain runs *inside* the supervisor's `drainPromise`, and `ensureReady`
   * blocks on that promise — so anything the drain waits for that itself needs an
   * RPC is a mutual wait that wedges every thread in the environment. The deadline
   * is what turns that from "the bridge is dead" into "one turn was interrupted".
   */
  test("the drain gives up at its deadline instead of wedging every thread", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      { "thread/resume": (params) => ({ thread: threadPayload(String(params.threadId)) }) },
      { fingerprintEnvironment: () => fingerprint, environmentDrainTimeoutMs: 40 },
    );
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "never finishes",
      requestId: "req-a",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-2", mode: "build" });
    fingerprint = "sha256:two";

    const outcome = await Promise.race([
      h.runtime.prompt(second!.sessionId, {
        prompt: "next task",
        requestId: "req-b",
        attachments: [],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("drain never gave up")), 2_000),
      ),
    ]);

    expect(outcome.ok).toBe(true);
    expect(h.children).toHaveLength(2);
  });

  test.each(["failed", "stopped"] as const)(
    "the drain stops waiting when the engine is %s",
    async (state) => {
      let fingerprint = "sha256:one";
      const h = await harness(
        { "thread/resume": (params) => ({ thread: threadPayload(String(params.threadId)) }) },
        { fingerprintEnvironment: () => fingerprint },
      );
      const first = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(first.sessionId, {
        prompt: "long task",
        requestId: "req-a",
        attachments: [],
      });
      const second = await h.runtime.resumeSession({ threadId: "thread-2", mode: "build" });

      const health = h.engine.getHealth.bind(h.engine);
      h.engine.getHealth = () => ({ ...health(), state });
      fingerprint = "sha256:two";

      // Nothing will ever report terminal on a dead engine, so waiting for the
      // running turn would be waiting forever.
      const outcome = await Promise.race([
        h.runtime.prompt(second!.sessionId, {
          prompt: "next task",
          requestId: "req-b",
          attachments: [],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("drain did not bail out")), 1_000),
        ),
      ]);
      expect(outcome.ok).toBe(true);
      expect(h.children).toHaveLength(2);
    },
  );

  test("the drain stops waiting once the bridge itself is shutting down", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      { "thread/resume": (params) => ({ thread: threadPayload(String(params.threadId)) }) },
      { fingerprintEnvironment: () => fingerprint },
    );
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "long task",
      requestId: "req-a",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-2", mode: "build" });

    const health = h.engine.getHealth.bind(h.engine);
    // A shutdown drain has already released its generation; the environment drain
    // that owns this wait still has a live child, which is why `draining` alone is
    // not an exit.
    h.engine.getHealth = () => ({ ...health(), state: "draining", pid: null });
    fingerprint = "sha256:two";

    const outcome = await Promise.race([
      h.runtime.prompt(second!.sessionId, {
        prompt: "next task",
        requestId: "req-b",
        attachments: [],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("drain did not bail out")), 1_000),
      ),
    ]);
    expect(outcome.ok).toBe(true);
  });

  /**
   * Regression: a prompt that has claimed `dispatchInFlight` but not yet reached
   * `turn/start` is waiting on an RPC — which is queued behind the drain — while
   * the drain waits for it to go idle. Neither can move, and every other thread is
   * stuck behind the same drain.
   */
  test("a prompt parked before turn/start cannot deadlock another thread's restart", async () => {
    let fingerprint = "sha256:one";
    const h = await harness(
      { "thread/resume": (params) => ({ thread: threadPayload(String(params.threadId)) }) },
      { fingerprintEnvironment: () => fingerprint, environmentDrainTimeoutMs: 40 },
    );
    const a = await h.runtime.resumeSession({ threadId: "thread-a", mode: "build" });
    const b = await h.runtime.resumeSession({ threadId: "thread-b", mode: "build" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const startTurn = h.engine.startTurn.bind(h.engine);
    h.engine.startTurn = async (options) => {
      // Only thread B's dispatch is parked; it has already claimed the thread.
      if (!gated) {
        gated = true;
        await gate;
      }
      return startTurn(options);
    };

    const promptB = h.runtime.prompt(b!.sessionId, {
      prompt: "parked",
      requestId: "req-b",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.runtime.getRegistry().getThread("thread-b")!.dispatchInFlight).toBe(true);

    fingerprint = "sha256:two";
    const outcomeA = await Promise.race([
      h.runtime.prompt(a!.sessionId, { prompt: "a", requestId: "req-a", attachments: [] }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("thread A deadlocked behind the drain")), 3_000),
      ),
    ]);
    expect(outcomeA.ok).toBe(true);

    release();
    await Promise.race([
      promptB,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("thread B never settled")), 3_000),
      ),
    ]);
  });

  test("a thread never waits on its own in-flight dispatch", async () => {
    const h = await harness(
      { "thread/resume": (params) => ({ thread: threadPayload(String(params.threadId)) }) },
      { environmentDrainTimeoutMs: 5_000 },
    );
    await h.runtime.resumeSession({ threadId: "thread-solo", mode: "build" });
    h.runtime.getRegistry().getThread("thread-solo")!.dispatchInFlight = true;

    // Driven directly: a caller can only reach the drain once its own thread has
    // passed the overlapping-turn guard, so the exclusion is unreachable through
    // `prompt` — but it is the difference between a drain and a wait on itself.
    const runtime = h.runtime as unknown as {
      waitForAllThreadsIdle: (
        generation: number,
        options?: { excludeThreadId?: string | null },
      ) => Promise<void>;
    };
    const generation = h.engine.info().generation;

    await Promise.race([
      runtime.waitForAllThreadsIdle(generation, { excludeThreadId: "thread-solo" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("a thread waited on itself")), 500),
      ),
    ]);

    // Without the exclusion the same wait runs to its deadline.
    let settled = false;
    void runtime.waitForAllThreadsIdle(generation).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
  });
});



describe("models", () => {
  test("publishes app-server's resolved and rerouted model on the assistant message", async () => {
    let turnNumber = 0;
    const h = await harness({
      "thread/start": () => ({
        thread: threadPayload("thread-1"),
        model: "gpt-resolved",
      }),
      "turn/start": () => ({
        turn: { id: `turn-${(turnNumber += 1)}` },
      }),
    });
    const { sessionId } = h.runtime.createSession({
      mode: "build",
      model: "gpt-requested",
    });

    await h.runtime.prompt(sessionId, {
      prompt: "Use the confirmed model",
      requestId: "req-model",
      attachments: [],
    });

    let assistant = (await h.runtime.getMessages(sessionId))
      ?.find((message) => message.role === "assistant");
    expect(assistant?.modelId).toBe("gpt-resolved");
    const secondTab = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
      model: "gpt-requested",
    });

    h.child().notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-settings-confirmed" },
    });
    await h.drain();
    assistant = (await h.runtime.getMessages(sessionId))
      ?.find((message) => message.role === "assistant");
    expect(assistant?.modelId).toBe("gpt-settings-confirmed");

    h.child().notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-settings-confirmed",
      toModel: "gpt-rerouted",
      reason: "highRiskCyber",
    });
    await h.drain();
    assistant = (await h.runtime.getMessages(sessionId))
      ?.find((message) => message.role === "assistant");
    expect(assistant?.modelId).toBe("gpt-rerouted");

    // Thread settings describe the default for future turns. They must not
    // overwrite a turn-scoped reroute on the still-active assistant message.
    h.child().notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-settings-confirmed" },
    });
    await h.drain();
    assistant = (await h.runtime.getMessages(sessionId))
      ?.find((message) => message.role === "assistant");
    expect(assistant?.modelId).toBe("gpt-rerouted");

    const rerouteRecipients = new Set(
      h.events
        .filter((event) =>
          event.type === "message.updated"
          && (
            event.data as { message?: { modelId?: string } } | undefined
          )?.message?.modelId === "gpt-rerouted"
        )
        .map((event) => event.sessionId),
    );
    expect(rerouteRecipients).toEqual(new Set([sessionId, secondTab?.sessionId]));

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    await h.runtime.prompt(sessionId, {
      prompt: "Use the confirmed model again",
      requestId: "req-model-2",
      attachments: [],
    });

    let assistants = (await h.runtime.getMessages(sessionId))
      ?.filter((message) => message.role === "assistant");
    expect(assistants?.[1]?.modelId).toBe("gpt-settings-confirmed");

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    });
    await h.drain();
    expect(await h.runtime.updateConfig(sessionId, {
      mode: "build",
      model: "gpt-new-request",
    })).toBe("updated");
    await h.runtime.prompt(sessionId, {
      prompt: "Wait for the new confirmation",
      requestId: "req-model-3",
      attachments: [],
    });
    assistants = (await h.runtime.getMessages(sessionId))
      ?.filter((message) => message.role === "assistant");
    expect(assistants?.[2]?.modelId).toBeUndefined();
  });

  test("applies a post-steer reroute to every assistant segment of the turn", async () => {
    const h = await harness({
      "thread/start": () => ({
        thread: threadPayload("thread-1"),
        model: "gpt-start",
      }),
      "turn/steer": () => ({ turnId: "turn-1" }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Investigate",
      requestId: "req-reroute-segments",
      attachments: [],
    });
    expect(
      await h.runtime.steerSession(
        sessionId,
        "Also inspect tests",
        "turn-1",
        "req-reroute-steer",
      ),
    ).toBe("accepted");

    h.child().notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-start",
      toModel: "gpt-rerouted",
    });
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "assistant")
        .map((message) => message.modelId),
    ).toEqual(["gpt-rerouted", "gpt-rerouted"]);
  });

  test("restores a rerouted model after idle detach and rollout rehydration", async () => {
    let clock = 1_000_000;
    const h = await harness(
      {
        "thread/start": () => ({
          thread: threadPayload("thread-1"),
          model: "gpt-start",
        }),
      },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Persist the reroute",
      requestId: "req-reroute",
      attachments: [],
    });
    h.child().notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-start",
      toModel: "gpt-rerouted",
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    writeRolloutWithTurns("thread-1", [{
      turnId: "turn-1",
      user: "Persist the reroute",
      assistant: "Done",
      model: "gpt-start",
    }]);

    clock += 60_000;
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 1 });
    expect(h.runtime.getRegistry().getThread("thread-1")).toBeUndefined();

    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.find((message) => message.role === "assistant")?.modelId)
      .toBe("gpt-rerouted");
  });

  test("persists reroutes for inactive sessions across a stale-first restart", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    for (const bridgeSessionId of ["session-active", "session-inactive"]) {
      await store.upsert(
        store.toRecord({
          bridgeSessionId,
          threadId: "thread-shared-model",
          cwd: "/tmp/ws",
          config: { mode: "build" },
        }),
      );
    }
    const first = await harness({
      "thread/resume": () => ({
        thread: threadPayload("thread-shared-model"),
        model: "gpt-start",
      }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    expect(await first.runtime.getMessages("session-active")).toEqual([]);
    await first.runtime.prompt("session-active", {
      prompt: "Persist for both tabs",
      requestId: "req-shared-reroute",
      attachments: [],
    });
    // session-inactive is restored in the registry but has never attached.
    expect(
      first.runtime.getRegistry().getThread("thread-shared-model")?.bridgeSessionIds,
    ).toEqual(new Set(["session-active"]));

    first.child().notify("model/rerouted", {
      threadId: "thread-shared-model",
      turnId: "turn-1",
      fromModel: "gpt-start",
      toModel: "gpt-rerouted",
    });
    first.child().notify("turn/completed", {
      threadId: "thread-shared-model",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.drain();
    writeRolloutWithTurns("thread-shared-model", [{
      turnId: "turn-1",
      user: "Persist for both tabs",
      assistant: "Done",
      model: "gpt-start",
    }]);
    await first.runtime.stop();

    expect(
      (await store.load()).map((record) => [
        record.bridgeSessionId,
        record.confirmedModelsByTurn?.["turn-1"],
      ]).sort(),
    ).toEqual([
      ["session-active", "gpt-rerouted"],
      ["session-inactive", "gpt-rerouted"],
    ]);

    const restarted = await harness({
      "thread/resume": () => ({
        thread: threadPayload("thread-shared-model"),
        model: "gpt-start",
      }),
    });
    // Reopen the formerly inactive tab first, then join the formerly active one.
    for (const sessionId of ["session-inactive", "session-active"]) {
      expect(
        (await restarted.runtime.getMessages(sessionId))
          ?.find((message) => message.role === "assistant")?.modelId,
      ).toBe("gpt-rerouted");
    }
  });

  test("a joining overlay updates an already hydrated transcript and every view", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-first",
        threadId: "thread-overlay-join",
        cwd: "/tmp/ws",
        config: { mode: "build" },
        confirmedModelsByTurn: { "turn-1": "gpt-first-reroute" },
      }),
    );
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-second",
        threadId: "thread-overlay-join",
        cwd: "/tmp/ws",
        config: { mode: "build" },
        confirmedModelsByTurn: { "turn-2": "gpt-second-reroute" },
      }),
    );
    writeRolloutWithTurns("thread-overlay-join", [
      {
        turnId: "turn-1",
        user: "First",
        assistant: "First answer",
        model: "gpt-rollout",
      },
      {
        turnId: "turn-2",
        user: "Second",
        assistant: "Second answer",
        model: "gpt-rollout",
      },
    ]);
    const h = await harness({
      "thread/resume": () => ({
        thread: threadPayload("thread-overlay-join"),
      }),
    });

    const initial = await h.runtime.getMessages("session-first");
    expect(
      initial?.find(
        (message) => message.role === "assistant" && message.turnId === "turn-1",
      )?.modelId,
    )
      .toBe("gpt-first-reroute");
    expect(
      initial?.find(
        (message) => message.role === "assistant" && message.turnId === "turn-2",
      )?.modelId,
    )
      .toBe("gpt-rollout");
    const revisionBeforeJoin =
      h.runtime.getStatus("session-first")?.messageRevision ?? 0;
    h.events.length = 0;

    const joined = await h.runtime.getMessages("session-second");
    expect(
      joined?.find(
        (message) => message.role === "assistant" && message.turnId === "turn-2",
      )?.modelId,
    )
      .toBe("gpt-second-reroute");
    expect(h.runtime.getStatus("session-first")?.messageRevision)
      .toBeGreaterThan(revisionBeforeJoin);
    const recipients = new Set(
      h.events
        .filter((event) =>
          event.type === "message.updated"
          && (
            event.data as { message?: { turnId?: string; modelId?: string } }
          ).message?.turnId === "turn-2"
        )
        .map((event) => event.sessionId),
    );
    expect(recipients).toEqual(new Set(["session-first", "session-second"]));
    expect(
      (await store.load()).every(
        (record) =>
          record.confirmedModelsByTurn?.["turn-1"] === "gpt-first-reroute"
          && record.confirmedModelsByTurn?.["turn-2"] === "gpt-second-reroute",
      ),
    ).toBe(true);
  });

  test("matches confirmations during active-turn and dispatch race windows", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Exercise race fallbacks",
      requestId: "req-race",
      attachments: [],
    });
    const context = h.runtime.getRegistry().getThread("thread-1")!;
    const assistant = context.messages.find((message) => message.role === "assistant")!;

    // A reroute can race the assignment made after turn/start returns.
    assistant.turnId = undefined;
    h.child().notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      toModel: "gpt-active-fallback",
    });
    await h.drain();
    expect(assistant.modelId).toBe("gpt-active-fallback");

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // A settings notification can also land after the optimistic assistant was
    // appended but before an active accumulator was installed.
    context.confirmedModelsByTurn.clear();
    context.dispatchInFlight = true;
    h.child().notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-dispatch-fallback" },
    });
    await h.drain();
    expect(assistant.modelId).toBe("gpt-dispatch-fallback");
    context.dispatchInFlight = false;
  });

  test("uses resume-confirmed models for the next turn", async () => {
    writeRolloutWithTurns("thread-resume-model", [{
      turnId: "old-turn",
      user: "Old",
      assistant: "History",
    }]);
    const h = await harness({
      "thread/resume": () => ({
        thread: threadPayload("thread-resume-model"),
        model: "gpt-resumed",
      }),
      "turn/start": () => ({ turn: { id: "new-turn" } }),
    });
    const resumed = await h.runtime.resumeSession({
      threadId: "thread-resume-model",
      mode: "build",
    });

    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "Next",
      requestId: "req-resumed-model",
      attachments: [],
    });
    expect(
      (await h.runtime.getMessages(resumed!.sessionId))
        ?.filter((message) => message.role === "assistant")
        .at(-1)?.modelId,
    ).toBe("gpt-resumed");
  });

  test("uses an idle thread settings update for the next turn", async () => {
    let turnNumber = 0;
    const h = await harness({
      "turn/start": () => ({
        turn: { id: `turn-${(turnNumber += 1)}` },
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "First",
      requestId: "req-idle-model-1",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    h.child().notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-idle-confirmed" },
    });
    await h.drain();
    await h.runtime.prompt(sessionId, {
      prompt: "Second",
      requestId: "req-idle-model-2",
      attachments: [],
    });

    expect(
      (await h.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "assistant")
        .at(-1)?.modelId,
    ).toBe("gpt-idle-confirmed");
  });

  test("uses fork-confirmed models for the fork's next turn", async () => {
    const h = await harness({
      "thread/fork": () => ({
        thread: threadPayload("thread-forked-model"),
        model: "gpt-fork-confirmed",
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Parent",
      requestId: "req-parent-model",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const forked = await h.runtime.forkSession(sessionId);
    expect(forked.outcome).toBe("created");
    if (forked.outcome !== "created") throw new Error("fork was not created");
    await h.runtime.prompt(forked.sessionId, {
      prompt: "Fork",
      requestId: "req-fork-model",
      attachments: [],
    });

    expect(
      (await h.runtime.getMessages(forked.sessionId))
        ?.filter((message) => message.role === "assistant")
        .at(-1)?.modelId,
    ).toBe("gpt-fork-confirmed");
  });

  test("uses the model reconfirmed while an idle thread rebinds", async () => {
    const h = await harness({
      "thread/resume": () => ({
        thread: threadPayload("thread-1"),
        model: "gpt-rebound",
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Before restart",
      requestId: "req-before-restart",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();
    await h.runtime.prompt(sessionId, {
      prompt: "After restart",
      requestId: "req-after-restart",
      attachments: [],
    });

    expect(
      (await h.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "assistant")
        .at(-1)?.modelId,
    ).toBe("gpt-rebound");
  });

  test("model/list is authoritative and preserves reasoning order", async () => {
    const h = await harness({
      "model/list": () => ({
        data: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "frontier",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "medium", description: "balanced" },
              { reasoningEffort: "xhigh", description: "deepest" },
            ],
          },
          { id: "hidden-one", displayName: "Hidden", hidden: true, supportedReasoningEfforts: [] },
        ],
        nextCursor: null,
      }),
    });

    const result = await h.runtime.listModels();
    expect(result.source).toBe("app-server");
    // Hidden models stay out of the picker.
    expect(result.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(result.models[0]!.reasoningEfforts).toEqual(["low", "medium", "xhigh"]);
    // "high" is not on offer, so app-server's own default has to survive
    // instead of collapsing to the first listed effort.
    expect(result.models[0]!.defaultReasoningEffort).toBe("medium");
  });

  test("raises the advertised default to high when the model offers it", async () => {
    const h = await harness({
      "model/list": () => ({
        data: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
          },
        ],
        nextCursor: null,
      }),
    });

    const result = await h.runtime.listModels();
    expect(result.models[0]!.defaultReasoningEffort).toBe("high");
    // The default must always be a selectable option.
    expect(result.models[0]!.reasoningEfforts)
      .toContain(result.models[0]!.defaultReasoningEffort);
  });

  test("keeps app-server's default when the model advertises no efforts", async () => {
    const h = await harness({
      "model/list": () => ({
        data: [
          {
            id: "gpt-effortless",
            displayName: "Effortless",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      }),
    });

    const result = await h.runtime.listModels();
    expect(result.models[0]!.reasoningEfforts).toEqual([]);
    expect(result.models[0]!.defaultReasoningEffort).toBe("medium");
  });

  test("falls back to the persisted cache when model/list fails", async () => {
    const h = await harness({
      "model/list": () => {
        throw new Error("no auth");
      },
    });

    // A cold app-server must not empty the model picker.
    expect(await h.runtime.listModels()).toMatchObject({ source: "cache" });
  });
});



describe("titles", () => {
  test("a generated title is dual-written to Codex and the bridge index", async () => {
    const h = await harness({}, { generateTitle: async () => "Generated Title" });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "some work", requestId: "req-1", attachments: [] });
    await h.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // thread/name/set makes Codex show it; the bridge index keeps it visible
    // after a rollback to the SDK engine.
    expect(h.child().requests.some((r) => r.method === "thread/name/set")).toBe(true);
    expect(
      h.events.some(
        (event) =>
          event.type === "session.title-updated" && event.data?.title === "Generated Title",
      ),
    ).toBe(true);
  });

  test("a generated title is persisted for every tab sharing the thread", async () => {
    let resolveTitle!: (title: string) => void;
    const h = await harness(
      {
        "thread/resume": () => ({ thread: threadPayload("thread-1") }),
      },
      {
        generateTitle: () =>
          new Promise<string>((resolve) => {
            resolveTitle = resolve;
          }),
      },
    );
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "shared title",
      requestId: "req-title",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
    });
    resolveTitle("Shared Generated Title");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const records = await new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
    }).load();
    expect(records.find((record) => record.bridgeSessionId === first.sessionId))
      .toMatchObject({ title: "Shared Generated Title", titleSource: "generated" });
    expect(records.find((record) => record.bridgeSessionId === second!.sessionId))
      .toMatchObject({ title: "Shared Generated Title", titleSource: "generated" });
  });

  /**
   * Title generation is slow enough to outlive the prompt that started it. A
   * superseded result must not overwrite a newer title, or the tab silently
   * renames itself back to a conversation the user has moved on from.
   */
  test("a superseded title generation does not overwrite the newer title", async () => {
    let resolveFirst!: (title: string) => void;
    let calls = 0;
    const h = await harness({}, {
      generateTitle: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return "Second Title";
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // A restored session retries generation, which is how a second generation can
    // start while the first is still in flight.
    const session = h.runtime.getRegistry().getSession(sessionId)!;
    session.titleGenerationAttempted = false;
    session.title = undefined;
    session.titleSource = undefined;

    await h.runtime.prompt(sessionId, { prompt: "second", requestId: "req-2", attachments: [] });
    for (let attempt = 0; attempt < 100 && session.title !== "Second Title"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(session.title).toBe("Second Title");

    resolveFirst("First Title");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(session.title).toBe("Second Title");
    expect(
      h.events.some(
        (event) => event.type === "session.title-updated" && event.data?.title === "First Title",
      ),
    ).toBe(false);
  });

  test("a prompt fallback title is emitted immediately", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "Fix the parser", requestId: "req-1", attachments: [] });

    expect(h.events.some((event) => event.type === "session.title-updated")).toBe(true);
  });

  test("a rejected title generation keeps the prompt fallback and clears its token", async () => {
    const h = await harness({}, {
      generateTitle: async () => {
        throw new Error("title service unavailable");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Fix the parser",
      requestId: "req-title-failure",
      attachments: [],
    });
    await Bun.sleep(10);

    const session = h.runtime.getRegistry().getSession(sessionId)!;
    expect(session.title).toBe("Fix the parser");
    expect(session.titleSource).toBe("prompt");
    expect(session.titleGenerationToken).toBeUndefined();
  });
});



describe("forking", () => {
  const FORK_HANDLERS = {
    "thread/fork": (params: Record<string, unknown>) => ({
      thread: threadPayload(`fork-of-${String(params.threadId)}`),
    }),
  };

  test("a session with no thread yet reports not-found, not a fork failure", async () => {
    const h = await harness(FORK_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(await h.runtime.forkSession(sessionId)).toEqual({ outcome: "not-found" });
    expect(await h.runtime.forkSession("session-does-not-exist")).toEqual({
      outcome: "not-found",
    });
  });

  test("a running session cannot be forked", async () => {
    const h = await harness({ ...FORK_HANDLERS });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    expect(await h.runtime.forkSession(sessionId)).toEqual({ outcome: "running" });
  });

  test("a lastMessageId that is in no transcript reports unknown-message", async () => {
    const h = await harness(FORK_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(await h.runtime.forkSession(sessionId, "message-that-never-existed")).toEqual({
      outcome: "unknown-message",
    });
  });

  test("forks the whole thread when no boundary message is given", async () => {
    const h = await harness(FORK_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const invalidationsBefore = getTranscriptCatalogInvalidationCountForTesting();
    const forked = await h.runtime.forkSession(sessionId);
    expect(forked).toMatchObject({ outcome: "created", threadId: "fork-of-thread-1" });
    expect(getTranscriptCatalogInvalidationCountForTesting())
      .toBe(invalidationsBefore + 1);
    const params = h.child().requests.find((request) => request.method === "thread/fork")?.params;
    expect(params && "lastTurnId" in params).toBe(false);
  });

  test("forks at the turn of an in-process message, on either bubble", async () => {
    const h = await harness(FORK_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    for (const message of messages) {
      // Both halves of the exchange carry the turn, so "fork from here" works
      // wherever the user clicks.
      expect(message.turnId).toBe("turn-1");
      const forked = await h.runtime.forkSession(sessionId, message.id);
      expect(forked.outcome).toBe("created");
      expect(h.child().requests.at(-1)?.params).toMatchObject({ lastTurnId: "turn-1" });
    }
  });

  /**
   * The regression. `turnId` used to be set in exactly one place — the user
   * message of a prompt this process dispatched — so after a detach/re-attach or
   * a bridge restart every message lost it and `forkSession` returned null, which
   * the route reported as "cannot fork while running".
   */
  test("forks at a turn reconstructed from the rollout, with no in-process dispatch", async () => {
    writeRolloutWithTurns("thread-hydrated", [
      { turnId: "turn-a", user: "first question", assistant: "first answer" },
      { turnId: "turn-b", user: "second question", assistant: "second answer" },
    ]);
    const h = await harness({
      ...FORK_HANDLERS,
      "thread/resume": () => ({ thread: threadPayload("thread-hydrated") }),
    });

    const resumed = await h.runtime.resumeSession({
      threadId: "thread-hydrated",
      mode: "build",
    });
    const messages = resumed!.messages;
    expect(messages.map((message) => message.turnId)).toEqual([
      "turn-a",
      "turn-a",
      "turn-b",
      "turn-b",
    ]);

    const forked = await h.runtime.forkSession(resumed!.sessionId, messages[1]!.id);
    expect(forked).toMatchObject({ outcome: "created" });
    expect(h.child().requests.at(-1)?.params).toMatchObject({ lastTurnId: "turn-a" });
  });

  test("survives a detach and re-attach, which used to erase every turn id", async () => {
    writeRolloutWithTurns("thread-detached", [
      { turnId: "turn-a", user: "question", assistant: "answer" },
    ]);
    const h = await harness(
      { ...FORK_HANDLERS, "thread/resume": () => ({ thread: threadPayload("thread-detached") }) },
      { threadIdleMs: 1 },
    );

    const resumed = await h.runtime.resumeSession({
      threadId: "thread-detached",
      mode: "build",
    });
    await Bun.sleep(5);
    expect((await h.runtime.sweepIdle()).detached).toBe(1);

    // Re-attaching rehydrates from the rollout, which is where the turn ids now
    // come from.
    const messages = (await h.runtime.getMessages(resumed!.sessionId))!;
    expect(messages[0]?.turnId).toBe("turn-a");
    expect(await h.runtime.forkSession(resumed!.sessionId, messages[0]!.id))
      .toMatchObject({ outcome: "created" });
  });

  test("a message with no resolvable turn reports no-fork-point, not a 409", async () => {
    // A rollout with no turn markers at all: every message is real, but none can
    // be attributed to a Codex turn, so there is no boundary to fork at.
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-no-turns.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { id: "thread-no-turns", cwd: "/tmp/ws", timestamp: "2026-07-25T12:00:00.000Z" },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "b" }] },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const h = await harness({
      ...FORK_HANDLERS,
      "thread/resume": () => ({ thread: threadPayload("thread-no-turns") }),
      // Two user messages, one turn: the mapping is unprovable, so nothing is
      // guessed.
      "thread/read": () => ({
        thread: threadPayload("thread-no-turns", {
          turns: [{ id: "turn-only", status: "completed", items: [] }],
        }),
      }),
    });

    const resumed = await h.runtime.resumeSession({
      threadId: "thread-no-turns",
      mode: "build",
    });
    expect(await h.runtime.forkSession(resumed!.sessionId, resumed!.messages[0]!.id)).toEqual({
      outcome: "no-fork-point",
    });
    expect(h.child().requests.some((request) => request.method === "thread/fork")).toBe(false);
  });

  test("falls back to thread/read when the rollout carried no turn ids", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-legacy.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { id: "thread-legacy", cwd: "/tmp/ws", timestamp: "2026-07-25T12:00:00.000Z" },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "b" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const h = await harness({
      ...FORK_HANDLERS,
      "thread/resume": () => ({ thread: threadPayload("thread-legacy") }),
      "thread/read": () => ({
        thread: threadPayload("thread-legacy", {
          turns: [{ id: "turn-real", status: "completed", items: [] }],
        }),
      }),
    });

    const resumed = await h.runtime.resumeSession({ threadId: "thread-legacy", mode: "build" });
    expect(resumed!.messages[0]?.turnId).toBeUndefined();

    const forked = await h.runtime.forkSession(resumed!.sessionId, resumed!.messages[0]!.id);
    expect(forked).toMatchObject({ outcome: "created" });
    expect(h.child().requests.at(-1)?.params).toMatchObject({ lastTurnId: "turn-real" });
  });

  test("a fork that returns no thread id reports unavailable, not success", async () => {
    const h = await harness({
      "thread/fork": () => ({ thread: threadPayload("fork-1", { id: null }) }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(await h.runtime.forkSession(sessionId)).toEqual({ outcome: "unavailable" });
  });

  /** A forkable session whose turn has already finished. */
  async function forkableSession(
    handlers: Record<string, (params: Record<string, unknown>) => unknown> = FORK_HANDLERS,
  ) {
    const h = await harness(handlers);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    return { h, sessionId };
  }

  /**
   * A restarting app-server rejects `thread/fork` outright. Without a catch the
   * rejection escaped the route's own 404/409/422/503 mapping and Hono answered
   * a raw 500, which tells the UI nothing about whether it can retry.
   */
  test("an engine rejection reports unavailable rather than escaping the route", async () => {
    const { h, sessionId } = await forkableSession({
      "thread/fork": () => {
        throw new Error("app-server is restarting");
      },
    });

    expect(await h.runtime.forkSession(sessionId)).toEqual({ outcome: "unavailable" });
  });

  test("a fork that cannot be persisted is cleaned up instead of left orphaned", async () => {
    const { h, sessionId } = await forkableSession();
    const before = h.runtime.getRegistry().listSessions().length;
    // Fails *after* `registry.attach`, which is the window where a rejection used
    // to leave a child session bound to a fork no client was ever told about.
    (h.runtime as unknown as { persistSession: () => Promise<void> }).persistSession =
      async () => {
        throw new Error("session store is unwritable");
      };

    expect(await h.runtime.forkSession(sessionId)).toEqual({ outcome: "unavailable" });
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(before);
    expect(h.runtime.getRegistry().getThread("fork-of-thread-1")).toBeUndefined();
    // Released by unsubscribing. Deleting would destroy the user's rollout.
    expect(h.child().requests.some((request) => request.method === "thread/delete")).toBe(false);
    expect(h.child().requests.some((request) => request.method === "thread/unsubscribe")).toBe(
      true,
    );
  });
});



describe("compaction", () => {
  const COMPACT_HANDLERS = { "thread/compact/start": () => ({}) };

  async function compactableSession(
    extraHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  ) {
    const h = await harness({ ...COMPACT_HANDLERS, ...extraHandlers });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    return { h, sessionId };
  }

  test("a session with no thread reports not-found", async () => {
    const h = await harness(COMPACT_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.compactSession(sessionId)).toBe("not-found");
    expect(await h.runtime.compactSession("session-nope")).toBe("not-found");
  });

  test("a running session cannot be compacted", async () => {
    const h = await harness(COMPACT_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    expect(await h.runtime.compactSession(sessionId)).toBe("running");
  });

  /**
   * The regression. `thread/compact/start` returns immediately and the rewrite
   * continues in the background, so reporting `idle` in between let the next
   * prompt — or a build-pipeline step — race a context rewrite in progress.
   */
  test("the thread stays busy until thread/compacted arrives", async () => {
    const { h, sessionId } = await compactableSession();

    expect(await h.runtime.compactSession(sessionId)).toBe("accepted");
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "running" });

    // A prompt in this window must be refused, not interleaved with the rewrite.
    const overlapping = await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    });
    expect(overlapping).toMatchObject({ ok: false, status: 409 });

    h.child().notify("thread/compacted", { threadId: "thread-1", turnId: "turn-compact" });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    expect(h.events.some((event) => event.type === "session.idle")).toBe(true);
    expect(
      h.events.some((event) => event.data?.compacted === true && event.data?.compacting === false),
    ).toBe(true);
  });

  test("a compacting thread is never detached by the idle sweep", async () => {
    const { h, sessionId } = await compactableSession();
    await h.runtime.compactSession(sessionId);

    // Detaching would drop the state that is waiting for `thread/compacted`.
    expect((await h.runtime.sweepIdle()).detached).toBe(0);
  });

  test("a rejected compaction releases the busy state instead of wedging the thread", async () => {
    const { h, sessionId } = await compactableSession({
      "thread/compact/start": () => {
        throw new Error("nothing to compact");
      },
    });

    expect(await h.runtime.compactSession(sessionId)).toBe("unavailable");
    expect(h.runtime.getStatus(sessionId)?.status).toBe("error");
    // The next prompt is accepted: the failed compaction holds nothing.
    expect(await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    })).toMatchObject({ ok: true });
  });

  test("a missing compacted notification is released by the deadline", async () => {
    const h = await harness(COMPACT_HANDLERS, { compactionTimeoutMs: 15 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(await h.runtime.compactSession(sessionId)).toBe("accepted");
    await Bun.sleep(35);

    expect(h.runtime.getRegistry().getThread("thread-1")?.compacting).toBe(false);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      error: expect.stringContaining("never reported"),
    });
  });

  test("abort releases a compaction hold so a lost notification cannot wedge it", async () => {
    const { h, sessionId } = await compactableSession();
    await h.runtime.compactSession(sessionId);
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");

    await h.runtime.abort(sessionId);

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    })).toMatchObject({ ok: true });
  });

  /**
   * The retraction has to reach *every* tab on the thread, not just the one that
   * called abort. Clearing the flag without emitting left any other mounted tab —
   * which had seen `{compacted: true, compacting: true}` — showing busy until it
   * happened to refetch.
   */
  test("abort emits the same retraction frames a finished compaction does", async () => {
    const { h, sessionId } = await compactableSession();
    const second = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    await h.runtime.compactSession(sessionId);
    h.events.length = 0;

    await h.runtime.abort(sessionId);

    for (const id of [sessionId, second!.sessionId]) {
      const forSession = h.events.filter((event) => event.sessionId === id);
      expect(forSession.some(
        (event) => event.type === "session.updated" && event.data?.status === "idle",
      )).toBe(true);
      expect(forSession.some(
        (event) => event.data?.compacted === true && event.data?.compacting === false,
      )).toBe(true);
      expect(forSession.some((event) => event.type === "session.idle")).toBe(true);
    }
  });

  /**
   * The hold can be released while `thread/compact/start` is still in flight — by
   * an abort, a generation change, or a `thread/compacted` arriving in the same
   * stdout chunk as the response, since the JSONL client dispatches every line of
   * a chunk synchronously. Announcing the hold afterwards would make
   * `compacting: true` the last word, with nothing left to retract it.
   */
  test("a hold released during the RPC is never re-announced afterwards", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { h, sessionId } = await compactableSession({
      "thread/compact/start": async () => {
        await inFlight;
        return {};
      },
    });

    const compaction = h.runtime.compactSession(sessionId);
    await Bun.sleep(1);
    await h.runtime.abort(sessionId);
    release();

    expect(await compaction).toBe("accepted");
    await h.drain();
    expect(h.events.some((event) => event.data?.compacting === true)).toBe(false);
    expect(
      h.events.some((event) => event.data?.compacted === true && event.data?.compacting === false),
    ).toBe(true);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
  });

  test("a generation change releases a compaction the dead child can never finish", async () => {
    const { h, sessionId } = await compactableSession();
    await h.runtime.compactSession(sessionId);

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();
    await h.drain();

    // Recovery must not leave the thread pinned on a notification that belongs to
    // a process that no longer exists.
    expect(h.runtime.getRegistry().getThread("thread-1")?.compacting).toBe(false);
  });

  test("a late thread/compacted never drags a newly running turn back to idle", async () => {
    const { h, sessionId } = await compactableSession();
    await h.runtime.compactSession(sessionId);
    h.child().notify("thread/compacted", { threadId: "thread-1", turnId: "turn-compact" });
    await h.drain();

    await h.runtime.prompt(sessionId, { prompt: "next", requestId: "req-2", attachments: [] });
    h.child().notify("thread/compacted", { threadId: "thread-1", turnId: "turn-compact" });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
  });
});



describe("native review", () => {
  const REVIEW_HANDLERS = {
    "review/start": () => ({ reviewThreadId: "review-1", turn: { id: "turn-review" } }),
  };

  async function reviewableSession(
    extraHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
    options: Parameters<typeof harness>[1] = {},
  ) {
    const h = await harness({ ...REVIEW_HANDLERS, ...extraHandlers }, options);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    h.events.length = 0;
    return { h, sessionId };
  }

  test("reports not-found before the session has a thread", async () => {
    const h = await harness(REVIEW_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" }))
      .toEqual({ outcome: "not-found" });
  });

  test("starts the review turn and streams into its assistant message", async () => {
    const { h, sessionId } = await reviewableSession({}, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });

    const started = await h.runtime.startNativeReview(sessionId, {
      type: "baseBranch",
      branch: "main",
    });
    expect(started).toEqual({ outcome: "accepted", turnId: "turn-review" });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      turnId: "turn-review",
      turnStartedAt: "2026-08-01T12:34:56.000Z",
    });
    await h.drain();
    expect(h.events).toContainEqual({
      type: "session.updated",
      sessionId,
      data: {
        status: "running",
        phase: "running",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    expect(h.child().requests.find((request) => request.method === "review/start")?.params)
      .toMatchObject({ target: { type: "baseBranch", branch: "main" }, delivery: "inline" });

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-review",
      item: { id: "i1", type: "agentMessage", text: "looks fine" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-review", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "looks fine",
      turnId: "turn-review",
    });
    expect(h.runtime.getStatus(sessionId)?.status).toBe("idle");
  });

  test("a review cannot start while a turn is running", async () => {
    const h = await harness(REVIEW_HANDLERS);
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    expect(await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" }))
      .toEqual({ outcome: "running" });
  });

  /**
   * The regression. `review/start` is a full round-trip; the thread used to read
   * idle to the overlap guard for its whole duration, so a prompt arriving in the
   * gap registered its own accumulator and was then silently replaced — its
   * `turn.completed` classified stale and dropped, leaving the thread `running`
   * on a turn nothing would ever complete.
   */
  test("a prompt racing review/start is refused, not silently replaced", async () => {
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const { h, sessionId } = await reviewableSession({
      "review/start": async () => {
        await reviewGate;
        return { reviewThreadId: "review-1", turn: { id: "turn-review" } };
      },
    });

    const review = h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" });
    await Bun.sleep(5);

    // The window the guard has to close.
    const racing = await h.runtime.prompt(sessionId, {
      prompt: "meanwhile",
      requestId: "req-race",
      attachments: [],
    });
    expect(racing).toMatchObject({ ok: false, status: 409 });

    releaseReview();
    expect(await review).toEqual({ outcome: "accepted", turnId: "turn-review" });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ turnId: "turn-review" });

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-review", status: "completed" },
    });
    await h.drain();
    // The turn that actually ran is the one that completes it.
    expect(h.runtime.getStatus(sessionId)?.status).toBe("idle");
  });

  test("a failed review rolls the optimistic bubble back with a revision bump", async () => {
    const { h, sessionId } = await reviewableSession({
      "review/start": () => {
        throw new Error("review is unavailable");
      },
    });
    const revisionBefore = h.runtime.getStatus(sessionId)!.messageRevision;
    const messagesBefore = (await h.runtime.getMessages(sessionId))!.length;

    expect(await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" }))
      .toEqual({ outcome: "unavailable" });

    expect((await h.runtime.getMessages(sessionId))!).toHaveLength(messagesBefore);
    // Without the second bump a reconciling tab has no signal to refetch and
    // keeps a permanently blank assistant bubble.
    expect(h.runtime.getStatus(sessionId)!.messageRevision).toBeGreaterThan(revisionBefore + 1);
    expect(
      h.events.some((event) => typeof event.data?.removedMessageId === "string"),
    ).toBe(true);
  });

  test("a failed review does not mark the whole session errored", async () => {
    const { h, sessionId } = await reviewableSession({
      "review/start": () => {
        throw new Error("review is unavailable");
      },
    });

    await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" });

    // No turn ran, so the thread is exactly where it was. Reporting `error` here
    // told the UI the conversation had failed.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    // The failure is still surfaced, just as an error event rather than a phase.
    expect(h.events.some((event) => event.type === "session.error")).toBe(true);
    // And the thread accepts work again immediately.
    expect(await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    })).toMatchObject({ ok: true });
  });

  test("a native review reattaches by turn id after an app-server restart", async () => {
    const { h, sessionId } = await reviewableSession({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [{ id: "turn-review", status: "inProgress", items: [] }],
        }),
      }),
    }, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    expect(await h.runtime.startNativeReview(sessionId, { type: "uncommittedChanges" }))
      .toEqual({ outcome: "accepted", turnId: "turn-review" });

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      turnId: "turn-review",
      turnStartedAt: "2026-08-01T12:34:56.000Z",
    });
    expect(h.runtime.getJournal().get("review-turn-review")).toBeUndefined();
  });

  test("review-start rejection after a child crash preserves the recovering phase", async () => {
    const { h, sessionId } = await reviewableSession({
      "review/start": () => NO_RESPONSE,
    }, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const review = h.runtime.startNativeReview(sessionId, {
      type: "uncommittedChanges",
    });
    await Bun.sleep(5);
    h.child().exit(1);

    expect(await review).toEqual({ outcome: "unavailable" });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "recovering",
      turnStartedAt: "2026-08-01T12:34:56.000Z",
    });
  });
});



describe("interactions", () => {
  const QUESTION_PARAMS = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    questions: [{
      id: "language",
      header: "Language",
      question: "Which language?",
      options: [{ label: "TypeScript" }],
    }],
  };

  async function askingSession(params: Record<string, unknown> = QUESTION_PARAMS) {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7001,
      method: "item/tool/requestUserInput",
      params,
    });
    await h.drain();
    return { h, sessionId };
  }

  test("presents a question to every tab on the thread and serves it for rehydration", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-before-question",
      delta: "Before question",
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7001,
      method: "item/tool/requestUserInput",
      params: QUESTION_PARAMS,
    });
    await h.drain();

    const requested = h.events.filter((event) => event.type === "session.interaction-requested");
    expect(requested).toHaveLength(1);
    expect(h.events.findLastIndex((event) => event.type === "message.patched"))
      .toBeLessThan(
        h.events.findIndex((event) => event.type === "session.interaction-requested"),
      );
    // The authoritative rehydration path: a tab that was unmounted for the SSE
    // frame must still be able to ask.
    const listed = h.runtime.listInteractions(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ kind: "question", threadId: "thread-1" });
  });

  test("an interaction for a thread with no session is declined, never parked", async () => {
    const h = await harness();
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7002,
      method: "item/tool/requestUserInput",
      params: { ...QUESTION_PARAMS, threadId: "thread-unbound" },
    });
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"answers":{}');
    expect(h.events.some((event) => event.type === "session.interaction-requested")).toBe(false);
  });

  test("listInteractions is empty for an unknown or unbound session", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.listInteractions(sessionId)).toEqual([]);
    expect(h.runtime.listInteractions("session-nope")).toEqual([]);
  });

  test("an accepted answer is sent to Codex and resolves the card", async () => {
    const { h, sessionId } = await askingSession();
    const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;

    expect(h.runtime.respondToInteraction(sessionId, interactionId, {
      action: "accept",
      answers: { language: ["TypeScript"] },
    })).toBe("applied");
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"language":{"answers":["TypeScript"]}');
    expect(h.runtime.listInteractions(sessionId)).toEqual([]);
    expect(h.events.some((event) => event.type === "session.interaction-resolved")).toBe(true);
  });

  test("an unknown interaction id reports unknown rather than throwing", async () => {
    const { h, sessionId } = await askingSession();
    expect(h.runtime.respondToInteraction(sessionId, "ask-nope", { action: "cancel" }))
      .toBe("unknown");
  });

  test("another session cannot answer this thread's card", async () => {
    const { h } = await askingSession();
    const other = h.runtime.createSession({ mode: "build" });
    const interactionId = h.runtime.listInteractions(
      h.runtime.getRegistry().listSessions()[0]!.id,
    )[0]!.interactionId;

    expect(h.runtime.respondToInteraction(other.sessionId, interactionId, { action: "cancel" }))
      .toBe("wrong-session");
  });

  /**
   * The regression. `answers?.[id]?.some(...)` guards nullish, not non-callable:
   * `{"answers":{"language":"TypeScript"}}` threw a TypeError from inside the
   * runtime, which surfaced as a 500 while the card stayed parked until its
   * auto-cancel.
   */
  test("a malformed answers map is rejected, not thrown on", async () => {
    const { h, sessionId } = await askingSession();
    const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;

    for (const answers of [
      { language: "TypeScript" },
      { language: [] },
      { language: [""] },
      { language: [1] },
      { language: { answers: ["TypeScript"] } },
    ]) {
      expect(h.runtime.respondToInteraction(sessionId, interactionId, {
        action: "accept",
        answers: answers as never,
      })).toBe("invalid");
    }
    // Still answerable: a rejected answer must not consume the card.
    expect(h.runtime.listInteractions(sessionId)).toHaveLength(1);
  });

  test("an accept must answer every question and invent none", async () => {
    const { h, sessionId } = await askingSession({
      ...QUESTION_PARAMS,
      questions: [
        { id: "language", header: "L", question: "Which language?" },
        { id: "framework", header: "F", question: "Which framework?" },
      ],
    });
    const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;

    expect(h.runtime.respondToInteraction(sessionId, interactionId, { action: "accept" }))
      .toBe("invalid");
    expect(h.runtime.respondToInteraction(sessionId, interactionId, {
      action: "accept",
      answers: { language: ["ts"] },
    })).toBe("invalid");
    expect(h.runtime.respondToInteraction(sessionId, interactionId, {
      action: "accept",
      answers: { language: ["ts"], framework: ["bun"], extra: ["nope"] },
    })).toBe("invalid");
    expect(h.runtime.respondToInteraction(sessionId, interactionId, {
      action: "accept",
      answers: { language: ["ts"], framework: ["bun"] },
    })).toBe("applied");
  });

  test.each(["decline", "cancel"] as const)(
    "a %s needs no answers and always resolves the card",
    async (action) => {
      const { h, sessionId } = await askingSession();
      const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;

      expect(h.runtime.respondToInteraction(sessionId, interactionId, { action }))
        .toBe("applied");
      await h.drain();
      expect(h.runtime.listInteractions(sessionId)).toEqual([]);
    },
  );

  async function elicitationSession(params: Record<string, unknown>) {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7003,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: "turn-1", ...params },
    });
    await h.drain();
    return { h, sessionId };
  }

  test("an MCP form accept requires a JSON object", async () => {
    const { h, sessionId } = await elicitationSession({
      serverName: "deploy",
      mode: "form",
      message: "Pick a region",
      requestedSchema: { type: "object" },
    });
    const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;

    for (const content of [undefined, null, "eu-west-1", 7, ["eu-west-1"]]) {
      expect(h.runtime.respondToInteraction(sessionId, interactionId, {
        action: "accept",
        content,
      })).toBe("invalid");
    }
    expect(h.runtime.respondToInteraction(sessionId, interactionId, {
      action: "accept",
      content: { region: "eu-west-1" },
    })).toBe("applied");
  });

  test("a url elicitation may accept with nothing, but not with an arbitrary scalar", async () => {
    const { h, sessionId } = await elicitationSession({
      serverName: "linear",
      mode: "url",
      message: "Authorize",
      url: "https://linear.app/oauth",
      elicitationId: "elicit-1",
    });
    const listed = h.runtime.listInteractions(sessionId)[0]!;
    expect(listed.kind).toBe("mcp-url");

    // There is no form to fill, so an empty accept is legitimate — but arbitrary
    // content must not pass straight through to the MCP server.
    for (const content of ["done", 7, ["done"]]) {
      expect(h.runtime.respondToInteraction(sessionId, listed.interactionId, {
        action: "accept",
        content,
      })).toBe("invalid");
    }
    expect(h.runtime.respondToInteraction(sessionId, listed.interactionId, { action: "accept" }))
      .toBe("applied");
  });

  test("a card the router has already forgotten is dropped, not served forever", async () => {
    const { h, sessionId } = await askingSession();
    const interactionId = h.runtime.listInteractions(sessionId)[0]!.interactionId;
    // Force the divergence the approval path guards against: the router forgets
    // the request without notifying us.
    h.engine.abandonThreadApprovals("thread-1");
    // `onInteractionResolved` normally clears our copy; re-add it to model a
    // notification that never landed.
    (h.runtime as unknown as {
      pendingInteractions: Map<string, unknown>;
    }).pendingInteractions.set(interactionId, { request: { threadId: "thread-1" } });

    expect(h.runtime.respondToInteraction(sessionId, interactionId, { action: "cancel" }))
      .toBe("unknown");
    // Mirrors the approval path: a card no client can ever resolve must not stay
    // in the rehydration snapshot.
    expect(h.runtime.listInteractions(sessionId)).toEqual([]);
  });
});
