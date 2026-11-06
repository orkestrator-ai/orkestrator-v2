import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { BackendRuntime } from "./backend-runtime.js";
import { scheduleMergeCleanupRecovery } from "./commands-servers.js";
import type { CommandContext } from "./commands.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { closeEnvironmentCleanupStorage } from "./environment-cleanup-ledger.js";
import type { Environment } from "./models.js";
import { StorageService } from "./storage.js";

const directories: string[] = [];

afterEach(async () => {
  resetLogger();
  closeEnvironmentCleanupStorage();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture(overrides: Partial<Environment> = {}) {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "orkestrator-merge-cleanup-recovery-")),
  );
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: "merged",
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    cleanupAfterMergeRequestedAt: "2026-11-05T12:00:00.000Z",
    ...overrides,
  });
  const logged: string[] = [];
  configureLogger({
    sink: (output: LogOutput) => {
      logged.push(output.line);
    },
  });
  const contextOn = (runtime: BackendRuntime) =>
    ({
      storage,
      appRoot: "",
      resourceRoot: "",
      toolchainBinDir: "",
      worktreeDir: path.join(dataDir, "workspaces"),
      environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
      runtime,
      emit: () => undefined,
    }) as CommandContext;
  return { storage, contextOn, logged };
}

async function deleted(storage: StorageService): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await storage.getEnvironment("e1"))) return;
    await Bun.sleep(5);
  }
  throw new Error("recovery did not delete the environment");
}

test("recovery stands aside while Merge and Cleanup holds the environment", async () => {
  const { storage, contextOn, logged } = await fixture();
  const runtime = new BackendRuntime({ emit: () => undefined });
  const context = contextOn(runtime);
  expect(runtime.environments.beginMerge("e1")).toBe(true);
  for (let poll = 0; poll < 3; poll += 1) {
    scheduleMergeCleanupRecovery("e1", context);
    await Bun.sleep(5);
  }
  expect(logged.filter((line) => line.includes("merge-cleanup.resume-failed"))).toEqual([]);
  expect(await storage.getEnvironment("e1")).toMatchObject({
    cleanupAfterMergeRequestedAt: "2026-11-05T12:00:00.000Z",
  });
  expect((await storage.getEnvironment("e1"))?.deletionRequestedAt).toBeUndefined();
});

test("recovery stands aside while that environment's delete is running", async () => {
  const { storage, contextOn, logged } = await fixture();
  const runtime = new BackendRuntime({ emit: () => undefined });
  const context = contextOn(runtime);
  expect(runtime.environments.beginDelete("e1")).toBe(true);
  scheduleMergeCleanupRecovery("e1", context);
  await Bun.sleep(5);
  expect(logged.filter((line) => line.includes("merge-cleanup.resume-failed"))).toEqual([]);
  expect((await storage.getEnvironment("e1"))?.deletionRequestedAt).toBeUndefined();
  runtime.environments.endDelete("e1");
});

test("a guard taken while recovery reads storage still stops it", async () => {
  const { storage, contextOn, logged } = await fixture();
  const runtime = new BackendRuntime({ emit: () => undefined });
  const context = contextOn(runtime);
  const read = storage.getEnvironment.bind(storage);
  storage.getEnvironment = (async (id: string) => {
    const environment = await read(id);
    runtime.environments.beginMerge("e1");
    return environment;
  }) as typeof storage.getEnvironment;
  scheduleMergeCleanupRecovery("e1", context);
  await Bun.sleep(20);
  storage.getEnvironment = read;
  expect(logged.filter((line) => line.includes("merge-cleanup.resume-failed"))).toEqual([]);
  expect((await storage.getEnvironment("e1"))?.deletionRequestedAt).toBeUndefined();
});

test("after a real restart the guards are gone and recovery finishes the delete", async () => {
  const { storage, contextOn } = await fixture();
  const beforeRestart = new BackendRuntime({ emit: () => undefined });
  expect(beforeRestart.environments.beginMerge("e1")).toBe(true);
  scheduleMergeCleanupRecovery("e1", contextOn(beforeRestart));
  await Bun.sleep(5);
  expect(await storage.getEnvironment("e1")).not.toBeNull();

  // Only the persisted intent crosses a restart; the running-work guards do not.
  const afterRestart = new BackendRuntime({ emit: () => undefined });
  scheduleMergeCleanupRecovery("e1", contextOn(afterRestart));
  await deleted(storage);
});

test("a recorded failure still waits for a manual retry", async () => {
  const { storage, contextOn } = await fixture({ cleanupAfterMergeError: "failed earlier" });
  const runtime = new BackendRuntime({ emit: () => undefined });
  scheduleMergeCleanupRecovery("e1", contextOn(runtime));
  await Bun.sleep(20);
  expect((await storage.getEnvironment("e1"))?.deletionRequestedAt).toBeUndefined();
});
