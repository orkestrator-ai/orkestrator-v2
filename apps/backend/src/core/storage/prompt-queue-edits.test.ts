import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROMPT_QUEUE_EDIT_LEASE_MS,
  promptQueueHeadHeldByEdit,
} from "@orkestrator/protocol/prompt-queue-edit";
import { nativeQueueObligation } from "../native-agent/queue-scheduling.js";
import { StorageService } from "./service.js";

const dataDirs: string[] = [];
const QUEUE = "codex\0tab-1";
const ENVIRONMENT = "environment-1";

async function createStorage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-prompt-edits-"));
  dataDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: ENVIRONMENT,
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

/** Three queued prompts, the second carrying settings and an attachment. */
async function seedThree(storage: StorageService) {
  await storage.savePromptQueue(QUEUE, ENVIRONMENT, [
    { id: "first", text: "one" },
    {
      id: "second",
      text: "two",
      model: "gpt-5",
      mode: "plan",
      attachments: [
        { type: "file", path: "/workspace/a.txt", filename: "a.txt" },
        { type: "image", path: "/workspace/b.png", filename: "b.png" },
      ],
    },
    { id: "third", text: "three" },
  ]);
}

function target(messageId: string) {
  return { queueKey: QUEUE, environmentId: ENVIRONMENT, messageId };
}

function ids(queue: { messages: unknown[] } | null | undefined): unknown[] {
  return (queue?.messages ?? []).map((message) => (message as { id: unknown }).id);
}

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => fs.rm(dataDir, { recursive: true, force: true })),
  );
});

