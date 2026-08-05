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

test("large message snapshots use a progressively lower streaming cadence", () => {
  expect(messageSnapshotIntervalMs(255 * 1024)).toBe(100);
  expect(messageSnapshotIntervalMs(256 * 1024)).toBe(250);
  expect(messageSnapshotIntervalMs(1024 * 1024)).toBe(500);
});

test("snapshot sizing includes nested tool, reasoning, diff and subagent content", () => {
  const message = {
    id: "large-parts",
    role: "assistant" as const,
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const reasoningChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [{ type: "thinking" as const, content: "r".repeat(300 * 1024) }],
  });
  const toolChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [{
      type: "tool-result" as const,
      content: "",
      toolOutput: "o".repeat(300 * 1024),
    }],
  });
  const nestedChars = normalizedMessageSnapshotChars({
    ...message,
    parts: [
      {
        type: "tool-invocation" as const,
        content: "apply",
        toolArgs: { nested: { prompt: "a".repeat(96 * 1024) } },
        toolDiff: { diff: "d".repeat(96 * 1024) },
      },
      {
        type: "subagent" as const,
        content: "worker",
        subagentPrompt: "p".repeat(48 * 1024),
        subagentActions: [{
          type: "tool-result" as const,
          content: "",
          toolOutput: "o".repeat(48 * 1024),
        }],
      },
    ],
  });

  expect(messageSnapshotIntervalMs(reasoningChars)).toBe(250);
  expect(messageSnapshotIntervalMs(toolChars)).toBe(250);
  expect(messageSnapshotIntervalMs(nestedChars)).toBe(250);
});

test("snapshot sizing is bounded and tolerates cyclic metadata", () => {
  const cyclicMessage: Record<string, unknown> = {
    id: "cyclic",
    role: "assistant",
    content: "visible",
    parts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  cyclicMessage.self = cyclicMessage;

  expect(
    normalizedMessageSnapshotChars(
      cyclicMessage as unknown as Parameters<typeof normalizedMessageSnapshotChars>[0],
    ),
  ).toBeGreaterThan(0);
  expect(normalizedMessageSnapshotChars({
    id: "bounded",
    role: "assistant",
    content: "x".repeat(2 * 1024 * 1024),
    parts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  })).toBe(1024 * 1024);
});

describe("mergeRateLimitWindows", () => {
  const primary: EngineRateLimitWindow = {
    slot: "primary",
    label: "Five hour",
    usedPercent: 60,
    resetsAt: "2026-07-30T20:00:00.000Z",
    windowMinutes: 300,
  };

  test("returns the retained snapshot unchanged for an empty update", () => {
    const retained = [primary];

    expect(mergeRateLimitWindows(retained, [])).toBe(retained);
  });

  test("adds a new slot and restores stable primary-first ordering", () => {
    const secondary: EngineRateLimitWindow = {
      slot: "secondary",
      label: "Weekly",
      usedPercent: 20,
    };

    expect(mergeRateLimitWindows([secondary], [primary])).toEqual([
      primary,
      secondary,
    ]);
  });

  test("preserves omitted fields while updating the fields that are present", () => {
    const sparseUpdate: EngineRateLimitWindowUpdate = {
      slot: "primary",
      usedPercent: 65,
    };

    expect(mergeRateLimitWindows([primary], [sparseUpdate])).toEqual([{
      ...primary,
      usedPercent: 65,
    }]);
  });

  test("uses a slot fallback only until an explicit provider label is observed", () => {
    const unlabeled: EngineRateLimitWindowUpdate = {
      slot: "primary",
      usedPercent: 10,
    };
    const initial = mergeRateLimitWindows([], [unlabeled]);
    expect(initial).toEqual([{
      slot: "primary",
      label: "Primary",
      usedPercent: 10,
    }]);

    expect(mergeRateLimitWindows([primary], [unlabeled])).toEqual([{
      ...primary,
      usedPercent: 10,
    }]);

    expect(mergeRateLimitWindows([primary], [{
      slot: "primary",
      label: "New plan name",
    }])).toEqual([{
      ...primary,
      label: "New plan name",
    }]);
  });
});

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

describe("estimateOrderedEventBytes", () => {
  test("charges strings by their UTF-16 storage and scalars a flat node cost", () => {
    expect(estimateOrderedEventBytes("")).toBe(2);
    expect(estimateOrderedEventBytes("abcd")).toBe(10);
    expect(estimateOrderedEventBytes(42)).toBe(16);
    expect(estimateOrderedEventBytes(null)).toBe(16);
    expect(estimateOrderedEventBytes(undefined)).toBe(16);
    expect(estimateOrderedEventBytes(true)).toBe(16);
  });

  test("charges keys as well as values so a wide object is not free", () => {
    const wide = estimateOrderedEventBytes({ aa: 1, bb: 2 });
    const narrow = estimateOrderedEventBytes({ a: 1, b: 2 });
    expect(wide).toBeGreaterThan(narrow);
    expect(estimateOrderedEventBytes([1, 2, 3]))
      .toBeGreaterThan(estimateOrderedEventBytes([1]));
  });

  /**
   * The walk is bounded so a pathological structure cannot make the *estimate*
   * the expensive part of a bounded queue. It is a heuristic, so undercounting
   * past the cap is deliberate.
   */
  test("stops descending at the depth cap instead of walking forever", () => {
    let deep: unknown = "leaf".repeat(64);
    for (let index = 0; index < 40; index += 1) deep = { next: deep };
    const start = performance.now();
    const estimate = estimateOrderedEventBytes(deep);
    expect(performance.now() - start).toBeLessThan(50);
    // Nine nested nodes plus their keys, and nothing for the truncated tail.
    expect(estimate).toBeLessThan(400);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateOrderedEventBytes(cyclic)).toBeLessThan(400);
  });
});

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

