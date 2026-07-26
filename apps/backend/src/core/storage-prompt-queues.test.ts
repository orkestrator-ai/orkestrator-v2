import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-prompt-queues-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const KEY = "claude env-e1:tab-1";

describe("StorageService prompt queues", () => {
  test("stores and reads a queue", async () => {
    await withStorage(async (storage) => {
      const saved = await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      expect(saved).toMatchObject({ queueKey: KEY, environmentId: "e1", revision: 1 });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [{ id: "m1" }] });
    });
  });

  test("returns null for a queue that was never created", async () => {
    await withStorage(async (storage) => {
      expect(await storage.getPromptQueue("claude env-e1:missing")).toBeNull();
    });
  });

  test("lets exactly one client take the head under a contended revision", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }, { id: "m2" }], 0);

      // Both clients believe they are at revision 1 and try to take "m1".
      const first = storage.savePromptQueue(KEY, "e1", [{ id: "m2" }], 1);
      await expect(first).resolves.toMatchObject({ revision: 2 });
      await expect(
        storage.savePromptQueue(KEY, "e1", [{ id: "m2" }], 1),
      ).rejects.toThrow("revision conflict");

      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m2" }],
        revision: 2,
      });
    });
  });

  test("refuses to move a queue between environments", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      await expect(
        storage.savePromptQueue(KEY, "e2", [{ id: "m1" }]),
      ).rejects.toThrow("another environment");
    });
  });

  test("lists every queue an environment owns", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue("claude env-e1:t1", "e1", [{ id: "a" }]);
      await storage.savePromptQueue("codex env-e1:t1", "e1", [{ id: "b" }]);
      await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "c" }]);

      expect((await storage.listPromptQueues("e1")).map((queue) => queue.queueKey).sort())
        .toEqual(["claude env-e1:t1", "codex env-e1:t1"]);
    });
  });

  test("deletes every queue for an environment and reports the keys", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue("claude env-e1:t1", "e1", [{ id: "a" }]);
      await storage.savePromptQueue("codex env-e1:t1", "e1", [{ id: "b" }]);
      await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "c" }]);

      expect((await storage.deletePromptQueuesByEnvironment("e1")).sort())
        .toEqual(["claude env-e1:t1", "codex env-e1:t1"]);
      expect(await storage.listPromptQueues("e1")).toEqual([]);
      expect(await storage.listPromptQueues("e2")).toHaveLength(1);
    });
  });

  test("stores an empty queue rather than treating it as a delete", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      await storage.savePromptQueue(KEY, "e1", []);
      expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [], revision: 2 });
    });
  });

  test("rejects a non-array message list", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.savePromptQueue(KEY, "e1", "not-an-array" as unknown as unknown[]),
      ).rejects.toThrow("must be an array");
    });
  });

  test("ignores a corrupt record instead of failing every read", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      const file = path.join(storage.getDataDir(), "prompt-queues.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      stored.corrupt = { queueKey: "corrupt", environmentId: "e1", messages: "nope", revision: 1 };
      await fs.writeFile(file, JSON.stringify(stored));

      expect((await storage.listPromptQueues("e1")).map((queue) => queue.queueKey))
        .toEqual([KEY]);
    });
  });

  test("serializes concurrent writes so revisions never collide", async () => {
    await withStorage(async (storage) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          storage.savePromptQueue(KEY, "e1", [{ id: `m${index}` }]),
        ),
      );
      expect(results.map((result) => result.revision).sort((a, b) => a - b))
        .toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  test("rejects blank identifiers", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getPromptQueue("")).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue("", "e1", [])).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue(KEY, "", [])).rejects.toThrow("must not be blank");
      await expect(storage.listPromptQueues("")).rejects.toThrow("must not be blank");
    });
  });

  describe("backup scrubbing", () => {
    /** Every retained copy of the queue file, primary and backups. */
    async function readAllCopies(storage: StorageService): Promise<string> {
      const dir = storage.getDataDir();
      const names = (await fs.readdir(dir)).filter((name) => name.startsWith("prompt-queues.json"));
      const contents = await Promise.all(
        names.map((name) => fs.readFile(path.join(dir, name), "utf8")),
      );
      return contents.join("\n");
    }

    test("removes a deleted environment's prompt text from every retained backup", async () => {
      await withStorage(async (storage) => {
        // Several writes so the file rotates and the early prompt survives only
        // in a backup.
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "TOP-SECRET-PROMPT" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2", text: "second" }], 1);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m3", text: "third" }], 2);
        expect(await readAllCopies(storage)).toContain("TOP-SECRET-PROMPT");

        await storage.deletePromptQueuesByEnvironment("e1");

        expect(await readAllCopies(storage)).not.toContain("TOP-SECRET-PROMPT");
      });
    });

    test("leaves another environment's queues intact in the backups", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep", text: "KEEP-ME" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "DROP-ME" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2", text: "DROP-ME-TOO" }], 1);

        await storage.deletePromptQueuesByEnvironment("e1");

        const all = await readAllCopies(storage);
        expect(all).toContain("KEEP-ME");
        expect(all).not.toContain("DROP-ME");
        expect(await storage.listPromptQueues("e2")).toHaveLength(1);
      });
    });

    test("discards a corrupt backup that cannot be proven scrubbed", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "SENSITIVE" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2" }], 1);
        const backup = path.join(storage.getDataDir(), "prompt-queues.json.bak.1");
        await fs.writeFile(backup, "{ not json SENSITIVE");

        await storage.deletePromptQueuesByEnvironment("e1");

        expect(await readAllCopies(storage)).not.toContain("SENSITIVE");
      });
    });

    test("does not touch backups when the environment owned no queues", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep", text: "KEEP-ME" }]);
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep2" }], 1);

        expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([]);

        expect(await readAllCopies(storage)).toContain("KEEP-ME");
      });
    });
  });
});