describe("editing a queued prompt in place", () => {
  test("commits text and attachments together, keeping identity, position and settings", async () => {
    const storage = await createStorage();
    await seedThree(storage);

    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    expect(begun.status).toBe("editing");
    if (begun.status !== "editing") throw new Error("unreachable");
    expect(begun.message).toMatchObject({ id: "second", text: "two" });
    expect(begun.queue.editLeases).toHaveLength(1);

    const finished = await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: begun.lease.leaseId },
      {
        outcome: "commit",
        text: "two, edited",
        attachments: [{ type: "file", path: "/workspace/a.txt", filename: "a.txt" }],
      },
    );
    expect(finished.status).toBe("committed");

    const queue = await storage.getPromptQueue(QUEUE);
    expect(ids(queue)).toEqual(["first", "second", "third"]);
    expect(queue?.messages[1]).toEqual({
      id: "second",
      text: "two, edited",
      model: "gpt-5",
      mode: "plan",
      attachments: [{ type: "file", path: "/workspace/a.txt", filename: "a.txt" }],
    });
    expect(queue?.editLeases).toBeUndefined();
  });

  test("removing every attachment drops the field", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: begun.lease.leaseId },
      { outcome: "commit", text: "plain" },
    );
    const edited = (await storage.getPromptQueue(QUEUE))?.messages[1] as Record<string, unknown>;
    expect(edited.text).toBe("plain");
    expect("attachments" in edited).toBe(false);
  });

  test("an edited head is held, and the prompts behind it wait rather than overtake it", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    if (begun.status !== "editing") throw new Error("expected a lease");

    const held = await storage.getPromptQueue(QUEUE);
    expect(promptQueueHeadHeldByEdit(held)).toBe(true);
    expect(nativeQueueObligation(held)).toBeNull();
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
    expect(ids(await storage.getPromptQueue(QUEUE))).toEqual(["first", "second", "third"]);

    await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("first"), leaseId: begun.lease.leaseId },
      { outcome: "cancel" },
    );
    const released = await storage.getPromptQueue(QUEUE);
    expect(nativeQueueObligation(released)).toBe("pending");
    const reservation = await storage.reservePromptQueueHeadForDispatch(QUEUE);
    expect(reservation?.message).toMatchObject({ id: "first", text: "one" });
  });

  test("an edit behind the head does not hold the head", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    const first = await storage.reservePromptQueueHeadForDispatch(QUEUE);
    expect(first?.message).toMatchObject({ id: "first" });
    await storage.acknowledgePromptQueueDispatch(QUEUE, first!.requestId);
    // The edited prompt is the head now, so delivery stops at it.
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
    expect(ids(await storage.getPromptQueue(QUEUE))).toEqual(["second", "third"]);
  });

  test("the lease follows its item when the queue is reordered", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    await storage.movePromptQueueMessage(QUEUE, ENVIRONMENT, "second", "up");
    const moved = await storage.getPromptQueue(QUEUE);
    expect(ids(moved)).toEqual(["second", "first", "third"]);
    expect(moved?.editLeases?.[0]?.messageId).toBe("second");
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
  });

  test("a second client is refused while the lease is live, and may take it over", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const phone = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (phone.status !== "editing") throw new Error("expected a lease");

    const desktop = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    expect(desktop).toMatchObject({
      status: "refused",
      reason: "held-elsewhere",
      expiresAt: phone.lease.expiresAt,
    });

    const takeover = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"), {
      takeOver: true,
    });
    expect(takeover).toMatchObject({ status: "editing", tookOver: true });

    // The phone's lease is gone: its commit conflicts and changes nothing.
    const late = await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: phone.lease.leaseId },
      { outcome: "commit", text: "phone text" },
    );
    expect(late).toMatchObject({
      status: "conflict",
      reason: "lease-lost",
      current: { id: "second", text: "two" },
    });
    expect(
      await storage.promptQueueEdits.renewPromptQueueMessageEdit({
        ...target("second"),
        leaseId: phone.lease.leaseId,
      }),
    ).toEqual({ status: "conflict", reason: "lease-lost" });
    // Nor can a stale cancel release the new holder's lease.
    await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: phone.lease.leaseId },
      { outcome: "cancel" },
    );
    expect((await storage.getPromptQueue(QUEUE))?.editLeases).toHaveLength(1);
  });

  test("an expired lease still holds the item until someone reviews it", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const past = Date.now() - PROMPT_QUEUE_EDIT_LEASE_MS - 1_000;
    const stale = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"), {
      now: past,
    });
    if (stale.status !== "editing") throw new Error("expected a lease");
    expect(Date.parse(stale.lease.expiresAt)).toBeLessThan(Date.now());

    // Expiry never releases it: delivery stays held.
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();

    // Anyone may take an expired edit over without forcing it.
    const review = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    expect(review).toMatchObject({ status: "editing", tookOver: true });
  });

  test("an expired lease nobody took over can still be renewed and committed", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"), {
      now: Date.now() - PROMPT_QUEUE_EDIT_LEASE_MS - 1_000,
    });
    if (begun.status !== "editing") throw new Error("expected a lease");
    const renewed = await storage.promptQueueEdits.renewPromptQueueMessageEdit({
      ...target("second"),
      leaseId: begun.lease.leaseId,
    });
    expect(renewed.status).toBe("renewed");
    if (renewed.status !== "renewed") throw new Error("unreachable");
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
    const finished = await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: begun.lease.leaseId },
      { outcome: "commit", text: "late but mine" },
    );
    expect(finished.status).toBe("committed");
  });

  test("release requires the observed lease to still own the row and be expired", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const now = Date.now();
    const expired = now - PROMPT_QUEUE_EDIT_LEASE_MS - 1;
    const original = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"), {
      now: expired,
    });
    if (original.status !== "editing") throw new Error("expected a lease");
    const observed = { ...target("first"), leaseId: original.lease.leaseId };
    const release = (leaseId: string, at: number) =>
      storage.promptQueueEdits.finishPromptQueueMessageEdit(
        { ...target("first"), leaseId },
        { outcome: "release-expired" },
        { now: at },
      );

    await storage.promptQueueEdits.renewPromptQueueMessageEdit(observed, { now });
    expect(await release(observed.leaseId, now)).toMatchObject({ status: "conflict" });
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();

    const replacement = await storage.promptQueueEdits.beginPromptQueueMessageEdit(
      target("first"),
      { takeOver: true, now },
    );
    if (replacement.status !== "editing") throw new Error("expected a replacement");
    const deadline = now + PROMPT_QUEUE_EDIT_LEASE_MS;
    expect(await release(observed.leaseId, deadline)).toMatchObject({ status: "conflict" });
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
    expect(await release(replacement.lease.leaseId, deadline)).toMatchObject({
      status: "released",
    });
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toMatchObject({
      message: { id: "first", text: "one" },
    });
  });

  test("a prompt removed during the edit answers a conflict", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    const removal = await storage.removePromptQueueMessage(QUEUE, ENVIRONMENT, "second");
    expect(removal.queue?.editLeases).toBeUndefined();
    const finished = await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: begun.lease.leaseId },
      { outcome: "commit", text: "too late" },
    );
    expect(finished).toMatchObject({ status: "conflict", reason: "missing" });
    expect(ids(await storage.getPromptQueue(QUEUE))).toEqual(["first", "third"]);
  });

  test("a prompt rewritten under the lease answers a conflict and keeps the lease", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    const queue = await storage.getPromptQueue(QUEUE);
    // An older client's whole-list save.
    await storage.savePromptQueue(
      QUEUE,
      ENVIRONMENT,
      queue!.messages.map((message) =>
        (message as { id: string }).id === "second" ? { id: "second", text: "rewritten" } : message,
      ),
    );
    const finished = await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("second"), leaseId: begun.lease.leaseId },
      { outcome: "commit", text: "mine" },
    );
    expect(finished).toMatchObject({
      status: "conflict",
      reason: "changed",
      current: { id: "second", text: "rewritten" },
    });
    const after = await storage.getPromptQueue(QUEUE);
    expect(after?.messages[1]).toEqual({ id: "second", text: "rewritten" });
    expect(after?.editLeases?.[0]?.leaseId).toBe(begun.lease.leaseId);
    await storage.movePromptQueueMessage(QUEUE, ENVIRONMENT, "second", "up");
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
    expect(
      await storage.promptQueueEdits.finishPromptQueueMessageEdit(
        { ...target("second"), leaseId: begun.lease.leaseId },
        { outcome: "cancel" },
      ),
    ).toMatchObject({ status: "released" });
    expect(await storage.reservePromptQueueHeadForDispatch(QUEUE)).toMatchObject({
      message: { id: "second", text: "rewritten" },
    });
  });

  test("a job and its coalesced resend keep their original payload binding", async () => {
    const storage = await createStorage();
    const job = { id: "message", requestId: "job", text: "original job" };
    const receipt = {
      requestId: "job",
      fingerprint: "a".repeat(64),
      status: "accepted",
      queued: true,
    } as const;
    await storage.reserveNativeAgentJobRequest(QUEUE, ENVIRONMENT, receipt, job, true);
    expect(
      await storage.promptQueueEdits.beginPromptQueueMessageEdit(target(job.id)),
    ).toMatchObject({ status: "refused", reason: "frozen" });
    const resend = await storage.reserveNativeAgentJobRequest(
      QUEUE,
      ENVIRONMENT,
      { ...receipt, requestId: "resend" },
      { ...job, id: "resend", requestId: "resend" },
      true,
    );
    expect(resend.dispatchRequestId).toBe("job");
    expect((await storage.getPromptQueue(QUEUE))?.messages).toEqual([job]);
  });

  test("a coalesced job freezes its target, while a live edit cannot acquire a new job alias", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const receipt = {
      requestId: "job",
      fingerprint: "a".repeat(64),
      status: "accepted",
      queued: true,
    } as const;
    const alias = await storage.reserveNativeAgentJobRequest(
      QUEUE,
      ENVIRONMENT,
      receipt,
      { id: "job", text: "one" },
      true,
    );
    expect(alias.dispatchRequestId).toBe("first");
    expect(
      await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first")),
    ).toMatchObject({
      status: "refused",
      reason: "frozen",
    });

    const edit = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("second"));
    if (edit.status !== "editing") throw new Error("expected a lease");
    const otherJob = { id: "other-job", text: "two" };
    const otherReceipt = await storage.reserveNativeAgentJobRequest(
      QUEUE,
      ENVIRONMENT,
      { ...receipt, requestId: otherJob.id, fingerprint: "b".repeat(64) },
      otherJob,
      true,
    );
    expect(otherReceipt.dispatchRequestId).toBeUndefined();
    expect(
      await storage.promptQueueEdits.finishPromptQueueMessageEdit(
        { ...target("second"), leaseId: edit.lease.leaseId },
        { outcome: "commit", text: "edited second" },
      ),
    ).toMatchObject({ status: "committed" });
    expect((await storage.getPromptQueue(QUEUE))?.messages.at(-1)).toEqual(otherJob);
  });

  test("backend-authored items and slash commands are not edited in place", async () => {
    const storage = await createStorage();
    await storage.savePromptQueue(QUEUE, ENVIRONMENT, [
      { id: "goal", text: "continue", origin: { kind: "goal", goalId: "g", iteration: 1 } },
      { id: "command", text: "/compact", command: { name: "compact" } },
      { id: "plain", text: "hello" },
    ]);
    for (const messageId of ["goal", "command"]) {
      expect(
        await storage.promptQueueEdits.beginPromptQueueMessageEdit(target(messageId)),
      ).toMatchObject({ status: "refused", reason: "frozen" });
    }
    expect(
      await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("missing")),
    ).toMatchObject({ status: "refused", reason: "missing" });
  });

  test("a commit is refused before anything is written when it has nothing to send", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    const lease = { ...target("first"), leaseId: begun.lease.leaseId };
    await expect(
      storage.promptQueueEdits.finishPromptQueueMessageEdit(lease, {
        outcome: "commit",
        text: "   ",
      }),
    ).rejects.toThrow("needs text or an attachment");
    await expect(
      storage.promptQueueEdits.finishPromptQueueMessageEdit(lease, {
        outcome: "commit",
        text: "x",
        attachments: [{ type: "file" }],
      }),
    ).rejects.toThrow("attachment path");
    expect((await storage.getPromptQueue(QUEUE))?.editLeases).toHaveLength(1);
  });

  test("editing a rejected head clears its latch only when the text changes", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const reservation = await storage.reservePromptQueueHeadForDispatch(QUEUE);
    await storage.failPromptQueueDispatch(QUEUE, reservation!.requestId, "rejected");

    const cancelled = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    if (cancelled.status !== "editing") throw new Error("expected a lease");
    await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("first"), leaseId: cancelled.lease.leaseId },
      { outcome: "cancel" },
    );
    expect((await storage.getPromptQueue(QUEUE))?.dispatchError?.message).toBe("rejected");

    const edited = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    if (edited.status !== "editing") throw new Error("expected a lease");
    await storage.promptQueueEdits.finishPromptQueueMessageEdit(
      { ...target("first"), leaseId: edited.lease.leaseId },
      { outcome: "commit", text: "one, fixed" },
    );
    const after = await storage.getPromptQueue(QUEUE);
    expect(after?.dispatchError).toBeUndefined();
    expect(ids(after)).toEqual(["first", "second", "third"]);
  });

  test("leases survive a restart", async () => {
    const storage = await createStorage();
    await seedThree(storage);
    const begun = await storage.promptQueueEdits.beginPromptQueueMessageEdit(target("first"));
    if (begun.status !== "editing") throw new Error("expected a lease");
    const reloaded = new StorageService(storage.getDataDir());
    await reloaded.init();
    expect(await reloaded.reservePromptQueueHeadForDispatch(QUEUE)).toBeNull();
    expect((await reloaded.getPromptQueue(QUEUE))?.editLeases?.[0]).toEqual(begun.lease);
  });
});