describe("session lifecycle", () => {
  test("concurrent start callers share initialization and wait for it to finish", async () => {
    const h = await harness({}, { deferStart: true });
    const originalStart = h.engine.start.bind(h.engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let starts = 0;
    h.engine.start = async () => {
      starts += 1;
      signalEntered();
      await gate;
      return originalStart();
    };

    const first = h.runtime.start();
    const second = h.runtime.start();
    await entered;
    expect(starts).toBe(1);

    release();
    await Promise.all([first, second]);
    await h.runtime.start();
    expect(h.children).toHaveLength(1);
    expect(h.child().requests.filter((request) => request.method === "initialize")).toHaveLength(1);
  });

  test("a failed start can be retried", async () => {
    const h = await harness({}, { deferStart: true });
    const originalStart = h.engine.start.bind(h.engine);
    let attempts = 0;
    h.engine.start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient startup failure");
      return originalStart();
    };

    await expect(h.runtime.start()).rejects.toThrow("transient startup failure");
    await h.runtime.start();

    expect(attempts).toBe(2);
    expect(h.engine.getHealth().state).toBe("ready");
  });

  test("restores durable bridge session ids lazily after a runtime restart", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-restored",
        threadId: "thread-restored",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Restored",
        titleSource: "explicit",
        lastAcceptedRequestId: "req-old",
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-restored") }),
    });

    expect(h.runtime.getStatus("session-restored")).toMatchObject({
      status: "idle",
      threadId: "thread-restored",
      title: "Restored",
    });
    expect(h.child().requests.some((request) => request.method === "thread/resume")).toBe(false);

    expect(await h.runtime.getMessages("session-restored")).toEqual([]);
    expect(h.child().requests.some((request) => request.method === "thread/resume")).toBe(true);
  });

  test("resume without a thread id is rejected rather than creating a session", async () => {
    const h = await harness();
    expect(await h.runtime.resumeSession({ threadId: "   ", mode: "build" })).toBeNull();
    expect(await h.runtime.resumeSession({ mode: "build" })).toBeNull();
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(0);
  });

  test("resuming a thread whose rollout is gone falls back to the parser", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-gone.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-gone",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Remember the parser constraint" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will preserve it." }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-gone");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });

    // The user still sees the conversation; the next prompt starts a fresh thread
    // with reconstructed context.
    const resumed = await h.runtime.resumeSession({ threadId: "thread-gone", mode: "build" });
    expect(resumed).toMatchObject({ threadId: "thread-gone" });
    expect(resumed!.messages.map((message) => message.content)).toEqual([
      "Remember the parser constraint",
      "I will preserve it.",
    ]);
    expect(h.runtime.getStatus(resumed!.sessionId)?.messageRevision).toBe(1);
    expect(h.runtime.getRegistry().getSession(resumed!.sessionId)?.threadId).toBeNull();
    expect((await h.runtime.getMessages(resumed!.sessionId))!.map((message) => message.content))
      .toEqual(["Remember the parser constraint", "I will preserve it."]);

    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "Continue now",
      requestId: "req-recovered",
      attachments: [],
    });
    const turnStart = h.child().requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params.input)).toContain("Remember the parser constraint");
    expect(JSON.stringify(turnStart?.params.input)).toContain("Continue now");
  });

  test("recovered rollout context is sent once, even when its dispatch was ambiguous", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-ambiguous.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-ambiguous",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Earlier recovered turn" }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    let hangNextTurn = false;
    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-ambiguous");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      // The ambiguous dispatch really did run, carrying the recovered context.
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-live",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-ambiguous" }],
            },
          ],
        }),
      }),
    });

    const invalidationsBeforeResume =
      getTranscriptCatalogInvalidationCountForTesting();
    const resumed = await h.runtime.resumeSession({
      threadId: "thread-ambiguous",
      mode: "build",
    });
    expect(getTranscriptCatalogInvalidationCountForTesting())
      .toBe(invalidationsBeforeResume + 1);
    hangNextTurn = true;
    const pending = h.runtime.prompt(resumed!.sessionId, {
      prompt: "first after recovery",
      requestId: "req-ambiguous",
      attachments: [],
    });
    // The dispatch must be genuinely in flight before the child dies — that is
    // what makes it ambiguous. Waiting for the request rather than sleeping keeps
    // this deterministic; a fixed delay loses the race on a loaded machine and
    // the turn never becomes ambiguous, so the prompt below never settles.
    await h.child().waitForRequest("turn/start");
    h.child().exit(1);
    await pending;
    await h.drain();

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-live", status: "completed" },
    });
    await h.drain();

    hangNextTurn = false;
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "second after recovery",
      requestId: "req-next",
      attachments: [],
    });

    // Across children: the ambiguous dispatch went to the child that then died.
    const starts = h.children
      .flatMap((child) => child.requests)
      .filter((request) => request.method === "turn/start");
    const carrying = starts.filter((request) =>
      JSON.stringify(request.params.input).includes("recovered_conversation"),
    );
    // Exactly one turn carries the transcript: the one that already ran.
    expect(carrying).toHaveLength(1);
    expect(JSON.stringify(starts.at(-1)?.params.input)).not.toContain("recovered_conversation");
  });

  test("recovered context keeps every assistant segment of a multi-step turn", async () => {
    // Hydration folds a whole turn into one assistant message whose `content` is
    // only the *last* agent text; the earlier segments live in `parts`. The
    // recovered transcript must read the parts, or a turn that reasoned across
    // several messages is replayed to the model as its closing line alone.
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-multi.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { id: "thread-multi", cwd: "/tmp/ws", timestamp: "2026-07-25T12:00:00.000Z" },
        },
        { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/tmp/ws" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Investigate the failure" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "First I checked the logs." }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The cache key was stale." }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-multi");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });
    const resumed = await h.runtime.resumeSession({ threadId: "thread-multi", mode: "build" });
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "continue",
      requestId: "req-multi",
      attachments: [],
    });

    const start = h.child().requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params.input);
    expect(input).toContain("Investigate the failure");
    expect(input).toContain("First I checked the logs.");
    expect(input).toContain("The cache key was stale.");
  });

  test("recovered context is bounded before it is sent", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const huge = "y".repeat(MAX_RECOVERED_CONTEXT_CHARS * 2);
    writeFileSync(
      join(sessionsDir, "thread-huge.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-huge",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: huge }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-huge");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });
    const resumed = await h.runtime.resumeSession({ threadId: "thread-huge", mode: "build" });
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "continue",
      requestId: "req-huge",
      attachments: [],
    });

    const start = h.child().requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params.input);
    expect(input).toContain("earlier recovered context omitted");
    // A runaway rollout must not be able to dominate the turn.
    expect(input.length).toBeLessThan(MAX_RECOVERED_CONTEXT_CHARS * 2);
  });

  test("restores unresolved accepted work as running before serving status", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-recovering",
        threadId: "thread-recovering",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Recovering",
        titleSource: "prompt",
        lastAcceptedRequestId: "req-live",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-live",
      bridgeSessionId: "session-recovering",
      threadId: "thread-recovering",
    });
    await journal.markAccepted("req-live", {
      threadId: "thread-recovering",
      turnId: "turn-live",
    });

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-recovering") }),
      "thread/read": () => ({
        thread: threadPayload("thread-recovering", {
          turns: [
            {
              id: "turn-live",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-live" }],
            },
          ],
        }),
      }),
    });

    expect(h.runtime.getStatus("session-recovering")).toMatchObject({
      status: "running",
      phase: "running",
      requestId: "req-live",
      turnId: "turn-live",
    });
    expect(await h.runtime.prompt("session-recovering", {
      prompt: "must wait",
      requestId: "req-new",
      attachments: [],
    })).toMatchObject({ ok: false, status: 409 });
  });

  test("an unresolved record with no thread is spent, not replayed", async () => {
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    // `markPrepared` with no thread: the write may have had side effects, but
    // there is no address at which anything could still be executing.
    await journal.markPrepared({
      requestId: "req-orphan",
      bridgeSessionId: "session-gone",
    });

    const h = await harness();
    const recovered = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await recovered.load();

    expect(recovered.unresolved().some((record) => record.requestId === "req-orphan"))
      .toBe(false);
    expect(recovered.classify("req-orphan").action).toBe("already-done");
    expect(h.child().requests.some((request) => request.method === "turn/start"))
      .toBe(false);
  });

  test("only the newest record per thread is recovered; older ones are failed", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-multi",
        threadId: "thread-multi",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Multi",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    for (const requestId of ["req-old", "req-new"]) {
      await journal.markPrepared({
        requestId,
        bridgeSessionId: "session-multi",
        threadId: "thread-multi",
      });
      await journal.markAccepted(requestId, {
        threadId: "thread-multi",
        turnId: `turn-${requestId}`,
      });
      // Distinct `updatedAt` values, which is what orders the records.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-multi") }),
      "thread/read": () => ({
        thread: threadPayload("thread-multi", {
          turns: [
            {
              id: "turn-req-new",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-new" }],
            },
          ],
        }),
      }),
    });

    const recovered = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await recovered.load();
    expect(recovered.unresolved().map((record) => record.requestId)).not.toContain("req-old");
    expect(recovered.classify("req-old").action).toBe("already-done");
  });

  test("a thread that cannot be re-attached during recovery stays guarded and escalates", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-stuck",
        threadId: "thread-stuck",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Stuck",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-stuck",
      bridgeSessionId: "session-stuck",
      threadId: "thread-stuck",
    });
    await journal.markAccepted("req-stuck", {
      threadId: "thread-stuck",
      turnId: "turn-stuck",
    });

    let resumeFailures = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeFailures += 1;
          throw new Error("temporary transport failure");
        },
      },
      { ambiguousRecoveryTimeoutMs: 10 },
    );

    expect(resumeFailures).toBeGreaterThan(0);
    // Never idle: the turn may still be executing on the old child.
    expect(h.runtime.getStatus("session-stuck")).toMatchObject({
      status: "running",
      phase: "recovering",
    });
    // The backstop is armed, so this cannot be a permanent state.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.children.length).toBeGreaterThan(1);
  });

  test("a failed escalation restart keeps the guard and re-arms the backstop", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-norestart",
        threadId: "thread-norestart",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "No restart",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-norestart",
      bridgeSessionId: "session-norestart",
      threadId: "thread-norestart",
    });
    await journal.markAccepted("req-norestart", {
      threadId: "thread-norestart",
      turnId: "turn-norestart",
    });

    const h = await harness(
      {
        "thread/resume": () => {
          throw new Error("temporary transport failure");
        },
      },
      { ambiguousRecoveryTimeoutMs: 10, deferStart: true },
    );
    let restartAttempts = 0;
    const supervisor = h.engine.getSupervisor();
    const realRestart = supervisor.restartNow.bind(supervisor);
    supervisor.restartNow = async () => {
      restartAttempts += 1;
      throw new Error("circuit breaker open");
    };
    await h.runtime.start();

    // Escalation keeps failing, so the thread must stay guarded and keep trying
    // rather than sit in `recovering` with no timer left to move it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(restartAttempts).toBeGreaterThan(1);
    expect(h.runtime.getStatus("session-norestart")).toMatchObject({
      status: "running",
      phase: "recovering",
    });
    expect(h.events.some(
      (event) =>
        event.type === "session.error"
        && event.data?.error === "circuit breaker open",
    )).toBe(true);

    supervisor.restartNow = realRestart;
  });

  test("status reports recovering, not idle, while startup recovery is still running", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-slow",
        threadId: "thread-slow",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Slow",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-slow",
      bridgeSessionId: "session-slow",
      threadId: "thread-slow",
    });
    await journal.markAccepted("req-slow", {
      threadId: "thread-slow",
      turnId: "turn-slow",
    });

    const h = await harness(
      // Never answers, so recovery is still in flight while we observe status.
      { "thread/resume": () => NO_RESPONSE },
      { deferStart: true },
    );
    const started = h.runtime.start();
    await waitUntil(
      () => h.children.length === 1
        && h.child().requests.some((request) => request.method === "thread/resume"),
      "startup recovery did not reach thread/resume",
    );

    // `idle` here would let the build pipeline advance on a turn that may still
    // be executing.
    expect(h.runtime.getStatus("session-slow")).toMatchObject({
      status: "running",
      phase: "recovering",
    });

    h.children.at(-1)?.exit(1);
    await started.catch(() => undefined);
  });

  test("resuming rethrows an ambiguous failure instead of forking a thread", async () => {
    const h = await harness({
      "thread/resume": () => {
        throw new Error("temporary transport failure");
      },
    });

    // Falling back here would rebuild the conversation in a *new* thread while the
    // original is merely unreachable.
    await expect(
      h.runtime.resumeSession({ threadId: "thread-1", mode: "build" }),
    ).rejects.toThrow("temporary transport failure");
  });

  test("re-attaching hydrates the transcript and adopts the Codex thread name", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-named.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-named",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "persisted-tool",
            arguments: JSON.stringify({ cmd: "git status --short" }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "persisted-tool",
            output: "clean",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Persisted answer" }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-named",
        threadId: "thread-named",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-named", { name: "Codex Name" }) }),
    });

    const messages = await h.runtime.getMessages("session-named");
    expect(messages?.map((message) => message.content)).toEqual(["Persisted answer"]);
    expect(messages?.[0]?.parts).toEqual([
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "exec_command",
        // A persisted function_call records no outcome, so none is claimed.
        toolState: undefined,
        toolOutput: "clean",
      }),
      { type: "text", content: "Persisted answer" },
    ]);
    expect(h.runtime.getStatus("session-named")?.messageRevision).toBe(1);
    // app-server's own name outranks anything reconstructed from the rollout.
    expect(h.runtime.getStatus("session-named")).toMatchObject({ title: "Codex Name" });
    expect(h.runtime.getRegistry().getSession("session-named")?.titleSource).toBe("codex");
  });

  test("re-attaching an unnamed thread leaves the title to the rollout", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-unnamed",
        threadId: "thread-unnamed",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-unnamed") }),
    });

    expect(await h.runtime.getMessages("session-unnamed")).toEqual([]);
    const session = h.runtime.getRegistry().getSession("session-unnamed")!;
    expect(session.title).toBeUndefined();
    expect(session.titleSource).toBeUndefined();
  });

  test("create does not materialize a Codex thread", async () => {
    const h = await harness();
    const created = h.runtime.createSession({ mode: "build" });

    expect(created.sessionId).toMatch(/^session-/);
    // An abandoned session must not appear in the resume dialog.
    expect(h.child().requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(h.runtime.getStatus(created.sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
      threadId: null,
    });
  });

  test("create is idempotent for one stable client tab key", async () => {
    let clock = 1_000;
    const h = await harness({}, { now: () => clock });
    const first = h.runtime.createSession({
      mode: "build",
      clientSessionKey: "env-1:tab-1",
      title: "First writer",
    });
    const createdAt = h.runtime.getRegistry().getSession(first.sessionId)!.createdAt;
    clock = 2_000;
    const duplicate = h.runtime.createSession({
      mode: "plan",
      clientSessionKey: "env-1:tab-1",
      title: "Racing writer",
    });
    const otherTab = h.runtime.createSession({
      mode: "build",
      clientSessionKey: "env-1:tab-2",
    });

    expect(duplicate.sessionId).toBe(first.sessionId);
    expect(otherTab.sessionId).not.toBe(first.sessionId);
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(2);
    // The first accepted create owns configuration; a racing duplicate must
    // not mutate a logical tab before its first prompt.
    expect(h.runtime.getRegistry().getSession(first.sessionId)).toMatchObject({
      title: "First writer",
      titleSource: "explicit",
      createdAt,
      lastAccessed: 2_000,
      config: { mode: "build", sandbox: "danger-full-access" },
    });
    expect(duplicate.title).toBe("First writer");
  });

  test("client tab keys enforce type, content, and length boundaries", async () => {
    const h = await harness();
    const accepted512 = "k".repeat(512);
    const stable = h.runtime.createSession({
      mode: "build",
      clientSessionKey: accepted512,
    });
    expect(h.runtime.createSession({
      mode: "plan",
      clientSessionKey: accepted512,
    }).sessionId).toBe(stable.sessionId);
    expect(stable.sessionId).toMatch(/^session-client-[a-f0-9]{32}$/);

    const invalidKeys: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      " \t\n ",
      "k".repeat(513),
    ];
    const fallbackIds = invalidKeys.map((clientSessionKey) =>
      h.runtime.createSession({ mode: "build", clientSessionKey }).sessionId
    );
    expect(new Set(fallbackIds).size).toBe(invalidKeys.length);
    for (const id of fallbackIds) {
      expect(id).toMatch(/^session-/);
      expect(id.startsWith("session-client-")).toBe(false);
    }
  });

  test("deleting a keyed session permits a clean recreation with the same identity", async () => {
    const h = await harness();
    const first = h.runtime.createSession({
      mode: "build",
      title: "Old session",
      clientSessionKey: "env-1:tab-recreated",
    });

    expect(await h.runtime.deleteSession(first.sessionId)).toBe(true);
    expect(h.runtime.getStatus(first.sessionId)).toBeNull();
    expect(await h.runtime.deleteSession(first.sessionId)).toBe(false);

    const recreated = h.runtime.createSession({
      mode: "plan",
      title: "New session",
      clientSessionKey: "env-1:tab-recreated",
    });
    expect(recreated).toEqual({
      sessionId: first.sessionId,
      title: "New session",
    });
    expect(h.runtime.getRegistry().getSession(recreated.sessionId)).toMatchObject({
      title: "New session",
      config: { mode: "plan", sandbox: "read-only" },
    });
  });

  test("a keyed materialized session converges on its durable identity after restart", async () => {
    const key = "env-1:tab-durable";
    const first = await harness();
    const created = first.runtime.createSession({
      mode: "plan",
      title: "Durable first writer",
      clientSessionKey: key,
    });
    await first.runtime.prompt(created.sessionId, {
      prompt: "materialize",
      requestId: "req-durable-key",
      attachments: [],
    });
    first.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.drain();
    await first.runtime.stop();

    const second = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const duplicate = second.runtime.createSession({
      mode: "build",
      title: "Must not replace persisted state",
      clientSessionKey: key,
    });
    expect(duplicate).toEqual({
      sessionId: created.sessionId,
      title: "Durable first writer",
    });
    expect(second.runtime.getRegistry().getSession(created.sessionId)).toMatchObject({
      threadId: "thread-1",
      title: "Durable first writer",
      config: { mode: "plan", sandbox: "read-only" },
    });
    await second.runtime.stop();
  });

  test("the first prompt creates the thread and dispatches a turn", async () => {
    const turnStartedAt = Date.parse("2026-08-01T12:34:56.000Z");
    const h = await harness({}, { now: () => turnStartedAt });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const invalidationsBefore = getTranscriptCatalogInvalidationCountForTesting();

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "do the thing",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt)
      .toBe("2026-08-01T12:34:56.000Z");
    expect(h.events).toContainEqual({
      type: "session.updated",
      sessionId,
      data: {
        status: "running",
        phase: "starting",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    const methods = h.child().requests.map((r) => r.method);
    expect(methods).toContain("thread/start");
    expect(methods).toContain("turn/start");
    expect(getTranscriptCatalogInvalidationCountForTesting())
      .toBe(invalidationsBefore + 1);
    // The request id must reach app-server as the at-most-once key.
    expect(
      h.child().requests.find((r) => r.method === "turn/start")!.params.clientUserMessageId,
    ).toBe("req-1");
  });

  test("drainPendingWork waits for terminal journal and render finalization", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish deterministically",
      requestId: "req-drain",
      attachments: [],
    });

    const journal = h.runtime.getJournal();
    const originalMarkTerminal = journal.markTerminal.bind(journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    journal.markTerminal = async (...args) => {
      await gate;
      await originalMarkTerminal(...args);
    };

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.engine.getSupervisor().notificationQueue.drainAll();

    let drained = false;
    const pendingDrain = h.runtime.drainPendingWork().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");

    release();
    await pendingDrain;
    expect(h.runtime.getStatus(sessionId)?.status).toBe("idle");
    expect(journal.allRecords().find((record) => record.requestId === "req-drain"))
      .toMatchObject({ state: "terminal", terminalStatus: "completed" });
  });

  test("graceful stop does not release render state before finalization settles", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish before shutdown",
      requestId: "req-stop-drain",
      attachments: [],
    });

    const journal = h.runtime.getJournal();
    const originalMarkTerminal = journal.markTerminal.bind(journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    journal.markTerminal = async (...args) => {
      await gate;
      await originalMarkTerminal(...args);
    };
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.engine.getSupervisor().notificationQueue.drainAll();

    let stopped = false;
    const pendingStop = h.runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await pendingStop;
    expect(journal.allRecords().find((record) => record.requestId === "req-stop-drain"))
      .toMatchObject({ state: "terminal", terminalStatus: "completed" });
  });

  test("stores a schema-constrained final response and rehydrates it by request id", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-1",
      attachments: [],
      outputSchema,
    });

    expect(
      h.child().requests.find((request) => request.method === "turn/start")!.params.outputSchema,
    ).toEqual(outputSchema);
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: JSON.stringify({ summary: "Looks good" }),
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId, "structured-1")).toEqual({
      requestId: "structured-1",
      structuredOutput: {
        ok: true,
        provider: "codex",
        requestId: "structured-1",
        value: { summary: "Looks good" },
      },
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      structuredOutputRequestId: "structured-1",
      structuredOutput: { ok: true, value: { summary: "Looks good" } },
    });
    const persisted = (await new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
    }).load())[0];
    expect(persisted?.structuredOutput).toMatchObject({
      ok: true,
      requestId: "structured-1",
    });
  });

  test("does not treat a plaintext final message as structured success", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-plain",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", text: "Looks good" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: false,
        error: { code: "malformed_output", retryable: true },
      },
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
    });
  });

  test("maps Codex structured-output retry exhaustion to the shared failure code", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-retries",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: {
          message: "Structured output retries exhausted",
          codexErrorInfo: "structuredOutputRetryExhausted",
        },
      },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: false,
        error: { code: "schema_retry_exhausted", retryable: true },
      },
    });
  });

  test("status reports running while a turn is live", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
      requestId: "req-1",
    });
  });

  test("config persistence changes only after configure succeeds", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const configure = h.engine.configureThread.bind(h.engine);
    const order: string[] = [];
    h.engine.configureThread = async (handle, config) => {
      order.push("configure:start");
      await gate;
      await configure(handle, config);
      order.push("configure:done");
    };

    const pending = h.runtime.updateConfig(sessionId, { mode: "plan" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.load())[0]?.config.mode).toBe("build");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("build");

    release();
    expect(await pending).toBe("updated");
    order.push("returned");
    expect(order).toEqual(["configure:start", "configure:done", "returned"]);
    expect((await store.load())[0]?.config.mode).toBe("plan");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({
      mode: "plan",
      fastMode: false,
      durable: true,
    });

    h.engine.configureThread = async () => {
      throw new Error("configure rejected");
    };
    // Reported, not thrown: the route answers 503 rather than leaking a 500, and
    // both memory and disk stay on the configuration the engine accepted.
    expect(await h.runtime.updateConfig(sessionId, { mode: "build" })).toBe("unavailable");
    expect((await store.load())[0]?.config.mode).toBe("plan");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
  });

  test("an unresumable session reports unavailable instead of throwing", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-503",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Force the slow path, then fail it the way an in-flight restart would.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("temporary transport failure");
    };

    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("unavailable");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("build");
  });

  test("a rejected model configuration restores the prior confirmed model", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({
      mode: "build",
      model: "gpt-accepted-request",
    });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-model-config-rollback",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const context = h.runtime.getRegistry().getThread("thread-1")!;
    context.modelId = "gpt-accepted-confirmation";
    h.engine.configureThread = async () => {
      // Model notifications can race the RPC response. A failed response means
      // this tentative confirmation must not replace the last accepted model.
      context.modelId = "gpt-rejected-confirmation";
      throw new Error("configure rejected");
    };

    expect(await h.runtime.updateConfig(sessionId, {
      mode: "build",
      model: "gpt-rejected-request",
    })).toBe("unavailable");
    expect(context.modelId).toBe("gpt-accepted-confirmation");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.model)
      .toBe("gpt-accepted-request");
  });

  test("a running session found only after re-attaching is still refused", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-race",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const registry = h.runtime.getRegistry();
    const context = registry.getThread("thread-1")!;
    // Idle when the route looks, running by the time the handle is valid again:
    // configuring here would change the sandbox under an executing turn.
    context.unsubscribed = true;
    const resume = h.engine.resumeThread.bind(h.engine);
    h.engine.resumeThread = async (...args) => {
      const result = await resume(...args);
      registry.setPhase(context, "running");
      return result;
    };

    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("running");
    expect(registry.getSession(sessionId)?.config.mode).toBe("build");
  });

  test("a configuration change that cannot be persisted is reported, not claimed", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-disk",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    const recordsDir = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/tmp/ws")}`,
    );
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/tmp/ws")}.json`,
    );
    const durableBeforeFailure = await store.load();
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: durableBeforeFailure,
      }),
      "utf8",
    );
    rmSync(recordsDir, { recursive: true, force: true });
    writeFileSync(recordsDir, "blocks the per-session registry directory", "utf8");

    // The store warns and resolves on a write failure, so "updated" here would
    // be a lie: after a restart the stale plan/build mode is re-hydrated into
    // thread/resume, silently restoring the old sandbox.
    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("memory-only");
    expect((await store.load())[0]?.config.mode).toBe("build");
    // Memory still matches the engine, which did accept the change.
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
  });

  test("a full turn streams deltas and finalizes the transcript", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(0);
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    const promptRevision = h.runtime.getStatus(sessionId)!.messageRevision;
    expect(promptRevision).toBe(1);
    const initialAssistantUpdates = h.events.filter(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "assistant",
    );
    expect(initialAssistantUpdates).toHaveLength(1);
    expect(
      (initialAssistantUpdates[0]!.data?.message as { revision?: number }).revision,
    ).toBe(1);

    const child = h.child();
    child.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "Hi ",
    });
    child.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "there",
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toBe("hello");
    // Streaming text is visible before completion.
    expect(messages[1]!.content).toBe("Hi there");
    expect(h.events.some((event) => event.type === "message.patched")).toBe(true);
    expect(h.events.filter(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "assistant",
    )).toHaveLength(1);

    const streamingRevision = h.runtime.getStatus(sessionId)!.messageRevision;
    expect(streamingRevision).toBeGreaterThan(promptRevision);
    const revisionBeforeRead = streamingRevision;
    const messageEventsBeforeRead = h.events.filter(
      (event) => event.type === "message.updated",
    ).length;
    await h.runtime.getMessages(sessionId);
    expect(h.runtime.getStatus(sessionId)!.messageRevision).toBe(revisionBeforeRead);
    expect(
      h.events.filter((event) => event.type === "message.updated").length,
    ).toBe(messageEventsBeforeRead);

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "Hi there, final." },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    // item/completed is authoritative and replaces the streamed text.
    expect(messages[1]!.content).toBe("Hi there, final.");
    expect(h.runtime.getStatus(sessionId)!.messageRevision).toBeGreaterThan(streamingRevision);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt).toBeUndefined();
    expect(h.events.some((event) => event.type === "session.idle")).toBe(true);
    expect(h.events.findLastIndex((event) => event.type === "message.patched"))
      .toBeLessThan(h.events.findLastIndex((event) => event.type === "session.idle"));
  });

  test("command output streams while the command is in progress", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "run", requestId: "req-1", attachments: [] });

    const child = h.child();
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c1",
        type: "commandExecution",
        command: "ls -la",
        status: "inProgress",
        aggregatedOutput: null,
      },
    });
    child.notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c1",
      delta: "total 8\n",
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    const toolPart = messages[1]!.parts.find((part) => part.toolName === "bash")!;
    // An in-progress command reports no aggregated output, so the deltas are
    // spliced in — otherwise the user watches an empty box.
    expect(toolPart.toolOutput).toBe("total 8\n");
    expect(toolPart.toolState).toBe("pending");
  });

  test("plan updates do not disrupt per-file raw patch fallback or structured replacement", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-raw-patch",
      attachments: [],
    });
    const child = h.child();
    child.notify("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "inProgress" },
      ],
    });
    const rawOutput = {
      type: "custom_tool_call_output",
      call_id: "patch-1",
      output: "Failed to read file to update: missing.ts",
    };
    const rawPatch = `*** Begin Patch
*** Update File: missing.ts
@@
-old
+new
*** Add File: second.ts
+second
*** End Patch`;

    // Output-before-call cannot invent an item. Repeated call/output delivery
    // must still converge on one fallback rather than duplicating transcript UI.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-1",
        name: "apply_patch",
        input: rawPatch,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-1",
        name: "apply_patch",
        input: rawPatch,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(3);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "todo_list",
      toolState: "success",
    });
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolState: "failure",
      toolError: "Failed to read file to update: missing.ts",
      toolDiff: { filePath: expect.stringContaining("missing.ts") },
    });
    expect(messages[1]!.parts[2]).toMatchObject({
      toolName: "apply_patch",
      toolState: "failure",
      toolDiff: { filePath: expect.stringContaining("second.ts") },
    });

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "fixed.ts", kind: { type: "add" } },
          { path: "second-fixed.ts", kind: { type: "add" } },
        ],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(3);
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolState: "success",
      toolTitle: "add: fixed.ts",
      toolOutput: "add: fixed.ts",
    });
    expect(messages[1]!.parts[1]!.toolError).toBeUndefined();
    expect(messages[1]!.parts[2]).toMatchObject({
      toolTitle: "add: second-fixed.ts",
      toolOutput: "add: second-fixed.ts",
    });
  });

  test("a successful raw patch stays hidden until structured fileChange arrives", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-successful-raw-patch",
      attachments: [],
    });
    const child = h.child();
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-success",
        name: "apply_patch",
        input: `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch`,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "patch-success",
        output: "Done!",
      },
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toEqual([]);

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-success",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", kind: { type: "update" } }],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "update: src/example.ts",
      toolState: "success",
    });

    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-without-structured-item",
        name: "apply_patch",
        input: `*** Begin Patch
*** Add File: src/fallback.ts
+fallback
*** End Patch`,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "patch-without-structured-item",
        output: "Done!",
      },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(2);
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "add: src/fallback.ts",
      toolState: "success",
      toolDiff: { filePath: expect.stringContaining("src/fallback.ts") },
    });
  });

  test("the streamed patch preview survives the raw call that follows it", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-preview-before-raw",
      attachments: [],
    });
    const child = h.child();

    // app-server streams the in-progress patch while the model writes it.
    child.notify("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-preview",
      changes: [{ path: "src/example.ts", kind: { type: "update" } }],
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({ toolName: "apply_patch" });

    // The raw `custom_tool_call` uses the same call id and lands afterwards. It
    // is only a recovery candidate, so it must not blank the preview already on
    // screen — the gap lasts until the patch applies, or until an approval is
    // answered, which is unbounded.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-preview",
        name: "apply_patch",
        input: `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch`,
        status: "completed",
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "update: src/example.ts",
    });

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-preview",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", kind: { type: "update" } }],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolState: "success",
      toolTitle: "update: src/example.ts",
    });
  });

  test("a raw patch call from a stale turn is dropped rather than applied", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-stale-raw-patch",
      attachments: [],
    });
    const child = h.child();

    // A turn that has already moved on must not have a previous turn's patch
    // spliced into it; `accepts` is the only thing standing between them.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-0",
      item: {
        type: "custom_tool_call",
        call_id: "stale-patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: stale.ts\n+stale\n*** End Patch",
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-0",
      item: {
        type: "custom_tool_call_output",
        call_id: "stale-patch",
        output: "Failed to read file to update: stale.ts",
      },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toEqual([]);
  });

  test("a coalesced publish rejection is contained and reported", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "stream",
      requestId: "req-publish-rejection",
      attachments: [],
    });
    const runtime = h.runtime as unknown as {
      publishAssistantMessage: (threadId: string) => Promise<void>;
    };
    runtime.publishAssistantMessage = async () => {
      throw new Error("render rejected");
    };

    const errors = await captureConsoleErrors(async () => {
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "partial",
      });
      await h.drain();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Failed to publish message update:"
        && error instanceof Error
        && error.message === "render rejected",
    )).toBe(true);
  });

  test("a terminal finalization rejection is contained and removed from pending work", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish",
      requestId: "req-finalize-rejection",
      attachments: [],
    });
    const runtime = h.runtime as unknown as {
      finalizeTurn: () => Promise<void>;
      pendingFinalizations: Set<Promise<void>>;
    };
    runtime.finalizeTurn = async () => {
      throw new Error("journal unavailable");
    };

    const errors = await captureConsoleErrors(async () => {
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Failed to finalize turn turn-1:"
        && error === "journal unavailable",
    )).toBe(true);
    expect(runtime.pendingFinalizations.size).toBe(0);
  });

  test("tool-heavy snapshots change runtime cadence and terminal events still flush immediately", async () => {
    const h = await harness({}, { adaptiveCoalesce: true });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "produce output",
      requestId: "req-large-output",
      attachments: [],
    });

    const output = "x".repeat(300 * 1024);
    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c-large",
        type: "commandExecution",
        command: "generate",
        status: "inProgress",
        aggregatedOutput: output,
      },
    });
    await h.drain();

    const runtimeState = h.runtime as unknown as {
      threadState: Map<string, {
        lastPublishedSnapshotChars: number;
        coalescer: { intervalMs: () => number };
      }>;
    };
    const state = runtimeState.threadState.get("thread-1")!;
    expect(state.lastPublishedSnapshotChars).toBeGreaterThanOrEqual(256 * 1024);
    expect(state.coalescer.intervalMs()).toBe(250);

    // This update is now parked behind the slower cadence.
    h.child().notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c-large",
      delta: "tail",
    });
    // A terminal event must cancel that timer and publish the authoritative
    // final snapshot without waiting for the adaptive interval.
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c-large",
        type: "commandExecution",
        command: "generate",
        status: "completed",
        aggregatedOutput: output,
      },
    });
    await h.drain();
    const completedToolPatchCount = h.events.length;
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-after-large-tool",
      delta: "Done",
    });
    await h.drain();
    const laterPatches = h.events
      .slice(completedToolPatchCount)
      .filter((event) => event.type === "message.patched");
    expect(laterPatches).not.toHaveLength(0);
    for (const patch of laterPatches) {
      expect(
        (patch.data as {
          changedParts?: Array<{ index: number }>;
        }).changedParts?.some(({ index }) => index === 0),
      ).toBe(false);
    }

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ phase: "idle" });
    expect((await h.runtime.getMessages(sessionId))?.[1]?.parts[0]?.toolState).toBe("success");
  });

  test("plan mode marks the assistant message as a plan review", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "plan" });
    await h.runtime.prompt(sessionId, { prompt: "plan it", requestId: "req-1", attachments: [] });

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.planReview).toBe(true);
    expect(h.child().requests.find((r) => r.method === "thread/start")!.params.sandbox).toBe(
      "read-only",
    );
  });
});

