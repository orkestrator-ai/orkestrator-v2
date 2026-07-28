import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEnvironment, StorageService } from "./storage.js";

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

async function backupContents(dataDir: string): Promise<string[]> {
  const entries = await fs.readdir(dataDir);
  return Promise.all(entries
    .filter((entry) => entry.startsWith("environments.json.bak."))
    .map((entry) => fs.readFile(path.join(dataDir, entry), "utf8")));
}

describe("StorageService environment attachment privacy", () => {
  test("clearing attachments scrubs retained backups and restricts permissions", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "c2Vuc2l0aXZlLWltYWdl";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [{
          id: "attachment-1",
          name: "private.png",
          previewUrl: "blob:private",
          base64Data: secret,
        }],
      });
      // Rotate a copy containing the attachment before clearing it.
      await storage.updateEnvironment(environment.id, { name: "renamed" });
      expect((await backupContents(dataDir)).some(
        (contents) => contents.includes(secret),
      )).toBe(true);

      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });

      expect(await fs.readFile(path.join(dataDir, "environments.json"), "utf8"))
        .not.toContain(secret);
      for (const contents of await backupContents(dataDir)) {
        expect(contents).not.toContain(secret);
      }
      const entries = (await fs.readdir(dataDir))
        .filter((entry) => entry === "environments.json"
          || entry.startsWith("environments.json.bak."));
      for (const entry of entries) {
        expect((await fs.stat(path.join(dataDir, entry))).mode & 0o777).toBe(0o600);
      }
    });
  });

  test("deleting an environment removes its complete record from retained backups", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "ZGVsZXRlZC1pbWFnZQ==";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [{
          id: "attachment-2",
          name: "deleted.png",
          previewUrl: "blob:deleted",
          base64Data: secret,
        }],
      });
      await storage.updateEnvironment(environment.id, { status: "running" });

      await storage.removeEnvironment(environment.id);

      expect(await storage.getEnvironment(environment.id)).toBeNull();
      for (const contents of await backupContents(dataDir)) {
        expect(contents).not.toContain(secret);
        expect(contents).not.toContain(environment.id);
      }
    });
  });

  test("retries attachment cleanup after the primary was already cleared", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "cmV0cnktY2xlYXItc2VjcmV0";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [{
          id: "attachment-retry-clear",
          name: "private.png",
          previewUrl: "blob:private",
          base64Data: secret,
        }],
      });
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });
      const backup = path.join(dataDir, "environments.json.bak.1");
      await fs.writeFile(backup, JSON.stringify([{
        ...environment,
        initialPromptAttachments: [{
          id: "attachment-retry-clear",
          name: "private.png",
          previewUrl: "blob:private",
          base64Data: secret,
        }],
      }]), { mode: 0o600 });

      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: null,
      });

      expect(await fs.readFile(backup, "utf8")).not.toContain(secret);
      expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    });
  });

  test("retries backup cleanup after the environment primary was already removed", async () => {
    await withStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const secret = "cmV0cnktZGVsZXRlLXNlY3JldA==";
      await storage.updateEnvironment(environment.id, {
        initialPromptAttachments: [{
          id: "attachment-retry-delete",
          name: "private.png",
          previewUrl: "blob:private",
          base64Data: secret,
        }],
      });
      await storage.removeEnvironment(environment.id);
      const backup = path.join(dataDir, "environments.json.bak.1");
      await fs.writeFile(backup, JSON.stringify([{
        ...environment,
        initialPromptAttachments: [{
          id: "attachment-retry-delete",
          name: "private.png",
          previewUrl: "blob:private",
          base64Data: secret,
        }],
      }]), { mode: 0o600 });

      await expect(storage.removeEnvironment(environment.id))
        .rejects.toThrow("Environment not found");

      expect(await fs.readFile(backup, "utf8")).not.toContain(secret);
      expect(await fs.readFile(backup, "utf8")).not.toContain(environment.id);
      expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    });
  });
});
