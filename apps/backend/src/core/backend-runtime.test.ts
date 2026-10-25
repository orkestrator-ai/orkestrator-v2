import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { PtyProcess } from "./pty.js";
import type { StorageService } from "./storage.js";

/**
 * Two backends in one process own separate state: whatever one registers is
 * invisible to the other (docs/todo/backend-structure/0011 and 0066).
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

  test("the replacement and move fence is per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const commands = createCommandRegistry();

    let finishReplacement!: () => void;
    const replacement = first.environments.fence.withReplacement(
      "env-1",
      () => new Promise<void>((resolve) => (finishReplacement = resolve)),
    );
    expect(() => first.environments.fence.beginAgentWork("env-1")).toThrow("being rebuilt");
    second.environments.fence.beginAgentWork("env-1")();
    finishReplacement();
    await replacement;
    first.environments.fence.beginAgentWork("env-1")();

    expect(first.environments.fence.beginMove("env-1")).toBe(true);
    expect(() => first.environments.fence.beginMutation("env-1")).toThrow("being moved");
    second.environments.fence.beginMutation("env-1")();
    // The command surface reads the fence of the backend it runs in: a shell
    // in the moving folder is refused by the first backend only.
    const open = (runtime: BackendRuntime) =>
      commands.get("create_local_terminal_session")!(
        { environmentId: "env-1" },
        {
          ...contextFor(runtime),
          storage: { getEnvironment: async () => null } as unknown as StorageService,
        },
      );
    await expect(open(first)).rejects.toThrow("being moved");
    await expect(open(second)).rejects.not.toThrow("being moved");
    first.environments.fence.endMove("env-1");
    expect(second.environments.fence.beginMove("env-1")).toBe(true);
    second.environments.fence.endMove("env-1");
  });

  test("host OpenCode starts take turns within one backend only", async () => {
    const first = createRuntime({
      emit: () => undefined,
      localServers: { openCodeLockedStartRetryDelaysMs: [1] },
    });
    const second = createRuntime();

    const releaseFirst = await first.localServers.openCodeHostStart.acquire();
    // The other backend's turn is not held behind this one.
    const releaseSecond = await second.localServers.openCodeHostStart.acquire();
    let queued = false;
    const next = first.localServers.openCodeHostStart.acquire().then((release) => {
      queued = true;
      return release;
    });
    await Bun.sleep(5);
    expect(queued).toBe(false);
    releaseFirst();
    (await next)();
    releaseSecond();

    expect(first.localServers.openCodeHostStart.lockedStartRetryDelayMs(0)).toBe(1);
    expect(first.localServers.openCodeHostStart.lockedStartRetryDelayMs(1)).toBeUndefined();
    expect(second.localServers.openCodeHostStart.lockedStartRetryDelayMs(1)).toBe(2_000);
  });

  test("Pi catalogue probes and the container-state snapshot are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();

    let probes = 0;
    const emptyProbe = async () => {
      probes += 1;
      return [];
    };
    expect(await first.localServers.piCatalog.discover(false, emptyProbe)).toEqual([]);
    // The first backend backs off after its empty probe; the second still probes.
    expect(await first.localServers.piCatalog.discover(false, emptyProbe)).toEqual([]);
    expect(probes).toBe(1);
    await second.localServers.piCatalog.discover(false, emptyProbe);
    expect(probes).toBe(2);
    expect(first.localServers.piCatalog.nextProbeKey()).toBe("pi:catalog-seed:1");
    expect(second.localServers.piCatalog.nextProbeKey()).toBe("pi:catalog-seed:1");

    let fetches = 0;
    const fetchStates = async () => {
      fetches += 1;
      return new Map();
    };
    const snapshot = first.containerStates.read("legacy", fetchStates);
    expect(first.containerStates.read("legacy", fetchStates)).toBe(snapshot);
    expect(fetches).toBe(1);
    expect(second.containerStates.read("legacy", fetchStates)).not.toBe(snapshot);
    expect(fetches).toBe(2);
    second.containerStates.invalidate();
    expect(first.containerStates.read("legacy", fetchStates)).toBe(snapshot);
    expect(fetches).toBe(2);
  });

  test("terminal history and terminal account homes are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-runtime-history-"));
    try {
      const historyId = first.terminals.history.configure({
        sessionId: "env-1:terminal",
        dataDir,
        stableIdentity: "env-1:tab-1",
        cols: 80,
        rows: 24,
      });
      expect(historyId).not.toBeNull();
      expect(first.terminals.history.stats().configurations).toBe(1);
      expect(second.terminals.history.stats().configurations).toBe(0);
      expect(await second.terminals.history.page("env-1:terminal")).toBeNull();

      first.terminals.recordAccountHome("env-1:terminal:/accounts/a", "/accounts/a");
      expect(first.terminals.isAccountHomeInUse("/accounts/a")).toBe(true);
      expect(second.terminals.isAccountHomeInUse("/accounts/a")).toBe(false);
      // Closing the session in the other backend does not release this one's home.
      second.terminals.cleanupSession("env-1:terminal", { explicit: true });
      expect(first.terminals.isAccountHomeInUse("/accounts/a")).toBe(true);
      first.terminals.cleanupSession("env-1:terminal", { explicit: true });
      expect(first.terminals.isAccountHomeInUse("/accounts/a")).toBe(false);
      await first.terminals.history.flush(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("PR monitoring and merge cleanup are per backend", async () => {
    const scheduled: string[] = [];
    const runtimeWithScheduler = (name: string) =>
      createRuntime({
        emit: () => undefined,
        prMonitor: {
          scheduleMergeCleanup: (environmentId) => scheduled.push(`${name}:${environmentId}`),
        },
      });
    const first = runtimeWithScheduler("first");
    const second = runtimeWithScheduler("second");
    const contextWithNoEnvironments = (runtime: BackendRuntime): CommandContext => ({
      ...contextFor(runtime),
      storage: { loadEnvironments: async () => [] } as unknown as StorageService,
    });
    await first.prMonitor.sync(contextWithNoEnvironments(first));
    await second.prMonitor.sync(contextWithNoEnvironments(second));

    expect(first.prMonitor.service).not.toBe(second.prMonitor.service);
    first.prMonitor.resumeTerminalEffects("env-1", {
      url: "https://github.com/o/r/pull/1",
      state: "merged",
    });
    expect(scheduled).toEqual(["first:env-1"]);

    // Shutting one monitor down leaves the other's service in place.
    const secondService = second.prMonitor.service;
    first.prMonitor.shutdown();
    expect(second.prMonitor.service).toBe(secondService);
  });
});
