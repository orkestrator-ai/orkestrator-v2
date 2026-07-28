import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { StorageService } from "./storage.js";

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
