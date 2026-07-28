import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";

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