describe("at-most-once dispatch", () => {
  test("a duplicate request id while running attaches to the existing turn", async () => {
    const h = await harness({}, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(again).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        duplicate: true,
        turnId: "turn-1",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt)
      .toBe("2026-08-01T12:34:56.000Z");
    // Exactly one turn was dispatched.
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("a duplicate request id after completion is not re-run", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(again).toMatchObject({ ok: true, result: { status: "already-processed", duplicate: true } });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("the same prompt text under a new request id runs again", async () => {
    let turnCounter = 0;
    const h = await harness({
      "turn/start": () => {
        turnCounter += 1;
        return { turn: { id: `turn-${turnCounter}` } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "same", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    const second = await h.runtime.prompt(sessionId, {
      prompt: "same",
      requestId: "req-2",
      attachments: [],
    });

    // Deduplicating on text would swallow a legitimate retry.
    expect(second).toMatchObject({ ok: true, result: { turnId: "turn-2" } });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
  });

  test("an overload rejection leaves the session usable and does not journal a dispatch", async () => {
    const h = await harness({
      "turn/start": () => {
        const error = new Error("ingress queue full");
        (error as { rpcCode?: number }).rpcCode = -32001;
        throw error;
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    // The server said it did not accept the request, so the id is reusable.
    expect(h.runtime.getJournal().classify("req-1").action).toBe("dispatch");
    expect(h.runtime.getStatus(sessionId)!.phase).toBe("failed");
  });

  test("an initial prompt retries one definite overload inside the bridge", async () => {
    let attempts = 0;
    const h = await harness({
      "turn/start": () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("ingress queue full");
          (error as { rpcCode?: number }).rpcCode = -32001;
          throw error;
        }
        return { turn: { id: "turn-after-overload" } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-1";

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        requestId,
        turnId: "turn-after-overload",
      },
    });
    expect(h.child().requests.filter((request) => request.method === "turn/start"))
      .toHaveLength(2);
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "attach",
      record: { turnId: "turn-after-overload" },
    });
  });

  test("a failed prepared-journal write prevents turn dispatch", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const bridgeDir = join(codexHome, "orkestrator-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    mkdirSync(
      join(bridgeDir, `dispatch-journal-${hashCwd("/tmp/ws")}.json`),
    );

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "must not execute",
      requestId: "req-unwritable",
      attachments: [],
    });
    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(h.child().requests.some((request) => request.method === "turn/start"))
      .toBe(false);
  });

  /**
   * `recovering` after an ambiguous dispatch must be transient.
   *
   * It maps to `running`, so a thread left there rejects every later prompt with
   * a 409 and the session is bricked — the exact failure the phase exists to
   * avoid. Reconciliation, never a re-dispatch, is what resolves it.
   */
  test("an ambiguous dispatch that never ran fails, and does not brick the session", async () => {
    let hangNextTurn = false;
    let turns = 0;
    const h = await harness({
      "turn/start": () => {
        turns += 1;
        return hangNextTurn ? NO_RESPONSE : { turn: { id: `turn-${turns}` } };
      },
      // No turn carries req-1, so the write provably never landed.
      "thread/read": () => ({ thread: threadPayload("thread-1", { turns: [] }) }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Materialize the thread with a first successful turn.
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    // Dispatch a turn app-server never answers, then kill the child. The write
    // may have landed, so the outcome is genuinely unknowable.
    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    const outcome = await pending;
    await h.drain();

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    // Reconciled to a definite phase, and never silently idle while the turn
    // might still have been running.
    expect(h.runtime.getStatus(sessionId)!.phase).not.toBe("recovering");
    // Absent means it provably did not run, so the id is reusable.
    expect(h.runtime.getJournal().classify("req-1").action).toBe("dispatch");

    hangNextTurn = false;
    const next = await h.runtime.prompt(sessionId, {
      prompt: "third",
      requestId: "req-2",
      attachments: [],
    });
    expect(next.ok).toBe(true);
  });

  test("an ambiguous dispatch that did run stays running until its terminal event", async () => {
    let hangNextTurn = false;
    let now = Date.parse("2026-08-01T12:00:00.000Z");
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      // The write landed: app-server is executing this request right now.
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-9",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    }, { now: () => now });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    now = Date.parse("2026-08-01T12:05:00.000Z");
    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        turnId: "turn-9",
        turnStartedAt: "2026-08-01T12:05:00.000Z",
        duplicate: true,
      },
    });
    await h.drain();

    // Reporting idle here would let the build pipeline advance on a live turn.
    expect(phaseToExternalStatus(h.runtime.getStatus(sessionId)!.phase)).toBe("running");
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt)
      .toBe("2026-08-01T12:05:00.000Z");
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ state: "accepted" });

    // The adopted turn is tracked, so its terminal event finalizes normally.
    const adoptedTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-9", status: "completed" },
    });
    await adoptedTurnIdle;
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
  });

  test("an attached structured turn stays pending after its start response is lost", async () => {
    let hangNextTurn = false;
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-structured",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "structured-lost-response" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-0",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "return a structured review",
      requestId: "structured-lost-response",
      attachments: [],
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    });
    // The dispatch must genuinely be in flight before the child dies. A fixed
    // delay loses that race on a loaded machine — the child exits before
    // turn/start is written, so the turn never becomes ambiguous and `pending`
    // never settles. Wait for the second turn/start (the first materialized the
    // thread), matching the other lost-response tests in this file.
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);

    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "structured-lost-response",
        turnId: "turn-structured",
        duplicate: true,
      },
    });
    await h.drain();

    expect(
      h.events.filter((event) =>
        event.type === "session.structured-output"
        && event.sessionId === sessionId
      ),
    ).toEqual([]);
    expect(
      h.events.filter((event) =>
        event.type === "session.error"
        && event.sessionId === sessionId
      ),
    ).toEqual([]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      requestId: "structured-lost-response",
    });
    expect(h.runtime.getStructuredOutput(sessionId, "structured-lost-response")).toEqual({
      requestId: "structured-lost-response",
      structuredOutput: null,
    });

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-structured",
      item: {
        id: "structured-answer",
        type: "agentMessage",
        text: JSON.stringify({ summary: "Recovered successfully" }),
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-structured", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId, "structured-lost-response"))
      .toMatchObject({
        structuredOutput: {
          ok: true,
          value: { summary: "Recovered successfully" },
        },
      });
  });

  test("events emitted while an ambiguous dispatch reconciles are not lost", async () => {
    /**
     * Regression: the placeholder accumulator installed during reconciliation
     * carries a requestId, which made every event for the *real* turn look like
     * a stale event from an older turn. They were dropped instead of parked, so
     * the transcript lost items and a `turn/completed` landing in this window
     * left the thread reporting `running` forever.
     */
    let hangNextTurn = false;
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      "thread/read": () => {
        const thread = hangNextTurn
          ? threadPayload("thread-1", {
              turns: [
                {
                  id: "turn-live",
                  status: "inProgress",
                  items: [{ type: "userMessage", clientId: "req-1" }],
                },
              ],
            })
          : threadPayload("thread-1");
        // Answer late, so the turn's own events reach the runtime while the
        // reconcile is still open and the placeholder owns the thread.
        return new Promise((resolve) => setTimeout(() => resolve({ thread }), 25));
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);

    // The real turn reports itself while reconciliation is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-live",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "Work done during the ambiguous window",
      },
    });

    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        duplicate: true,
      },
    });
    await h.drain();

    // Adopted, and the parked event was replayed into the transcript.
    expect(phaseToExternalStatus(h.runtime.getStatus(sessionId)!.phase)).toBe("running");
    const messages = await h.runtime.getMessages(sessionId);
    expect(JSON.stringify(messages)).toContain("Work done during the ambiguous window");

    const adoptedTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-live", status: "completed" },
    });
    await adoptedTurnIdle;
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
  });

  test("a recovering thread is failed by the backstop when reconciliation cannot answer", async () => {
    let hangNextTurn = false;
    const h = await harness(
      {
        "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
        // Reconciliation is as broken as the dispatch was.
        "thread/read": () => {
          throw new Error("thread/read unavailable");
        },
      },
      { ambiguousRecoveryTimeoutMs: 20 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        duplicate: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Unresolvable, but bounded: `recovering` can never be permanent.
    expect(h.runtime.getStatus(sessionId)!.phase).not.toBe("recovering");
    hangNextTurn = false;
    expect((await h.runtime.prompt(sessionId, {
      prompt: "third",
      requestId: "req-2",
      attachments: [],
    })).ok).toBe(true);
  });

  test("config for a session with no thread yet is reported durable", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "plan" });

    // Nothing to persist until the thread materializes, so there is no pending
    // write that could be lost — reporting "not durable" would warn about a
    // problem that does not exist.
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({
      mode: "plan",
      durable: true,
    });
    expect(await h.runtime.getConfig("session-does-not-exist")).toBeNull();
  });

  test("a prompt without a request id is rejected before dispatch", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(await h.runtime.prompt(sessionId, { prompt: "no id", attachments: [] }))
      .toMatchObject({ ok: false, status: 400 });
    expect(h.child().requests.some((request) => request.method === "turn/start"))
      .toBe(false);
  });

  test("an ambiguous request that did run is reconciled as already-processed", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-9",
              status: "completed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Leave req-1 stuck at `prepared`, exactly as a crash mid-write would.
    await h.runtime.getJournal().markPrepared({
      requestId: "req-1",
      bridgeSessionId: sessionId,
      threadId: "thread-1",
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });

    // thread/read proved it ran, so it must not run a second time.
    expect(outcome).toMatchObject({ ok: true, result: { status: "already-processed" } });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("an ambiguous request that never ran is dispatched exactly once", async () => {
    let turns = 0;
    const h = await harness({
      "turn/start": () => {
        turns += 1;
        return { turn: { id: `turn-${turns}` } };
      },
      // No turn carries req-1, so it provably never executed.
      "thread/read": () => ({ thread: threadPayload("thread-1", { turns: [] }) }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    await h.runtime.getJournal().markPrepared({
      requestId: "req-1",
      bridgeSessionId: sessionId,
      threadId: "thread-1",
    });
    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true, result: { status: "processing", turnId: "turn-2" } });
    expect(turns).toBe(2);
  });
});

