import { describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testing as commandTesting } from "./commands.js";
import { OrkestratorBackend } from "./index.js";
import type { AgentToolConnection } from "./agent-tools.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { StorageService } from "./storage.js";

function fakeAgentTools(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}) {
  return {
    start: mock(overrides.start ?? (async () => undefined)),
    stop: mock(overrides.stop ?? (async () => undefined)),
    connection: mock((
      _environmentId: string,
      _projectId: string,
      _target: "host" | "container",
    ): AgentToolConnection => ({
      url: "http://127.0.0.1:43210/mcp",
      token: "test-token",
    })),
    revokeEnvironment: mock(() => undefined),
  };
}

describe("agent-tools lifecycle", () => {
  test("starts before reapers and stops during shutdown", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    const calls: string[] = [];
    const tools = fakeAgentTools({
      start: async () => {
        calls.push("tools:start");
      },
      stop: async () => {
        calls.push("tools:stop");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => {
          calls.push("pid");
          return [];
        },
        claudeTmuxRuntimes: async () => {
          calls.push("tmux");
          return [];
        },
      },
    });
    try {
      await backend.init();
      expect(calls).toEqual(["tools:start", "pid", "tmux"]);
      await backend.shutdown();
      expect(calls).toEqual(["tools:start", "pid", "tmux", "tools:stop"]);
      expect(tools.start).toHaveBeenCalledTimes(1);
      expect(tools.stop).toHaveBeenCalledTimes(1);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("surfaces bind failures and still permits lifecycle cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    const tools = fakeAgentTools({
      start: async () => {
        throw new Error("bind failed");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    try {
      await expect(backend.init()).rejects.toThrow("bind failed");
      expect(tools.start).toHaveBeenCalledTimes(1);
      await backend.shutdown();
      expect(tools.stop).toHaveBeenCalledTimes(1);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("propagates stop failures and retries cleanup on a later shutdown", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    let attempts = 0;
    const tools = fakeAgentTools({
      stop: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stop failed");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    try {
      await backend.init();
      await expect(backend.shutdown()).rejects.toThrow("stop failed");
      await expect(backend.shutdown()).resolves.toBeUndefined();
      expect(tools.stop).toHaveBeenCalledTimes(2);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFakeChild(pid: number): ChildProcessWithoutNullStreams {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  } as unknown as ChildProcessWithoutNullStreams;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function resolvesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<"resolved" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("startup runs the tmux reaper after the PID reaper even when PID reaping fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-init-"));
  const calls: string[] = [];
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => {
        calls.push("pid");
        throw new Error("PID scan failed");
      },
      claudeTmuxRuntimes: async () => {
        calls.push("tmux");
        return [];
      },
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await backend.init();
    expect(calls).toEqual(["pid", "tmux"]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup remains available when the tmux runtime reaper fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-init-"));
  const calls: string[] = [];
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => {
        calls.push("pid");
        return [];
      },
      claudeTmuxRuntimes: async () => {
        calls.push("tmux");
        throw new Error("tmux scan failed");
      },
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await expect(backend.init()).resolves.toBeUndefined();
    expect(calls).toEqual(["pid", "tmux"]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("native-agent restore failure leaves commands available and shutdown still drains pipelines", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-native-lifecycle-"));
  const calls: string[] = [];
  const tools = fakeAgentTools({
    start: async () => {
      calls.push("tools:start");
    },
    stop: async () => {
      calls.push("tools:stop");
    },
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: tools,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  const internals = backend as unknown as {
    buildPipelines: {
      init: () => Promise<void>;
      shutdown: () => Promise<void>;
    };
    nativeAgents: {
      init: () => Promise<void>;
      shutdown: () => Promise<void>;
      ensureSession: (input: Record<string, unknown>) => Promise<unknown>;
    };
  };
  internals.buildPipelines.init = mock(async () => {
    calls.push("pipelines:init");
  });
  internals.nativeAgents.init = mock(async () => {
    calls.push("native:init");
    throw new Error("restore failed");
  });
  internals.nativeAgents.ensureSession = mock(async (input) => ({
    providerSessionId: "provider-1",
    ...input,
  }));
  internals.nativeAgents.shutdown = mock(async () => {
    calls.push("native:shutdown");
    throw new Error("native drain failed");
  });
  internals.buildPipelines.shutdown = mock(async () => {
    calls.push("pipelines:shutdown");
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await expect(backend.init()).resolves.toBeUndefined();
    expect(calls).toEqual([
      "tools:start",
      "pipelines:init",
      "native:init",
    ]);
    await expect(backend.invoke("ensure_native_agent_session", {
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
    })).resolves.toMatchObject({ providerSessionId: "provider-1" });
    expect(internals.nativeAgents.ensureSession).toHaveBeenCalledWith({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
      title: undefined,
      model: undefined,
      reasoningEffort: undefined,
      phase: undefined,
    });

    await expect(backend.shutdown()).resolves.toBeUndefined();
    expect(calls.slice(-3)).toEqual([
      "native:shutdown",
      "pipelines:shutdown",
      "tools:stop",
    ]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown clears backend-owned PR watch state before a new backend starts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-pr-shutdown-"));
  const options = {
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  };
  const first = new OrkestratorBackend(options);
  let second: OrkestratorBackend | undefined;
  try {
    await first.init();
    const project = await first.invoke<{ id: string }>("add_project", {
      gitUrl: "https://github.com/acme/repo.git",
    });
    const environment = await first.invoke<{ id: string }>("create_environment", {
      projectId: project.id,
      name: "PR watch",
      environmentType: "local",
    });
    await first.invoke("pr_monitor_watch", {
      environmentId: environment.id,
      mode: "create-pending",
    });
    await expect(first.invoke<{ entries: unknown[] }>("get_pr_monitor_state"))
      .resolves.toMatchObject({ entries: [expect.objectContaining({ mode: "create-pending" })] });

    await first.shutdown();
    second = new OrkestratorBackend(options);
    await second.init();
    await expect(second.invoke<{ entries: unknown[] }>("get_pr_monitor_state"))
      .resolves.toEqual({ entries: [] });
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown closes lifecycle admission before draining accepted work", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-shutdown-"));
  const lifecycleTasks = new EnvironmentLifecycleTaskTracker();
  let finishOperation!: () => void;
  const operationBlocked = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: lifecycleTasks,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  try {
    await backend.init();
    const operation = lifecycleTasks.admit(() => operationBlocked);
    const shutdown = backend.shutdown();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(lifecycleTasks.isAccepting()).toBe(false);
    await expect(backend.invoke("greet", { name: "late" })).rejects.toThrow(
      "Backend is shutting down",
    );

    finishOperation();
    await operation;
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownFinished).toBe(true);
  } finally {
    finishOperation();
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup reconciles a persisted creating environment before accepting commands", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-recovery-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "interrupted",
    projectId: "project",
    name: "Interrupted",
    branch: "interrupted",
    containerId: null,
    status: "creating",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  try {
    await backend.init();
    await expect(backend.invoke<{ status: string; lifecycleError?: string }[]>(
      "get_environments",
      { projectId: "project" },
    )).resolves.toEqual([
      expect.objectContaining({
        id: "interrupted",
        status: "error",
        lifecycleError: expect.stringContaining("interrupted"),
      }),
    ]);
  } finally {
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup re-admits interrupted deletion while its tombstone continues blocking writes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-delete-recovery-"));
  const storage = new StorageService(dataDir);
  const releaseTermination = deferred<void>();
  const terminationStarted = deferred<void>();
  const environmentId = "interrupted-delete";
  const originalWarn = console.warn;
  commandTesting.resetLocalServerLifecycle();
  await storage.init();
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project",
    name: "Interrupted delete",
    branch: "interrupted-delete",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: path.join(dataDir, "interrupted-delete-worktree"),
    deletionRequestedAt: new Date(1).toISOString(),
    lifecycleOperation: "deleting",
    lifecycleOperationStartedAt: new Date(1).toISOString(),
  });
  commandTesting.setLocalServerProcess(
    `codex:${environmentId}`,
    createFakeChild(96001),
  );
  commandTesting.setTerminateProcessTree(async () => {
    terminationStarted.resolve();
    await releaseTermination.promise;
    return true;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });

  try {
    // An empty fixture worktree has no tmux runtime to clean up. That
    // best-effort warning is unrelated to lifecycle recovery under test.
    console.warn = () => undefined;
    await backend.init();
    await terminationStarted.promise;

    await expect(storage.savePromptQueue(
      `codex env-${environmentId}:tab-1`,
      environmentId,
      [{ id: "late" }],
    )).rejects.toThrow("being deleted");
    await expect(storage.getEnvironment(environmentId)).resolves.toMatchObject({
      deletionRequestedAt: expect.any(String),
      lifecycleOperation: "deleting",
    });

    releaseTermination.resolve();
    await waitForCondition(
      async () => await storage.getEnvironment(environmentId) === null,
      "re-admitted deletion to remove the environment",
    );
    expect(commandTesting.getLocalServerProcess(`codex:${environmentId}`)).toBeUndefined();
  } finally {
    console.warn = originalWarn;
    releaseTermination.resolve();
    await backend.shutdown().catch(() => undefined);
    commandTesting.resetLocalServerLifecycle();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown applies one deadline across lifecycle and local-operation drains", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-shutdown-deadline-"));
  const storage = new StorageService(dataDir);
  const releaseFirstTermination = deferred<void>();
  const firstTerminationStarted = deferred<void>();
  const environmentId = "blocked-delete";
  let terminationAttempts = 0;
  const originalWarn = console.warn;
  commandTesting.resetLocalServerLifecycle();
  await storage.init();
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project",
    name: "Blocked delete",
    branch: "blocked-delete",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: path.join(dataDir, "blocked-delete-worktree"),
  });
  commandTesting.setLocalServerProcess(
    `codex:${environmentId}`,
    createFakeChild(96002),
  );
  commandTesting.setTerminateProcessTree(async () => {
    terminationAttempts += 1;
    if (terminationAttempts === 1) {
      firstTerminationStarted.resolve();
      await releaseFirstTermination.promise;
    }
    return true;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleDrainTimeoutMs: 20,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });

  let deletion: Promise<void> | undefined;
  try {
    // An empty fixture worktree has no tmux runtime to clean up. That
    // best-effort warning is unrelated to shutdown coordination under test.
    console.warn = () => undefined;
    await backend.init();
    deletion = backend.invoke("delete_environment", { environmentId });
    await firstTerminationStarted.promise;

    const shutdown = backend.shutdown();
    await expect(resolvesWithin(shutdown, 1_000)).resolves.toBe("resolved");
    expect(terminationAttempts).toBe(2);
    expect(commandTesting.getLocalServerProcess(`codex:${environmentId}`)).toBeUndefined();

    releaseFirstTermination.resolve();
    await expect(deletion).resolves.toBeUndefined();
  } finally {
    console.warn = originalWarn;
    releaseFirstTermination.resolve();
    await deletion?.catch(() => undefined);
    await backend.shutdown().catch(() => undefined);
    commandTesting.resetLocalServerLifecycle();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup fails closed when reconciliation cannot persist its result", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-failclosed-"));
  const seed = new StorageService(dataDir);
  await seed.init();
  await seed.addEnvironment({
    id: "interrupted",
    projectId: "project",
    name: "Interrupted",
    branch: "interrupted",
    containerId: null,
    status: "creating",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  const storage = (backend as unknown as {
    context: { storage: StorageService };
  }).context.storage;
  const realUpdate = storage.updateEnvironment.bind(storage);
  storage.updateEnvironment = (async () => {
    throw new Error("environments.json is read-only");
  }) as StorageService["updateEnvironment"];

  try {
    // Serving commands on top of a `creating` record this backend can never
    // finish would report progress that will never arrive, so init must reject
    // rather than continue past a failed reconciliation.
    await expect(backend.init()).rejects.toThrow("environments.json is read-only");
    storage.updateEnvironment = realUpdate;
    await expect(storage.getEnvironment("interrupted")).resolves.toMatchObject({
      status: "creating",
    });
  } finally {
    storage.updateEnvironment = realUpdate;
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
