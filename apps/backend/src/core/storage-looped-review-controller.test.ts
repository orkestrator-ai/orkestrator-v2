import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

describe("StorageService looped-review controller lease", () => {
  test("elects one client across backend processes and supports explicit handoff", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-lease-"));
    const first = new StorageService(dataDir);
    const second = new StorageService(dataDir);
    await Promise.all([first.init(), second.init()]);
    await first.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "Environment",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
      worktreePath: dataDir,
    });
    await first.saveLoopedReviewWorkflow(
      "workflow-1",
      "env-1",
      1,
      { id: "workflow-1", phase: "reviewing" },
    );

    try {
      const [left, right] = await Promise.all([
        first.claimLoopedReviewController("workflow-1", "desktop", 15_000),
        second.claimLoopedReviewController("workflow-1", "web", 15_000),
      ]);
      expect([left.granted, right.granted].filter(Boolean)).toHaveLength(1);
      const winner = left.granted ? "desktop" : "web";
      const loser = winner === "desktop" ? "web" : "desktop";
      const winnerStorage = winner === "desktop" ? first : second;
      const loserStorage = loser === "desktop" ? first : second;

      await winnerStorage.releaseLoopedReviewController("workflow-1", winner);
      expect(
        await loserStorage.claimLoopedReviewController(
          "workflow-1",
          loser,
          15_000,
        ),
      ).toMatchObject({ granted: true });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