describe("interrupt lifecycle", () => {
  test("abort reports cancelling, not idle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const outcome = await h.runtime.abort(sessionId);

    // turn/interrupt is asynchronous; idle here would allow an overlapping turn.
    expect(outcome).toEqual({ status: "cancelling", phase: "cancelling" });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "cancelling",
    });
    expect(h.child().requests.some((r) => r.method === "turn/interrupt")).toBe(true);
  });

  test("a new prompt is rejected while cancelling", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    await h.runtime.abort(sessionId);

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
  });

  test("the terminal interrupted event settles the session and keeps partial output", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "partial work",
    });
    await h.drain();
    await h.runtime.abort(sessionId);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    const messages = (await h.runtime.getMessages(sessionId))!;
    // The user keeps what the agent had already produced.
    expect(messages[1]!.content).toBe("partial work");
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "interrupted",
    });
  });

  test("aborting an idle session is harmless", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.abort(sessionId)).toMatchObject({ phase: "idle" });
  });

  test("a failed abort escalation settles the turn and surfaces the error", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });
    h.engine.waitForTurnTerminal = async () => {
      throw new Error("replacement failed");
    };

    await h.runtime.abort(sessionId);
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
    });
    expect(h.events.some(
      (event) =>
        event.type === "session.error"
        && event.sessionId === sessionId
        && event.data?.error === "replacement failed",
    )).toBe(true);
  });
});

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

