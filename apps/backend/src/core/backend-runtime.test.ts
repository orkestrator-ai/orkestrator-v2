import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import type { DockerCleanupGrant } from "./docker-cleanup-grants.js";
import type { CursorSdkLoginHandle } from "./cursor-sdk-bridge.js";
import type { KanbanTask } from "./storage-shared.js";
import { TmuxBackend } from "./tmux-backend.js";
import { TmuxSession } from "./tmux-session-manager.js";
import type { ContainerUsageSnapshot } from "@orkestrator/protocol/container-resources";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

/**
 * Two backends in one process own separate state: whatever one registers is
 * invisible to the other (docs/todo/backend-structure/0011, 0066 and 0133).
 */

/** A promise and its resolver, for work held in flight. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  test("claude-tmux sessions, interactive panes and the orphan sweep are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const commands = createCommandRegistry();
    const session = new TmuxSession("env-1", "tab-1", TmuxBackend.local("/tmp"), "/tmp");
    spyOn(session, "tmuxAlive").mockResolvedValue(true);
    first.tmux.sessions.insert("env-1", "tab-1", session);

    const status = (context: CommandContext) =>
      commands.get("claude_tmux_status")!({ environmentId: "env-1", tabId: "tab-1" }, context);
    expect(await status(contextFor(first))).toMatchObject({ tab_id: "tab-1", running: true });
    expect(await status(contextFor(second))).toBeNull();
    await expect(
      commands.get("claude_tmux_interrupt")!(
        { environmentId: "env-1", tabId: "tab-1" },
        contextFor(second),
      ),
    ).rejects.toThrow("tmux session not running");

    const terminalId = first.tmux.interactiveTerminals.create(session, 80, 24);
    await expect(second.tmux.interactiveTerminals.resize(terminalId, 100, 30)).rejects.toThrow(
      "not found",
    );

    // Each backend sweeps orphans once a minute on its own clock.
    expect(first.tmux.beginOrphanSweep(1_000_000)).toBe(true);
    expect(first.tmux.beginOrphanSweep(1_000_001)).toBe(false);
    expect(second.tmux.beginOrphanSweep(1_000_001)).toBe(true);
    expect(first.tmux.orphanFirstSeen("env-1\0orphan", 5)).toBe(5);
    expect(first.tmux.orphanFirstSeen("env-1\0orphan", 9)).toBe(5);
    expect(second.tmux.orphanFirstSeen("env-1\0orphan", 9)).toBe(9);
    first.tmux.sessions.removeEnvironment("env-1");
  });

  test("tmux activity writes read only their own backend's sessions", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const working = new TmuxSession("env-1", "tab-1", TmuxBackend.local("/tmp"), "/tmp");
    spyOn(working, "activityState").mockReturnValue("working");
    first.tmux.sessions.insert("env-1", "tab-1", working);
    const written: string[] = [];
    const contextWithActivity = (runtime: BackendRuntime, name: string): CommandContext => ({
      ...contextFor(runtime),
      storage: {
        getEnvironment: async () => ({ id: "env-1" }),
        setEnvironmentAgentActivity: async (_id: string, state: string) => {
          written.push(`${name}:${state}`);
        },
      } as unknown as StorageService,
    });
    await first.tmux.persistEnvironmentActivity(contextWithActivity(first, "first"), "env-1");
    await second.tmux.persistEnvironmentActivity(contextWithActivity(second, "second"), "env-1");
    expect(written).toEqual(["first:working", "second:idle"]);
    first.tmux.sessions.removeEnvironment("env-1");
  });

  test("Claude state polls are per backend and stop with it", async () => {
    const pollOptions = {
      readState: async () => "idle",
      schedule: () => 1,
      cancel: () => undefined,
    };
    const first = createRuntime({ emit: () => undefined, tmux: { claudeStatePolls: pollOptions } });
    const second = createRuntime({
      emit: () => undefined,
      tmux: { claudeStatePolls: pollOptions },
    });
    const commands = createCommandRegistry();
    const context: CommandContext = {
      ...contextFor(first),
      storage: {
        loadEnvironments: async () => [
          { id: "env-1", status: "running", containerId: "container-1" },
        ],
      } as unknown as StorageService,
    };
    await commands.get("reconcile_claude_state_polling")!({}, context);
    expect(first.tmux.claudeStatePolls.status().containers).toBe(1);
    expect(second.tmux.claudeStatePolls.status().containers).toBe(0);
    second.tmux.shutdown();
    expect(first.tmux.claudeStatePolls.status().containers).toBe(1);
    first.tmux.shutdown();
    expect(first.tmux.claudeStatePolls.status().containers).toBe(0);
  });

  test("Docker cleanup grants and the container usage sample are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();
    const grant: DockerCleanupGrant = {
      owner: "owner",
      expiresAt: first.dockerCleanupGrants.expiryFrom(0),
      containers: new Map(),
      volumes: new Set(["volume-1"]),
      networks: new Set(),
    };
    first.dockerCleanupGrants.record("token", grant, 0);
    expect(second.dockerCleanupGrants.take("token", "owner", 1)).toBeUndefined();
    expect(first.dockerCleanupGrants.take("token", "other-owner", 1)).toBeUndefined();
    expect(first.dockerCleanupGrants.take("token", "owner", 1)).toBe(grant);
    // The token is consumed.
    expect(first.dockerCleanupGrants.take("token", "owner", 1)).toBeUndefined();

    let samples = 0;
    const sampleNow = async (): Promise<ContainerUsageSnapshot> => {
      samples += 1;
      return {
        scope: "installation",
        sampledAt: new Date().toISOString(),
        stale: false,
        containers: [],
        error: null,
      };
    };
    await first.containerUsage.sample(sampleNow);
    await first.containerUsage.sample(sampleNow);
    expect(samples).toBe(1);
    await second.containerUsage.sample(sampleNow);
    expect(samples).toBe(2);
    // Neither backend follows Docker events until it starts its own follower.
    expect(first.containerOom.count("container-1")).toBeNull();
    expect(second.containerOom).not.toBe(first.containerOom);
  });

  test("GitHub and Linear locks, feature builds and public API reconciliations are per backend", async () => {
    const first = createRuntime();
    const second = createRuntime();

    const comment = held<string>();
    const firstComment = first.integrationLocks.withGitHubCompletionComment(
      "pipeline-1",
      () => comment.promise,
    );
    // The other backend's comment for the same pipeline does not queue behind it.
    expect(
      await second.integrationLocks.withGitHubCompletionComment("pipeline-1", async () => "second"),
    ).toBe("second");
    expect(
      await second.integrationLocks.withLinearCompletionComment("pipeline-1", async () => "linear"),
    ).toBe("linear");
    comment.resolve("first");
    expect(await firstComment).toBe("first");

    let setups = 0;
    const labels = held<void>();
    const setup = () => {
      setups += 1;
      return labels.promise;
    };
    const firstSetup = first.integrationLocks.joinWorkflowLabelSetup("o/r", setup);
    const joined = first.integrationLocks.joinWorkflowLabelSetup("o/r", setup);
    const secondSetup = second.integrationLocks.joinWorkflowLabelSetup("o/r", setup);
    expect(setups).toBe(2);
    labels.resolve();
    await Promise.all([firstSetup, joined, secondSetup]);

    const resolution = held<KanbanTask>();
    const firstTask = first.featureBuilds.resolveTask("project:request", () => resolution.promise);
    expect(first.featureBuilds.resolveTask("project:request", async () => ({}) as KanbanTask)).toBe(
      firstTask,
    );
    const other = { id: "task-2" } as KanbanTask;
    expect(await second.featureBuilds.resolveTask("project:request", async () => other)).toBe(
      other,
    );
    resolution.resolve({ id: "task-1" } as KanbanTask);
    await firstTask;
    let refined = 0;
    first.featureBuilds.refineTitle("task-1", async () => void refined++);
    second.featureBuilds.refineTitle("task-1", async () => void refined++);
    await Promise.all([
      first.featureBuilds.titleRefinementsSettled(),
      second.featureBuilds.titleRefinementsSettled(),
    ]);
    expect(refined).toBe(2);

    const evaluation = held<null>();
    const observed = first.publicApi.observeRun("operation-1", () => evaluation.promise);
    expect(first.publicApi.observeRun("operation-1", async () => null)).toBe(observed);
    expect(second.publicApi.observeRun("operation-1", async () => null)).not.toBe(observed);
    expect(second.publicApi.reconcileExec("operation-1", async () => null)).not.toBe(observed);
    evaluation.resolve(null);
    await observed;
  });

  test("the Cursor SDK login and agent-account state are per backend", async () => {
    let refreshes = 0;
    const first = createRuntime({
      emit: () => undefined,
      accounts: { localClaudeLoginRefresher: async () => void refreshes++ },
    });
    const second = createRuntime();

    const begin = held<CursorSdkLoginHandle>();
    const starting = first.localServers.cursorSdkLogin.start(() => begin.promise);
    expect(first.localServers.cursorSdkLogin.progress()).toEqual({ state: "pending" });
    expect(second.localServers.cursorSdkLogin.progress()).toEqual({ state: "idle" });
    const cancel = mock(() => undefined);
    begin.resolve({
      loginUrl: "https://cursor.example/login",
      completion: held<void>().promise,
      cancel,
    });
    expect(await starting).toEqual({ loginUrl: "https://cursor.example/login" });
    second.localServers.cursorSdkLogin.cancel();
    expect(cancel).not.toHaveBeenCalled();
    first.localServers.cursorSdkLogin.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);

    expect(await first.accounts.refreshLocalClaudeLogin()).toBe(true);
    expect(await second.accounts.refreshLocalClaudeLogin()).toBe(false);
    expect(refreshes).toBe(1);
    expect(first.accounts.claimCoordinatorKeychainClear("/coordinator")).toBe(true);
    expect(first.accounts.claimCoordinatorKeychainClear("/coordinator")).toBe(false);
    expect(second.accounts.claimCoordinatorKeychainClear("/coordinator")).toBe(true);

    // The loaded store is per backend: the second reads the file afresh.
    const accountsRoot = await mkdtemp(path.join(tmpdir(), "ork-runtime-usage-"));
    try {
      const reading: PlanUsageSnapshot = {
        platform: "claude",
        status: "ok",
        plan: "max",
        windows: [],
        fetchedAt: "2026-10-01T00:00:00.000Z",
      };
      const failure: PlanUsageSnapshot = {
        platform: "claude",
        status: "error",
        windows: [],
        message: "HTTP 429",
        fetchedAt: "2026-10-02T00:00:00.000Z",
      };
      await first.accounts.lastUsage.remember(accountsRoot, "claude", "account", reading);
      await rm(path.join(accountsRoot, "last-usage.json"));
      const now = Date.parse(failure.fetchedAt);
      expect(
        await first.accounts.lastUsage.withLastKnown(
          accountsRoot,
          "claude",
          "account",
          failure,
          now,
        ),
      ).toMatchObject({ plan: "max", stale: true });
      expect(
        await second.accounts.lastUsage.withLastKnown(
          accountsRoot,
          "claude",
          "account",
          failure,
          now,
        ),
      ).toBe(failure);
    } finally {
      await rm(accountsRoot, { recursive: true, force: true });
    }
  });
});
