import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { StorageService } from "./storage.js";
import {
  PROMPT_QUEUE_MESSAGE_CONFLICT,
  PROMPT_QUEUE_MESSAGE_FROZEN,
  canonicalPromptQueueMessageFingerprint,
} from "./storage-prompts.js";

const LOGICAL = "env-e1:tab-1";
const KEY = `claude\0${LOGICAL}`;
const SESSION_KEY = nativeAgentSessionStorageKey("e1", "claude", LOGICAL);

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-prompt-idempotent-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1",
    projectId: "proj-1",
    name: "e1",
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
  try {
    return await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(storage: StorageService) {
  return storage.getOrCreateNativeAgentSession(
    { key: SESSION_KEY, environmentId: "e1", agent: "claude", logicalSessionKey: LOGICAL },
    async () => "provider-1",
  );
}

function message(id: string, text = "brief") {
  return {
    id,
    requestId: id,
    text,
    attachments: [],
    origin: { kind: "web-annotation", requestId: id },
  };
}

describe("enqueuePromptQueueMessageIfAbsent", () => {
  test("appends once and reports an identical retry as present", async () => {
    await withStorage(async (storage) => {
      const first = await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(first.status).toBe("queued");
      const retry = await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(retry.status).toBe("present");
      expect((await storage.getPromptQueue(KEY))?.messages).toHaveLength(1);
    });
  });

  test("fingerprints are independent of key order", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      const reordered = {
        text: "brief",
        origin: { requestId: "r1", kind: "web-annotation" },
        attachments: [],
        requestId: "r1",
        id: "r1",
      };
      expect(canonicalPromptQueueMessageFingerprint(reordered)).toBe(
        canonicalPromptQueueMessageFingerprint(message("r1")),
      );
      expect((await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", reordered)).status).toBe(
        "present",
      );
    });
  });

  test("rejects a different body for an id that is already queued", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await expect(
        storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1", "changed")),
      ).rejects.toThrow(PROMPT_QUEUE_MESSAGE_CONFLICT);
      expect((await storage.getPromptQueue(KEY))?.messages).toEqual([message("r1")]);
    });
  });

  test("treats an in-flight reservation as present and never appends a twin", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      const reservation = await storage.reservePromptQueueHeadForDispatch(KEY);
      expect(reservation?.requestId).toBe("r1");
      const retry = await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(retry.status).toBe("present");
      const queue = await storage.getPromptQueue(KEY);
      expect(queue?.messages).toEqual([]);
      expect(queue?.inFlight?.requestId).toBe("r1");
      await expect(
        storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1", "changed")),
      ).rejects.toThrow(PROMPT_QUEUE_MESSAGE_CONFLICT);
    });
  });

  test("treats a parked dispatch error as present without clearing the latch", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.failPromptQueueDispatch(KEY, "r1", "rejected");
      const retry = await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(retry.status).toBe("present");
      const queue = await storage.getPromptQueue(KEY);
      expect(queue?.dispatchError?.messageId).toBe("r1");
      expect(queue?.messages).toHaveLength(1);
    });
  });

  test("reports a consumed id after the queue acknowledged a confirmed dispatch", async () => {
    await withStorage(async (storage) => {
      await createSession(storage);
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await storage.reservePromptQueueHeadForDispatch(KEY);
      // Crash boundary: provider accepted, session receipt written, then ack.
      await storage.dispatchNativeAgentPromptOnce(SESSION_KEY, "r1", async () => undefined);
      await storage.acknowledgePromptQueueDispatch(KEY, "r1");
      expect((await storage.getPromptQueue(KEY))?.inFlight).toBeUndefined();

      const restarted = new StorageService(storage.getDataDir());
      await restarted.init();
      const retry = await restarted.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(retry.status).toBe("consumed");
      expect((await restarted.getPromptQueue(KEY))?.messages).toEqual([]);
    });
  });

  test("reports a consumed id while the provider outcome is parked as ambiguous", async () => {
    await withStorage(async (storage) => {
      await createSession(storage);
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await expect(
        storage.dispatchNativeAgentPromptOnce(
          SESSION_KEY,
          "r1",
          async () => {
            throw new Error("socket closed");
          },
          { requestId: "r1", prompt: "brief", createdAt: new Date(0).toISOString() },
        ),
      ).rejects.toThrow("socket closed");
      // The drainer keeps the reservation; a crash could also have cleared it.
      await storage.acknowledgePromptQueueDispatch(KEY, "r1");
      const retry = await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      expect(retry.status).toBe("consumed");
      expect((await storage.getPromptQueue(KEY))?.messages).toEqual([]);
    });
  });

  test("keeps ordinary enqueue semantics for a fresh id behind user prompts", async () => {
    await withStorage(async (storage) => {
      await createSession(storage);
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "user-1", text: "mine" });
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r2"));
      expect(
        (await storage.getPromptQueue(KEY))?.messages.map((m) => (m as { id: string }).id),
      ).toEqual(["user-1", "r2"]);
    });
  });

  test("validates environment ownership and blank ids", async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", { text: "x" }),
      ).rejects.toThrow("non-blank ID");
      await expect(
        storage.enqueuePromptQueueMessageIfAbsent(KEY, "missing", message("r1")),
      ).rejects.toThrow("environment not found");
    });
  });

  test("concurrent retries from two storage instances append exactly once", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      const results = await Promise.all([
        storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1")),
        second.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1")),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["present", "queued"]);
      expect((await storage.getPromptQueue(KEY))?.messages).toHaveLength(1);
    });
  });
});