describe("crash recovery", () => {
  test("an unexpected generation recovery rejection is contained and reported", async () => {
    const h = await harness();
    const runtime = h.runtime as unknown as {
      recoverAfterGenerationChange: (generation: number) => Promise<void>;
    };
    runtime.recoverAfterGenerationChange = async () => {
      throw new Error("recovery invariant failed");
    };
    const engine = h.engine as unknown as { emit: (event: EngineEvent) => void };

    const errors = await captureConsoleErrors(async () => {
      engine.emit({
        kind: "engine.generation",
        generation: 2,
        previous: 1,
        engineGeneration: 2,
      });
      await h.runtime.drainPendingWork();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Generation recovery failed:"
        && error instanceof Error
        && error.message === "recovery invariant failed",
    )).toBe(true);
  });

  test("generation recovery durably clears an unmaterialized thread binding", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const context = h.runtime.getRegistry().attach(sessionId, "thread-ghost", {
      engineHandle: "thread-ghost",
      engineGeneration: h.engine.info().generation,
    });
    expect(context.materialized).toBe(false);

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: sessionId,
        threadId: "thread-ghost",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    await h.engine.getSupervisor().restartNow("test generation replacement");
    await h.drain();

    expect(h.runtime.getRegistry().getSession(sessionId)?.threadId).toBeNull();
    expect(await store.load()).toEqual([]);
  });

  test("a failed rebind is resumed before a later prompt uses the replacement child", async () => {
    let resumeAttempts = 0;
    const h = await harness({
      "thread/resume": () => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) {
          const error = new Error("temporary resume failure");
          (error as { rpcCode?: number }).rpcCode = -32603;
          throw error;
        }
        return { thread: threadPayload("thread-1") };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-before-crash",
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
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: expect.stringContaining("temporary resume failure"),
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "retry after rebind",
      requestId: "req-after-crash",
      attachments: [],
    });
    expect(outcome.ok).toBe(true);
    expect(resumeAttempts).toBe(2);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods.lastIndexOf("thread/resume")).toBeLessThan(
      methods.indexOf("turn/start"),
    );
  });

  test("a prompt waits for generation recovery before dispatching on the refreshed handle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "first",
      requestId: "req-1",
      attachments: [],
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = h.engine.resumeThread.bind(h.engine);
    const order: string[] = [];
    h.engine.resumeThread = async (...args) => {
      order.push("recovery:start");
      await gate;
      const result = await resume(...args);
      order.push("recovery:done");
      return result;
    };

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["recovery:start"]);

    let settled = false;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-2",
      attachments: [],
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);

    release();
    expect((await pending).ok).toBe(true);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
    expect(order).toEqual(["recovery:start", "recovery:done"]);
  });

  test("an active turn becomes recovering, not idle or error", async () => {
    const h = await harness({}, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).toBe("recovering");
    // A crash must not masquerade as a completed turn.
    expect(status.status).toBe("running");
    expect(status.turnStartedAt).toBe("2026-08-01T12:34:56.000Z");
  });

  /**
   * `recovering` must be a transient state, not a terminal one.
   *
   * The plan's contract is "active sessions become recovering and *eventually
   * terminal*". If nothing resolves it, the overlapping-turn guard rejects every
   * subsequent prompt with a 409 and the session is bricked until the tab is
   * closed — worse for the user than a visible failure.
   */
  test("a recovering session resolves once the replacement child is ready", async () => {
    const h = await harness({
      // The turn had already finished on the dead child.
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    const revisionBeforeRecovery = h.runtime.getStatus(sessionId)!.messageRevision;

    h.child().exit(1);
    await h.drain();
    // Bring the replacement child up, as the next request would.
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).not.toBe("recovering");
    expect(status.status).toBe("idle");
    // Recovery changed only execution state in this fixture. Sparse transcript
    // publishing must not invent a message revision when no part changed.
    expect(status.messageRevision).toBe(revisionBeforeRecovery);

    // And the session must accept work again.
    const next = await h.runtime.prompt(sessionId, {
      prompt: "after recovery",
      requestId: "req-2",
      attachments: [],
    });
    expect(next.ok).toBe(true);
  });

  test("a turn still running on the replacement child stays running", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    }, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    // Still executing, so it must not be reported idle or accept a new prompt.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      turnStartedAt: "2026-08-01T12:34:56.000Z",
    });
  });

  test("a turn that failed on the dead child is finalized as failed", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "failed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    // The real status, not a generic "restarted" failure.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "error", phase: "failed" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "failed",
    });
  });

  test("a generation reconciliation read failure terminates recovery as failed", async () => {
    const h = await harness({
      "thread/read": () => {
        throw new Error("replacement read failed");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: expect.stringContaining("replacement read failed"),
    });
  });

  /**
   * Two restarts in quick succession are ordinary (a crash during a controlled
   * restart). Both recovery passes walk the same registry and rebind the same
   * contexts, so interleaving them would let the second overwrite handles the
   * first is still installing.
   */
  test("overlapping generation changes recover one pass at a time", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const order: string[] = [];
    let pass = 0;
    const resume = h.engine.resumeThread.bind(h.engine);
    h.engine.resumeThread = async (...args) => {
      const id = (pass += 1);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await resume(...args);
      order.push(`end:${id}`);
      return result;
    };

    // Emitted directly: the point is two generation events landing back to back,
    // which a scripted child cannot produce deterministically.
    const engine = h.engine as unknown as { emit: (event: EngineEvent) => void };
    engine.emit({ kind: "engine.generation", generation: 2, previous: 1, engineGeneration: 2 });
    engine.emit({ kind: "engine.generation", generation: 3, previous: 2, engineGeneration: 3 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("a thread no session can reach is released, not just forgotten", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const runtime = h.runtime as unknown as { threadState: Map<string, unknown> };
    expect(runtime.threadState.has("thread-1")).toBe(true);
    // Orphaned: no bridge session can ever address this thread again.
    h.runtime.getRegistry().getThread("thread-1")!.bridgeSessionIds.clear();

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    expect(h.runtime.getRegistry().getThread("thread-1")).toBeUndefined();
    // The render state holds the diff baselines and the coalescer holds a timer;
    // dropping the map entry alone leaks both.
    expect(runtime.threadState.has("thread-1")).toBe(false);
  });

  test("events from the dead generation are ignored", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const dead = h.child();
    dead.exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    dead.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "ghost text",
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.content).not.toContain("ghost text");
  });
});

