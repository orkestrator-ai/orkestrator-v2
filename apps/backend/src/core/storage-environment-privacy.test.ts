import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEnvironment, StorageService } from "./storage.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";
import { storageFilesContain, storageDatabase } from "./storage-test-support.js";

async function withStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-environment-privacy-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("StorageService environment attachment privacy", () => {
  test.each([false, true])(
    "privacy deletion scrubs migrated primaries and backups (remove=%s)",
    async (remove) => {
      const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-legacy-privacy-"));
      const storage = new StorageService(dataDir);
      const secret = "ARCHIVED-ATTACHMENT-83a7";
      const environment = createEnvironment("project-1");
      environment.initialPromptAttachments = [
        { id: "image", name: "private.png", base64Data: secret },
      ];
      const kept = createEnvironment("project-1");
      kept.name = "unrelated-archive-data";
      const raw = JSON.stringify([environment, kept]);
      try {
        await fs.writeFile(path.join(dataDir, "environments.json"), raw);
        await fs.writeFile(path.join(dataDir, "environments.json.bak.1"), raw);
        await storage.init();
        const stamp = (await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY)))[0]!;
        const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp);
        expect(await fs.readFile(path.join(archive, "environments.json"), "utf8")).toContain(
          secret,
        );
        if (remove) await storage.removeEnvironment(environment.id);
        else await storage.updateEnvironment(environment.id, { initialPromptAttachments: null });
        expect(storageFilesContain(dataDir, secret)).toBe(false);
        for (const file of ["environments.json", "environments.json.bak.1"]) {
          const contents = await fs.readFile(path.join(archive, file), "utf8");
          expect(contents).not.toContain(secret);
          expect(contents).toContain(kept.name);
          if (remove) expect(contents).not.toContain(environment.id);
        }
      } finally {
        await storage.close();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test("deleting a migrated draft removes archived sensitive copies and keeps other stores", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-legacy-draft-"));
    const storage = new StorageService(dataDir);
    const environment = createEnvironment("project-1");
    const secret = "ARCHIVED-DRAFT-c1e7";
    try {
      const draft = {
        draftKey: "draft",
        ownerType: "environment",
        ownerId: environment.id,
        value: { text: secret },
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(dataDir, "environments.json"), JSON.stringify([environment]));
      for (const suffix of ["", ".bak.1"])
        await fs.writeFile(
          path.join(dataDir, `compose-drafts.json${suffix}`),
          JSON.stringify({ draft }),
        );
      await storage.init();
      const stamp = (await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY)))[0]!;
      const archive = path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp);
      await storage.deleteComposeDraft("draft");
      expect(storageFilesContain(dataDir, secret)).toBe(false);
      for (const file of ["compose-drafts.json", "compose-drafts.json.bak.1"])
        expect(await fs.readFile(path.join(archive, file), "utf8")).not.toContain(secret);
      expect(await fs.readFile(path.join(archive, "environments.json"), "utf8")).toContain(
        environment.id,
      );
    } finally {
      await storage.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("clearing attachments scrubs superseded copies and restricts permissions", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "c2Vuc2l0aXZlLWltYWdl";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [
          {
            id: "attachment-1",
            name: "private.png",
            previewUrl: "blob:private",
            base64Data: secret,
          },
        ],
      });
      const storedAttachment = (await storage.getEnvironment(environment.id))
        ?.initialPromptAttachments?.[0];
      expect(storedAttachment?.base64Data).toBe(secret);
      expect(storedAttachment?.previewUrl).toBeUndefined();
      // Supersede the record once while it still holds the attachment.
      await storage.updateEnvironment(environment.id, { name: "renamed" });
      expect(storageFilesContain(dataDir, secret)).toBe(true);

      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });

      expect((await storage.getEnvironment(environment.id))?.name).toBe("renamed");
      expect(storageFilesContain(dataDir, secret)).toBe(false);
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = path.join(dataDir, `${STORAGE_DATABASE_FILE}${suffix}`);
        const stat = await fs.stat(file).catch(() => null);
        if (stat) expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });

  test("deleting an environment leaves its complete record unrecoverable", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "ZGVsZXRlZC1pbWFnZQ==";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [
          {
            id: "attachment-2",
            name: "deleted.png",
            previewUrl: "blob:deleted",
            base64Data: secret,
          },
        ],
      });
      await storage.updateEnvironment(environment.id, { status: "running" });
      expect(storageFilesContain(dataDir, secret)).toBe(true);
      expect(storageFilesContain(dataDir, environment.id)).toBe(true);

      await storage.removeEnvironment(environment.id);

      expect(await storage.getEnvironment(environment.id)).toBeNull();
      expect(storageFilesContain(dataDir, secret)).toBe(false);
      expect(storageFilesContain(dataDir, environment.id)).toBe(false);
    });
  });

  test("retries the attachment scrub after the clearing write already committed", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "cmV0cnktY2xlYXItc2VjcmV0";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [
          {
            id: "attachment-retry-clear",
            name: "private.png",
            previewUrl: "blob:private",
            base64Data: secret,
          },
        ],
      });
      // The clearing commit lands but its scrub does not (a reader kept the
      // WAL alive), so superseded frames still hold the attachment.
      const scrub = spyOn(storageDatabase(storage), "scrubDeletedContent").mockImplementationOnce(
        () => {},
      );
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });
      scrub.mockRestore();
      expect(
        (await storage.getEnvironment(environment.id))?.initialPromptAttachments,
      ).toBeUndefined();
      expect(storageFilesContain(dataDir, secret)).toBe(true);

      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });

      expect(storageFilesContain(dataDir, secret)).toBe(false);
    });
  });

  test("retries the scrub after the environment removal already committed", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "cmV0cnktZGVsZXRlLXNlY3JldA==";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [
          {
            id: "attachment-retry-delete",
            name: "private.png",
            previewUrl: "blob:private",
            base64Data: secret,
          },
        ],
      });
      const scrub = spyOn(storageDatabase(storage), "scrubDeletedContent").mockImplementationOnce(
        () => {},
      );
      await storage.removeEnvironment(environment.id);
      scrub.mockRestore();
      expect(await storage.getEnvironment(environment.id)).toBeNull();
      expect(storageFilesContain(dataDir, secret)).toBe(true);

      await expect(storage.removeEnvironment(environment.id)).rejects.toThrow(
        "Environment not found",
      );

      expect(storageFilesContain(dataDir, secret)).toBe(false);
      expect(storageFilesContain(dataDir, environment.id)).toBe(false);
    });
  });
});
