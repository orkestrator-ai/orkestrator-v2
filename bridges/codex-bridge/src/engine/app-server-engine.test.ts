import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { AppServerEngine, ROOT_THREAD_SOURCE_KINDS } from "./app-server-engine.js";
import type { AppServerSupervisorOptions } from "../app-server/process-supervisor.js";
import { FakeReadable, FakeWritable } from "../app-server/testing/fake-app-server.js";
import type { EngineEvent, EngineTurnConfig } from "./types.js";

const BUILD: EngineTurnConfig = { mode: "build", model: "gpt-5.6-sol", cwd: "/tmp/workspace" };
const PLAN: EngineTurnConfig = { mode: "plan", cwd: "/tmp/workspace" };

/**
 * A scripted app-server child. Handlers may be replaced per test, and
 * notifications can be injected to model the real interleaving of a response with
 * the events it triggers.
 */
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
      this.stdout.pushMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: handler((message.params ?? {}) as Record<string, unknown>),
      });
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

  kill(signal: string): boolean {
    this.exit(null, signal);
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

const INITIALIZE = () => ({
  userAgent: "orkestrator/0.145.0 (test)",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
});

function thread(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    sessionId: id,
    cwd: "/tmp/workspace",
    preview: "hello",
    source: "appServer",
    parentThreadId: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    name: null,
    turns: [],
    ...extra,
  };
}

interface Harness {
  engine: AppServerEngine;
  children: ScriptedChild[];
  events: EngineEvent[];
  child: () => ScriptedChild;
}

function harness(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  engineOptions: Partial<ConstructorParameters<typeof AppServerEngine>[0]> = {},
): Harness {
  const children: ScriptedChild[] = [];
  const merged = { initialize: INITIALIZE, ...handlers };
  let index = 0;

  const engine = new AppServerEngine({
    codexPath: "/fake/codex",
    cwd: "/tmp/workspace",
    codexHome: "/tmp/codex-home",
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    interruptTimeoutMs: 30,
    // The engine always owns its own supervisor wiring; only the process spawn
    // and timings are overridden here.
    supervisorOverrides: {
      pidFileEnabled: false,
      shutdownGraceMs: 10,
      backoffScheduleMs: [1],
      refreshEnvironment: async () => undefined,
      spawnProcess: (() => {
        index += 1;
        const child = new ScriptedChild(1000 + index, merged);
        children.push(child);
        return child;
      }) as unknown as AppServerSupervisorOptions["spawnProcess"],
    },
    ...engineOptions,
  });

  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));

  return { engine, children, events, child: () => children.at(-1)! };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("startup and capabilities", () => {
  test("advertises app-server capabilities", async () => {
    const h = harness();
    const info = await h.engine.start();

    expect(info.kind).toBe("app-server");
    expect(info.codexVersion).toBe("0.145.0");
    expect(h.engine.capabilities).toMatchObject({
      readThread: true,
      listThreads: true,
      setThreadName: true,
      clientUserMessageId: true,
      asyncInterrupt: true,
      itemDeltas: true,
    });
  });
});

