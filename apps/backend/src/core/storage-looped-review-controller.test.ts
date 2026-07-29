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
      const winningClaim = left.granted ? left : right;

      expect(winningClaim.token).not.toBe("");
      expect(await winnerStorage.validateLoopedReviewController(
        "workflow-1",
        winner,
        winningClaim.token,
      )).toBe(true);
      expect(await winnerStorage.validateLoopedReviewController(
        "workflow-1",
        winner,
        "wrong-token",
      )).toBe(false);

      const renewed = await winnerStorage.claimLoopedReviewController(
        "workflow-1",
        winner,
        15_000,
      );
      expect(renewed.token).toBe(winningClaim.token);
      await winnerStorage.releaseLoopedReviewController(
        "workflow-1",
        winner,
        "wrong-token",
      );
      expect(await winnerStorage.validateLoopedReviewController(
        "workflow-1",
        winner,
        winningClaim.token,
      )).toBe(true);

      await winnerStorage.releaseLoopedReviewController(
        "workflow-1",
        winner,
        winningClaim.token,
      );
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

  test("expires generations and rejects stale validation and release", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-fence-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.addEnvironment({
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
    await storage.saveLoopedReviewWorkflow(
      "workflow-1",
      "env-1",
      1,
      { id: "workflow-1" },
    );
    try {
      const first = await storage.claimLoopedReviewController(
        "workflow-1",
        "desktop",
        2_000,
      );
      expect(await storage.validateLoopedReviewController(
        "workflow-1",
        "desktop",
        first.token,
      )).toBe(true);
      const file = path.join(dataDir, "looped-reviews.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      stored["workflow-1"].controllerLease.expiresAt =
        new Date(Date.now() - 1).toISOString();
      await fs.writeFile(file, JSON.stringify(stored));

      expect(await storage.validateLoopedReviewController(
        "workflow-1",
        "desktop",
        first.token,
      )).toBe(false);
      const next = await storage.claimLoopedReviewController(
        "workflow-1",
        "web",
        2_000,
      );
      expect(next.granted).toBe(true);
      expect(next.token).not.toBe(first.token);
      // The first controller validated while it still owned the lease, then
      // stalled. A takeover must fence its later commit inside the workflow
      // save lock rather than trusting that earlier validation.
      await expect(storage.saveLoopedReviewWorkflow(
        "workflow-1",
        "env-1",
        1,
        { id: "workflow-1", phase: "stale-desktop-result" },
        1,
        { ownerId: "desktop", token: first.token },
      )).rejects.toThrow("Looped review controller lease conflict");
      expect(
        (await storage.getLoopedReviewWorkflow("workflow-1"))?.snapshot,
      ).toEqual({ id: "workflow-1" });

      await expect(storage.saveLoopedReviewWorkflow(
        "workflow-1",
        "env-1",
        1,
        { id: "workflow-1", phase: "web-result" },
        1,
        { ownerId: "web", token: next.token },
      )).resolves.toMatchObject({
        revision: 2,
        snapshot: { id: "workflow-1", phase: "web-result" },
      });
      await storage.releaseLoopedReviewController(
        "workflow-1",
        "desktop",
        first.token,
      );
      expect(await storage.validateLoopedReviewController(
        "workflow-1",
        "web",
        next.token,
      )).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
