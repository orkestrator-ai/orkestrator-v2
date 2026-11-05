import { describe, expect, test } from "bun:test";
import {
  readStoredValue,
  seedStore,
  storageDatabase,
  storageInternals,
  withTemporaryStorage,
} from "./storage-test-support.js";
import type { StorageService } from "./storage.js";

/** Counts lease rows this connection writes: each is an fsynced commit. */
function countLeaseWrites(storage: StorageService): () => number {
  const { db } = storageDatabase(storage);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS lease_writes (name TEXT)");
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS lease_write_${event} AFTER ${event} ON main.leases
      BEGIN INSERT INTO lease_writes VALUES ('write'); END`);
  }
  return () =>
    (db.query("SELECT count(*) AS count FROM lease_writes").get() as { count: number }).count;
}

function mailStore(pending: Array<Record<string, unknown>> = []) {
  return {
    version: 1,
    revision: 0,
    mailboxes: {
      "mailbox-1": {
        mailboxId: "mailbox-1",
        messages: [
          { id: "message-1", placement: "pending-inject", body: "text" },
          { id: "message-2", placement: "delivered", body: "text" },
        ],
      },
      "mailbox-2": {
        mailboxId: "mailbox-2",
        messages: [{ id: "message-3", placement: "pending-inject", body: "text" }],
      },
    },
    idempotency: {},
    pendingInject: pending,
    counterparts: {},
  };
}

interface StoredMail {
  pendingInject: Array<{
    mailboxId: string;
    messageId: string;
    nextAttemptAt?: string;
    attempts?: number;
  }>;
}

describe("agent mail backoff reset", () => {
  test("nothing to reset acquires the lease but does not rewrite the store", async () => {
    await withTemporaryStorage(async (storage) => {
      seedStore(
        storage.getDataDir(),
        "agent-mail.json",
        mailStore([
          { mailboxId: "mailbox-1", messageId: "message-1" },
          {
            mailboxId: "mailbox-2",
            messageId: "message-3",
            nextAttemptAt: "2026-11-04T00:00:00.000Z",
            attempts: 2,
          },
        ]),
      );
      const leaseWrites = countLeaseWrites(storage);
      const revision = storageDatabase(storage).storeRevision("agent-mail");

      // Mailbox 1 has an entry with no backoff; mailbox 3 has none at all.
      await storage.resetAgentMailInjectBackoff("mailbox-1");
      await storage.resetAgentMailInjectBackoff("mailbox-3");

      expect(leaseWrites()).toBeGreaterThan(0);
      expect(storageDatabase(storage).storeRevision("agent-mail")).toBe(revision);
    });
  });

  test("reset waits behind a queued backoff writer", async () => {
    await withTemporaryStorage(async (storage) => {
      seedStore(storage.getDataDir(), "agent-mail.json", mailStore());
      const { repos } = storageInternals(storage);
      // Use the shared store queue used by all mail writers.
      const store = (
        repos.agentMailInjects as unknown as {
          store: {
            enqueue<T>(run: () => Promise<T>): Promise<T>;
          };
        }
      ).store;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = store.enqueue(async () => {
        entered();
        await gate;
        seedStore(
          storage.getDataDir(),
          "agent-mail.json",
          mailStore([
            {
              mailboxId: "mailbox-1",
              messageId: "message-1",
              nextAttemptAt: "2026-11-04T00:00:00.000Z",
              attempts: 3,
            },
          ]),
        );
      });
      await started;
      const reset = storage.resetAgentMailInjectBackoff("mailbox-1");
      release();
      await writer;
      await reset;
      expect(
        readStoredValue<StoredMail>(storage.getDataDir(), "agent-mail.json")!.pendingInject[0],
      ).toMatchObject({ attempts: 0 });
      expect(
        readStoredValue<StoredMail>(storage.getDataDir(), "agent-mail.json")!.pendingInject[0]
          ?.nextAttemptAt,
      ).toBeUndefined();
    });
  });

  test("a matching entry is cleared under the lease and the others are left", async () => {
    await withTemporaryStorage(async (storage) => {
      const later = "2026-11-04T00:00:00.000Z";
      seedStore(
        storage.getDataDir(),
        "agent-mail.json",
        mailStore([
          { mailboxId: "mailbox-1", messageId: "message-1", nextAttemptAt: later, attempts: 3 },
          { mailboxId: "mailbox-2", messageId: "message-3", nextAttemptAt: later, attempts: 2 },
        ]),
      );
      const leaseWrites = countLeaseWrites(storage);

      await storage.resetAgentMailInjectBackoff("mailbox-1");

      expect(leaseWrites()).toBeGreaterThan(0);
      const stored = readStoredValue<StoredMail>(storage.getDataDir(), "agent-mail.json")!;
      const entry = (mailboxId: string) =>
        stored.pendingInject.find((candidate) => candidate.mailboxId === mailboxId);
      expect(entry("mailbox-1")?.nextAttemptAt).toBeUndefined();
      expect(entry("mailbox-1")?.attempts).toBe(0);
      expect(entry("mailbox-2")).toMatchObject({ nextAttemptAt: later, attempts: 2 });
    });
  });

  test("a backoff another backend committed is seen by the next reset", async () => {
    await withTemporaryStorage(async (storage) => {
      seedStore(storage.getDataDir(), "agent-mail.json", mailStore());
      await storage.resetAgentMailInjectBackoff("mailbox-1");
      // The read model is current; a foreign commit moves the store's revision.
      seedStore(
        storage.getDataDir(),
        "agent-mail.json",
        mailStore([
          {
            mailboxId: "mailbox-1",
            messageId: "message-1",
            nextAttemptAt: "2026-11-04T00:00:00.000Z",
            attempts: 1,
          },
        ]),
      );

      await storage.resetAgentMailInjectBackoff("mailbox-1");

      const stored = readStoredValue<StoredMail>(storage.getDataDir(), "agent-mail.json")!;
      expect(
        stored.pendingInject.find((entry) => entry.mailboxId === "mailbox-1")?.nextAttemptAt,
      ).toBeUndefined();
    });
  });
});
