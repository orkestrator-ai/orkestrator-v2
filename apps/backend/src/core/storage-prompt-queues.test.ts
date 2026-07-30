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

      const [first, other] = await Promise.all([
        storage.claimPromptQueueHead(KEY, "e1", "m1", candidate),
        second.claimPromptQueueHead(KEY, "e1", "m1", candidate),
      ]);

      expect([first.claimed, other.claimed].filter(Boolean)).toHaveLength(1);
      expect([first.claimed, other.claimed].filter(Boolean)[0]).toEqual(candidate[0]);
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [candidate[1]],
        revision: 1,
      });
    });
  });

  test("reserves one durable in-flight dispatch across backend processes", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      await storage.savePromptQueue(KEY, "e1", [
        { id: "row-1", requestId: "request-1", text: "first" },
        { id: "row-2", text: "second" },
      ]);

      const [first, other] = await Promise.all([
        storage.reservePromptQueueHeadForDispatch(KEY),
        second.reservePromptQueueHeadForDispatch(KEY),
      ]);

      expect(first).toEqual(other);
      expect(first).toMatchObject({
        requestId: "request-1",
        message: { id: "row-1", text: "first" },
      });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "row-2", text: "second" }],
        inFlight: { requestId: "request-1" },
      });
    });
  });

  test("preserves in-flight work through renderer queue saves and clears it only by request id", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "row-1", text: "first" }]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.savePromptQueue(KEY, "e1", [{ id: "row-2", text: "second" }]);

      expect(await storage.acknowledgePromptQueueDispatch(KEY, "wrong")).toMatchObject({
        inFlight: { requestId: "row-1" },
      });
      expect(await storage.acknowledgePromptQueueDispatch(KEY, "row-1")).toMatchObject({
        messages: [{ id: "row-2", text: "second" }],
      });
      expect((await storage.getPromptQueue(KEY))?.inFlight).toBeUndefined();
    });
  });

  test("restores a permanently rejected dispatch and requires explicit retry", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [
        { id: "row-1", text: "invalid" },
        { id: "row-2", text: "later" },
      ]);
      await storage.reservePromptQueueHeadForDispatch(KEY);

      const failed = await storage.failPromptQueueDispatch(KEY, "row-1");
      expect(failed).toMatchObject({
        messages: [
          { id: "row-1", text: "invalid" },
          { id: "row-2", text: "later" },
        ],
        dispatchError: {
          requestId: "row-1",
          messageId: "row-1",
          messageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(failed?.inFlight).toBeUndefined();
      expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toBeNull();

      const rendererSave = await storage.savePromptQueue(
        KEY,
        "e1",
        failed!.messages,
        failed!.revision,
      );
      expect(rendererSave.dispatchError).toEqual(failed!.dispatchError);
      expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toBeNull();

      const retrying = await storage.retryPromptQueueDispatch(KEY);
      expect(retrying?.dispatchError).toBeUndefined();
      expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toMatchObject({
        requestId: "row-1",
      });
    });
  });

  test("clears a rejection when the failed prompt is edited or removed", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [
        { id: "row-1", text: "invalid" },
        { id: "row-2", text: "later" },
      ]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      const failed = await storage.failPromptQueueDispatch(KEY, "row-1");

      const edited = await storage.savePromptQueue(
        KEY,
        "e1",
        [
          { id: "row-1", text: "valid now" },
          { id: "row-2", text: "later" },
        ],
        failed!.revision,
      );
      expect(edited.dispatchError).toBeUndefined();

      await storage.reservePromptQueueHeadForDispatch(KEY);
      const failedAgain = await storage.failPromptQueueDispatch(KEY, "row-1");
      const removed = await storage.savePromptQueue(
        KEY,
        "e1",
        [{ id: "row-2", text: "later" }],
        failedAgain!.revision,
      );
      expect(removed.dispatchError).toBeUndefined();
    });
  });

  test("preserves a rejection on equal saves and rejects stale saves", async () => {
    await withStorage(async (storage) => {
      const messages = [{ id: "row-1", text: "invalid" }];
      await storage.savePromptQueue(KEY, "e1", messages);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      const failed = await storage.failPromptQueueDispatch(KEY, "row-1");

      const equal = await storage.savePromptQueue(
        KEY,
        "e1",
        messages,
        failed!.revision,
      );
      expect(equal.dispatchError).toEqual(failed!.dispatchError);
      await expect(
        storage.savePromptQueue(KEY, "e1", messages, failed!.revision),
      ).rejects.toThrow("revision conflict");
      expect((await storage.getPromptQueue(KEY))?.dispatchError)
        .toEqual(failed!.dispatchError);
    });
  });

  test("returns the current queue without mutation when the expected head differs", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m2" }]);
      const result = await storage.claimPromptQueueHead(
        KEY,
        "e1",
        "m1",
        [{ id: "m1" }],
      );
      expect(result.claimed).toBeNull();
      expect(result.queue).toMatchObject({ messages: [{ id: "m2" }], revision: 1 });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({ revision: 1 });
    });
  });

  test("refuses to claim a head while a rejection is parked", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [
        { id: "m1", text: "invalid" },
        { id: "m2", text: "later" },
      ]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      const failed = await storage.failPromptQueueDispatch(KEY, "m1");

      // The renderer promotes a claimed head into its composer. Handing it the
      // rejected prompt would silently discard the error the user must see.
      const result = await storage.claimPromptQueueHead(KEY, "e1", "m1", [
        { id: "m1", text: "invalid" },
      ]);
      expect(result.claimed).toBeNull();
      expect(result.queue).toMatchObject({
        revision: failed!.revision,
        dispatchError: { requestId: "m1" },
      });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m1" }, { id: "m2" }],
        revision: failed!.revision,
      });

      await storage.retryPromptQueueDispatch(KEY);
      expect((await storage.claimPromptQueueHead(KEY, "e1", "m1", [])).claimed)
        .toEqual({ id: "m1", text: "invalid" });
    });
  });

  test("keeps a durable in-flight dispatch when a later head is claimed", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [
        { id: "row-1", text: "dispatching" },
        { id: "row-2", text: "claimable" },
      ]);
      await storage.reservePromptQueueHeadForDispatch(KEY);

      const result = await storage.claimPromptQueueHead(KEY, "e1", "row-2", []);
      expect(result.claimed).toEqual({ id: "row-2", text: "claimable" });
      // Dropping inFlight here would let the backend reserve and send row-1 a
      // second time under a fresh request id.
      expect(result.queue).toMatchObject({
        messages: [],
        inFlight: { requestId: "row-1" },
      });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        inFlight: { requestId: "row-1", message: { id: "row-1" } },
      });
    });
  });

  test("validates claim candidates and environment ownership", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.claimPromptQueueHead(KEY, "e1", "m1", "bad" as unknown as unknown[]),
      ).rejects.toThrow("must be an array");
      await expect(
        storage.claimPromptQueueHead(KEY, "missing", "m1", [{ id: "m1" }]),
      ).rejects.toThrow("environment not found");

      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(
        storage.claimPromptQueueHead(KEY, "e1", "m1", [{ id: "m1" }]),
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

  test("upgrades a legacy dispatch error with the failed message fingerprint", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "invalid" }]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.failPromptQueueDispatch(KEY, "m1");
      const file = path.join(storage.getDataDir(), "prompt-queues.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        { dispatchError?: Record<string, unknown> }
      >;
      delete stored[KEY]?.dispatchError?.messageId;
      delete stored[KEY]?.dispatchError?.messageFingerprint;
      await fs.writeFile(file, JSON.stringify(stored));

      expect((await storage.getPromptQueue(KEY))?.dispatchError).toMatchObject({
        messageId: "m1",
        messageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
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
      await expect(storage.claimPromptQueueHead("", "e1", "m1", []))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "", "m1", []))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "e1", "", []))
        .rejects.toThrow("must not be blank");
    });
  });

  test("returns no claim when a new candidate queue has no matching object head", async () => {
    await withStorage(async (storage) => {
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m1", []))
        .resolves.toEqual({ claimed: null, queue: null });
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m1", ["not-an-object"]))
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
