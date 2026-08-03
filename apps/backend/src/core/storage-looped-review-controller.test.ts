import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withWorkflowStorage(
  run: (storage: StorageService) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-lease-guard-"));
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
  await storage.saveLoopedReviewWorkflow("workflow-1", "env-1", 1, {
    id: "workflow-1",
  });
  try {
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

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

  test.each([
    ["below the floor", 1_999],
    ["above the ceiling", 60_001],
    ["not an integer", 15_000.5],
    ["not finite", Number.POSITIVE_INFINITY],
    ["negative", -15_000],
  ])("refuses a lease %s", async (_label, leaseMs) => {
    await withWorkflowStorage(async (storage) => {
      await expect(
        storage.claimLoopedReviewController("workflow-1", "desktop", leaseMs),
      ).rejects.toThrow("lease is invalid");
      // A refused claim must not have written a lease the caller could then
      // renew into a longer one than the bounds allow.
      expect(await storage.validateLoopedReviewController(
        "workflow-1",
        "desktop",
        "any-token",
      )).toBe(false);
    });
  });

  test.each([
    ["the floor", 2_000],
    ["the ceiling", 60_000],
  ])("grants a lease at %s", async (_label, leaseMs) => {
    await withWorkflowStorage(async (storage) => {
      const claim = await storage.claimLoopedReviewController(
        "workflow-1",
        "desktop",
        leaseMs,
      );
      expect(claim.granted).toBe(true);
      expect(Date.parse(claim.expiresAt) - Date.now())
        .toBeLessThanOrEqual(leaseMs);
    });
  });

  test("refuses a claim for a workflow that does not exist", async () => {
    await withWorkflowStorage(async (storage) => {
      await expect(
        storage.claimLoopedReviewController("workflow-missing", "desktop", 15_000),
      ).rejects.toThrow("Looped review workflow not found: workflow-missing");
    });
  });

  test("refuses a claim with a blank workflow or owner identity", async () => {
    await withWorkflowStorage(async (storage) => {
      await expect(storage.claimLoopedReviewController("", "desktop", 15_000))
        .rejects.toThrow("identity must not be blank");
      await expect(storage.claimLoopedReviewController("workflow-1", "  ", 15_000))
        .rejects.toThrow("identity must not be blank");
    });
  });

  test("lists valid workflows across environments in update order", async () => {
    await withWorkflowStorage(async (storage) => {
      const dataDir = storage.getDataDir();
      await storage.addEnvironment({
        id: "env-2",
        projectId: "project-1",
        name: "Second environment",
        branch: "second",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: 1,
        environmentType: "local",
        worktreePath: dataDir,
      });
      await storage.saveLoopedReviewWorkflow("workflow-2", "env-2", 2, {
        id: "workflow-2",
      });
      await storage.saveLoopedReviewWorkflow("workflow-3", "env-1", 2, {
        id: "workflow-3",
      });

      const file = path.join(dataDir, "looped-reviews.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      stored["workflow-1"].updatedAt = new Date(3_000).toISOString();
      stored["workflow-2"].updatedAt = new Date(1_000).toISOString();
      stored["workflow-3"].updatedAt = new Date(2_000).toISOString();
      stored["workflow-malformed"] = {
        ...stored["workflow-2"],
        id: "different-key",
      };
      await fs.writeFile(file, JSON.stringify(stored));

      expect((await storage.listAllLoopedReviewWorkflows()).map(({ id }) => id))
        .toEqual(["workflow-2", "workflow-3", "workflow-1"]);
      expect((await storage.listLoopedReviewWorkflows("env-1")).map(({ id }) => id))
        .toEqual(["workflow-3", "workflow-1"]);
      expect((await storage.listLoopedReviewWorkflows("env-2")).map(({ id }) => id))
        .toEqual(["workflow-2"]);
    });
  });
});

describe("listAllLoopedReviewWorkflows", () => {
  test("spans environments, orders by update time, and includes legacy records", async () => {
    await withWorkflowStorage(async (storage) => {
      // The helper has already seeded a legacy `workflow-1` for env-1.
      await storage.addEnvironment({
        id: "env-2", projectId: "project-1", name: "Second", branch: "main",
        containerId: null, status: "running", prUrl: null, prState: null,
        hasMergeConflicts: null, createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted", order: 1, environmentType: "local",
        worktreePath: "/tmp/second",
      });
      await storage.saveLoopedReviewWorkflow("workflow-2", "env-2", 2, { id: "workflow-2" }, 0);

      const all = await storage.listAllLoopedReviewWorkflows();
      // The supervisor restores work across every environment, and a legacy
      // version-1 record is exactly what it must find in order to adopt it.
      expect(all.map(({ id }) => id).sort()).toEqual(["workflow-1", "workflow-2"]);
      expect(all.find((entry) => entry.id === "workflow-1")?.version).toBe(1);
      expect(all.find((entry) => entry.id === "workflow-2")?.version).toBe(2);
      // Sorted by updatedAt, so the most recently written record is last.
      expect(all.at(-1)?.id).toBe("workflow-2");
      // listLoopedReviewWorkflows is the per-environment view of the same data.
      expect((await storage.listLoopedReviewWorkflows("env-2")).map(({ id }) => id))
        .toEqual(["workflow-2"]);
      expect(await storage.listLoopedReviewWorkflows("env-unknown")).toEqual([]);
    });
  });

  test("refuses a renderer write once the stored record is backend-owned", async () => {
    await withWorkflowStorage(async (storage) => {
      await storage.saveLoopedReviewWorkflow("workflow-2", "env-1", 2, { id: "workflow-2" }, 0);
      // Evaluated inside the mutation queue, so a concurrent backend adoption
      // between a caller's read and its write cannot slip past it.
      await expect(storage.saveLoopedReviewWorkflow(
        "workflow-2", "env-1", 1, { id: "workflow-2" }, 1, undefined,
        { rejectStoredVersionAtLeast: 2 },
      )).rejects.toThrow(/can only be changed through workflow commands/);

      // A legacy record is still writable through the same path.
      await expect(storage.saveLoopedReviewWorkflow(
        "workflow-1", "env-1", 1, { id: "workflow-1", x: 1 }, 1, undefined,
        { rejectStoredVersionAtLeast: 2 },
      )).resolves.toBeDefined();
    });
  });
});