describe("thread lifecycle", () => {
  test("thread/start passes explicit policy and clears the service tier", async () => {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });

    expect(started.id).toBe("t1");
    const params = h.child().requests.find((r) => r.method === "thread/start")!.params;
    expect(params).toMatchObject({
      cwd: "/tmp/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.6-sol",
      // Explicitly null, so a previously set fast tier is cleared rather than
      // silently inherited.
      serviceTier: null,
    });
  });

  test("plan mode resolves to a read-only sandbox", async () => {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    await h.engine.start();
    await h.engine.startThread({ config: PLAN });

    expect(h.child().requests.find((r) => r.method === "thread/start")!.params.sandbox).toBe(
      "read-only",
    );
  });

  test("resume returns reconstructed turns with their client ids", async () => {
    const h = harness({
      "thread/resume": () => ({
        thread: thread("t1", {
          turns: [
            {
              id: "turn-1",
              status: "completed",
              startedAt: 1_700_000_000,
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    await h.engine.start();
    const resumed = await h.engine.resumeThread("t1", { config: BUILD, includeTurns: true });

    expect(resumed.turns).toHaveLength(1);
    expect(resumed.turns![0]).toMatchObject({ id: "turn-1", clientId: "req-1" });
    // Unix seconds are converted to ISO for the bridge's own model.
    expect(resumed.turns![0]!.startedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  test("an unmaterialized thread reads as empty turns, not an error", async () => {
    const h = harness({
      "thread/read": () => {
        const error = new Error(
          "thread t1 is not materialized yet; includeTurns is unavailable before first user message",
        );
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });
    await h.engine.start();

    // This is the first-turn ambiguous-dispatch case: "no turns" is the correct
    // reading, and it is what makes a single clean re-dispatch safe.
    const read = await h.engine.readThread("t1", { includeTurns: true });
    expect(read).toEqual({ id: "t1", handle: "t1", turns: [] });
  });

  test("a genuine read failure still propagates", async () => {
    const h = harness({
      "thread/read": () => {
        throw new Error("disk on fire");
      },
    });
    await h.engine.start();
    await expect(h.engine.readThread("t1")).rejects.toThrow("disk on fire");
  });

  test("closing a thread unsubscribes and never deletes", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "thread/unsubscribe": () => ({}),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.unsubscribeThread(started.handle);

    const methods = h.child().requests.map((r) => r.method);
    expect(methods).toContain("thread/unsubscribe");
    // Deleting would destroy the user's conversation and its descendants.
    expect(methods).not.toContain("thread/delete");
  });
});

describe("history listing", () => {
  test("requests every root source kind explicitly", async () => {
    const h = harness({ "thread/list": () => ({ data: [], nextCursor: null }) });
    await h.engine.start();
    await h.engine.listThreads();

    const params = h.child().requests.find((r) => r.method === "thread/list")!.params;
    // Omitting sourceKinds silently returns zero threads, emptying the resume
    // dialog for both legacy exec and new appServer conversations.
    expect(params.sourceKinds).toEqual([...ROOT_THREAD_SOURCE_KINDS]);
    expect(params.cwd).toBe("/tmp/workspace");
  });

  test("excludes sub-agent children and foreign working directories", async () => {
    const h = harness({
      "thread/list": () => ({
        data: [
          thread("root-1"),
          thread("child-1", { parentThreadId: "root-1" }),
          thread("other-cwd", { cwd: "/tmp/workspace-sibling" }),
        ],
        nextCursor: null,
      }),
    });
    await h.engine.start();
    const result = await h.engine.listThreads();

    expect(result.threads.map((entry) => entry.id)).toEqual(["root-1"]);
    expect(result.supported).toBe(true);
  });

  test("keeps legacy exec threads created by the SDK engine", async () => {
    const h = harness({
      "thread/list": () => ({
        data: [thread("legacy", { source: "exec" })],
        nextCursor: null,
      }),
    });
    await h.engine.start();
    const result = await h.engine.listThreads();

    expect(result.threads[0]).toMatchObject({ id: "legacy", source: "exec" });
  });

  test("unwraps an object-form session source", async () => {
    const h = harness({
      "thread/list": () => ({
        data: [thread("sub", { source: { subagent: { kind: "review" } }, parentThreadId: null })],
        nextCursor: null,
      }),
    });
    await h.engine.start();
    expect((await h.engine.listThreads()).threads[0]!.source).toBe("subagent");
  });
});

describe("model catalog", () => {
  test("paginates and preserves the server's reasoning order", async () => {
    let call = 0;
    const h = harness({
      "model/list": () => {
        call += 1;
        return call === 1
          ? {
              data: [
                {
                  id: "gpt-5.6-sol",
                  displayName: "GPT-5.6-Sol",
                  description: "frontier",
                  hidden: false,
                  isDefault: true,
                  defaultReasoningEffort: "medium",
                  // Deliberately not alphabetical: the order is meaningful and
                  // clients must not re-sort it.
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low", description: "fast" },
                    { reasoningEffort: "medium", description: "balanced" },
                    { reasoningEffort: "xhigh", description: "deepest" },
                  ],
                  serviceTiers: [{ id: "fast", name: "Fast", description: "" }],
                },
              ],
              nextCursor: "page-2",
            }
          : { data: [{ id: "gpt-5.6-mini", displayName: "Mini" }], nextCursor: null };
      },
    });
    await h.engine.start();
    const models = await h.engine.listModels();

    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-mini"]);
    expect(models[0]!.supportedReasoningEfforts.map((entry) => entry.effort)).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    expect(models[0]!.serviceTiers).toEqual(["fast"]);
    expect(models[0]!.isDefault).toBe(true);
  });

  test("stops paginating rather than looping on a repeated cursor", async () => {
    let calls = 0;
    const h = harness({
      "model/list": () => {
        calls += 1;
        return { data: [{ id: `m${calls}`, displayName: "m" }], nextCursor: "always" };
      },
    });
    await h.engine.start();
    await h.engine.listModels();

    expect(calls).toBeLessThanOrEqual(20);
  });
});

describe("turn dispatch", () => {
  test("forwards the request id as clientUserMessageId", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    const turn = await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "do the thing" }],
      config: BUILD,
      requestId: "req-42",
    });

    expect(turn).toMatchObject({ threadId: "t1", turnId: "turn-1" });
    const params = h.child().requests.find((r) => r.method === "turn/start")!.params;
    // This is what lets recovery ask "did my request run?" instead of guessing.
    expect(params.clientUserMessageId).toBe("req-42");
    expect(params.input).toEqual([{ type: "text", text: "do the thing", text_elements: [] }]);
  });

  test("forwards outputSchema on turn/start without changing the tool-capable turn", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "review it" }],
      config: BUILD,
      outputSchema,
    });

    const params = h.child().requests.find((r) => r.method === "turn/start")!.params;
    expect(params.outputSchema).toEqual(outputSchema);
    expect(params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  test("sends a resolved sandboxPolicy object, not the mode shorthand", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: PLAN });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "plan it" }],
      config: PLAN,
    });

    const params = h.child().requests.find((r) => r.method === "turn/start")!.params;
    expect(params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: true });
    expect(params.sandbox).toBeUndefined();
  });

  test("carries image attachments", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [
        { type: "text", text: "look" },
        { type: "local_image", path: "/tmp/shot.png" },
      ],
      config: BUILD,
    });

    expect(h.child().requests.find((r) => r.method === "turn/start")!.params.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/shot.png" },
    ]);
  });

  test("an overload rejection is the only immediately retryable failure", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => {
        const error = new Error("ingress queue full");
        (error as { rpcCode?: number }).rpcCode = -32001;
        throw error;
      },
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });

    const failure = await h.engine
      .startTurn({ handle: started.handle, input: [{ type: "text", text: "x" }], config: BUILD })
      .catch((error: unknown) => h.engine.classifyFailure(error));

    expect(failure).toMatchObject({ class: "rejected", retryImmediately: true });
  });

  test("a process exit during dispatch is ambiguous, never retried blind", async () => {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });

    const pending = h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
      requestId: "req-1",
    });
    h.child().exit(1);

    const failure = await pending.catch((error: unknown) => h.engine.classifyFailure(error));
    expect(failure).toMatchObject({ class: "ambiguous", retryImmediately: false });
  });

  test("a non-overload RPC error is ambiguous and requires reconciliation", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => {
        const error = new Error("internal failure after acceptance");
        (error as { rpcCode?: number }).rpcCode = -32603;
        throw error;
      },
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });

    const failure = await h.engine
      .startTurn({
        handle: started.handle,
        input: [{ type: "text", text: "x" }],
        config: BUILD,
        requestId: "req-ambiguous",
      })
      .catch((error: unknown) => h.engine.classifyFailure(error));

    expect(failure).toMatchObject({ class: "ambiguous", retryImmediately: false });
  });

  test("dispatching on an unknown handle fails loudly", async () => {
    const h = harness();
    await h.engine.start();
    await expect(
      h.engine.startTurn({ handle: "nope", input: [{ type: "text", text: "x" }], config: BUILD }),
    ).rejects.toThrow(/Unknown app-server thread handle/);
  });
});

