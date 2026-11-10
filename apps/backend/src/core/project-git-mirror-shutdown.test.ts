import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { refreshProjectGitMirror } from "./project-git-mirror.js";
import { runCommand } from "./shell.js";
import { openRegistryWriter } from "./registry-writer-lease.js";
import { StorageService } from "./storage.js";

test("backend shutdown settles a blocked mirror writer before another backend takes ownership", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mirror-shutdown-"));
  const tasks = new EnvironmentLifecycleTaskTracker();
  const options = {
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: tasks,
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  };
  const first = new OrkestratorBackend(options);
  let second: OrkestratorBackend | undefined;
  let release!: () => void;
  let started!: () => void;
  let aborted!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancelling = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  try {
    await first.init();
    const storage = new StorageService(dataDir);
    const project = { id: "mirror-shutdown", gitUrl: "file:///unused" };
    const access = { kind: "anonymous", localRemote: true } as const;
    const pending = refreshProjectGitMirror(
      { storage, environmentLifecycleTasks: tasks },
      project,
      access,
      {
        force: true,
        freeBytes: async () => 10 * 1024 ** 3,
        run: async (command, args, settings) => {
          if (!args?.includes("fetch")) return runCommand(command, args, settings);
          started();
          settings!.signal!.addEventListener("abort", aborted, { once: true });
          await gate;
          settled = true;
          throw new Error("cancelled");
        },
      },
    );
    await fetching;
    const stopping = first.shutdown();
    await cancelling;
    expect(tasks.isAccepting()).toBe(false);
    expect(settled).toBe(false);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const blocked = await openRegistryWriter(dataDir);
    expect(blocked.isHeld()).toBe(false);
    await blocked.release();
    release();
    expect(await pending).toBe("cancelled");
    await stopping;
    expect(settled).toBe(true);
    expect(
      await refreshProjectGitMirror({ storage, environmentLifecycleTasks: tasks }, project, access),
    ).toBe("skipped-shutdown");
    second = new OrkestratorBackend({
      ...options,
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    });
    await second.init();
  } finally {
    release?.();
    await first.shutdown();
    await second?.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
