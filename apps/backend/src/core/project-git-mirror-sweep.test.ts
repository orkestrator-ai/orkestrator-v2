import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sweepPreLedgerDiskState,
  ORPHANED_STATE_MIN_AGE_MS,
} from "./environment-cleanup-reconciler.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { BackendRuntime } from "./backend-runtime.js";
import { StorageService } from "./storage.js";
import { seedStore } from "./storage-test-support.js";
import type { CommandContext } from "./commands-context.js";
const stores: StorageService[] = [];
afterEach(async () => {
  for (const storage of stores.splice(0)) {
    storage.close();
    await fs.rm(storage.getDataDir(), { recursive: true, force: true });
  }
});
async function reconcileContext() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mirror-sweep-"));
  const storage = new StorageService(dataDir);
  stores.push(storage);
  await storage.init();
  const context = {
    storage,
    worktreeDir: path.join(dataDir, "worktrees"),
    strictDockerOwner: false,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as CommandContext;
  // Other pre-ledger sweeps need complete owner sets too.
  seedStore(dataDir, "projects.json", []);
  seedStore(dataDir, "environments.json", []);
  return { context, storage, dataDir };
}

describe("pre-ledger mirror sweep wiring", () => {
  test("removes old orphan mirrors and logs the count", async () => {
    const { context, dataDir } = await reconcileContext();
    const { captureLogs } = await import("@orkestrator/protocol/testing/log-capture");
    const logs = captureLogs();
    try {
      seedStore(dataDir, "projects.json", []);
      const orphan = path.join(dataDir, "git-mirrors", "gone");
      await fs.mkdir(path.join(orphan, "mount"), { recursive: true });
      await sweepPreLedgerDiskState(context, {
        now: () => new Date(Date.now() + ORPHANED_STATE_MIN_AGE_MS + 60_000),
      });
      expect(
        await fs.stat(orphan).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(logs.records().some((record) => record.event === "git-mirror.orphans-removed")).toBe(
        true,
      );
    } finally {
      logs.restore();
    }
  });

  test("cancellation skips mirror ownership reads and deletion", async () => {
    const { context, storage } = await reconcileContext();
    const read = spyOn(storage, "loadProjectIdsForCleanup");
    try {
      await sweepPreLedgerDiskState(context, { isCancelled: () => true });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  test("a failed project-store read keeps orphan mirrors and logs a warning", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const { captureLogs } = await import("@orkestrator/protocol/testing/log-capture");
    const logs = captureLogs();
    const read = spyOn(storage, "loadProjectIdsForCleanup").mockRejectedValue(
      new Error("owner read failed"),
    );
    const orphan = path.join(dataDir, "git-mirrors", "gone");
    await fs.mkdir(orphan, { recursive: true });
    try {
      await sweepPreLedgerDiskState(context, {
        now: () => new Date(Date.now() + ORPHANED_STATE_MIN_AGE_MS + 60_000),
      });
      expect(
        await fs.stat(orphan).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(read).toHaveBeenCalled();
      expect(logs.records().some((record) => record.level === "warn")).toBe(true);
    } finally {
      read.mockRestore();
      logs.restore();
    }
  });
});
