import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

async function withStorage<T>(
  run: (storage: StorageService) => Promise<T>,
  options: { promptQueueClaimLeaseMs?: number } = {},
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-prompt-queues-"));
  const storage = new StorageService(dataDir, options);
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
      expect([first.claimToken, other.claimToken].filter(Boolean)).toHaveLength(1);
      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [candidate[1]],
        revision: 3,
        outstandingClaim: { message: candidate[0] },
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

  test("blocks a second claim until the first dispatch is acknowledged", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });

      const first = await storage.claimPromptQueueHead(KEY, "e1", "m1");
      expect(first.claimToken).toBeString();
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m2"))
        .resolves.toMatchObject({
          claimed: null,
          claimToken: null,
          queue: {
            messages: [{ id: "m2" }],
            outstandingClaim: { message: { id: "m1" } },
          },
        });
      await expect(
        storage.acknowledgePromptQueueClaim(KEY, "e1", "wrong-token"),
      ).rejects.toThrow("does not match");

      await expect(
        storage.acknowledgePromptQueueClaim(KEY, "e1", first.claimToken!),
      ).resolves.toMatchObject({
        messages: [{ id: "m2" }],
        revision: 4,
      });
      expect((await storage.getPromptQueue(KEY))?.outstandingClaim).toBeUndefined();
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m2"))
        .resolves.toMatchObject({ claimed: { id: "m2" } });
    });
  });

  test("nacks a claim back to the head without duplicating the message", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      const claim = await storage.claimPromptQueueHead(KEY, "e1", "m1");

      await expect(
        storage.rejectPromptQueueClaim(KEY, "e1", claim.claimToken!),
      ).resolves.toMatchObject({
        messages: [{ id: "m1" }, { id: "m2" }],
        revision: 4,
      });
      expect((await storage.getPromptQueue(KEY))?.outstandingClaim).toBeUndefined();
    });
  });

  test("makes ack and nack idempotent only after the matching claim is settled", async () => {
    await withStorage(async (storage) => {
      await expect(storage.acknowledgePromptQueueClaim(KEY, "e1", "token"))
        .resolves.toBeNull();
      await expect(storage.rejectPromptQueueClaim(KEY, "e1", "token"))
        .resolves.toBeNull();

      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await expect(storage.acknowledgePromptQueueClaim(KEY, "e1", "token"))
        .resolves.toMatchObject({ messages: [{ id: "m1" }], revision: 1 });
      const claim = await storage.claimPromptQueueHead(KEY, "e1", "m1");
      await storage.acknowledgePromptQueueClaim(KEY, "e1", claim.claimToken!);
      await expect(
        storage.acknowledgePromptQueueClaim(KEY, "e1", claim.claimToken!),
      ).resolves.toMatchObject({ messages: [], revision: 3 });
      await expect(
        storage.rejectPromptQueueClaim(KEY, "e1", claim.claimToken!),
      ).resolves.toMatchObject({ messages: [], revision: 3 });
    });
  });

  test("treats legacy requeue of the outstanding message as a nack", async () => {
    await withStorage(async (storage) => {
      const message = { id: "m1", text: "recover me" };
      await storage.enqueuePromptQueueMessage(KEY, "e1", message);
      await storage.claimPromptQueueHead(KEY, "e1", "m1");

      await expect(storage.requeuePromptQueueMessage(KEY, "e1", message))
        .resolves.toMatchObject({ messages: [message] });
      expect((await storage.getPromptQueue(KEY))?.outstandingClaim).toBeUndefined();
    });
  });

  test("recovers and announces an expired sole claim during backend restart", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.claimPromptQueueHead(KEY, "e1", "m1");
      const file = path.join(storage.getDataDir(), "prompt-queues.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        { outstandingClaim?: { claimedAt: string; expiresAt: string } }
      >;
      stored[KEY]!.outstandingClaim!.claimedAt = new Date(0).toISOString();
      stored[KEY]!.outstandingClaim!.expiresAt = new Date(1).toISOString();
      await fs.writeFile(file, JSON.stringify(stored));

      const events: Array<{ resource: string; id: string }> = [];
      const restarted = new StorageService(storage.getDataDir());
      restarted.setResourceChangeListener((event) => events.push(event));
      await restarted.init();
      expect(await restarted.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m1" }],
        revision: 3,
      });
      expect((await restarted.getPromptQueue(KEY))?.outstandingClaim).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        resource: "prompt-queue",
        id: "e1",
      }));
    });
  });

  test("live lease timer restores and announces a sole claimed head", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      const events: Array<{ resource: string; id: string }> = [];
      storage.setResourceChangeListener((event) => events.push(event));
      await storage.claimPromptQueueHead(KEY, "e1", "m1");
      events.length = 0;

      const deadline = Date.now() + 1_000;
      let recovered = await storage.getPromptQueue(KEY);
      while (
        (recovered?.messages.length === 0 || events.length === 0)
        && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        recovered = await storage.getPromptQueue(KEY);
      }

      expect(recovered).toMatchObject({
        messages: [{ id: "m1" }],
        revision: 3,
      });
      expect(recovered?.outstandingClaim).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({
        resource: "prompt-queue",
        id: "e1",
      }));
    }, { promptQueueClaimLeaseMs: 25 });
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

  test("deduplicates enqueue and requeue against queued and claimed IDs", async () => {
    await withStorage(async (storage) => {
      const first = await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      const duplicate = await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "replacement must not win",
      });
      expect(duplicate).toEqual(first);

      const claimed = await storage.claimPromptQueueHead(KEY, "e1", "m1");
      const enqueueClaimed = await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
      });
      expect(enqueueClaimed.revision).toBe(claimed.queue!.revision);
      const nacked = await storage.requeuePromptQueueMessage(KEY, "e1", { id: "m1" });
      const duplicateRequeue = await storage.requeuePromptQueueMessage(
        KEY,
        "e1",
        { id: "m1", text: "replacement must not win" },
      );
      expect(duplicateRequeue).toEqual(nacked);
      expect(duplicateRequeue.messages).toEqual([{ id: "m1" }]);
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
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m1", "down"))
        .resolves.toMatchObject({
          messages: [{ id: "m3" }, { id: "m2" }, { id: "m1" }],
        });
    });
  });

  test("makes missing removals and invalid or boundary moves no-ops", async () => {
    await withStorage(async (storage) => {
      await expect(storage.removePromptQueueMessage(KEY, "e1", "missing"))
        .resolves.toEqual({ removed: null, queue: null });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "missing", "up"))
        .resolves.toBeNull();

      const queue = await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      await expect(storage.removePromptQueueMessage(KEY, "e1", "missing"))
        .resolves.toMatchObject({ removed: null, queue: { revision: 2 } });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "missing", "down"))
        .resolves.toMatchObject({ revision: 2 });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m1", "up"))
        .resolves.toMatchObject({ revision: 2 });
      await expect(storage.movePromptQueueMessage(KEY, "e1", "m2", "down"))
        .resolves.toMatchObject({ revision: 2 });
      expect(queue.revision).toBe(1);
      await expect(
        storage.movePromptQueueMessage(KEY, "e1", "m1", "sideways" as "up"),
      ).rejects.toThrow("must be up or down");
    });
  });

  test("transfers a queue item to a compose draft without a loss window", async () => {
    await withStorage(async (storage) => {
      const message = { id: "m1", text: "hello", attachments: [] };
      const value = { text: "hello", mentions: [], attachments: [] };
      await storage.enqueuePromptQueueMessage(KEY, "e1", message);
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });

      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY,
        "e1",
        "m1",
        "compose:e1:tab-1",
        "environment",
        "e1",
        0,
      )).resolves.toMatchObject({
        removed: message,
        queue: { messages: [{ id: "m2" }], revision: 3 },
        draft: {
          draftKey: "compose:e1:tab-1",
          ownerType: "environment",
          ownerId: "e1",
          value,
          revision: 1,
        },
      });
      expect(await storage.getComposeDraft("compose:e1:tab-1"))
        .toMatchObject({ value });
    });
  });

  test("never overwrites an existing draft during queue transfer", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "replace me",
        attachments: [],
      });
      await storage.saveComposeDraft(
        "compose:e1:tab-1",
        "environment",
        "e1",
        { text: "keep me" },
      );

      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY,
        "e1",
        "m1",
        "compose:e1:tab-1",
        "environment",
        "e1",
      )).rejects.toThrow("already exists");
      expect(await storage.getPromptQueue(KEY))
        .toMatchObject({ messages: [{ id: "m1" }] });
      expect(await storage.getComposeDraft("compose:e1:tab-1"))
        .toMatchObject({ value: { text: "keep me" } });
    });
  });

  test("retries a transfer after draft persistence outlives queue persistence", async () => {
    await withStorage(async (storage) => {
      const message = {
        id: "m1",
        text: "survive the partial failure",
        attachments: [{ id: "a1" }],
      };
      await storage.enqueuePromptQueueMessage(KEY, "e1", message);

      type SaveSensitiveJson = (
        filePath: string,
        value: unknown,
        options?: { backup?: boolean },
      ) => Promise<void>;
      const mutable = storage as unknown as {
        saveSensitiveJson: SaveSensitiveJson;
      };
      const originalSave = mutable.saveSensitiveJson.bind(storage);
      let failPromptQueueWrite = true;
      mutable.saveSensitiveJson = async (filePath, value, options) => {
        if (
          failPromptQueueWrite
          && path.basename(filePath) === "prompt-queues.json"
        ) {
          failPromptQueueWrite = false;
          throw new Error("injected prompt queue persistence failure");
        }
        await originalSave(filePath, value, options);
      };

      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY,
        "e1",
        "m1",
        "compose:e1:tab-1",
        "environment",
        "e1",
      )).rejects.toThrow("injected prompt queue persistence failure");
      expect(await storage.getPromptQueue(KEY))
        .toMatchObject({ messages: [message], revision: 1 });
      expect(await storage.getComposeDraft("compose:e1:tab-1"))
        .toMatchObject({
          value: {
            text: message.text,
            mentions: [],
            attachments: message.attachments,
          },
          sourcePromptQueue: {
            queueKey: KEY,
            messageId: "m1",
          },
          revision: 1,
        });
      await storage.saveComposeDraft(
        "compose:e1:tab-1",
        "environment",
        "e1",
        {
          text: "survive the partial failure",
          mentions: [],
          attachments: message.attachments,
        },
        1,
      );
      expect(await storage.getComposeDraft("compose:e1:tab-1"))
        .toMatchObject({
          sourcePromptQueue: { queueKey: KEY, messageId: "m1" },
          revision: 2,
        });

      mutable.saveSensitiveJson = originalSave;
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY,
        "e1",
        "m1",
        "compose:e1:tab-1",
        "environment",
        "e1",
      )).resolves.toMatchObject({
        removed: message,
        queue: { messages: [], revision: 2 },
        draft: {
          sourcePromptQueue: { queueKey: KEY, messageId: "m1" },
          revision: 2,
        },
      });
      expect(await storage.getPromptQueue(KEY))
        .toMatchObject({ messages: [], revision: 2 });
      expect(await storage.getComposeDraft("compose:e1:tab-1"))
        .toMatchObject({ revision: 2 });
    });
  });

  test("validates transfer ownership, missing messages, and draft revisions", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "hello",
        attachments: [],
      });
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "missing", "compose:e1:tab", "environment", "e1",
      )).resolves.toMatchObject({ removed: null, draft: null });
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", "compose:e2:tab", "environment", "e2",
      )).rejects.toThrow("does not own");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", "compose:other:tab", "project", "other",
      )).rejects.toThrow("does not own");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", "compose:e1:tab", "environment", "e1", 1,
      )).rejects.toThrow("revision conflict");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        `claude ${"x".repeat(4 * 1024)}`,
        "e1",
        "m1",
        "compose:e1:tab",
        "environment",
        "e1",
      )).rejects.toThrow("key is too large");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY,
        "e1",
        "x".repeat(1025),
        "compose:e1:tab",
        "environment",
        "e1",
      )).rejects.toThrow("message ID is too large");
      expect(await storage.getPromptQueue(KEY))
        .toMatchObject({ messages: [{ id: "m1" }] });
    });
  });

  test("refuses to transfer a malformed authoritative queued payload", async () => {
    await withStorage(async (storage) => {
      await storage.savePromptQueue(KEY, "e1", [{
        id: "m1",
        text: 123,
        attachments: "not-an-array",
      }]);
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", "compose:e1:tab", "environment", "e1",
      )).rejects.toThrow("must have text and attachments");
      expect(await storage.getComposeDraft("compose:e1:tab")).toBeNull();
      expect(await storage.getPromptQueue(KEY))
        .toMatchObject({ messages: [{ id: "m1" }] });
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
      const result = await storage.claimPromptQueueHead(KEY, "e1", "m1");
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
      expect((await storage.claimPromptQueueHead(KEY, "e1", "m1")).claimed)
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

      const result = await storage.claimPromptQueueHead(KEY, "e1", "row-2");
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

  test("validates individual message mutations before touching storage", async () => {
    await withStorage(async (storage) => {
      const circular: Record<string, unknown> = { id: "m1" };
      circular.self = circular;
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e1", null),
        () => storage.requeuePromptQueueMessage(KEY, "e1", { id: " " }),
      ]) {
        await expect(mutate()).rejects.toThrow("non-blank ID");
      }
      await expect(storage.enqueuePromptQueueMessage(KEY, "e1", circular))
        .rejects.toThrow("JSON serializable");
      await expect(storage.requeuePromptQueueMessage(KEY, "e1", {
        id: "large",
        text: "x".repeat(33 * 1024 * 1024),
      })).rejects.toThrow("32 MB limit");
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

  test("validates environment lifecycle and ownership for every atomic mutation", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e2", { id: "m2" }),
        () => storage.requeuePromptQueueMessage(KEY, "e2", { id: "m2" }),
        () => storage.removePromptQueueMessage(KEY, "e2", "m1"),
        () => storage.movePromptQueueMessage(KEY, "e2", "m1", "up"),
        () => storage.claimPromptQueueHead(KEY, "e2", "m1"),
      ]) {
        await expect(mutate()).rejects.toThrow("another environment");
      }
      await storage.updateEnvironment("e1", {
        deletionRequestedAt: new Date().toISOString(),
      });
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" }),
        () => storage.requeuePromptQueueMessage(KEY, "e1", { id: "m2" }),
        () => storage.removePromptQueueMessage(KEY, "e1", "m1"),
        () => storage.movePromptQueueMessage(KEY, "e1", "m1", "up"),
        () => storage.acknowledgePromptQueueClaim(KEY, "e1", "token"),
        () => storage.rejectPromptQueueClaim(KEY, "e1", "token"),
        () => storage.transferPromptQueueMessageToComposeDraft(
          KEY,
          "e1",
          "m1",
          "compose:e1:tab",
          "environment",
          "e1",
        ),
      ]) {
        await expect(mutate()).rejects.toThrow("being deleted");
      }
    });
  });

  test("rejects every atomic mutation for a missing environment", async () => {
    await withStorage(async (storage) => {
      for (const mutate of [
        () => storage.enqueuePromptQueueMessage("claude missing:t", "missing", { id: "m" }),
        () => storage.requeuePromptQueueMessage("claude missing:t", "missing", { id: "m" }),
        () => storage.removePromptQueueMessage("claude missing:t", "missing", "m"),
        () => storage.movePromptQueueMessage("claude missing:t", "missing", "m", "up"),
        () => storage.claimPromptQueueHead("claude missing:t", "missing", "m"),
        () => storage.acknowledgePromptQueueClaim("claude missing:t", "missing", "token"),
        () => storage.rejectPromptQueueClaim("claude missing:t", "missing", "token"),
        () => storage.transferPromptQueueMessageToComposeDraft(
          "claude missing:t",
          "missing",
          "m",
          "compose:missing:t",
          "environment",
          "missing",
        ),
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
      await expect(storage.deletePromptQueuesByEnvironment(""))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead("", "e1", "m1"))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "", "m1"))
        .rejects.toThrow("must not be blank");
      await expect(storage.claimPromptQueueHead(KEY, "e1", ""))
        .rejects.toThrow("must not be blank");
      await expect(storage.acknowledgePromptQueueClaim(KEY, "e1", ""))
        .rejects.toThrow("must not be blank");
      await expect(storage.rejectPromptQueueClaim(KEY, "e1", ""))
        .rejects.toThrow("must not be blank");
      await expect(storage.removePromptQueueMessage(KEY, "e1", ""))
        .rejects.toThrow("must not be blank");
      await expect(storage.movePromptQueueMessage(KEY, "e1", "", "up"))
        .rejects.toThrow("must not be blank");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "", "compose:e1:tab", "environment", "e1",
      )).rejects.toThrow("must not be blank");
    });
  });

  test("returns no claim when the authoritative queue does not exist", async () => {
    await withStorage(async (storage) => {
      await expect(storage.claimPromptQueueHead(KEY, "e1", "m1"))
        .resolves.toEqual({ claimed: null, claimToken: null, queue: null });
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

describe("StorageService prompt queue claim leases", () => {
  test("refuses a non-positive or non-finite claim lease", () => {
    for (const promptQueueClaimLeaseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new StorageService("/tmp/unused", { promptQueueClaimLeaseMs }))
        .toThrow("Prompt queue claim lease must be positive");
    }
  });

  test("rejects a settlement whose token does not match the outstanding claim", async () => {
    // The acknowledge path already guards this; a mismatched *reject* is the
    // one that would hand a live prompt back to a client that never held it.
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.claimPromptQueueHead(KEY, "e1", "m1");

      await expect(storage.rejectPromptQueueClaim(KEY, "e1", "wrong-token"))
        .rejects.toThrow("does not match");
      expect((await storage.getPromptQueue(KEY))?.outstandingClaim?.message)
        .toMatchObject({ id: "m1" });
    });
  });

  test("recovers an expired claim inline when the next claim arrives first", async () => {
    // Neither restart nor the lease timer has run yet: the claim path itself
    // has to re-head the abandoned message before it can grant a new claim.
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m2" });
      await storage.claimPromptQueueHead(KEY, "e1", "m1");

      const file = path.join(storage.getDataDir(), "prompt-queues.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        { outstandingClaim?: { expiresAt: string } }
      >;
      stored[KEY]!.outstandingClaim!.expiresAt = new Date(1).toISOString();
      await fs.writeFile(file, JSON.stringify(stored));

      const reclaimed = await storage.claimPromptQueueHead(KEY, "e1", "m1");
      expect(reclaimed.claimed).toMatchObject({ id: "m1" });
      expect(reclaimed.claimToken).toBeTruthy();
      expect(reclaimed.queue?.messages).toMatchObject([{ id: "m2" }]);
    });
  });

  test("recovers every expired claim and announces each owning environment", async () => {
    await withStorage(async (storage) => {
      const otherKey = "claude env-e2:tab-1";
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.enqueuePromptQueueMessage(otherKey, "e2", { id: "m2" });
      await storage.claimPromptQueueHead(KEY, "e1", "m1");
      await storage.claimPromptQueueHead(otherKey, "e2", "m2");

      const file = path.join(storage.getDataDir(), "prompt-queues.json");
      const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<
        string,
        { outstandingClaim?: { expiresAt: string } }
      >;
      for (const record of Object.values(stored)) {
        record.outstandingClaim!.expiresAt = new Date(1).toISOString();
      }
      await fs.writeFile(file, JSON.stringify(stored));

      const events: Array<{ resource: string; id: string }> = [];
      const restarted = new StorageService(storage.getDataDir());
      restarted.setResourceChangeListener((event) => events.push(event));
      await restarted.init();

      expect(await restarted.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m1" }],
      });
      expect(await restarted.getPromptQueue(otherKey)).toMatchObject({
        messages: [{ id: "m2" }],
      });
      const announced = events
        .filter((event) => event.resource === "prompt-queue")
        .map((event) => event.id);
      expect(new Set(announced)).toEqual(new Set(["e1", "e2"]));
    });
  });

  test("drops a whole record whose stored claim is malformed", async () => {
    // A half-written claim cannot be reasoned about: leaving the messages
    // readable while the claim is unusable would let the same prompt be
    // dispatched from the queue and recovered from the claim.
    for (const outstandingClaim of [
      { token: "  ", message: { id: "m1" }, claimedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() },
      { token: "t", message: { id: "m1" }, claimedAt: "not-a-date", expiresAt: new Date(1).toISOString() },
      { token: "t", message: { id: "m1" }, claimedAt: new Date(0).toISOString(), expiresAt: "not-a-date" },
      { token: "t", claimedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() },
    ]) {
      await withStorage(async (storage) => {
        const file = path.join(storage.getDataDir(), "prompt-queues.json");
        await fs.writeFile(file, JSON.stringify({
          [KEY]: {
            queueKey: KEY,
            environmentId: "e1",
            messages: [{ id: "m1" }],
            outstandingClaim,
            updatedAt: new Date(0).toISOString(),
            revision: 1,
          },
        }));

        expect(await storage.getPromptQueue(KEY)).toBeNull();
      });
    }
  });

  test("keeps the claim discarded and re-arms recovery when its queue is deleted", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1", text: "SENSITIVE" });
      await storage.claimPromptQueueHead(KEY, "e1", "m1");

      expect(await storage.deletePromptQueuesByEnvironment("e1")).toEqual([KEY]);
      expect(await storage.getPromptQueue(KEY)).toBeNull();

      // Nothing is left for the lease timer to restore.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await storage.getPromptQueue(KEY)).toBeNull();
    });
  });
});

