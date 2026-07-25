import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerRuntime,
  MAX_PENDING_EVENTS_PER_TURN,
  MAX_PENDING_TURNS,
  MAX_RECOVERED_CONTEXT_CHARS,
  type RuntimeSseEvent,
} from "./app-server-runtime.js";
import { AppServerEngine } from "./engine/app-server-engine.js";
import type { AppServerSupervisorOptions } from "./app-server/process-supervisor.js";
import { FakeReadable, FakeWritable } from "./app-server/testing/fake-app-server.js";
import { MAX_LOCAL_MESSAGES, phaseToExternalStatus } from "./sessions/thread-registry.js";
import { BridgeSessionStore, hashCwd } from "./sessions/persistence.js";
import { DispatchJournal } from "./sessions/dispatch-journal.js";
import type { EngineEvent } from "./engine/types.js";

/**
 * Returned by a handler to model a request app-server never answers — the exact
 * shape of an ambiguous dispatch, where the write may have landed but no response
 * ever arrives.
 */
const NO_RESPONSE = Symbol("no-response");

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
    fingerprintEnvironment?: () => string;
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
    // Deltas are published on a cadence; zero keeps the tests deterministic.
    coalesceIntervalMs: 0,
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
    for (let round = 0; round < 5; round += 1) {
      await engine.getSupervisor().notificationQueue.drainAll();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
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

describe("session lifecycle", () => {
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

    const resumed = await h.runtime.resumeSession({
      threadId: "thread-ambiguous",
      mode: "build",
    });
    hangNextTurn = true;
    const pending = h.runtime.prompt(resumed!.sessionId, {
      prompt: "first after recovery",
      requestId: "req-ambiguous",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
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
    await new Promise((resolve) => setTimeout(resolve, 20));

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

    expect(await h.runtime.getMessages("session-named")).toEqual([]);
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

  test("the first prompt creates the thread and dispatches a turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "do the thing",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: { status: "processing", requestId: "req-1", threadId: "thread-1", turnId: "turn-1" },
    });
    const methods = h.child().requests.map((r) => r.method);
    expect(methods).toContain("thread/start");
    expect(methods).toContain("turn/start");
    // The request id must reach app-server as the at-most-once key.
    expect(
      h.child().requests.find((r) => r.method === "turn/start")!.params.clientUserMessageId,
    ).toBe("req-1");
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
    chmodSync(recordsDir, 0o500);
    try {
      // The store warns and resolves on a write failure, so "updated" here would
      // be a lie: after a restart the stale plan/build mode is re-hydrated into
      // thread/resume, silently restoring the old sandbox.
      expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("memory-only");
      expect((await store.load())[0]?.config.mode).toBe("build");
      // Memory still matches the engine, which did accept the change.
      expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
    } finally {
      chmodSync(recordsDir, 0o700);
    }
  });

  test("a full turn streams deltas and finalizes the transcript", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });

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
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    expect(h.events.some((event) => event.type === "session.idle")).toBe(true);
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
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(again).toMatchObject({
      ok: true,
      result: { status: "processing", duplicate: true, turnId: "turn-1" },
    });
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

  test("a failed prepared-journal write prevents turn dispatch", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const bridgeDir = join(codexHome, "orkestrator-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    chmodSync(bridgeDir, 0o500);
    try {
      const outcome = await h.runtime.prompt(sessionId, {
        prompt: "must not execute",
        requestId: "req-unwritable",
        attachments: [],
      });
      expect(outcome).toMatchObject({ ok: false, status: 503 });
      expect(h.child().requests.some((request) => request.method === "turn/start"))
        .toBe(false);
    } finally {
      chmodSync(bridgeDir, 0o700);
    }
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
    expect(await pending).toMatchObject({ ok: false, status: 503 });
    await h.drain();

    // Reporting idle here would let the build pipeline advance on a live turn.
    expect(phaseToExternalStatus(h.runtime.getStatus(sessionId)!.phase)).toBe("running");
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

    expect(await pending).toMatchObject({ ok: false, status: 503 });
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
    expect(await pending).toMatchObject({ ok: false, status: 503 });

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

    await h.runtime.prompt(first!.sessionId, {
      prompt: "from tab A",
      requestId: "req-1",
      attachments: [],
    });

    // Tab B sees tab A's message because they share the ThreadContext.
    const messagesB = (await h.runtime.getMessages(second!.sessionId))!;
    expect(messagesB.some((message) => message.content === "from tab A")).toBe(true);
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
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).toBe("recovering");
    // A crash must not masquerade as a completed turn.
    expect(status.status).toBe("running");
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

    h.child().exit(1);
    await h.drain();
    // Bring the replacement child up, as the next request would.
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).not.toBe("recovering");
    expect(status.status).toBe("idle");

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
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    // Still executing, so it must not be reported idle or accept a new prompt.
    expect(h.runtime.getStatus(sessionId)!.status).toBe("running");
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

  test("a detached session serves messages again by re-attaching from the rollout", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    // Same session id the UI still holds — this must just work.
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).not.toBeNull();
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
   * rollout found" — verified against codex 0.145.0. Keeping its id would strand
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

describe("models", () => {
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
});

describe("slash commands", () => {
  test("/help is answered locally without reaching Codex", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

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
    options: { approvalParams?: Record<string, unknown> } = {},
  ) {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();

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
    const { h, sessionId } = await withPendingApproval();

    const requested = h.events.filter((event) => event.type === "session.approval-requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.sessionId).toBe(sessionId);
    expect((requested[0]!.data!.approval as { command?: string }).command).toBe("rm -rf build");

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

  test("retryable errors fan out to every tab sharing the thread", async () => {
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
    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: { message: "retry later", codexErrorInfo: null },
      willRetry: true,
    });
    await h.drain();

    const recipients = h.events
      .filter(
        (event) =>
          event.type === "session.error"
          && event.data?.error === "retry later",
      )
      .map((event) => event.sessionId)
      .sort();
    expect(recipients).toEqual([first.sessionId, second!.sessionId].sort());
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