describe("idle detach and transparent re-attach", () => {
  /**
   * Detaching is the whole storage story: it frees the bridge's transcript, its
   * render state (the biggest consumer, since diffs hold whole file contents) and
   * app-server's own thread state. It is only safe because the rollout on disk is
   * the authoritative transcript.
   */
  test("an idle materialized thread is detached and unsubscribed", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 1 });

    expect(h.child().requests.some((r) => r.method === "thread/unsubscribe")).toBe(true);
    expect(h.runtime.getRegistry().listThreads()).toHaveLength(0);
    expect(h.runtime.getStorageStats()).toMatchObject({ threads: 0, detachedThreads: 1 });
  });

  test("a thread with a live turn is never detached, however idle it looks", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    clock += 60_000;
    // The turn is still executing; freeing its state would lose the in-flight work.
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 0 });
    expect(h.runtime.getRegistry().listThreads()).toHaveLength(1);
  });

  test("a detached session rehydrates accepted steering text from the rollout", async () => {
    let clock = 1_000_000;
    const h = await harness(
      { "turn/steer": () => ({ turnId: "turn-1" }) },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    expect(
      await h.runtime.steerSession(
        sessionId,
        "also inspect the bridge",
        "turn-1",
        "req-steer",
      ),
    ).toBe("accepted");
    expect((await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["hello", "also inspect the bridge"]);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-1.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "turn_context",
          payload: { turn_id: "turn-1", cwd: "/tmp/ws" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "update_plan",
            call_id: "call-plan",
            arguments: JSON.stringify({
              plan: [{ step: "Patch both files", status: "in_progress" }],
            }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-plan",
            output: "Plan updated",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "also inspect the bridge" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-patch",
            status: "completed",
            input: `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`,
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-patch",
            output: "Done!",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    // Same session id the UI still holds — this must just work.
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).not.toBeNull();
    expect(messages!.filter((message) => message.role === "user").map((message) => ({
      content: message.content,
      turnId: message.turnId,
    }))).toEqual([
      { content: "hello", turnId: "turn-1" },
      { content: "also inspect the bridge", turnId: "turn-1" },
    ]);
    const patchParts = messages!
      .flatMap((message) => message.parts)
      .filter((part) => part.toolName === "apply_patch");
    expect(patchParts).toHaveLength(2);
    expect(patchParts.map((part) => part.toolDiff?.filePath)).toEqual([
      "/tmp/ws/src/a.ts",
      "/tmp/ws/src/b.ts",
    ]);
    expect(h.child().requests.some((r) => r.method === "thread/resume")).toBe(true);
    expect(h.runtime.getStorageStats()).toMatchObject({ reattachedThreads: 1 });
  });

  test("a prompt on a detached session resumes rather than forking a new thread", async () => {
    let clock = 1_000_000;
    let turns = 0;
    const h = await harness(
      {
        "turn/start": () => {
          turns += 1;
          return { turn: { id: `turn-${turns}` } };
        },
      },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-2",
      attachments: [],
    });

    expect(outcome.ok).toBe(true);
    const methods = h.child().requests.map((r) => r.method);
    // Forking would orphan the conversation the user was looking at.
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect((outcome as { result: { threadId: string } }).result.threadId).toBe("thread-1");
  });

  /**
   * An unmaterialized thread has no rollout, so `thread/resume` fails with "no
   * rollout found" — verified against codex 0.146.0. Keeping its id would strand
   * the session against a dead thread forever.
   */
  test("detaching a thread that never ran a turn clears its id so the next prompt starts fresh", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    // Materialize a thread binding without completing a turn: resume the session
    // onto a thread, then let it go idle before any prompt.
    const context = h.runtime.getRegistry().attach(sessionId, "thread-ghost", {
      engineHandle: "thread-ghost",
    });
    expect(context.materialized).toBe(false);
    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
    });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: sessionId,
        threadId: "thread-ghost",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    clock += 60_000;
    await h.runtime.sweepIdle();

    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
    expect(await store.load()).toEqual([]);

    // A bridge restart must not resurrect the rollout-less thread id that was
    // cleared in memory by the sweep.
    await h.runtime.stop();
    const restarted = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sweepIntervalMs: 0,
    });
    expect(restarted.runtime.getStatus(sessionId)).toBeNull();
  });

  test("a re-attach failure clears the binding instead of stranding the session", async () => {
    let clock = 1_000_000;
    const h = await harness(
      {
        "thread/resume": () => {
          const error = new Error("thread/resume: no rollout found for thread id thread-1");
          (error as { rpcCode?: number }).rpcCode = -32600;
          throw error;
        },
      },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    await h.runtime.sweepIdle();

    // Rollout deleted underneath us: the session must recover, not wedge.
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
  });

  test("a transient re-attach failure preserves the original thread for retry", async () => {
    let clock = 1_000_000;
    let resumeAttempts = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeAttempts += 1;
          if (resumeAttempts === 1) {
            const error = new Error("temporary transport failure");
            (error as { rpcCode?: number }).rpcCode = -32603;
            throw error;
          }
          return { thread: threadPayload("thread-1") };
        },
      },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    clock += 60_000;
    await h.runtime.sweepIdle();

    // A read must not 500 on an ambiguous re-attach: the transcript the bridge
    // still knows about is a better answer than an error page.
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBe("thread-1");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(resumeAttempts).toBe(2);
  });

  test("a read falls back to the last known transcript rather than failing", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "answer" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Force the slow path and fail it the way an in-flight restart would.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("temporary transport failure");
    };

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => message.content)).toEqual(["hello", "answer"]);
  });

  test("a prompt never forks when transient re-attach fails", async () => {
    let clock = 1_000_000;
    let resumeAttempts = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeAttempts += 1;
          if (resumeAttempts === 1) {
            const error = new Error("temporary transport failure");
            (error as { rpcCode?: number }).rpcCode = -32603;
            throw error;
          }
          return { thread: threadPayload("thread-1") };
        },
      },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    expect(await h.runtime.prompt(sessionId, {
      prompt: "retry later",
      requestId: "req-2",
      attachments: [],
    })).toMatchObject({ ok: false, status: 503 });
    expect(h.runtime.getRegistry().getSession(sessionId)?.threadId).toBe("thread-1");
    expect(h.child().requests.map((request) => request.method)).toEqual(["thread/resume"]);

    expect((await h.runtime.prompt(sessionId, {
      prompt: "retry now",
      requestId: "req-3",
      attachments: [],
    })).ok).toBe(true);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  test("a resumed history thread remains materialized when swept", async () => {
    let clock = 1_000_000;
    const h = await harness(
      { "thread/resume": () => ({ thread: threadPayload("thread-history") }) },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const resumed = await h.runtime.resumeSession({ threadId: "thread-history", mode: "build" });
    expect(
      h.runtime.getRegistry().getThread("thread-history")?.materialized,
    ).toBe(true);

    clock += 60_000;
    await h.runtime.sweepIdle();
    expect(h.runtime.getRegistry().getSession(resumed!.sessionId)?.threadId).toBe(
      "thread-history",
    );
  });

  test("a long-dead session id is eventually forgotten", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    clock += 60_000;
    const result = await h.runtime.sweepIdle();

    // Only a tiny mapping was retained, and past retention even that goes.
    expect(result.forgotten).toBe(1);
    expect(h.runtime.getRegistry().getSession(sessionId)).toBeUndefined();
  });

  test("an active session is not forgotten", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    clock += 60_000;
    h.runtime.getRegistry().touch(sessionId);

    expect(await h.runtime.sweepIdle()).toMatchObject({ forgotten: 0 });
    expect(h.runtime.getRegistry().getSession(sessionId)).toBeDefined();
  });

  test("normal activity refreshes durable retention across a runtime restart", async () => {
    let clock = 1_000_000;
    const options = {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    };
    const first = await harness({}, options);
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    await first.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-retained",
      attachments: [],
    });
    first.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.drain();

    // Past half of the short retention window, an ordinary messages read carries
    // the in-memory touch to disk. Repeated status polls inside that window share
    // the same bounded heartbeat rather than writing on every request.
    clock += 6_000;
    await first.runtime.getMessages(sessionId);
    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 10_000,
    });
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
    first.runtime.getStatus(sessionId);
    first.runtime.getStatus(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
    await first.runtime.stop();

    // The original creation time is now outside retention, but the durable
    // activity heartbeat is not, so the same bridge id must survive restart.
    clock += 6_000;
    const second = await harness({}, options);
    expect(await second.runtime.getMessages(sessionId)).not.toBeNull();
    expect(second.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
      threadId: "thread-1",
    });
    await second.runtime.stop();
  });

  test("activity heartbeats are bounded by an hour in production settings", async () => {
    let clock = 1_000_000;
    // Default retention (seven days), so the interval is the one-hour cap rather
    // than half of a deliberately short test window.
    const h = await harness({}, { now: () => clock, threadIdleMs: 0, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-hourly",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws", now: () => clock });
    const written = Date.parse((await store.load())[0]!.lastAccessed);

    // A mounted tab polls many times an hour; every touch must not be a write.
    clock += 59 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(written);

    clock += 2 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("disabled retention still heartbeats on the hourly interval", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 0,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-no-retention",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    const written = Date.parse((await store.load())[0]!.lastAccessed);

    // Retention 0 has no half-window to shrink to, so the hourly default applies.
    clock += 30 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(written);

    clock += 31 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("shutdown waits for an in-flight registry write", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-shutdown",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = (h.runtime as unknown as { store: BridgeSessionStore }).store;
    const upsert = store.upsert.bind(store);
    let landed = false;
    store.upsert = async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await upsert(record);
      landed = true;
    };

    // `getStatus` heartbeats without awaiting, so this write is genuinely in
    // flight when shutdown begins. Abandoning it loses the record the UI's
    // session id resolves through after a restart.
    clock += 6_000;
    h.runtime.getStatus(sessionId);
    await h.runtime.stop();

    expect(landed).toBe(true);
    const verifier = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 10_000,
    });
    expect(Date.parse((await verifier.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("a thread dropped for a missing rollout releases its runtime state", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const runtime = h.runtime as unknown as { threadState: Map<string, unknown> };
    expect(runtime.threadState.has("thread-1")).toBe(true);

    // Force the slow path, then delete the rollout underneath it.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("thread/resume: no rollout found for thread id thread-1");
    };

    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
    // The diff baselines are the largest per-thread allocation, and the coalescer
    // owns a live timer; neither can be reclaimed by a thread that never returns.
    expect(runtime.threadState.has("thread-1")).toBe(false);
  });

  test("detaching can be disabled", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 0, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 24 * 60 * 60 * 1000;
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 0 });
  });
});

