import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import type { AgentToolConnection } from "./agent-tools.js";

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