describe("StorageService prompt queue transfer validation", () => {
  const DRAFT_KEY = "claude:e1:tab-1";

  test("rejects malformed draft identity arguments before touching either store", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "keep me queued",
        attachments: [],
      });

      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", "  ", "environment", "e1",
      )).rejects.toThrow("Compose draft key must not be blank");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", DRAFT_KEY, "workspace" as "environment", "e1",
      )).rejects.toThrow("Compose draft owner type is invalid");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", DRAFT_KEY, "environment", "  ",
      )).rejects.toThrow("Compose draft owner ID must not be blank");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", DRAFT_KEY, "environment", "e1", 1.5,
      )).rejects.toThrow("Compose draft expected revision must be a non-negative integer");
      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", DRAFT_KEY, "environment", "e1", -1,
      )).rejects.toThrow("Compose draft expected revision must be a non-negative integer");

      expect(await storage.getPromptQueue(KEY)).toMatchObject({
        messages: [{ id: "m1" }],
        revision: 1,
      });
      expect(await storage.getComposeDraft(DRAFT_KEY)).toBeNull();
    });
  });

  test("refuses to transfer into a draft slot owned by someone else", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", {
        id: "m1",
        text: "keep me queued",
        attachments: [],
      });
      await storage.saveComposeDraft(DRAFT_KEY, "environment", "e2", { text: "other env draft" });

      await expect(storage.transferPromptQueueMessageToComposeDraft(
        KEY, "e1", "m1", DRAFT_KEY, "environment", "e1",
      )).rejects.toThrow("Compose draft belongs to another owner");
      expect(await storage.getComposeDraft(DRAFT_KEY))
        .toMatchObject({ value: { text: "other env draft" } });
      expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [{ id: "m1" }] });
    });
  });

  test("drops a persisted draft whose transfer provenance is malformed or oversized", async () => {
    for (const sourcePromptQueue of [
      "not-a-record",
      { queueKey: "  ", messageId: "m1" },
      { queueKey: KEY, messageId: "  " },
      { queueKey: "k".repeat(4 * 1024 + 1), messageId: "m1" },
      { queueKey: KEY, messageId: "m".repeat(1024 + 1) },
    ]) {
      await withStorage(async (storage) => {
        const file = path.join(storage.getDataDir(), "compose-drafts.json");
        await fs.writeFile(file, JSON.stringify({
          [DRAFT_KEY]: {
            draftKey: DRAFT_KEY,
            ownerType: "environment",
            ownerId: "e1",
            value: { text: "hi" },
            sourcePromptQueue,
            updatedAt: new Date(0).toISOString(),
            revision: 1,
          },
        }));

        expect(await storage.getComposeDraft(DRAFT_KEY)).toBeNull();
      });
    }
  });
});