describe("backend-authored queue items", () => {
  test("removal before dispatch leaves a tombstone and consumes the id", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "user-1", text: "mine" });
      await storage.removePromptQueueMessage(KEY, "e1", "r1");
      await storage.removePromptQueueMessage(KEY, "e1", "user-1");
      const queue = await storage.getPromptQueue(KEY);
      // Only typed-origin items are tombstoned; user prompts are not tracked.
      expect(queue?.removedOrigins?.map((entry) => entry.requestId)).toEqual(["r1"]);
      expect(
        (await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"))).status,
      ).toBe("consumed");
      // Later saves keep the tombstone.
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "user-2", text: "later" });
      expect((await storage.getPromptQueue(KEY))?.removedOrigins).toHaveLength(1);
    });
  });

  test("claims and dispatch reservations are never tombstoned", async () => {
    await withStorage(async (storage) => {
      await createSession(storage);
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r2"));
      const claim = await storage.claimPromptQueueHead(KEY, "e1", "r1");
      await storage.acknowledgePromptQueueClaim(KEY, "e1", claim.claimToken!);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.dispatchNativeAgentPromptOnce(SESSION_KEY, "r2", async () => undefined);
      await storage.acknowledgePromptQueueDispatch(KEY, "r2");
      expect((await storage.getPromptQueue(KEY))?.removedOrigins ?? []).toEqual([]);
    });
  });

  test("a whole-queue replacement that drops an item tombstones it", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      const queue = await storage.getPromptQueue(KEY);
      await storage.savePromptQueue(KEY, "e1", [], queue!.revision);
      expect((await storage.getPromptQueue(KEY))?.removedOrigins?.[0]?.requestId).toBe("r1");
    });
  });

  test("frozen items cannot be transferred into a draft or changed on requeue", async () => {
    await withStorage(async (storage) => {
      await storage.enqueuePromptQueueMessageIfAbsent(KEY, "e1", message("r1"));
      await expect(
        storage.transferPromptQueueMessageToComposeDraft(
          KEY,
          "e1",
          "r1",
          `claude:e1:${encodeURIComponent(LOGICAL)}`,
          "environment",
          "e1",
        ),
      ).rejects.toThrow(PROMPT_QUEUE_MESSAGE_FROZEN);
      expect(await storage.getComposeDraft(`claude:e1:${encodeURIComponent(LOGICAL)}`)).toBeNull();
      expect((await storage.getPromptQueue(KEY))?.messages).toHaveLength(1);

      await storage.claimPromptQueueHead(KEY, "e1", "r1");
      await expect(
        storage.requeuePromptQueueMessage(KEY, "e1", { ...message("r1"), text: "edited" }),
      ).rejects.toThrow(PROMPT_QUEUE_MESSAGE_FROZEN);
      await storage.requeuePromptQueueMessage(KEY, "e1", message("r1"));
      expect((await storage.getPromptQueue(KEY))?.messages).toEqual([message("r1")]);
      // Reordering stays allowed; it does not change the frozen body.
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "user-1", text: "mine" });
      await storage.movePromptQueueMessage(KEY, "e1", "r1", "down");
      expect(
        (await storage.getPromptQueue(KEY))?.messages.map((item) => (item as { id: string }).id),
      ).toEqual(["user-1", "r1"]);
    });
  });

  test("turn outcomes are recorded once per dispatched request", async () => {
    await withStorage(async (storage) => {
      await createSession(storage);
      const outcome = {
        requestId: "r1",
        outcome: "failed" as const,
        error: "x".repeat(900),
        observedAt: new Date(0).toISOString(),
      };
      // Not dispatched yet: nothing to attach it to.
      expect(await storage.recordNativeAgentTurnOutcome(SESSION_KEY, "provider-1", outcome)).toBe(
        false,
      );
      await storage.dispatchNativeAgentPromptOnce(SESSION_KEY, "r1", async () => undefined);
      expect(
        await storage.recordNativeAgentTurnOutcome(SESSION_KEY, "provider-other", outcome),
      ).toBe(false);
      expect(await storage.recordNativeAgentTurnOutcome(SESSION_KEY, "provider-1", outcome)).toBe(
        true,
      );
      expect(
        await storage.recordNativeAgentTurnOutcome(SESSION_KEY, "provider-1", {
          ...outcome,
          outcome: "completed",
        }),
      ).toBe(false);
      const session = await storage.getNativeAgentSession(SESSION_KEY);
      expect(session?.turnOutcomes).toEqual([
        {
          requestId: "r1",
          outcome: "failed",
          error: "x".repeat(500),
          observedAt: outcome.observedAt,
        },
      ]);
    });
  });
});