describe("activity polling", () => {
  /** A session mid-turn: its thread is materialized and running. */
  async function workingSession() {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();
    return { h, sessionId };
  }

  /** The scripted child asks for approval on the session's live turn. */
  async function parkApproval(h: Harness): Promise<void> {
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();
  }

  test("an unknown session is reported in band as missing", async () => {
    const h = await harness();
    // Not an error: the caller has to be able to tell "this session is gone"
    // apart from "this bridge is too old to answer".
    expect(h.runtime.getActivity("session-never-existed")).toBe("missing");
  });

  test("a session with no thread, and one whose turn finished, are both idle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Never prompted, so no thread has been materialized at all.
    expect(h.runtime.getActivity(sessionId)).toBe("idle");

    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getActivity(sessionId)).toBe("idle");
  });

  test("a running turn with nothing parked is working", async () => {
    const { h, sessionId } = await workingSession();
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
    expect(h.runtime.getActivity(sessionId)).toBe("working");
  });

  test("a parked approval is waiting rather than working", async () => {
    const { h, sessionId } = await workingSession();
    await parkApproval(h);

    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
    expect(h.runtime.getActivity(sessionId)).toBe("waiting");
  });

  test("a parked interaction is waiting rather than working", async () => {
    const { h, sessionId } = await workingSession();
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7101,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{
          id: "language",
          header: "Language",
          question: "Which language?",
          options: [{ label: "TypeScript" }],
        }],
      },
    });
    await h.drain();

    expect(h.runtime.listInteractions(sessionId)).toHaveLength(1);
    expect(h.runtime.getActivity(sessionId)).toBe("waiting");
  });

  test("cancelling, recovering and starting are never reported idle", async () => {
    const { h, sessionId } = await workingSession();
    const context = h.runtime.getRegistry().getThread("thread-1")!;

    for (const phase of ["starting", "cancelling", "recovering"] as const) {
      context.phase = phase;
      // All three map to `running`. Reporting them idle would let the build
      // pipeline advance on a turn that may still be executing.
      expect(phaseToExternalStatus(phase)).toBe("running");
      expect(h.runtime.getActivity(sessionId)).toBe("working");
    }

    await parkApproval(h);
    for (const phase of ["starting", "cancelling", "recovering"] as const) {
      context.phase = phase;
      expect(h.runtime.getActivity(sessionId)).toBe("waiting");
    }
  });

  test("a session awaiting dispatch recovery is working, never idle", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-awaiting",
        threadId: "thread-awaiting",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Awaiting",
        titleSource: "prompt",
        lastAcceptedRequestId: "req-live",
      }),
    );
    const h = await harness();
    // Startup clears the claim once recovery has run; re-arm it to model the
    // window where a restored thread's last turn may still be executing.
    (h.runtime as unknown as { threadsAwaitingDispatchRecovery: Set<string> })
      .threadsAwaitingDispatchRecovery.add("thread-awaiting");

    // Restored lazily, so there is no thread context — the recovery claim is the
    // only thing standing between this session and a misleading `idle`.
    expect(h.runtime.getRegistry().getThread("thread-awaiting")).toBeUndefined();
    expect(h.runtime.getActivity("session-awaiting")).toBe("working");
  });

  /**
   * The regression this endpoint exists for.
   *
   * The backend polls every persisted session every two seconds. Doing that
   * through `getStatus` touches `lastAccessed` on each poll, which keeps
   * `detachableThreads` permanently false, so the idle sweep never frees a
   * transcript, its render state or its app-server subscription.
   */
  test("polling activity still lets the sweep detach; polling status does not", async () => {
    async function pollPastTheIdleWindow(
      poll: (runtime: AppServerRuntime, sessionId: string) => void,
    ): Promise<{ detached: number; forgotten: number }> {
      let clock = 1_000_000;
      const h = await harness({}, { now: () => clock, sweepIntervalMs: 0 });
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();

      // The backend's own cadence, run past the production idle window.
      for (let elapsed = 0; elapsed <= DEFAULT_THREAD_IDLE_MS + 60_000; elapsed += 2_000) {
        clock += 2_000;
        poll(h.runtime, sessionId);
      }
      return h.runtime.sweepIdle();
    }

    expect(
      await pollPastTheIdleWindow((runtime, sessionId) => {
        runtime.getActivity(sessionId);
      }),
    ).toMatchObject({ detached: 1 });

    // The control: this is exactly what the sweep used to call, and why nothing
    // was ever detached.
    expect(
      await pollPastTheIdleWindow((runtime, sessionId) => {
        runtime.getStatus(sessionId);
      }),
    ).toMatchObject({ detached: 0 });
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

describe("slash commands", () => {
  test("/models lists descriptions and marks the configured model", async () => {
    const h = await harness({
      "model/list": () => ({
        data: [
          {
            id: "model-a",
            displayName: "Model A",
            description: "Fast general-purpose model",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: false,
          },
          {
            id: "model-b",
            displayName: "Model B",
            description: null,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      }),
    });
    const { sessionId } = h.runtime.createSession({
      mode: "build",
      model: "model-a",
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/models",
      requestId: "req-models",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[1]?.content).toContain(
      "- model-a (current): Fast general-purpose model",
    );
    expect(messages?.[1]?.content).toContain("- model-b");
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  test("custom prompt commands are matched case-insensitively and expanded before dispatch", async () => {
    const promptsDir = join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "review.md"),
      [
        "---",
        "description: Review a target",
        "argument_hint: <target>",
        "---",
        "Review $ARGUMENTS and report concrete findings.",
      ].join("\n"),
    );
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/ReViEw src/parser.ts",
      requestId: "req-custom-prompt",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    const turnStart = h.child().requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params.input))
      .toContain("Review src/parser.ts and report concrete findings.");
    expect(JSON.stringify(turnStart?.params.input)).not.toContain("/ReViEw");
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[0]?.content).toBe("/ReViEw src/parser.ts");
  });

  test("/help is answered locally without reaching Codex", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(0);

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/help",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.child().requests.some((r) => r.method === "turn/start")).toBe(false);
    const assistant = h.events.find((event) => event.type === "message.updated");
    expect(
      (assistant?.data?.message as { content: string } | undefined)?.content,
    ).toContain("Available Codex slash commands");
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.content).toBe("/help");
    expect(messages?.[1]?.content).toContain("Available Codex slash commands");
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(1);
  });

  test("an idle /steer is answered locally instead of starting a model turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/STEER check the failing test",
      requestId: "req-idle-steer",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[0]?.content).toBe("/STEER check the failing test");
    expect(messages?.[1]?.content).toContain("no active Codex turn to steer");
  });

  test("a structured /steer is rejected and never starts a model turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/steer do not start another turn",
      requestId: "req-structured-steer",
      attachments: [],
      outputSchema: { type: "object" },
    });

    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: "/steer cannot be used with structured output",
    });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(h.runtime.getRegistry().getSession(sessionId)?.structuredOutputRequestId)
      .toBeUndefined();
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).toEqual([]);
  });

  test("a bare or multiline idle /steer is answered locally without leaking to Codex", async () => {
    for (const [prompt, expectedReply] of [
      ["/steer", "Usage: /steer <instructions>"],
      ["/steer   \n  ", "Usage: /steer <instructions>"],
      ["/steer\ncheck the API\nthen the UI", "no active Codex turn to steer"],
    ] as const) {
      const h = await harness();
      const { sessionId } = h.runtime.createSession({ mode: "build" });

      const outcome = await h.runtime.prompt(sessionId, {
        prompt,
        requestId: `req-${prompt.length}`,
        attachments: [],
      });

      expect(outcome).toMatchObject({ ok: true });
      expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
      const messages = await h.runtime.getMessages(sessionId);
      expect(messages?.[0]?.content).toBe(prompt);
      expect(messages?.[1]?.content).toContain(expectedReply);
    }
  });

  /**
   * Local replies have no rollout item, so their timestamp is the only ordering
   * key they share with the model's transcript. Concatenating would show them
   * after work that actually happened later.
   */
  test("local replies are interleaved into a materialized transcript by time", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "/help", requestId: "req-help", attachments: [] });

    clock += 5_000;
    await h.runtime.prompt(sessionId, { prompt: "real work", requestId: "req-1", attachments: [] });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "done" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The /help exchange predates the Codex turn, so it sorts first.
    expect(messages[0]!.content).toBe("/help");
    expect(messages[2]!.content).toBe("real work");
    const timestamps = messages.map((message) => message.createdAt);
    expect([...timestamps].sort()).toEqual(timestamps);
  });

  test("the local transcript is capped rather than growing for the life of the tab", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const rounds = MAX_LOCAL_MESSAGES; // two entries each, so comfortably over the cap
    for (let round = 0; round < rounds; round += 1) {
      await h.runtime.prompt(sessionId, {
        prompt: "/help",
        requestId: `req-help-${round}`,
        attachments: [],
      });
    }

    const session = h.runtime.getRegistry().getSession(sessionId)!;
    // Nothing else ever evicts these: they survive detaching, and there is no
    // rollout to reload them from.
    expect(session.localMessages).toHaveLength(MAX_LOCAL_MESSAGES);
    expect(session.localMessages.at(-1)!.content).toContain("Available Codex slash commands");
    expect(session.messageRevision).toBe(rounds);
  });
});

describe("health", () => {
  test("reports engine state, generation and counters", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const health = h.runtime.getHealth();
    expect(health).toMatchObject({
      state: "ready",
      generation: 1,
      codexVersion: "0.145.0",
      activeThreads: 1,
      activeTurns: 1,
      bridgeSessions: 1,
    });
    expect(health.environmentFingerprint).toMatch(/^sha256:/);
  });
});

describe("interactive approvals", () => {
  /**
   * Creates a session, materializes its thread, then has the scripted child ask
   * for approval — the only way to reach the runtime's mapping code, which needs a
   * real threadId bound to a real bridge session.
   */
  async function withPendingApproval(
    options: {
      approvalParams?: Record<string, unknown>;
      withPendingMessageDelta?: boolean;
    } = {},
  ) {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();

    if (options.withPendingMessageDelta) {
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-before-approval",
        delta: "Before approval",
      });
    }
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9001,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
        ...(options.approvalParams ?? {}),
      },
    });
    await h.drain();

    return { h, sessionId };
  }

  test("emits approval-requested to the owning session and lists it", async () => {
    const { h, sessionId } = await withPendingApproval({
      withPendingMessageDelta: true,
    });

    const requested = h.events.filter((event) => event.type === "session.approval-requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.sessionId).toBe(sessionId);
    expect((requested[0]!.data!.approval as { command?: string }).command).toBe("rm -rf build");
    expect(h.events.findLastIndex((event) => event.type === "message.patched"))
      .toBeLessThan(
        h.events.findIndex((event) => event.type === "session.approval-requested"),
      );

    // The rehydration path: a remounting tab must be able to ask rather than
    // relying on having seen the SSE frame.
    const listed = h.runtime.listApprovals(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe("command");
  });

  test("a non-actionable approval cannot be approved, only denied or cancelled", async () => {
    /**
     * The renderer hides Approve for a request the bridge could not describe,
     * but that is presentation only. Anything that can reach the route — a stale
     * tab, another client — must not be able to approve an action no human was
     * ever shown.
     */
    const { h, sessionId } = await withPendingApproval({
      approvalParams: { command: undefined, cwd: undefined },
    });
    const approval = h.runtime.listApprovals(sessionId)[0]!;
    expect(approval.actionable).toBe(false);

    expect(h.runtime.respondToApproval(sessionId, approval.approvalId, "approve"))
      .toBe("not-actionable");
    expect(
      h.runtime.respondToApproval(sessionId, approval.approvalId, "approve-for-session"),
    ).toBe("not-actionable");
    // Still pending: refusing to approve must not silently drop the request.
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);

    expect(h.runtime.respondToApproval(sessionId, approval.approvalId, "deny"))
      .toBe("applied");
  });

  test("approving sends accept to app-server and clears the card", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "approve")).toBe("applied");
    await h.drain();

    // The response is a plain JSON-RPC result, so it shows up as a write rather
    // than a request; assert on the raw stdin instead.
    expect(h.child().stdin.lines.join("")).toContain('"decision":"accept"');
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);

    const resolved = h.events.filter((event) => event.type === "session.approval-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data).toMatchObject({ approvalId, decision: "approve", resolution: "answered" });
  });

  test("declining sends decline", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    h.runtime.respondToApproval(sessionId, approvalId, "deny");
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
  });

  test("another session cannot answer this one's approval", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    const other = h.runtime.createSession({ mode: "build" });

    // Scoped so one tab cannot authorise a command in another environment's turn.
    expect(h.runtime.respondToApproval(other.sessionId, approvalId, "approve")).toBe(
      "wrong-session",
    );
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
    expect(h.runtime.listApprovals(other.sessionId)).toHaveLength(0);
  });

  test("answering twice reports the second as unknown", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "approve")).toBe("applied");
    await h.drain();
    // A stale card, which is normal over a five-minute window.
    expect(h.runtime.respondToApproval(sessionId, approvalId, "deny")).toBe("unknown");
  });

  test("an unknown approval id is reported, not thrown", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.respondToApproval(sessionId, "apr-nope", "approve")).toBe("unknown");
  });

  test("closing the session withdraws the approval", async () => {
    const { h, sessionId } = await withPendingApproval();
    await h.runtime.deleteSession(sessionId);
    await h.drain();

    // The child is still alive, so it must be answered — otherwise the turn waits
    // forever on a prompt whose UI has gone.
    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
  });

  test("closing one of two tabs leaves the shared approval actionable", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9002,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch allowed",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();

    const approvalId = h.runtime.listApprovals(second!.sessionId)[0]!.approvalId;
    await h.runtime.deleteSession(first.sessionId);
    await h.drain();
    expect(h.child().stdin.lines.join("")).not.toContain('"decision":"decline"');
    expect(h.runtime.respondToApproval(second!.sessionId, approvalId, "deny")).toBe("applied");
  });

  test("a tab attached after presentation can take over a pending approval", async () => {
    const { h, sessionId: firstSessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(firstSessionId)[0]!.approvalId;
    const second = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
    });

    expect(h.runtime.listApprovals(second!.sessionId)).toHaveLength(1);
    await h.runtime.deleteSession(firstSessionId);
    expect(h.runtime.respondToApproval(second!.sessionId, approvalId, "deny"))
      .toBe("applied");
  });

  test("cancel approval interrupts the owning turn", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
    await h.drain();

    expect(h.child().requests.some((request) => request.method === "turn/interrupt"))
      .toBe(true);
  });

  test("an abort rejection after cancelling an approval is contained and reported", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    const runtime = h.runtime as unknown as {
      abort: (targetSessionId: string) => Promise<unknown>;
    };
    runtime.abort = async () => {
      throw new Error("abort dispatch rejected");
    };

    const errors = await captureConsoleErrors(async (captured) => {
      expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
      await waitUntil(
        () => captured.length > 0,
        "approval cancellation rejection was not reported",
      );
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Failed to cancel turn after approval response:"
        && error instanceof Error
        && error.message === "abort dispatch rejected",
    )).toBe(true);
  });

  test("a failed interrupt after cancelling an approval surfaces a terminal error", async () => {
    const h = await harness({
      "turn/interrupt": () => {
        throw new Error("interrupt transport failed");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9004,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch file",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();

    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
    await waitUntil(
      () => h.runtime.getStatus(sessionId)?.phase === "failed",
      "failed interrupt did not settle the turn",
    );

    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
    });
  });

  test("v2 file-change approvals are enriched from the active item", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-file",
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "src/index.ts", kind: { type: "update", move_path: null } }],
      },
    });
    await h.drain();
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9010,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        startedAtMs: 1,
      },
    });
    await h.drain();

    expect(h.runtime.listApprovals(sessionId)[0]).toMatchObject({
      actionable: true,
      changes: [{ path: "src/index.ts", kind: "update" }],
    });
  });

  test("non-terminal errors warn every shared tab without releasing the turn", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
    });
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-before-warning",
      delta: "Before warning",
    });
    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: {
        message: "retry later",
        codexErrorInfo: "usageLimitExceeded",
      },
      willRetry: true,
    });
    await h.drain();

    const warnings = h.events.filter((event) => event.type === "session.warning");
    expect(warnings).toHaveLength(2);
    expect(h.events.findLastIndex((event) => event.type === "message.patched"))
      .toBeLessThan(h.events.findIndex((event) => event.type === "session.warning"));
    expect(warnings.map((event) => event.sessionId).sort())
      .toEqual([first.sessionId, second!.sessionId].sort());
    for (const warning of warnings) {
      expect(warning.data).toEqual({
        error: "retry later",
        code: "usageLimitExceeded",
        willRetry: true,
      });
    }
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.runtime.getStatus(first.sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
    expect(h.runtime.getStatus(second!.sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
  });

  test("a non-retrying standalone error remains a warning while the turn is live", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });

    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: {
        message: "context window exceeded",
        codexErrorInfo: { contextWindowExceeded: {} },
      },
      willRetry: false,
    });
    await h.drain();

    expect(
      h.events.filter(
        (event) =>
          event.type === "session.warning"
          && event.sessionId === sessionId,
      ),
    ).toEqual([
      {
        type: "session.warning",
        sessionId,
        data: {
          error: "context window exceeded",
          code: "contextWindowExceeded",
          willRetry: false,
        },
      },
    ]);
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
      requestId: "req-1",
    });
  });

  test("a warning is followed by a terminal error when turn completion fails", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });

    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: { message: "temporary provider failure", codexErrorInfo: null },
      willRetry: true,
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: {
          message: "provider retries exhausted",
          codexErrorInfo: "streamDisconnected",
        },
      },
    });
    await h.drain();

    expect(
      h.events
        .filter(
          (event) =>
            event.sessionId === sessionId
            && (event.type === "session.warning" || event.type === "session.error"),
        )
        .map((event) => ({ type: event.type, data: event.data })),
    ).toEqual([
      {
        type: "session.warning",
        data: {
          error: "temporary provider failure",
          code: undefined,
          willRetry: true,
        },
      },
      {
        type: "session.error",
        data: { error: "provider retries exhausted" },
      },
    ]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: "provider retries exhausted",
    });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "failed",
    });
  });

  test("a file-change approval is described as such", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();

    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9002,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        startedAtMs: 1,
        reason: "write outside the workspace",
      },
    });
    await h.drain();

    const approval = h.runtime.listApprovals(sessionId)[0]!;
    expect(approval.kind).toBe("file-change");
    expect(approval.reason).toBe("write outside the workspace");
    // The v2 method carries no changes; the UI reads them off the item it holds.
    expect(approval.changes).toBeUndefined();
  });

  test("an approval for an unknown thread falls back to auto-decline", async () => {
    const h = await harness();

    // No bridge session is bound to this thread, so there is no card to click and
    // parking it would leave the turn waiting on nobody.
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9003,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-unbound", turnId: "turn-x", itemId: "item-x", startedAtMs: 1 },
    });
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
  });
});

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

