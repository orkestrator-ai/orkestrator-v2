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
