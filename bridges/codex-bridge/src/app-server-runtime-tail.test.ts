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



describe("ordered event backpressure", () => {
  test("bounds a slow-render queue and emits explicit authoritative reconciliation", async () => {
    const h = await harness({}, {
      orderedEventMaxCount: 3,
      orderedEventMaxBytes: 1_024,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "start",
      requestId: "req-ordered-overflow",
      attachments: [],
    });
    await h.drain();

    const runtime = h.runtime as unknown as {
      threadState: Map<string, {
        coalescer: { flushNow: () => Promise<void> };
        orderedEvents: Array<{ bytes: number }>;
        orderedEventBytes: number;
      }>;
      enqueueAfterMessageFlush: (
        threadId: string,
        publish: () => void,
        options?: { bytes?: number; coalesceKey?: "status" },
      ) => void;
    };
    const state = runtime.threadState.get("thread-1")!;
    let releaseRender!: () => void;
    const slowRender = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    state.coalescer.flushNow = () => slowRender;

    // The first event is removed from the queue and parked behind rendering.
    // Notification handlers must still return synchronously while it is slow.
    runtime.enqueueAfterMessageFlush("thread-1", () => {}, { bytes: 100 });
    await Promise.resolve();
    for (let index = 0; index < 4; index += 1) {
      runtime.enqueueAfterMessageFlush("thread-1", () => {}, { bytes: 100 });
    }

    expect(state.orderedEvents).toHaveLength(0);
    expect(state.orderedEventBytes).toBeLessThanOrEqual(1_024);
    expect(
      h.events.some((event) => event.type === "session.reconcile-required"),
    ).toBe(false);

    releaseRender();
    await h.runtime.drainPendingWork();
    expect(h.events).toContainEqual({
      type: "session.reconcile-required",
      sessionId,
      data: { reason: "ordered-event-queue-overflow" },
    });
  });

  test("coalesces superseded status work while a prior render is slow", async () => {
    const h = await harness({}, { orderedEventMaxCount: 3 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "start",
      requestId: "req-ordered-status",
      attachments: [],
    });
    await h.drain();

    const runtime = h.runtime as unknown as {
      threadState: Map<string, {
        coalescer: { flushNow: () => Promise<void> };
        orderedEvents: Array<{ coalesceKey?: "status" }>;
      }>;
      enqueueAfterMessageFlush: (
        threadId: string,
        publish: () => void,
        options?: { bytes?: number; coalesceKey?: "status" },
      ) => void;
    };
    const state = runtime.threadState.get("thread-1")!;
    let releaseRender!: () => void;
    const slowRender = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    state.coalescer.flushNow = () => slowRender;
    const published: number[] = [];

    runtime.enqueueAfterMessageFlush("thread-1", () => published.push(0));
    await Promise.resolve();
    runtime.enqueueAfterMessageFlush(
      "thread-1",
      () => published.push(1),
      { coalesceKey: "status" },
    );
    runtime.enqueueAfterMessageFlush(
      "thread-1",
      () => published.push(2),
      { coalesceKey: "status" },
    );
    runtime.enqueueAfterMessageFlush(
      "thread-1",
      () => published.push(3),
      { coalesceKey: "status" },
    );

    expect(state.orderedEvents).toHaveLength(1);
    releaseRender();
    await h.runtime.drainPendingWork();
    expect(published).toEqual([0, 3]);
  });

  test("drops work queued while a reconcile is pending and still announces it", async () => {
    const h = await harness({}, { orderedEventMaxCount: 2 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "start",
      requestId: "req-ordered-drop",
      attachments: [],
    });
    await h.drain();

    const runtime = h.runtime as unknown as {
      threadState: Map<string, {
        coalescer: { flushNow: () => Promise<void> };
        orderedEvents: unknown[];
        orderedReconcilePending: boolean;
      }>;
      enqueueAfterMessageFlush: (
        threadId: string,
        publish: () => void,
        options?: { bytes?: number; coalesceKey?: "status" },
      ) => void;
    };
    const state = runtime.threadState.get("thread-1")!;
    let releaseRender!: () => void;
    const slowRender = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    state.coalescer.flushNow = () => slowRender;
    const published: number[] = [];

    runtime.enqueueAfterMessageFlush("thread-1", () => published.push(0));
    await Promise.resolve();
    // Overflows the count bound, which arms the reconcile.
    runtime.enqueueAfterMessageFlush("thread-1", () => published.push(1));
    runtime.enqueueAfterMessageFlush("thread-1", () => published.push(2));
    expect(state.orderedReconcilePending).toBe(true);

    // Anything enqueued from here is dropped on purpose: the reconcile the
    // client is about to receive covers it, and re-queueing would just re-trip
    // the bound.
    runtime.enqueueAfterMessageFlush("thread-1", () => published.push(3));
    expect(state.orderedEvents).toHaveLength(0);

    releaseRender();
    await h.runtime.drainPendingWork();
    expect(published).toEqual([0]);
    expect(h.events).toContainEqual({
      type: "session.reconcile-required",
      sessionId,
      data: { reason: "ordered-event-queue-overflow" },
    });
  });

  test("announces a reconcile when publishing an ordered event throws", async () => {
    const h = await harness({});
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "start",
      requestId: "req-ordered-throw",
      attachments: [],
    });
    await h.drain();

    const runtime = h.runtime as unknown as {
      enqueueAfterMessageFlush: (threadId: string, publish: () => void) => void;
    };
    const published: number[] = [];
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      runtime.enqueueAfterMessageFlush("thread-1", () => {
        throw new Error("render blew up");
      });
      // Queued behind the failure, and deliberately abandoned: the stream now
      // has a hole, so the client must rehydrate rather than trust what follows.
      runtime.enqueueAfterMessageFlush("thread-1", () => published.push(1));
      await h.runtime.drainPendingWork();
    } finally {
      console.error = originalError;
    }

    expect(published).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(h.events).toContainEqual({
      type: "session.reconcile-required",
      sessionId,
      data: { reason: "ordered-event-queue-overflow" },
    });
  });

  /**
   * An approval or interaction can resolve *during* `detachThread`, after the
   * runtime state was released. Creating state there would re-insert a render
   * state and coalescer for a thread nothing will ever release again.
   */
  test("publishes inline instead of recreating released thread state", async () => {
    const h = await harness({});
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "start",
      requestId: "req-released-state",
      attachments: [],
    });
    await h.drain();

    const runtime = h.runtime as unknown as {
      threadState: Map<string, unknown>;
      releaseThreadRuntimeState: (threadId: string) => void;
      enqueueAfterMessageFlush: (threadId: string, publish: () => void) => void;
    };
    runtime.releaseThreadRuntimeState("thread-1");
    expect(runtime.threadState.has("thread-1")).toBe(false);

    let published = 0;
    runtime.enqueueAfterMessageFlush("thread-1", () => { published += 1; });

    expect(published).toBe(1);
    expect(runtime.threadState.has("thread-1")).toBe(false);
    await h.runtime.drainPendingWork();
    expect(runtime.threadState.has("thread-1")).toBe(false);
  });

  /**
   * `recoverAfterGenerationChange` releases runtime state for an unmaterialized
   * thread — precisely a first prompt in flight. The streaming identity has to
   * land on whatever `stateFor` hands out *after* the dispatch, or the turn runs
   * without ever streaming to the tab.
   */
  test("writes the streaming identity to state released during the dispatch", async () => {
    const h = await harness({});
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const runtime = h.runtime as unknown as {
      threadState: Map<string, {
        assistantMessageId?: string;
        publishedMessageId?: string;
        publishedParts: unknown[];
      }>;
      releaseThreadRuntimeState: (threadId: string) => void;
    };

    let released = false;
    const startTurn = h.engine.startTurn.bind(h.engine);
    h.engine.startTurn = async (options) => {
      if (!released) {
        released = true;
        // The object the dispatch path captured before the await is now orphaned.
        runtime.releaseThreadRuntimeState("thread-1");
      }
      return startTurn(options);
    };

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "first",
      requestId: "req-released-mid-dispatch",
      attachments: [],
    });
    expect(outcome.ok).toBe(true);
    expect(released).toBe(true);

    const live = runtime.threadState.get("thread-1");
    const assistantMessage = h.runtime.getRegistry().getThread("thread-1")!
      .messages.find((message) => message.role === "assistant");
    expect(assistantMessage).toBeDefined();
    expect(live?.assistantMessageId).toBe(assistantMessage!.id);
    expect(live?.publishedMessageId).toBe(assistantMessage!.id);
  });
});



