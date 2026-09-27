import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { StorageService } from "./storage.js";

function workflow(id: string): MultiReviewWorkflow {
  const timestamp = new Date(0).toISOString();
  return {
    version: 1,
    controller: "backend",
    id,
    environmentId: "env-1",
    projectId: "project-1",
    targetBranch: "main",
    reviewers: [{ id: `${id}-reviewer`, agent: "claude", model: "opus", status: "pending" }],
    fixModel: { agent: "codex", model: "gpt-5.6" },
    phase: "reviewing",
    createdAt: timestamp,
    updatedAt: timestamp,
    backendRevision: 0,
  };
}

/** The store's private data directory, for inspecting files on disk. */
function storeDir(storage: StorageService): string {
  return (storage as unknown as { dataDir: string }).dataDir;
}

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-storage-multi-review-"));
  try {
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "review",
      branch: "change",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/review",
      setupScriptsComplete: true,
    });
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("Multi Review storage atomically enforces one active workflow per environment", async () => {
  await withStorage(async (storage) => {
    const outcomes = await Promise.all([
      storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1")),
      storage.createMultiReviewWorkflowIfNoActive("multi-2", "env-1", 1, workflow("multi-2")),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await storage.listMultiReviewWorkflows("env-1")).toHaveLength(1);
  });
});

test("Multi Review storage fences revisions and controller ownership", async () => {
  await withStorage(async (storage) => {
    const created = await storage.createMultiReviewWorkflowIfNoActive(
      "multi-1",
      "env-1",
      1,
      workflow("multi-1"),
    );
    expect(created?.revision).toBe(1);
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 2_000);
    expect(claimed.granted).toBe(true);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    expect((await storage.claimMultiReviewController("multi-1", "owner-2", 2_000)).granted).toBe(
      false,
    );

    const current = workflow("multi-1");
    current.backendRevision = 1;
    await expect(
      storage.saveMultiReviewWorkflow("multi-1", "env-1", 1, current, 0, {
        ownerId: "owner-1",
        token: claimed.token,
      }),
    ).rejects.toThrow("revision conflict");
    await storage.releaseMultiReviewController("multi-1", "owner-1", claimed.token);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      false,
    );
    expect((await storage.claimMultiReviewController("multi-1", "owner-2", 2_000)).granted).toBe(
      true,
    );
  });
});

test("Multi Review lease writes do not rotate workflow backups", async () => {
  await withStorage(async (storage) => {
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const first = await storage.saveMultiReviewWorkflow(
      "multi-1",
      "env-1",
      1,
      { ...workflow("multi-1"), phase: "consolidating" },
      1,
    );
    await storage.saveMultiReviewWorkflow(
      "multi-1",
      "env-1",
      1,
      workflow("multi-1"),
      first.revision,
    );
    const file = path.join(storeDir(storage), "multi-reviews.json");
    const olderBackup = await fs.readFile(`${file}.bak.2`, "utf8");
    const backupsBefore = (await fs.readdir(storeDir(storage))).filter((name) =>
      name.startsWith("multi-reviews.json.bak."),
    );

    for (let renewal = 0; renewal < 6; renewal++) {
      const claimed = await storage.claimMultiReviewController(
        "multi-1",
        `owner-${renewal}`,
        2_000,
      );
      expect(claimed.granted).toBe(true);
      await storage.releaseMultiReviewController("multi-1", `owner-${renewal}`, claimed.token);
    }

    const backupsAfter = (await fs.readdir(storeDir(storage))).filter((name) =>
      name.startsWith("multi-reviews.json.bak."),
    );
    expect(backupsAfter.sort()).toEqual(backupsBefore.sort());
    // Older recovery points still hold content-commit snapshots, not lease churn.
    expect(await fs.readFile(`${file}.bak.2`, "utf8")).toBe(olderBackup);
    // The primary is intact and still parses after lease-only writes.
    expect((await storage.getMultiReviewWorkflow("multi-1"))?.revision).toBe(3);
  });
});

test("Multi Review fence checks follow every write to the store", async () => {
  await withStorage(async (storage) => {
    await storage.createMultiReviewWorkflowIfNoActive("multi-1", "env-1", 1, workflow("multi-1"));
    const claimed = await storage.claimMultiReviewController("multi-1", "owner-1", 2_000);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    // Repeated checks against an unchanged store stay correct.
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      true,
    );
    expect(await storage.validateMultiReviewController("multi-1", "owner-2", claimed.token)).toBe(
      false,
    );

    // A write from another process replaces the file; the next check sees it.
    const file = path.join(storeDir(storage), "multi-reviews.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    delete stored["multi-1"].controllerLease;
    await fs.writeFile(`${file}.external`, JSON.stringify(stored));
    await fs.rename(`${file}.external`, file);
    expect(await storage.validateMultiReviewController("multi-1", "owner-1", claimed.token)).toBe(
      false,
    );
    expect(await storage.validateMultiReviewController("missing", "owner-1", claimed.token)).toBe(
      false,
    );
  });
});