describe("steering", () => {
  test("reports not-found without a session or a thread", async () => {
    const h = await harness();
    expect(await h.runtime.steerSession("session-nope", "more", "turn-1", "req-steer"))
      .toBe("not-found");
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer"))
      .toBe("not-found");
  });

  test("reports idle when no turn is running", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer"))
      .toBe("idle");
  });

  test("steers the active turn, pinning the turn id the user was looking at", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    expect(
      await h.runtime.steerSession(
        sessionId,
        "also check the tests",
        "turn-1",
        "req-steer",
      ),
    )
      .toBe("accepted");
    expect(h.child().requests.find((request) => request.method === "turn/steer")?.params)
      .toMatchObject({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "also check the tests" }],
        clientUserMessageId: "req-steer",
      });

    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.filter((message) => message.role === "user").map((message) => ({
      content: message.content,
      turnId: message.turnId,
    }))).toEqual([
      { content: "go", turnId: "turn-1" },
      { content: "also check the tests", turnId: "turn-1" },
    ]);
    expect(h.events.some(
      (event) => event.type === "message.updated"
        && (event.data?.message as { content?: unknown } | undefined)?.content
          === "also check the tests",
    )).toBe(true);
  });

  test("rejects a stale renderer turn before calling app-server", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-stale",
      attachments: [],
    });

    expect(await h.runtime.steerSession(sessionId, "more", "turn-old", "req-steer"))
      .toBe("mismatch");
    expect(h.child().requests.some((request) => request.method === "turn/steer")).toBe(false);
  });

  test("an explicit app-server expected-turn rejection is a definite mismatch", async () => {
    const h = await harness({
      "turn/steer": () => {
        throw new Error("expectedTurnId does not match");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-explicit",
      attachments: [],
    });

    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer"))
      .toBe("mismatch");
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
  });

  test("ambiguous steering failures never claim the text was unsent", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-ambiguous",
      attachments: [],
    });

    for (const error of [
      new AppServerTimeoutError("turn/steer", 100),
      new AppServerProcessExitError("child exited", {
        generation: h.engine.info().generation,
        method: "turn/steer",
      }),
      new Error("transport is closed"),
    ]) {
      h.engine.steerTurn = async () => {
        throw error;
      };
      expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer"))
        .toBe("unknown");
    }

    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
    expect((await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user"))
      .toHaveLength(1);
  });

  test("an ambiguous steer retry reconciles its client id instead of dispatching twice", async () => {
    let steerCalls = 0;
    let steerAttempted = false;
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [{
            id: "turn-1",
            status: "inProgress",
            items: [
              { type: "userMessage", clientId: "req-original" },
              ...(steerAttempted
                ? [{ type: "userMessage", clientId: "req-steer-retry" }]
                : []),
            ],
          }],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-original",
      attachments: [],
    });
    h.engine.steerTurn = async () => {
      steerCalls += 1;
      steerAttempted = true;
      throw new AppServerTimeoutError("turn/steer", 100);
    };

    expect(
      await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry"),
    ).toBe("unknown");
    expect(
      await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry"),
    ).toBe("accepted");
    expect(steerCalls).toBe(1);
    expect((await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["go", "more"]);

    // A third delivery of the same logical request is served from the bounded
    // accepted cache and cannot append or dispatch it again.
    expect(
      await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry"),
    ).toBe("accepted");
    expect(steerCalls).toBe(1);
    expect((await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user"))
      .toHaveLength(2);
  });

  test("a fresh runtime reconciles a retained steer request id before dispatch", async () => {
    const first = await harness();
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    await first.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-original",
      attachments: [],
    });
    first.engine.steerTurn = async () => {
      throw new AppServerTimeoutError("turn/steer", 100);
    };
    expect(
      await first.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-restart"),
    ).toBe("unknown");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-1.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/tmp/ws" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "go" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "more" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await first.runtime.stop();

    const second = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [{
            id: "turn-1",
            status: "inProgress",
            items: [
              { type: "userMessage", clientId: "req-original" },
              { type: "userMessage", clientId: "req-steer-restart" },
            ],
          }],
        }),
      }),
    });
    second.child().requests.length = 0;

    expect(
      await second.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-restart"),
    ).toBe("accepted");
    expect(second.child().requests.some((request) => request.method === "turn/steer"))
      .toBe(false);
    expect((await second.runtime.getMessages(sessionId))?.filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["go", "more"]);
  });

  /**
   * `cancelling` reports `running`, so a steer arriving in the interrupt window
   * is offered to app-server rather than refused as idle: only the child knows
   * whether the turn is still accepting input. It must never be reported as
   * accepted on a guess — a turn that has already been interrupted rejects, and
   * that is a mismatch.
   */
  test("a steer during cancelling is decided by the engine, never assumed", async () => {
    const accepting = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = accepting.runtime.createSession({ mode: "build" });
    await accepting.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-cancelling-1",
      attachments: [],
    });
    await accepting.runtime.abort(sessionId);
    expect(accepting.runtime.getStatus(sessionId)).toMatchObject({ phase: "cancelling" });

    expect(await accepting.runtime.steerSession(sessionId, "more", "turn-1", "req-steer"))
      .toBe("accepted");
    // The steer is pinned to the turn the user was looking at, interrupt or not.
    expect(
      accepting.child().requests.find((request) => request.method === "turn/steer")?.params,
    ).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });

    const rejecting = await harness({
      "turn/steer": () => {
        throw new Error("turn is no longer accepting input");
      },
    });
    const { sessionId: rejectedId } = rejecting.runtime.createSession({ mode: "build" });
    await rejecting.runtime.prompt(rejectedId, {
      prompt: "go",
      requestId: "req-cancelling-2",
      attachments: [],
    });
    await rejecting.runtime.abort(rejectedId);

    expect(await rejecting.runtime.steerSession(rejectedId, "more", "turn-1", "req-steer"))
      .toBe("mismatch");
    // Still cancelling: a refused steer neither completes nor resurrects the turn.
    expect(rejecting.runtime.getStatus(rejectedId)).toMatchObject({
      status: "running",
      phase: "cancelling",
    });
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

describe("runtime health", () => {
  test("scopes the snapshot to the session's thread when there is one", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    const health = await h.runtime.getRuntimeHealth(sessionId) as Record<string, unknown>;
    expect(health.engine).toBeDefined();
    expect(h.child().requests.find((request) => request.method === "mcpServerStatus/list")?.params)
      .toMatchObject({ threadId: "thread-1" });
  });

  test("an unknown session is rejected instead of returning environment-wide data", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });

    expect(await h.runtime.getRuntimeHealth("session-nope")).toBeNull();
    expect(
      h.child().requests.some((request) => request.method === "mcpServerStatus/list"),
    ).toBe(false);
  });

  /**
   * Protocol drift is what operators watch after a Codex bump, and this is the
   * authenticated surface it is served on — the public `/global/health` payload
   * stays stripped.
   */
  test("carries the engine-global protocol drift counters", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("codex/invented/method", { threadId: "thread-1" });
    await h.drain();

    const health = await h.runtime.getRuntimeHealth(sessionId) as {
      protocol: {
        unknownNotifications: number;
        unsupportedItems: number;
        serverRequests: Record<string, unknown>;
      };
    };
    expect(health.protocol.unknownNotifications).toBe(1);
    expect(health.protocol.unsupportedItems).toBe(0);
    expect(health.protocol.serverRequests).toMatchObject({ pending: expect.any(Number) });
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
