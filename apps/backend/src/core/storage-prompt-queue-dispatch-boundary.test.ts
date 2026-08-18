import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

const dataDirs: string[] = [];

async function createStorage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-prompt-boundary-"));
  dataDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "environment-1",
    projectId: "project-1",
    name: "Environment",
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
  return storage;
}

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => fs.rm(dataDir, { recursive: true, force: true })),
  );
});

describe("prompt queue dispatch boundary", () => {
  test("persists submitting and submitted fences idempotently", async () => {
    const storage = await createStorage();
    await storage.savePromptQueue("queue-1", "environment-1", [{ id: "message-1" }]);
    const reservation = await storage.reservePromptQueueHeadForDispatch("queue-1");
    expect(reservation).not.toBeNull();

    const submitting = await storage.markPromptQueueDispatchSubmitting(
      "queue-1",
      reservation!.requestId,
    );
    expect(submitting?.inFlight?.submittingAt).toBeString();
    expect(submitting?.inFlight?.submittedAt).toBeUndefined();
    const sameSubmitting = await storage.markPromptQueueDispatchSubmitting(
      "queue-1",
      reservation!.requestId,
    );
    expect(sameSubmitting?.revision).toBe(submitting?.revision);

    const submitted = await storage.markPromptQueueDispatchSubmitted(
      "queue-1",
      reservation!.requestId,
    );
    expect(submitted?.inFlight?.submittedAt).toBeString();
    expect(Date.parse(submitted!.inFlight!.submittedAt!)).toBeGreaterThanOrEqual(
      Date.parse(submitted!.inFlight!.submittingAt!),
    );
    const reloaded = new StorageService(storage.getDataDir());
    await reloaded.init();
    expect((await reloaded.getPromptQueue("queue-1"))?.inFlight).toMatchObject({
      requestId: reservation!.requestId,
      submittingAt: submitted!.inFlight!.submittingAt,
      submittedAt: submitted!.inFlight!.submittedAt,
    });
  });

  test("requires the pre-submit fence and ignores stale request ids", async () => {
    const storage = await createStorage();
    await storage.savePromptQueue("queue-1", "environment-1", [{ id: "message-1" }]);
    const reservation = await storage.reservePromptQueueHeadForDispatch("queue-1");

    await expect(
      storage.markPromptQueueDispatchSubmitted("queue-1", reservation!.requestId),
    ).rejects.toThrow("not fenced");
    const before = await storage.getPromptQueue("queue-1");
    const stale = await storage.markPromptQueueDispatchSubmitting("queue-1", "stale-id");
    expect(stale).toEqual(before);
    expect(stale?.inFlight?.submittingAt).toBeUndefined();
  });

  test("rejects persisted submitted state without an ordered submitting fence", async () => {
    const storage = await createStorage();
    await storage.savePromptQueue("queue-1", "environment-1", [{ id: "message-1" }]);
    await storage.reservePromptQueueHeadForDispatch("queue-1");
    const queue = await storage.getPromptQueue("queue-1");
    const file = path.join(storage.getDataDir(), "prompt-queues.json");

    await fs.writeFile(
      file,
      JSON.stringify({
        "queue-1": {
          ...queue,
          inFlight: {
            ...queue!.inFlight,
            submittedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    await expect(storage.getPromptQueue("queue-1")).resolves.toBeNull();

    await fs.writeFile(
      file,
      JSON.stringify({
        "queue-1": {
          ...queue,
          inFlight: {
            ...queue!.inFlight,
            submittingAt: "2026-01-02T00:00:00.000Z",
            submittedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    await expect(storage.getPromptQueue("queue-1")).resolves.toBeNull();
  });

  test("rejects a tmux queue whose key routes to another environment", async () => {
    const storage = await createStorage();
    const queueKey = "claude-tmux\0env:environment-1:tab:tab-1";

    await expect(
      storage.savePromptQueue(queueKey, "environment-2", [{ id: "message-1" }]),
    ).rejects.toThrow("does not match its environment owner");
    await expect(
      storage.enqueuePromptQueueMessage(queueKey, "environment-2", { id: "message-1" }),
    ).rejects.toThrow("does not match its environment owner");
    await expect(
      storage.requeuePromptQueueMessage(queueKey, "environment-2", { id: "message-1" }),
    ).rejects.toThrow("does not match its environment owner");
    await expect(
      storage.claimPromptQueueHead(queueKey, "environment-2", "message-1"),
    ).rejects.toThrow("does not match its environment owner");
  });
});
