import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-prompt-queues-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const id of ["e1", "e2"]) {
    await storage.addEnvironment({
      id,
      projectId: "proj-1",
      name: id,
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
    });
  }
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

  test("lets exactly one StorageService instance atomically claim a queue head", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      const candidate = [{ id: "m1", text: "first" }, { id: "m2", text: "second" }];
      await storage.enqueuePromptQueueMessage(KEY, "e1", candidate[0]);
      await storage.enqueuePromptQueueMessage(KEY, "e1", candidate[1]);

      const [first, other] = await Promise.all([
        storage.claimPromptQueueHead(KEY, "e1", "m1"),
        second.claimPromptQueueHead(KEY, "e1", "m1"),
      ]);

      expect([first.claimed, other.claimed].filter(Boolean)).toHaveLength(1);
      expect([first.claimed, other.claimed].filter(Boolean)[0]).toEqual(candidate[0]);
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [candidate[1]],
        revision: 3,
      });
    });
  });

  test("preserves concurrent appends from different clients", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();

      await Promise.all([
        storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1", text: "first" }),
        second.enqueuePromptQueueMessage(KEY, "e1", { id: "m2", text: "second" }),
      ]);

      const queue = await storage.getPromptQueue(KEY);
      expect(queue?.messages).toHaveLength(2);
      expect(new Set(
        queue?.messages.map((message) =>
          typeof message === "object" && message !== null
            ? (message as { id?: string }).id
            : undefined
        ),
      )).toEqual(new Set(["m1", "m2"]));
    });
  });

  test("atomically removes, requeues, and moves messages by ID", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m3" });

      await expect(storage.movePromptQueueMessage(KEY, "e1", "m3", "up"))
        .resolves.toMatchObject({
          messages: [{ id: "m1" }, { id: "m3" }, { id: "m2" }],
        });
      await expect(storage.removePromptQueueMessage(KEY, "e1", "m3"))
        .resolves.toMatchObject({
          removed: { id: "m3" },
          queue: { messages: [{ id: "m1" }, { id: "m2" }] },
        });
      await expect(storage.requeuePromptQueueMessage(KEY, "e1", { id: "m3" }))
        .resolves.toMatchObject({
          messages: [{ id: "m3" }, { id: "m1" }, { id: "m2" }],
        });
    });
  });

  test("returns the current queue without mutation when the expected head differs", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m2" }]);
      const result = await storage.claimPromptQueueHead(
        KEY,
        "e1",
        "m1",
      );
      expect(result.claimed).toBeNull();
      expect(result.queue).toMatchObject({ messages: [{ id: "m2" }], revision: 1 });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({ revision: 1 });
    });
  });

  test("validates claim environment ownership", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.claimPromptQueueHead(KEY, "missing", "m1"),
      ).rejects.toThrow("environment not found");

      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(
        storage.claimPromptQueueHead(KEY, "e1", "m1"),
      ).rejects.toThrow("being deleted");
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

  test("rejects non-serializable and over-sized message lists", async () => {
    await withStorage(async (storage) => {
      const circular: Record<string, unknown> = { id: "m1" };
      circular.self = circular;
      await expect(storage.savePromptQueue(KEY, "e1", [circular]))
        .rejects.toThrow("JSON serializable");

      await expect(storage.savePromptQueue(KEY, "e1", [{
        id: "m1",
        attachment: "x".repeat(33 * 1024 * 1024),
      }])).rejects.toThrow("32 MB limit");
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

  test("serializes concurrent writes across StorageService instances", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 === 0 ? storage : second)
            .savePromptQueue(KEY, "e1", [{ id: `m${index}` }]),
        ),
      );
      expect(results.map((result) => result.revision).sort((a, b) => a - b))
        .toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  test("rejects writes for missing or deleting environments", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.savePromptQueue("claude missing:t1", "missing", []),
      ).rejects.toThrow("environment not found");

      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(storage.savePromptQueue(KEY, "e1", []))
        .rejects.toThrow("being deleted");
    });
  });

  test("rejects blank identifiers", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getPromptQueue("")).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue("", "e1", [])).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue(KEY, "", [])).rejects.toThrow("must not be blank");
      await expect(storage.listPromptQueues("")).rejects.toThrow("must not be blank");
      await expect(storage.deletePromptQueuesByEnvironment(""))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead("", "e1", "m1"))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "", "m1"))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "e1", ""))
        .rejects.toThrow("must not be blank");
    });
  });

  test("returns no claim when the authoritative queue does not exist", async () => {
    await withStorage(async (storage) => {
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m1"))
        .resolves.toEqual({ claimed: null, queue: null });
      expect(await storage.getPromptQueue(KEY)).toBeNull();
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
