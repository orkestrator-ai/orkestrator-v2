import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture } from "./agent-mail-storage-test-support.js";
import type { PersistedAgentMailStore } from "./storage-agent-mail-store.js";
import { planEnvironmentMailDeletion } from "./storage-agent-mail-deletion.js";
import { readStoredValue, storageDatabase, storageInternals } from "./storage-test-support.js";
import { StorageService } from "./storage.js";

/**
 * Deleting an environment's agent mail commits only the rows it changes, from
 * the shared read model, instead of cloning and rewriting the whole store
 * (todo 6120 task 6). The deletion's meaning is covered with the rest of agent
 * mail in `storage-agent-mail.test.ts`.
 */

const STORE = "agent-mail";
const FILE = "agent-mail.json";

/** Mail to and from `e1`, and mail to `e3` that the delete must not touch. */
async function seedMail(storage: StorageService): Promise<void> {
  const tab = (environmentId: string, projectId: string) =>
    ({ kind: "tab", environmentId, projectId, tabId: "agent" }) as const;
  await storage.sendAgentMail(tab("e1", "p1"), {
    requestId: "e1-to-e2",
    toEnvironmentId: "e2",
    toTabId: "agent",
    body: "from the deleted environment",
  });
  await storage.sendAgentMail(tab("e2", "p1"), {
    requestId: "e2-to-e1",
    toEnvironmentId: "e1",
    toTabId: "agent",
    body: "to the deleted environment",
  });
  await storage.sendAgentMail(
    { kind: "user" },
    { requestId: "user-to-e3", toEnvironmentId: "e3", toTabId: "agent", body: "unrelated" },
  );
}

/** `collection/key` of every store row written while `run` runs. */
async function rowWrites(storage: StorageService, run: () => Promise<void>): Promise<string[]> {
  const db = storageDatabase(storage).db;
  db.exec("CREATE TEMP TABLE IF NOT EXISTS mail_row_writes (row TEXT NOT NULL)");
  db.exec("DELETE FROM mail_row_writes");
  for (const [event, row] of [
    ["INSERT", "new"],
    ["UPDATE", "new"],
    ["DELETE", "old"],
  ] as const) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS mail_row_write_${event}
      AFTER ${event} ON main.store_rows WHEN ${row}.store = '${STORE}'
      BEGIN INSERT INTO mail_row_writes VALUES ('${event} ' || ${row}.collection || '/' || ${row}.key); END`);
  }
  await run();
  return (db.query("SELECT row FROM mail_row_writes").all() as Array<{ row: string }>)
    .map(({ row }) => row.replaceAll("\0", "|"))
    .sort();
}

describe("deleting an environment's agent mail", () => {
  test("commits only the rows it changes, without a whole-store save", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await seedMail(storage);
      const before = readStoredValue<PersistedAgentMailStore>(dataDir, FILE)!;
      const inbound = before.mailboxes["e1\0agent"]!.messages.map((message) => message.id);
      const idempotency = Object.keys(before.idempotency).filter((key) =>
        before.idempotency[key]!.senderScope.startsWith("tab:e1\0"),
      );
      expect(inbound).toHaveLength(1);
      expect(idempotency).toHaveLength(1);
      const { context } = storageInternals(storage);
      const wholeSaves = spyOn(context, "saveSensitiveJson");
      try {
        const written = await rowWrites(storage, () => storage.deleteAgentMailByEnvironment("e1"));
        expect(written).toEqual(
          [
            "DELETE mailboxes/e1|agent",
            "UPDATE mailboxes/e2|agent",
            ...idempotency.map((key) => `DELETE idempotency/${key.replaceAll("\0", "|")}`),
            ...inbound.map((id) => `INSERT counterparts/${id}`),
          ].sort(),
        );
        expect(wholeSaves.mock.calls.filter(([file]) => file.endsWith(FILE))).toEqual([]);
      } finally {
        wholeSaves.mockRestore();
      }

      const after = readStoredValue<PersistedAgentMailStore>(dataDir, FILE)!;
      expect(after.revision).toBe(before.revision + 1);
      expect(after.mailboxes["e3\0agent"]).toEqual(before.mailboxes["e3\0agent"]);
      expect(after.mailboxes["e1\0agent"]).toBeUndefined();
      expect(after.counterparts[inbound[0]!]).toMatchObject({
        placement: "undeliverable",
        placementReason: "recipient-deleted",
      });
      expect(after.mailboxes["e2\0agent"]!.messages[0]).toMatchObject({
        body: "",
        placement: "expired",
        placementReason: "sender-deleted",
      });
      // A repeat (a retried delete) finds no mailbox, idempotency record or
      // counterpart left to write; as before this change, it marks the sender's
      // already-expired message again.
      expect(await rowWrites(storage, () => storage.deleteAgentMailByEnvironment("e1"))).toEqual([
        "UPDATE mailboxes/e2|agent",
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("the whole-value fallback leaves the same store as the row write", async () => {
    const { storage, dataDir } = await fixture();
    const copy = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-copy-"));
    try {
      await seedMail(storage);
      await storage.close();
      await fs.cp(dataDir, copy, { recursive: true });
      const rows = new StorageService(dataDir);
      const whole = new StorageService(copy);
      await rows.init();
      await whole.init();
      const fallback = spyOn(storageInternals(whole).context, "updateStoreRows");
      fallback.mockReturnValue(false);
      try {
        await rows.deleteAgentMailByEnvironment("e1");
        await whole.deleteAgentMailByEnvironment("e1");
        expect(fallback).toHaveBeenCalled();
      } finally {
        fallback.mockRestore();
      }
      expect(readStoredValue(copy, FILE)).toEqual(readStoredValue(dataDir, FILE));
      await rows.close();
      await whole.close();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(copy, { recursive: true, force: true });
    }
  });

  test("inside an atomic scope the store is saved whole, in the scope's commit", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await seedMail(storage);
      const { context } = storageInternals(storage);
      expect(
        context.updateStoreRows(path.join(dataDir, FILE), [], { document: () => undefined }),
      ).toBe(true);
      await context.atomically(async () => {
        expect(context.updateStoreRows(path.join(dataDir, FILE), [])).toBe(false);
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("plans nothing for an environment with no mail, and never changes its input", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await seedMail(storage);
      const store = readStoredValue<PersistedAgentMailStore>(dataDir, FILE)!;
      store.pendingInject ??= [];
      const held = JSON.stringify(store);
      expect(planEnvironmentMailDeletion(store, "e-absent")).toBeNull();
      const plan = planEnvironmentMailDeletion(store, "e1")!;
      expect(plan.revision).toBe(store.revision + 1);
      expect([...plan.changedMailboxes]).toEqual([
        ["e1\0agent", "p1"],
        ["e2\0agent", "p1"],
      ]);
      expect(JSON.stringify(store)).toBe(held);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