describe("reconciliation", () => {
  test("finds an already-dispatched request by client id", async () => {
    const h = harness({
      "thread/read": () => ({
        thread: thread("t1", {
          turns: [
            { id: "turn-1", status: "completed", items: [{ type: "userMessage", clientId: "req-1" }] },
          ],
        }),
      }),
    });
    await h.engine.start();

    expect(await h.engine.reconcileRequest("t1", "req-1")).toEqual({
      result: "terminal",
      turnId: "turn-1",
      status: "completed",
    });
  });

  test("reports a still-running turn as attach", async () => {
    const h = harness({
      "thread/read": () => ({
        thread: thread("t1", {
          turns: [
            { id: "turn-1", status: "inProgress", items: [{ type: "userMessage", clientId: "req-1" }] },
          ],
        }),
      }),
    });
    await h.engine.start();
    expect(await h.engine.reconcileRequest("t1", "req-1")).toMatchObject({ result: "attach" });
  });

  test("reports absent when the request never landed, making one dispatch safe", async () => {
    const h = harness({ "thread/read": () => ({ thread: thread("t1", { turns: [] }) }) });
    await h.engine.start();
    expect(await h.engine.reconcileRequest("t1", "req-1")).toEqual({ result: "absent" });
  });
});

describe("interrupt lifecycle", () => {
  test("resolves once the terminal turn/completed arrives", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
      "turn/interrupt": () => ({}),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
    });

    await h.engine.interruptTurn(started.handle, "turn-1");
    const waiting = h.engine.waitForTurnTerminal(started.handle, "turn-1");

    // The interrupt response alone does not mean stopped.
    h.child().notify("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", status: "interrupted" },
    });

    expect(await waiting).toBe("interrupted");
  });

  test("re-asks before escalating when no terminal event arrives", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
      "turn/interrupt": () => ({}),
      "thread/read": () => ({
        thread: thread("t1", { turns: [{ id: "turn-1", status: "interrupted", items: [] }] }),
      }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
    });

    const status = await h.engine.waitForTurnTerminal(started.handle, "turn-1", { timeoutMs: 10 });

    // Persisted state settled it without needing a restart.
    expect(status).toBe("interrupted");
    expect(h.child().requests.filter((r) => r.method === "turn/interrupt").length).toBeGreaterThan(0);
    expect(h.children).toHaveLength(1);
  });

  test("returns unknown rather than falsely reporting idle", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
      "turn/interrupt": () => ({}),
      // Still running, and no terminal event will come.
      "thread/read": () => ({
        thread: thread("t1", { turns: [{ id: "turn-1", status: "inProgress", items: [] }] }),
      }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
    });

    // Saying "idle" here would let a new prompt overlap a live turn.
    expect(
      await h.engine.waitForTurnTerminal(started.handle, "turn-1", { timeoutMs: 10 }),
    ).toBe("unknown");
  });

  test("restarts the child only as an explicit last resort", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
      "turn/interrupt": () => ({}),
      "thread/read": () => ({
        thread: thread("t1", { turns: [{ id: "turn-1", status: "inProgress", items: [] }] }),
      }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
    });

    const status = await h.engine.waitForTurnTerminal(started.handle, "turn-1", {
      timeoutMs: 10,
      allowRestart: true,
    });

    expect(status).toBe("interrupted");
    expect(h.children).toHaveLength(2);
  });
});

