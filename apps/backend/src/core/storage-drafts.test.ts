import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
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
    return await run(storage, dataDir);
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
      const second = await storage.saveComposeDraft(
        first.draftKey,
        "environment",
        "e1",
        { text: "current" },
        first.revision,
      );
      expect(second.revision).toBe(2);
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
      const updated = await storage.saveFileDraft(
        saved.draftKey,
        "e1",
        "README.md",
        "edited again",
        "original",
      );
      expect(updated.revision).toBe(2);
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

  test("validates draft keys, owners, paths, revisions, and JSON values", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.saveComposeDraft("", "environment", "e1", "value"),
      ).rejects.toThrow("key must not be blank");
      await expect(
        storage.saveComposeDraft("key", "invalid" as "environment", "e1", "value"),
      ).rejects.toThrow("owner type is invalid");
      await expect(
        storage.saveComposeDraft("key", "environment", "", "value"),
      ).rejects.toThrow("owner ID must not be blank");
      await expect(
        storage.saveComposeDraft("key", "environment", "e1", "value", -1),
      ).rejects.toThrow("expected revision");
      await expect(
        storage.saveComposeDraft("key", "environment", "e1", 1n),
      ).rejects.toThrow("JSON serializable");
      await expect(
        storage.saveComposeDraft("key", "environment", "missing", "value"),
      ).rejects.toThrow("environment not found");
      await expect(
        storage.saveComposeDraft("key", "project", "missing", "value"),
      ).rejects.toThrow("project not found");
      await expect(storage.getComposeDraft("")).rejects.toThrow("key must not be blank");
      await expect(storage.deleteComposeDraft("")).rejects.toThrow("key must not be blank");
      await expect(
        storage.listComposeDrafts("invalid" as "environment", "e1"),
      ).rejects.toThrow("owner type is invalid");
      await expect(
        storage.listComposeDrafts("environment", ""),
      ).rejects.toThrow("owner ID must not be blank");
      await expect(
        storage.deleteComposeDraftsByEnvironment(""),
      ).rejects.toThrow("environment ID must not be blank");
      await expect(
        storage.deleteComposeDraftsByProject(""),
      ).rejects.toThrow("project ID must not be blank");

      await expect(
        storage.saveFileDraft("", "e1", "a.ts", "draft", "disk"),
      ).rejects.toThrow("key must not be blank");
      await expect(
        storage.saveFileDraft("file", "", "a.ts", "draft", "disk"),
      ).rejects.toThrow("environment ID must not be blank");
      await expect(
        storage.saveFileDraft("file", "e1", "", "draft", "disk"),
      ).rejects.toThrow("path must not be blank");
      await expect(
        storage.saveFileDraft("file", "missing", "a.ts", "draft", "disk"),
      ).rejects.toThrow("environment not found");
      await expect(storage.getFileDraft("")).rejects.toThrow("key must not be blank");
      await expect(storage.deleteFileDraft("")).rejects.toThrow("key must not be blank");
      await expect(
        storage.deleteFileDraftsByEnvironment(""),
      ).rejects.toThrow("environment ID must not be blank");
    });
  });

  test("prevents a draft key from changing ownership", async () => {
    await withStorage(async (storage) => {
      await storage.saveComposeDraft("shared", "environment", "e1", "first");
      await expect(
        storage.saveComposeDraft("shared", "project", "p1", "second"),
      ).rejects.toThrow("belongs to another owner");

      await storage.saveFileDraft("file:shared", "e1", "a.ts", "first", "disk");
      await expect(
        storage.saveFileDraft("file:shared", "e1", "b.ts", "second", "disk"),
      ).rejects.toThrow("belongs to another file");
    });
  });

  test("rejects drafts above the sensitive-storage size limit", async () => {
    await withStorage(async (storage) => {
      const oversized = "x".repeat(32 * 1024 * 1024 + 1);
      await expect(
        storage.saveComposeDraft("large", "environment", "e1", oversized),
      ).rejects.toThrow("32 MB limit");
      await expect(
        storage.saveFileDraft("large", "e1", "large.txt", oversized, ""),
      ).rejects.toThrow("32 MB limit");
    });
  });

  test("filters malformed and mismatched stored draft records", async () => {
    await withStorage(async (storage, dataDir) => {
      const composePath = path.join(dataDir, "compose-drafts.json");
      const filePath = path.join(dataDir, "file-drafts.json");
      await fs.writeFile(composePath, JSON.stringify({
        valid: {
          draftKey: "valid",
          ownerType: "environment",
          ownerId: "e1",
          value: "keep",
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
        mismatch: {
          draftKey: "different",
          ownerType: "environment",
          ownerId: "e1",
          value: "drop",
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
        malformed: { draftKey: "malformed" },
      }));
      await fs.writeFile(filePath, JSON.stringify({
        valid: {
          draftKey: "valid",
          environmentId: "e1",
          filePath: "a.ts",
          content: "draft",
          originalContent: "disk",
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
        mismatch: {
          draftKey: "different",
          environmentId: "e1",
          filePath: "b.ts",
          content: "drop",
          originalContent: "disk",
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
        malformed: { draftKey: "malformed" },
      }));

      expect((await storage.listComposeDrafts("environment", "e1")).map(
        (draft) => draft.draftKey,
      )).toEqual(["valid"]);
      expect(await storage.getComposeDraft("mismatch")).toBeNull();
      expect(await storage.getFileDraft("valid")).toMatchObject({ content: "draft" });
      expect(await storage.getFileDraft("mismatch")).toBeNull();
    });
  });

  test("explicit deletion removes schema-invalid keyed primary records", async () => {
    await withStorage(async (storage, dataDir) => {
      const composePath = path.join(dataDir, "compose-drafts.json");
      const filePath = path.join(dataDir, "file-drafts.json");
      await fs.writeFile(composePath, JSON.stringify({
        malformed: {
          draftKey: "malformed",
          value: "compose malformed secret",
        },
      }));
      await fs.writeFile(filePath, JSON.stringify({
        malformed: {
          draftKey: "malformed",
          content: "file malformed secret",
        },
      }));

      await storage.deleteComposeDraft("malformed");
      await storage.deleteFileDraft("malformed");

      expect(JSON.parse(await fs.readFile(composePath, "utf8"))).toEqual({});
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({});
      for (const filename of [
        "compose-drafts.json.bak.1",
        "file-drafts.json.bak.1",
      ]) {
        expect(await fs.readFile(path.join(dataDir, filename), "utf8"))
          .not.toContain("malformed secret");
      }
    });
  });

  test("serializes concurrent draft saves across service instances", async () => {
    await withStorage(async (storage, dataDir) => {
      const other = new StorageService(dataDir);
      await other.init();

      await Promise.all([
        storage.saveComposeDraft("compose:a", "environment", "e1", "a"),
        other.saveComposeDraft("compose:b", "environment", "e1", "b"),
        storage.saveFileDraft("file:a", "e1", "a.ts", "a", "disk"),
        other.saveFileDraft("file:b", "e1", "b.ts", "b", "disk"),
      ]);

      expect(new Set(
        (await storage.listComposeDrafts("environment", "e1"))
          .map((draft) => draft.draftKey),
      )).toEqual(new Set(["compose:a", "compose:b"]));
      expect(await storage.getFileDraft("file:a")).not.toBeNull();
      expect(await storage.getFileDraft("file:b")).not.toBeNull();
    });
  });

  test("individual deletes scrub sensitive backups even when the primary is absent", async () => {
    await withStorage(async (storage, dataDir) => {
      const changes: string[] = [];
      storage.setResourceChangeListener((change) => changes.push(change.resource));
      const composeKey = "compose:secret";
      const fileKey = "file:secret";
      await storage.saveComposeDraft(
        composeKey,
        "environment",
        "e1",
        { text: "compose secret" },
      );
      await storage.saveComposeDraft("compose:other", "environment", "e1", "other");
      await storage.saveFileDraft(fileKey, "e1", "secret.ts", "file secret", "disk");
      await storage.saveFileDraft("file:other", "e1", "other.ts", "other", "disk");

      await storage.deleteComposeDraft(composeKey);
      await storage.deleteFileDraft(fileKey);

      const composeBackup = path.join(dataDir, "compose-drafts.json.bak.1");
      const fileBackup = path.join(dataDir, "file-drafts.json.bak.1");
      expect(await fs.readFile(composeBackup, "utf8")).toContain("compose:other");
      expect(await fs.readFile(fileBackup, "utf8")).toContain("file:other");
      // Recreate the interrupted-delete shape: the primary is already clean,
      // but a retained copy still contains the sensitive record.
      await fs.writeFile(composeBackup, JSON.stringify({
        [composeKey]: {
          draftKey: composeKey,
          ownerType: "environment",
          ownerId: "e1",
          value: { text: "compose secret" },
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
      }), { mode: 0o600 });
      await fs.writeFile(fileBackup, JSON.stringify({
        [fileKey]: {
          draftKey: fileKey,
          environmentId: "e1",
          filePath: "secret.ts",
          content: "file secret",
          originalContent: "disk",
          updatedAt: new Date(0).toISOString(),
          revision: 1,
        },
      }), { mode: 0o600 });

      changes.length = 0;
      await storage.deleteComposeDraft(composeKey);
      await storage.deleteFileDraft(fileKey);
      expect(changes).toEqual([]);

      for (const [filename, secret] of [
        ["compose-drafts.json.bak.1", "compose secret"],
        ["file-drafts.json.bak.1", "file secret"],
      ] as const) {
        const contents = await fs.readFile(path.join(dataDir, filename), "utf8");
        expect(contents).not.toContain(secret);
        expect(contents).not.toContain("secret");
      }
    });
  });
});
