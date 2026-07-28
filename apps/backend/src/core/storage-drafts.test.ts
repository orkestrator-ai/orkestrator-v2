import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-drafts-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "p1",
    name: "Draft project",
    gitUrl: "https://example.com/drafts.git",
    localPath: null,
    order: 0,
    addedAt: new Date(0).toISOString(),
  });
  await storage.addEnvironment({
    id: "e1",
    projectId: "p1",
    name: "drafts",
    branch: "drafts",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
  });
  try {
    return await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("StorageService drafts", () => {
  test("round-trips revisioned compose drafts", async () => {
    await withStorage(async (storage) => {
      const first = await storage.saveComposeDraft(
        "claude:e1:tab",
        "environment",
        "e1",
        { text: "keep me", attachments: [] },
        0,
      );
      expect(first.revision).toBe(1);
      expect(await storage.getComposeDraft(first.draftKey)).toMatchObject({
        ownerType: "environment",
        ownerId: "e1",
        value: { text: "keep me", attachments: [] },
      });
      await expect(
        storage.saveComposeDraft(
          first.draftKey,
          "environment",
          "e1",
          { text: "stale" },
          0,
        ),
      ).rejects.toThrow("revision conflict");
    });
  });

  test("round-trips and removes file drafts", async () => {
    await withStorage(async (storage) => {
      const saved = await storage.saveFileDraft(
        "file:e1:README",
        "e1",
        "README.md",
        "edited",
        "original",
      );
      expect(saved).toMatchObject({
        content: "edited",
        originalContent: "original",
        revision: 1,
      });
      await storage.deleteFileDraft(saved.draftKey);
      expect(await storage.getFileDraft(saved.draftKey)).toBeNull();
    });
  });

  test("stores project-scoped UI drafts without pretending they are environments", async () => {
    await withStorage(async (storage) => {
      const saved = await storage.saveComposeDraft(
        "github-comment:p1:issue-1",
        "project",
        "p1",
        "unsent comment",
      );
      expect(saved).toMatchObject({
        ownerType: "project",
        ownerId: "p1",
        value: "unsent comment",
      });
      expect(await storage.listComposeDrafts("project", "p1")).toHaveLength(1);
      await storage.deleteComposeDraftsByProject("p1");
      expect(await storage.getComposeDraft(saved.draftKey)).toBeNull();
    });
  });

  test("deletion cleanup removes both draft classes", async () => {
    await withStorage(async (storage) => {
      await storage.saveComposeDraft(
        "terminal:e1:tab",
        "environment",
        "e1",
        { text: "draft" },
      );
      await storage.saveFileDraft("file:e1:a", "e1", "a.ts", "draft", "disk");
      await storage.deleteComposeDraftsByEnvironment("e1");
      await storage.deleteFileDraftsByEnvironment("e1");
      expect(await storage.listComposeDrafts("environment", "e1")).toEqual([]);
      expect(await storage.getFileDraft("file:e1:a")).toBeNull();
    });
  });

  test("rejects drafts for a deleting environment", async () => {
    await withStorage(async (storage) => {
      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(
        storage.saveComposeDraft(
          "terminal:e1:tab",
          "environment",
          "e1",
          { text: "late" },
        ),
      ).rejects.toThrow("being deleted");
      await expect(
        storage.saveFileDraft("file:e1:a", "e1", "a.ts", "late", "disk"),
      ).rejects.toThrow("being deleted");
    });
  });
});
