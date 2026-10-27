import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import {
  exportStoresAsLegacyJson,
  readStoredValue,
  seedLegacyPromptQueueClaim,
  seedStore,
  storageFilesContain,
  storageDatabase,
} from "./storage-test-support.js";

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
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const KEY = "claude env-e1:tab-1";
const QUEUES = "prompt-queues.json";

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
      await expect(storage.savePromptQueue(KEY, "e1", [{ id: "m2" }], 1)).rejects.toThrow(
        "revision conflict",
      );

      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m2" }],
        revision: 2,
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

      const equal = await storage.savePromptQueue(KEY, "e1", messages, failed!.revision);
      expect(equal.dispatchError).toEqual(failed!.dispatchError);
      await expect(storage.savePromptQueue(KEY, "e1", messages, failed!.revision)).rejects.toThrow(
        "revision conflict",
      );
      expect((await storage.getPromptQueue(KEY))?.dispatchError).toEqual(failed!.dispatchError);
    });
  });

  test("preserves a live legacy lease across queue saves and restores it at expiry", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      const expiresAt = Date.now() + 5 * 60 * 1000;
      const token = seedLegacyPromptQueueClaim(storage.getDataDir(), KEY, "m1", { expiresAt });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      const queue = await storage.getPromptQueue(KEY);
      expect(queue).toMatchObject({
        messages: [{ id: "m2" }],
        outstandingClaim: { token, message: { id: "m1" } },
      });
      await storage.savePromptQueue(KEY, "e1", queue!.messages, queue!.revision);
      expect(await storage.reservePromptQueueHeadForDispatch(KEY)).toBeNull();
      expect(
        readStoredValue<Record<string, unknown>>(storage.getDataDir(), QUEUES)?.[KEY],
      ).toMatchObject({ outstandingClaim: { token } });

      const clock = spyOn(Date, "now").mockReturnValue(expiresAt);
      try {
        await expect(storage.reservePromptQueueHeadForDispatch(KEY)).resolves.toMatchObject({
          message: { id: "m1" },
          requestId: "m1",
        });
        expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [{ id: "m2" }] });
        expect(
          readStoredValue<Record<string, unknown>>(storage.getDataDir(), QUEUES)?.[KEY],
        ).not.toHaveProperty("outstandingClaim");
      } finally {
        clock.mockRestore();
      }
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
      expect(
        new Set(
          queue?.messages.map((message) =>
            typeof message === "object" && message !== null
              ? (message as { id?: string }).id
              : undefined,
          ),
        ),
      ).toEqual(new Set(["m1", "m2"]));
    });
  });

  test("deduplicates enqueue against queued and legacy claimed IDs", async () => {
    await withStorage(async (storage) => {
      const first = await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      const duplicate = await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "replacement must not win",
      });
      expect(duplicate).toEqual(first);

      seedLegacyPromptQueueClaim(storage.getDataDir(), KEY, "m1");
      const claimed = await storage.getPromptQueue(KEY);
      const enqueueClaimed = await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "replacement must not win",
      });
      expect(enqueueClaimed.revision).toBe(claimed!.revision);
      expect(enqueueClaimed.messages).toEqual([]);
      expect(enqueueClaimed.outstandingClaim?.message).toEqual({ id: "m1" });
    });
  });

  test("atomically removes and moves messages by ID", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m3" });

      await expect(storage.movePromptQueueMessage(KEY, "e1", "m3", "up")).resolves.toMatchObject({
        messages: [{ id: "m1" }, { id: "m3" }, { id: "m2" }],
      });
      await expect(storage.removePromptQueueMessage(KEY, "e1", "m3")).resolves.toMatchObject({
        removed: { id: "m3" },
        queue: { messages: [{ id: "m1" }, { id: "m2" }] },
      });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m1", "down")).resolves.toMatchObject({
        messages: [{ id: "m2" }, { id: "m1" }],
      });
    });
  });

  test("makes missing removals and invalid or boundary moves no-ops", async () => {
    await withStorage(async (storage) => {
      await expect(storage.removePromptQueueMessage(KEY, "e1", "missing")).resolves.toEqual({
        removed: null,
        queue: null,
      });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "missing", "up")).resolves.toBeNull();

      const queue = await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      await expect(storage.removePromptQueueMessage(KEY, "e1", "missing")).resolves.toMatchObject({
        removed: null,
        queue: { revision: 2 },
      });
      await expect(
        storage.movePromptQueueMessage(KEY, "e1", "missing", "down"),
      ).resolves.toMatchObject({ revision: 2 });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m1", "up")).resolves.toMatchObject({
        revision: 2,
      });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m2", "down")).resolves.toMatchObject({
        revision: 2,
      });
      expect(queue.revision).toBe(1);
      await expect(
        storage.movePromptQueueMessage(KEY, "e1", "m1", "sideways" as "up"),
      ).rejects.toThrow("must be up or down");
    });
  });

  test("refuses to move a queue between environments", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      await expect(storage.savePromptQueue(KEY, "e2", [{ id: "m1" }])).rejects.toThrow(
        "another environment",
      );
    });
  });

  test("lists every queue an environment owns", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue("claude env-e1:t1", "e1", [{ id: "a" }]);
      await storage.savePromptQueue("codex env-e1:t1", "e1", [{ id: "b" }]);
      await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "c" }]);

      expect((await storage.listPromptQueues("e1")).map((queue) => queue.queueKey).sort()).toEqual([
        "claude env-e1:t1",
        "codex env-e1:t1",
      ]);
    });
  });

  test("deletes every queue for an environment and reports the keys", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue("claude env-e1:t1", "e1", [{ id: "a" }]);
      await storage.savePromptQueue("codex env-e1:t1", "e1", [{ id: "b" }]);
      await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "c" }]);

      expect((await storage.deletePromptQueuesByEnvironment("e1")).sort()).toEqual([
        "claude env-e1:t1",
        "codex env-e1:t1",
      ]);
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
      await expect(storage.savePromptQueue(KEY, "e1", [circular])).rejects.toThrow(
        "JSON serializable",
      );

      await expect(
        storage.savePromptQueue(KEY, "e1", [
          {
            id: "m1",
            attachment: "x".repeat(33 * 1024 * 1024),
          },
        ]),
      ).rejects.toThrow("32 MB limit");
    });
  });

  test("validates individual message mutations before touching storage", async () => {
    await withStorage(async (storage) => {
      const circular: Record<string, unknown> = { id: "m1" };
      circular.self = circular;
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e1", null),
        () => storage.enqueuePromptQueueMessage(KEY, "e1", { id: " " }),
      ]) {
        await expect(mutate()).rejects.toThrow("non-blank ID");
      }
      await expect(storage.enqueuePromptQueueMessage(KEY, "e1", circular)).rejects.toThrow(
        "JSON serializable",
      );
      await expect(
        storage.enqueuePromptQueueMessage(KEY, "e1", {
          id: "large",
          text: "x".repeat(33 * 1024 * 1024),
        }),
      ).rejects.toThrow("32 MB limit");
    });
  });

  test("ignores a corrupt record instead of failing every read", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1" }]);
      const stored = readStoredValue(storage.getDataDir(), QUEUES) as Record<string, unknown>;
      stored.corrupt = { queueKey: "corrupt", environmentId: "e1", messages: "nope", revision: 1 };
      seedStore(storage.getDataDir(), QUEUES, stored);

      expect((await storage.listPromptQueues("e1")).map((queue) => queue.queueKey)).toEqual([KEY]);
    });
  });

  test("upgrades a legacy dispatch error with the failed message fingerprint", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "invalid" }]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.failPromptQueueDispatch(KEY, "m1");
      // Rewrite the error in the first implementation's shape and import it
      // the way an upgraded installation does.
      const legacyDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-queue-legacy-"));
      exportStoresAsLegacyJson(storage.getDataDir(), legacyDir, (file, value) => {
        if (file !== QUEUES) return undefined;
        const queues = value as Record<string, { dispatchError?: Record<string, unknown> }>;
        delete queues[KEY]?.dispatchError?.messageId;
        delete queues[KEY]?.dispatchError?.messageFingerprint;
        return queues;
      });
      const upgraded = new StorageService(legacyDir);
      try {
        expect((await upgraded.getPromptQueue(KEY))?.dispatchError).toMatchObject({
          messageId: "m1",
          messageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } finally {
        upgraded.close();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });
  });

  test("serializes concurrent writes so revisions never collide", async () => {
    await withStorage(async (storage) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          storage.savePromptQueue(KEY, "e1", [{ id: `m${index}` }]),
        ),
      );
      expect(results.map((result) => result.revision).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    });
  });

  test("serializes concurrent writes across StorageService instances", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 === 0 ? storage : second).savePromptQueue(KEY, "e1", [{ id: `m${index}` }]),
        ),
      );
      expect(results.map((result) => result.revision).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    });
  });

  test("rejects writes for missing or deleting environments", async () => {
    await withStorage(async (storage) => {
      await expect(storage.savePromptQueue("claude missing:t1", "missing", [])).rejects.toThrow(
        "environment not found",
      );

      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(storage.savePromptQueue(KEY, "e1", [])).rejects.toThrow("being deleted");
    });
  });

  test("validates environment lifecycle and ownership for every atomic mutation", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e2", { id: "m2" }),
        () => storage.removePromptQueueMessage(KEY, "e2", "m1"),
        () => storage.movePromptQueueMessage(KEY, "e2", "m1", "up"),
      ]) {
        await expect(mutate()).rejects.toThrow("another environment");
      }
      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" }),
        () => storage.removePromptQueueMessage(KEY, "e1", "m1"),
        () => storage.movePromptQueueMessage(KEY, "e1", "m1", "up"),
      ]) {
        await expect(mutate()).rejects.toThrow("being deleted");
      }
    });
  });

  test("rejects every atomic mutation for a missing environment", async () => {
    await withStorage(async (storage) => {
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage("claude missing:t", "missing", { id: "m" }),
        () => storage.removePromptQueueMessage("claude missing:t", "missing", "m"),
        () => storage.movePromptQueueMessage("claude missing:t", "missing", "m", "up"),
      ]) {
        await expect(mutate()).rejects.toThrow("environment not found");
      }
    });
  });

  test("rejects blank identifiers", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getPromptQueue("")).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue("", "e1", [])).rejects.toThrow("must not be blank");
      await expect(storage.savePromptQueue(KEY, "", [])).rejects.toThrow("must not be blank");
      await expect(storage.listPromptQueues("")).rejects.toThrow("must not be blank");
      await expect(storage.deletePromptQueuesByEnvironment("")).rejects.toThrow(
        "must not be blank",
      );
      await expect(storage.removePromptQueueMessage(KEY, "e1", "")).rejects.toThrow(
        "must not be blank",
      );
      await expect(storage.movePromptQueueMessage(KEY, "e1", "", "up")).rejects.toThrow(
        "must not be blank",
      );
    });
  });

  describe("deleted content scrubbing", () => {
    test("leaves a deleted environment's prompt text unrecoverable", async () => {
      await withStorage(async (storage) => {
        // Several writes so the early prompt survives only in superseded pages.
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "TOP-SECRET-PROMPT" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2", text: "second" }], 1);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m3", text: "third" }], 2);
        expect(storageFilesContain(storage.getDataDir(), "TOP-SECRET-PROMPT")).toBe(true);

        await storage.deletePromptQueuesByEnvironment("e1");

        expect(storageFilesContain(storage.getDataDir(), "TOP-SECRET-PROMPT")).toBe(false);
      });
    });

    test("leaves another environment's queues intact", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep", text: "KEEP-ME" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "DROP-ME" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2", text: "DROP-ME-TOO" }], 1);

        await storage.deletePromptQueuesByEnvironment("e1");

        const dataDir = storage.getDataDir();
        expect(storageFilesContain(dataDir, "KEEP-ME")).toBe(true);
        expect(storageFilesContain(dataDir, "DROP-ME")).toBe(false);
        expect(await storage.listPromptQueues("e2")).toHaveLength(1);
      });
    });

    test("retries the scrub after the delete already committed", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "SENSITIVE" }]);
        await storage.savePromptQueue(KEY, "e1", [{ id: "m2" }], 1);
        // The delete commits but its scrub does not (a reader kept the WAL
        // alive), so superseded frames still hold the prompt.
        const scrub = spyOn(storageDatabase(storage), "scrubDeletedContent").mockImplementation(
          () => {},
        );
        expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([KEY]);
        scrub.mockRestore();
        expect(storageFilesContain(storage.getDataDir(), "SENSITIVE")).toBe(true);

        // The retry finds nothing left to delete but still finishes the scrub.
        expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([]);

        expect(storageFilesContain(storage.getDataDir(), "SENSITIVE")).toBe(false);
      });
    });

    test("does not touch other queues when the environment owned none", async () => {
      await withStorage(async (storage) => {
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep", text: "KEEP-ME" }]);
        await storage.savePromptQueue("claude env-e2:t1", "e2", [{ id: "keep2" }], 1);
        const write = spyOn(storageDatabase(storage), "writeStore");

        expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([]);

        expect(write).not.toHaveBeenCalled();
        write.mockRestore();
        expect(await storage.getPromptQueue("claude env-e2:t1")).toMatchObject({
          messages: [{ id: "keep2" }],
          revision: 2,
        });
      });
    });
  });
});