describe("notification fan-out", () => {
  test("streams deltas and the authoritative item as engine events", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const started = await h.engine.startThread({ config: BUILD });
    await h.engine.startTurn({
      handle: started.handle,
      input: [{ type: "text", text: "x" }],
      config: BUILD,
    });

    const child = h.child();
    child.notify("turn/started", { threadId: "t1", turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "par",
    });
    child.notify("item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "partial complete" },
    });
    child.notify("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", status: "completed" },
    });
    await settle();
    await h.engine.getSupervisor().notificationQueue.drainAll();

    expect(h.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "turn.started",
        "item.text.delta",
        "item.completed",
        "turn.completed",
      ]),
    );
  });

  test("events from a replaced generation are discarded", async () => {
    const h = harness({
      "thread/start": () => ({ thread: thread("t1") }),
      "turn/start": () => ({ turn: { id: "turn-1" } }),
    });
    await h.engine.start();
    const firstChild = h.child();
    firstChild.exit(1);
    await h.engine.getSupervisor().ensureReady();

    h.events.length = 0;
    // Generation 1 is dead; anything it says describes state that no longer
    // exists and must not be applied to the new process's threads.
    firstChild.notify("item/agentMessage/delta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "stale",
    });
    await settle();
    await h.engine.getSupervisor().notificationQueue.drainAll();

    expect(h.events.filter((event) => event.kind === "item.text.delta")).toHaveLength(0);
  });

  test("an unknown notification is counted, not fatal", async () => {
    const h = harness();
    await h.engine.start();
    h.child().notify("codex/invented/method", { threadId: "t1" });
    await settle();
    await h.engine.getSupervisor().notificationQueue.drainAll();

    expect(h.engine.getHealth().unknownNotifications).toBe(1);
    expect(h.events.some((event) => event.kind === "unknown.protocol")).toBe(true);
  });

  test("replayHistory rebuilds a transcript through the live event path", async () => {
    const h = harness();
    await h.engine.start();
    h.events.length = 0;

    h.engine.replayHistory("t1", [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "u1", type: "userMessage", clientId: "req-1" },
          { id: "a1", type: "agentMessage", text: "answer" },
        ],
      },
    ]);

    // Same events a live stream would have produced, so a rehydrated transcript
    // cannot drift from the original.
    expect(h.events.map((event) => event.kind)).toEqual([
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
  });
});

describe("server requests", () => {
  test("an unexpected approval is declined and surfaced to the transcript", async () => {
    const h = harness({ "thread/start": () => ({ thread: thread("t1") }) });
    await h.engine.start();

    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: "srv-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn-1", itemId: "i1" },
    });
    await settle();
    await settle();

    const answer = h.child().stdin.parsed().find((message) => message.id === "srv-1");
    expect(answer).toMatchObject({ result: { decision: "decline" } });
    // The user is told why, instead of watching the turn stall.
    expect(
      h.events.some(
        (event) => event.kind === "error" && event.error.code === "server-request-declined",
      ),
    ).toBe(true);
  });
});