describe("notifications that race the turn/start response", () => {
  /**
   * `turn/start`'s response and its notifications travel on independent paths, so
   * a fast turn can be fully reported before the bridge has recorded its id.
   * Dropping those events would silently lose the entire turn — the transcript
   * would show an empty assistant message for a turn that actually succeeded.
   */
  test("a turn reported before its response is registered is not lost", async () => {
    let child: ScriptedChild | undefined;
    const h = await harness({
      "turn/start": (params) => {
        const threadId = String(params.threadId);
        // Emit the whole turn synchronously, before the response is even read.
        child?.notify("turn/started", { threadId, turn: { id: "turn-fast" } });
        child?.notify("item/completed", {
          threadId,
          turnId: "turn-fast",
          item: { id: "i1", type: "agentMessage", text: "instant answer" },
        });
        child?.notify("turn/completed", {
          threadId,
          turn: { id: "turn-fast", status: "completed" },
        });
        return { turn: { id: "turn-fast" } };
      },
    });
    child = h.child();

    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "quick", requestId: "req-1", attachments: [] });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.content).toBe("instant answer");
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ state: "terminal" });
  });

  test("the pre-registration buffer sheds the oldest parked turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    // Driven directly: a peer that behaves this badly is exactly what the bound
    // exists for, and scripting thousands of notifications proves nothing extra.
    const runtime = h.runtime as unknown as {
      bufferEvent: (threadId: string, turnId: string, event: EngineEvent) => void;
      threadState: Map<string, { pendingEvents: Map<string, unknown[]> }>;
    };
    const event = (turnId: string): EngineEvent => ({
      kind: "turn.started",
      threadId: "thread-1",
      turnId,
      engineGeneration: 1,
    });

    for (let index = 0; index < MAX_PENDING_TURNS + 3; index += 1) {
      runtime.bufferEvent("thread-1", `parked-${index}`, event(`parked-${index}`));
    }

    const pending = runtime.threadState.get("thread-1")!.pendingEvents;
    expect(pending.size).toBe(MAX_PENDING_TURNS);
    expect(pending.has("parked-0")).toBe(false);
    expect(pending.has(`parked-${MAX_PENDING_TURNS + 2}`)).toBe(true);
  });

  test("the pre-registration buffer caps one turn's queue", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const runtime = h.runtime as unknown as {
      bufferEvent: (threadId: string, turnId: string, event: EngineEvent) => void;
      threadState: Map<string, { pendingEvents: Map<string, unknown[]> }>;
    };
    for (let index = 0; index < MAX_PENDING_EVENTS_PER_TURN + 50; index += 1) {
      runtime.bufferEvent("thread-1", "flood", {
        kind: "item.text.delta",
        threadId: "thread-1",
        turnId: "flood",
        itemId: "i1",
        delta: "x",
        engineGeneration: 1,
      });
    }

    expect(runtime.threadState.get("thread-1")!.pendingEvents.get("flood")).toHaveLength(
      MAX_PENDING_EVENTS_PER_TURN,
    );
  });

  test("a stale event from a previous turn is still discarded", async () => {
    let turns = 0;
    const h = await harness({
      "turn/start": () => {
        turns += 1;
        return { turn: { id: `turn-${turns}` } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    await h.runtime.prompt(sessionId, { prompt: "second", requestId: "req-2", attachments: [] });
    await h.drain();

    // Buffering must not resurrect an event belonging to the finished turn.
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "old",
      delta: "resurrected text",
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.at(-1)!.content).not.toContain("resurrected text");
  });
});



describe("history", () => {
  test("native threads and rollout threads are merged", async () => {
    const h = await harness({
      "thread/list": () => ({
        data: [
          threadPayload("native-1", { name: "Named thread" }),
          threadPayload("child", { parentThreadId: "native-1" }),
        ],
        nextCursor: null,
      }),
    });

    const { sessions } = await h.runtime.listSessions();
    const ids = sessions.map((session) => session.id);
    expect(ids).toContain("native-1");
    // Sub-agent children are not conversations the user picks from history.
    expect(ids).not.toContain("child");
    expect(sessions.find((session) => session.id === "native-1")!.title).toBe("Named thread");
  });

  test("a thread/list failure still returns rollout history", async () => {
    const h = await harness({
      "thread/list": () => {
        throw new Error("unavailable");
      },
    });
    // No rollouts exist in the temp home, but the call must not throw.
    await expect(h.runtime.listSessions()).resolves.toMatchObject({ sessions: [] });
  });

  test("a bridge-generated title overrides a native preview via the listing's title map", async () => {
    // The listing already parsed the generated-title index; listSessions must
    // apply it to native-only threads without re-reading the file.
    await persistSessionTitle(codexHome, "native-titled", "Bridge title", {
      source: "generated",
    });
    const h = await harness({
      "thread/list": () => ({
        data: [threadPayload("native-titled")],
        nextCursor: null,
      }),
    });

    const { sessions } = await h.runtime.listSessions();
    expect(sessions.find((session) => session.id === "native-titled")!.title)
      .toBe("Bridge title");
  });
});



describe("usage and account rate limits", () => {
  async function usageSession() {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    return { h, sessionId };
  }

  test("usage arriving after turn/completed is applied, not parked forever", async () => {
    const { h, sessionId } = await usageSession();
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // The fast path: a thread snapshot, not a transcript mutation, so it must not
    // wait for an accumulator that no longer exists.
    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 15_000 },
        last: { totalTokens: 25_000 },
        modelContextWindow: 100_000,
      },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.contextUsage).toMatchObject({
      usedTokens: 25_000,
      totalTokens: 100_000,
      percentUsed: 25,
    });
    expect(
      h.events.some((event) => event.data?.contextUsage !== undefined),
    ).toBe(true);
  });

  test("getStatus reports no usage before any has been observed", async () => {
    const { h, sessionId } = await usageSession();
    expect(h.runtime.getStatus(sessionId)?.contextUsage).toBeUndefined();
  });

  /**
   * The regression. `account/rateLimits/updated` is a sparse rolling update: an
   * update carrying only `secondary` used to erase the primary window, and one
   * omitting `credits` used to erase the balance.
   */
  test("a sparse rate-limit update merges instead of replacing", async () => {
    const { h, sessionId } = await usageSession();
    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
    });
    h.child().notify("account/rateLimits/updated", {
      rateLimits: {
        limitName: "Five hour",
        primary: {
          usedPercent: 60,
          resetsAt: 1_800_000_000,
          windowDurationMins: 300,
        },
        secondary: { usedPercent: 20 },
        credits: { balance: "12.50", hasCredits: true },
      },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.contextUsage).toMatchObject({
      rateLimits: [
        {
          slot: "primary",
          label: "Five hour",
          usedPercent: 60,
          resetsAt: new Date(1_800_000_000 * 1_000).toISOString(),
          windowMinutes: 300,
        },
        { slot: "secondary", usedPercent: 20 },
      ],
      credits: { balance: "12.50", hasCredits: true },
    });

    // A genuinely secondary-only update, with no primary or credits at all.
    h.child().notify("account/rateLimits/updated", {
      rateLimits: {
        secondary: { usedPercent: 35 },
      },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.contextUsage).toMatchObject({
      rateLimits: [
        {
          slot: "primary",
          label: "Five hour",
          usedPercent: 60,
          resetsAt: new Date(1_800_000_000 * 1_000).toISOString(),
          windowMinutes: 300,
        },
        { slot: "secondary", usedPercent: 35 },
      ],
      // Absent metadata does not clear a previously observed value.
      credits: { balance: "12.50", hasCredits: true },
    });

    h.child().notify("account/rateLimits/updated", {
      rateLimits: { limitName: "Renamed plan" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.contextUsage?.rateLimits?.[0]).toEqual({
      slot: "primary",
      label: "Renamed plan",
      usedPercent: 60,
      resetsAt: new Date(1_800_000_000 * 1_000).toISOString(),
      windowMinutes: 300,
    });
  });

  test("a partial credits update merges field by field", async () => {
    const { h, sessionId } = await usageSession();
    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
    });
    h.child().notify("account/rateLimits/updated", {
      rateLimits: { credits: { balance: "12.50", hasCredits: true, unlimited: false } },
    });
    await h.drain();
    h.child().notify("account/rateLimits/updated", {
      rateLimits: { credits: { balance: "3.00" } },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)?.contextUsage?.credits).toEqual({
      balance: "3.00",
      hasCredits: true,
      unlimited: false,
    });
  });

  /**
   * The regression. `usageByThread` was only ever written, so every thread the
   * bridge had ever touched left a permanent entry that the rate-limit fan-out
   * walked on every tick.
   */
  test("releasing a thread frees its retained usage snapshot", async () => {
    const { h, sessionId } = await usageSession();
    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const usageByThread = (h.runtime as unknown as {
      usageByThread: Map<string, unknown>;
    }).usageByThread;
    expect(usageByThread.size).toBe(1);

    await h.runtime.deleteSession(sessionId);
    expect(usageByThread.size).toBe(0);
  });

  test("rate-limit updates fan out context usage to every session for the thread", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-shared") }),
    });
    const first = await h.runtime.resumeSession({ threadId: "thread-shared", mode: "build" });
    const second = await h.runtime.resumeSession({ threadId: "thread-shared", mode: "build" });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-shared",
      turnId: "turn-1",
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
    });
    await h.drain();
    h.events.length = 0;

    h.child().notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 60 } },
    });
    await h.drain();

    const notified = h.events
      .filter(
        (event) =>
          event.type === "session.updated"
          && event.data?.contextUsage !== undefined,
      )
      .map((event) => event.sessionId)
      .sort();
    expect(notified).toEqual([first!.sessionId, second!.sessionId].sort());
    expect(h.runtime.getStatus(first!.sessionId)?.contextUsage?.rateLimits)
      .toEqual([{ slot: "primary", label: "Primary", usedPercent: 60 }]);
    expect(h.runtime.getStatus(second!.sessionId)?.contextUsage?.rateLimits)
      .toEqual([{ slot: "primary", label: "Primary", usedPercent: 60 }]);
  });

  test("a thread with no live sessions is skipped by the rate-limit fan-out", async () => {
    const { h } = await usageSession();
    h.child().notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 },
    });
    await h.drain();

    // Drop the registry's view of the thread without releasing runtime state,
    // which is the shape of a thread mid-teardown.
    h.runtime.getRegistry().detachThread("thread-1");
    h.events.length = 0;
    h.child().notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 60 } },
    });
    await h.drain();

    expect(h.events.filter((event) => event.data?.contextUsage !== undefined)).toHaveLength(0);
  });
});