/**
 * Only a backend up to v2.28.0-beta sharing the database writes
 * `outstandingClaim` (through the removed claim commands). Live leases remain
 * exclusive; expired or malformed leases are restored on every load.
 */
describe("StorageService legacy prompt queue claims", () => {
  test("restores expired claims on load, at startup or written while running", async () => {
    await withStorage(async (storage) => {
      const otherKey = "claude env-e2:tab-1";
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(otherKey, "e2", { id: "m2" });
      seedLegacyPromptQueueClaim(storage.getDataDir(), KEY, "m1", { expiresAt: 1 });

      const restarted = new StorageService(storage.getDataDir());
      await restarted.init();
      expect(await restarted.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m1" }],
        revision: 2,
      });
      expect(await restarted.getPromptQueue(KEY)).not.toHaveProperty("outstandingClaim");

      seedLegacyPromptQueueClaim(restarted.getDataDir(), otherKey, "m2", { expiresAt: 1 });
      expect(await restarted.getPromptQueue(otherKey)).toMatchObject({
        messages: [{ id: "m2" }],
        revision: 2,
      });
      // A load writes nothing: the claims stay stored until the next save.
      const stored = readStoredValue<Record<string, Record<string, unknown>>>(
        restarted.getDataDir(),
        QUEUES,
      );
      expect(stored?.[KEY]).toHaveProperty("outstandingClaim");
      expect(stored?.[otherKey]).toHaveProperty("outstandingClaim");
      restarted.close();
    });
  });

  test("restores a claim whose lease fields are malformed, and drops one with no message", async () => {
    for (const [outstandingClaim, messages] of [
      [
        { token: "  ", message: { id: "m1" }, claimedAt: "x", expiresAt: "not-a-date" },
        [{ id: "m1" }, { id: "m2" }],
      ],
      [{ token: "t", claimedAt: new Date(0).toISOString() }, [{ id: "m2" }]],
      ["not-a-record", [{ id: "m2" }]],
    ] as const) {
      await withStorage(async (storage) => {
        seedStore(storage.getDataDir(), QUEUES, {
          [KEY]: {
            queueKey: KEY,
            environmentId: "e1",
            messages: [{ id: "m2" }],
            outstandingClaim,
            updatedAt: new Date(0).toISOString(),
            revision: 1,
          },
        });

        const queue = await storage.getPromptQueue(KEY);
        expect(queue).toMatchObject({ messages, revision: 1 });
        expect(queue).not.toHaveProperty("outstandingClaim");
      });
    }
  });

  test("deleting a queue discards its legacy claim with it", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1", text: "SENSITIVE" });
      seedLegacyPromptQueueClaim(storage.getDataDir(), KEY, "m1");

      expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([KEY]);
      expect(await storage.getPromptQueue(KEY)).toBeNull();
      expect(
        readStoredValue<Record<string, unknown>>(storage.getDataDir(), QUEUES),
      ).not.toHaveProperty(KEY);
    });
  });
});

describe("StorageService legacy compose draft provenance", () => {
  const DRAFT_KEY = "claude:e1:tab-1";

  test("drops a persisted draft whose transfer provenance is malformed or oversized", async () => {
    for (const sourcePromptQueue of [
      "not-a-record",
      { queueKey: "  ", messageId: "m1" },
      { queueKey: KEY, messageId: "  " },
      { queueKey: "k".repeat(4 * 1024 + 1), messageId: "m1" },
      { queueKey: KEY, messageId: "m".repeat(1024 + 1) },
    ]) {
      await withStorage(async (storage) => {
        seedStore(storage.getDataDir(), "compose-drafts.json", {
          [DRAFT_KEY]: {
            draftKey: DRAFT_KEY,
            ownerType: "environment",
            ownerId: "e1",
            value: { text: "hi" },
            sourcePromptQueue,
            updatedAt: new Date(0).toISOString(),
            revision: 1,
          },
        });

        expect(await storage.getComposeDraft(DRAFT_KEY)).toBeNull();
      });
    }
  });
});
