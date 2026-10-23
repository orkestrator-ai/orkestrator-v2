import { EventEmitter } from "node:events";
import { AppServerEngine } from "./app-server-engine.js";
import type { AppServerSupervisorOptions } from "../app-server/process-supervisor.js";
import { FakeReadable, FakeWritable } from "../app-server/testing/fake-app-server.js";
import type { EngineEvent, EngineTurnConfig } from "./types.js";

export const BUILD: EngineTurnConfig = {
  mode: "build",
  model: "gpt-5.6-sol",
  cwd: "/tmp/workspace",
};
export const PLAN: EngineTurnConfig = { mode: "plan", cwd: "/tmp/workspace" };

/** What app-server's `config/read` reports once `-c web_search="disabled"` is applied. */
export const HOSTED_NETWORK_LOCKED = () => ({
  config: {
    web_search: "disabled",
    features: { standalone_web_search: false, incremental_tools: false },
  },
  origins: {},
  layers: null,
});

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
      if (result instanceof Promise) {
        void result.then(
          (value) => this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result: value }),
          respondWithError,
        );
      } else {
        this.stdout.pushMessage({ jsonrpc: "2.0", id: message.id, result });
      }
    } catch (error) {
      respondWithError(error);
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

export function thread(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

export function harness(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  engineOptions: Partial<ConstructorParameters<typeof AppServerEngine>[0]> = {},
): Harness {
  const children: ScriptedChild[] = [];
  const merged = {
    initialize: INITIALIZE,
    "skills/list": () => ({ data: [{ errors: [], skills: [] }] }),
    "config/read": () => ({ config: { features: { incremental_tools: false } } }),
    ...handlers,
  };
  let index = 0;

  const engine = new AppServerEngine({
    codexPath: "/fake/codex",
    cwd: "/tmp/workspace",
    codexHome: "/tmp/codex-home",
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    interruptTimeoutMs: 30,
    toolHistoryVerdict: async () => "clean",
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

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
