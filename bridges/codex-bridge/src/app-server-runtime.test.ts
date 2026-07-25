import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRuntime, type RuntimeSseEvent } from "./app-server-runtime.js";
import { AppServerEngine } from "./engine/app-server-engine.js";
import type { AppServerSupervisorOptions } from "./app-server/process-supervisor.js";
import { FakeReadable, FakeWritable } from "./app-server/testing/fake-app-server.js";
import { phaseToExternalStatus } from "./sessions/thread-registry.js";
import { BridgeSessionStore } from "./sessions/persistence.js";

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
    try {
      const result = handler((message.params ?? {}) as Record<string, unknown>);
      if (result === NO_RESPONSE) return;
      this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.stdout.pushMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: (error as { rpcCode?: number }).rpcCode ?? -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
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
    fingerprintEnvironment?: () => string;
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
  const runtime = new AppServerRuntime({
    engine,
    codexHome,
    cwd: "/tmp/ws",
    emit: (event) => events.push(event),
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
  });
  await runtime.start();

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

  return { runtime, engine, events, children, child: () => children.at(-1)!, drain };
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

    h.engine.configureThread = async () => {
      throw new Error("configure rejected");
    };
    await expect(h.runtime.updateConfig(sessionId, { mode: "build" })).rejects.toThrow(
      "configure rejected",
    );
    expect((await store.load())[0]?.config.mode).toBe("plan");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
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

  test("an ambiguous dispatch reports recovering, never idle", async () => {
    let hangNextTurn = false;
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Materialize the thread with a first successful turn.
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Dispatch a turn app-server never answers, then kill the child. The write
    // may have landed, so the outcome is genuinely unknowable.
    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.child().exit(1);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    const status = h.runtime.getStatus(sessionId)!;
    // The write may have landed, so the turn might be running. Reporting idle
    // would let the build pipeline advance on it.
    expect(status.phase).toBe("recovering");
    expect(phaseToExternalStatus(status.phase)).toBe("running");
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

    await expect(h.runtime.getMessages(sessionId)).rejects.toThrow("temporary transport failure");
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBe("thread-1");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(resumeAttempts).toBe(2);
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
