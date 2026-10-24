import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { PtyProcess } from "./pty.js";
import type { StorageService } from "./storage.js";

/**
 * Two backends in one process own separate state: whatever one registers is
 * invisible to the other (docs/todo/backend-structure/0011).
 */

const runtimes: BackendRuntime[] = [];

function createRuntime(
  options: ConstructorParameters<typeof BackendRuntime>[0] = {
    emit: () => undefined,
  },
): BackendRuntime {
  const runtime = new BackendRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

function fakePty(): PtyProcess & { writes: string[] } {
  const writes: string[] = [];
  return {
    pid: 4242,
    writes,
    write: (data: string) => writes.push(data),
    resize: () => undefined,
    kill: mock(() => undefined),
    terminate: async () => true,
  } as unknown as PtyProcess & { writes: string[] };
}

function fakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    pid: 5151,
    killed: false,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function contextFor(runtime: BackendRuntime): CommandContext {
  return {
    storage: {} as StorageService,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
  };
}

describe("two BackendRuntimes in one process", () => {
  test("a terminal registered in one backend is invisible to the other's commands", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const commands = createCommandRegistry();
    const call = async (name: string, args: Record<string, unknown>, context: CommandContext) =>
      commands.get(name)!(args, context);
    const pty = fakePty();
    first.terminals.rememberSession("env-1:terminal", {
      kind: "local",
      environmentId: "env-1",
      cols: 80,
      rows: 24,
    });
    first.terminals.registerProcess("env-1:terminal", pty);
    first.terminals.appendOutput("env-1:terminal", "hello");

    expect(await call("list_terminal_sessions", {}, contextFor(first))).toEqual(["env-1:terminal"]);
    expect(await call("list_terminal_sessions", {}, contextFor(second))).toEqual([]);

    expect(
      await call("terminal_write", { sessionId: "env-1:terminal", data: "ls" }, contextFor(second)),
    ).toEqual({ delivered: false });
    expect(pty.writes).toEqual([]);
    expect(
      await call("get_terminal_output_buffer", { sessionId: "env-1:terminal" }, contextFor(second)),
    ).toBe("");
    expect(
      await call("get_terminal_output_buffer", { sessionId: "env-1:terminal" }, contextFor(first)),
    ).toBe("hello");

    // Closing every terminal of the environment in one backend leaves the
    // other's untouched, and vice versa.
    second.terminals.cleanupSessionsForEnvironment("env-1");
    expect(first.terminals.hasProcess("env-1:terminal")).toBe(true);
    first.terminals.cleanupSessionsForEnvironment("env-1");
    expect(first.terminals.hasProcess("env-1:terminal")).toBe(false);
  });

  test("a local server owned by one backend is invisible to the other", async () => {
    const terminated: string[] = [];
    const first = createRuntime({
      emit: () => undefined,
      localServers: {
        terminateProcessTree: async (child) => {
          terminated.push(String(child.pid));
          return true;
        },
      },
    });
    const second = createRuntime({
      emit: () => undefined,
      localServers: {
        terminateProcessTree: async (child) => {
          terminated.push(`second:${child.pid}`);
          return true;
        },
      },
    });
    const child = fakeChild();
    first.localServers.adoptProcess("codex:env-1", child, {
      workingDirectory: "/work/env-1",
      accountId: "account-a",
    });
    first.localServers.recordBridgeToken("codex", "env-1", "token-a");

    expect(first.localServers.process("codex:env-1")).toBe(child);
    expect(second.localServers.process("codex:env-1")).toBeUndefined();
    expect(second.localServers.processCount()).toBe(0);
    expect(second.localServers.bridgeToken("codex", "env-1")).toBeUndefined();
    expect(second.localServers.isAccountInUse("codex", "account-a")).toBe(false);
    expect(first.localServers.isAccountInUse("codex", "account-a")).toBe(true);

    // Shutting one backend down neither closes the other's admission nor
    // terminates a process it does not own.
    await second.localServers.shutdown();
    expect(second.localServers.isShuttingDown()).toBe(true);
    expect(first.localServers.isShuttingDown()).toBe(false);
    expect(terminated).toEqual([]);
    expect(first.localServers.process("codex:env-1")).toBe(child);

    await first.localServers.shutdown();
    expect(terminated).toEqual(["5151"]);
    expect(first.localServers.processCount()).toBe(0);
    expect(first.localServers.bridgeToken("codex", "env-1")).toBeUndefined();
  });

  test("environment operations and their guards are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();

    expect(first.environments.beginDelete("env-1")).toBe(true);
    expect(() => first.environments.assertNotDeleting("env-1")).toThrow(
      "Environment is being deleted: env-1",
    );
    expect(() => second.environments.assertNotDeleting("env-1")).not.toThrow();
    expect(second.environments.beginDelete("env-1")).toBe(true);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = new EnvironmentLifecycleTaskTracker();
    const queued = first.environments.enqueueLifecycleOperation("env-1", tasks, () => held);
    expect(first.environments.hasLifecycleWork("env-1")).toBe(true);
    expect(second.environments.hasLifecycleWork("env-1")).toBe(false);
    release();
    await queued;
  });
});
