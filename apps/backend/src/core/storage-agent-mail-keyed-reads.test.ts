import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentMailboxId } from "@orkestrator/protocol/agent-mail";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  findMessage,
  metadataMessage,
  type AgentMailStore,
  type PersistedAgentMailStore,
} from "./storage-agent-mail-store.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import { readStoredValue, seedStore, storageInternals } from "./storage-test-support.js";
import { StorageService } from "./storage.js";

/**
 * Keyed agent mail reads: a mailbox's inbox, its environment's identity and
 * directory, and a message's status read the rows they name, not the whole
 * store, and acknowledge, seen and discard commit the one mailbox row they
 * change. Each must answer exactly what the whole-store read would.
 */

// `e1` is a prefix of `e10`: an environment's key range must not include it.
const ENVIRONMENTS = ["e1", "e10", "e2", "e3"] as const;

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-keyed-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "p1",
    name: "p1",
    gitUrl: "https://example.invalid/p1.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (const environmentId of ENVIRONMENTS) {
    await storage.addEnvironment({
      id: environmentId,
      projectId: "p1",
      name: environmentId,
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
      setupPhase: "ready",
      setupScriptsComplete: true,
    });
    await storage.savePaneLayout(
      environmentId,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: ["agent", "review"].map((tabId) => ({
            id: tabId,
            type: "agent-native" as const,
            displayTitle: `${environmentId} ${tabId}`,
            nativeAgentData: { environmentId, platform: "claude" as const },
          })),
          activeTabId: "agent",
        },
      },
      0,
    );
  }
  await storage.synchronizeAgentMailboxes();
  const mailStore = (
    storageInternals(storage).repos.agentMail as unknown as { store: AgentMailStore }
  ).store;
  let sequence = 0;
  const send = (from: string, to: string, toTabId = "agent") =>
    storage.sendAgentMail(
      { kind: "tab", environmentId: from, projectId: "p1", tabId: "agent" },
      {
        requestId: `request-${(sequence += 1)}`,
        toEnvironmentId: to,
        toTabId,
        body: `Message ${sequence}`,
      },
    );
  const dispose = async () => {
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  return { dataDir, storage, mailStore, send, dispose };
}

async function withWorld(run: (world: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const world = await fixture();
  try {
    await run(world);
  } finally {
    await world.dispose();
  }
}

const mailbox = (store: PersistedAgentMailStore, environmentId: string, tabId = "agent") =>
  store.mailboxes[agentMailboxId(environmentId, tabId)]!;

/** Runs `operation` and fails if it read the whole store (snapshot or load). */
async function withoutWholeStore<T>(mailStore: AgentMailStore, operation: () => Promise<T>) {
  const snapshot = spyOn(mailStore, "snapshot");
  const load = spyOn(mailStore, "load");
  const save = spyOn(mailStore, "save");
  try {
    const result = await operation();
    expect(snapshot).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    return result;
  } finally {
    snapshot.mockRestore();
    load.mockRestore();
    save.mockRestore();
  }
}

describe("keyed agent mail reads", () => {
  test("inbox, identity and directory reads after a write parse only their environment", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      await send("e2", "e1");
      await send("e3", "e10");
      await mailStore.snapshot();
      // Another tab's send moves the revision, so a whole-store read would rebuild.
      await send("e3", "e2");
      const parse = spyOn(JSON, "parse");
      try {
        await withoutWholeStore(mailStore, async () => {
          const inbox = await storage.getAgentMailMailbox("e1", "agent", { unreadOnly: true });
          expect(inbox.total).toBe(1);
          expect(await storage.listAgentMailPullTabIds("e1")).toEqual(["agent", "review"]);
          expect(await storage.listAgentMailPullTabIds("e10")).toEqual(["agent", "review"]);
          expect(await storage.resolveUniqueAgentMailPullTabId("e1")).toBeNull();
          const directory = await storage.listAgentMailboxes({
            environmentId: "e1",
            currentEnvironmentId: "e1",
          });
          expect(directory.mailboxes.map((entry) => entry.mailboxId)).toEqual([
            agentMailboxId("e1", "agent"),
            agentMailboxId("e1", "review"),
          ]);
          expect(await storage.hasUndeliveredCoordinatorRequest("e1", "agent")).toBe(false);
        });
        // The rows other environments hold, and the one the send changed, stay unread.
        expect(
          parse.mock.calls.some(
            ([value]) =>
              typeof value === "string" &&
              (value.includes('"environmentId":"e2"') || value.includes('"environmentId":"e3"')),
          ),
        ).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  });

  test("answer what the whole-store reads answer", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      const first = await send("e2", "e1");
      await send("e3", "e1", "review");
      await send("e1", "e10");
      await storage.ackAgentMail("e1", "agent", first.id);
      const whole = await mailStore.snapshot();
      for (const environmentId of ENVIRONMENTS) {
        expect(await mailStore.environmentMailboxes(environmentId)).toEqual(
          Object.values(whole.mailboxes).filter(
            (candidate) => candidate.environmentId === environmentId,
          ),
        );
        for (const tabId of ["agent", "review"]) {
          const keyed = await mailStore.mailbox(agentMailboxId(environmentId, tabId));
          expect(keyed).toEqual(mailbox(whole, environmentId, tabId));
          expect(Object.isFrozen(keyed!.messages)).toBe(true);
        }
        const all = await storage.listAgentMailboxes({ currentEnvironmentId: environmentId });
        const own = await storage.listAgentMailboxes({
          environmentId,
          currentEnvironmentId: environmentId,
        });
        expect(own.mailboxes).toEqual(
          all.mailboxes.filter((entry) => entry.environmentId === environmentId),
        );
      }
      expect(await mailStore.mailbox(agentMailboxId("e4", "agent"))).toBeUndefined();
      expect(await mailStore.environmentMailboxes("e4")).toEqual([]);
      expect(await mailStore.environmentMailboxes("bad\0id")).toEqual([]);
      // The message a read returns is the caller's own copy.
      const message = await storage.getAgentMailMessage("e1", "agent", first.id);
      message.body = "changed";
      expect(mailbox(await mailStore.snapshot(), "e1").messages[0]!.body).not.toBe("changed");
    });
  });

  test("status finds sent, bounced and counterpart mail by key", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      const sent = await send("e1", "e2");
      await storage.updateAgentMailboxPolicy("e3", "agent", { mutedInbound: true });
      const bounced = await send("e1", "e3");
      expect(bounced.placement).toBe("bounced");
      const orphaned = await send("e1", "e10");
      const whole = await mailStore.snapshot();
      await storage.deleteAgentMailByEnvironment("e10");
      await withoutWholeStore(mailStore, async () => {
        expect(await storage.getAgentMailStatus(sent.id)).toEqual(
          metadataMessage(findMessage(whole, sent.id)!.message),
        );
        expect(await storage.getAgentMailStatus(bounced.id)).toEqual(metadataMessage(bounced));
        expect(await storage.getAgentMailStatus(orphaned.id)).toMatchObject({
          id: orphaned.id,
          placement: "undeliverable",
          placementReason: "recipient-deleted",
        });
      });
      // An unknown id is searched for in the whole store, then refused.
      await expect(storage.getAgentMailStatus("unknown")).rejects.toMatchObject({
        code: "message-not-found",
      });
    });
  });

  test("a process that has not seen a message finds it once, then by key", async () => {
    await withWorld(async ({ dataDir, send }) => {
      const sent = await send("e1", "e2");
      const fresh = new StorageService(dataDir);
      await fresh.init();
      try {
        const freshStore = (
          storageInternals(fresh).repos.agentMail as unknown as { store: AgentMailStore }
        ).store;
        const snapshot = spyOn(freshStore, "snapshot");
        try {
          expect((await fresh.getAgentMailStatus(sent.id)).id).toBe(sent.id);
          expect(snapshot).toHaveBeenCalledTimes(1);
          snapshot.mockClear();
          expect((await fresh.getAgentMailStatus(sent.id)).id).toBe(sent.id);
          expect(snapshot).not.toHaveBeenCalled();
        } finally {
          snapshot.mockRestore();
        }
      } finally {
        fresh.close();
      }
    });
  });

  test("a moved message's stale location falls back to the whole store", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      const sent = await send("e1", "e2");
      await storage.getAgentMailStatus(sent.id);
      // Move it to another mailbox behind the location's back.
      const value = await mailStore.load();
      const [message] = mailbox(value, "e2").messages.splice(0, 1);
      mailbox(value, "e3").messages.push(message!);
      mailbox(value, "e2").revision += 1;
      mailbox(value, "e3").revision += 1;
      await mailStore.save(value);
      expect((await storage.getAgentMailStatus(sent.id)).toEnvironmentId).toBe("e2");
      expect(findMessage(await mailStore.snapshot(), sent.id)!.mailbox.environmentId).toBe("e3");
    });
  });
});

describe("keyed agent mail mutations", () => {
  test("acknowledge, seen and discard commit only the recipient's mailbox row", async () => {
    await withWorld(async ({ dataDir, storage, mailStore, send }) => {
      const first = await send("e2", "e1");
      const second = await send("e3", "e1");
      const before = await mailStore.snapshot();
      const revision = before.revision;
      const acked = await withoutWholeStore(mailStore, () =>
        storage.ackAgentMail("e1", "agent", first.id),
      );
      expect(acked.ackedAt).toBeString();
      expect(acked.revision).toBe(2);
      await withoutWholeStore(mailStore, () => storage.markAgentMailSeen("e1", "agent", first.id));
      await withoutWholeStore(mailStore, () => storage.discardAgentMail("e1", "agent", second.id));
      // A repeated acknowledgement changes nothing and writes nothing.
      await withoutWholeStore(mailStore, () => storage.ackAgentMail("e1", "agent", first.id));
      const after = await mailStore.snapshot();
      expect(after.revision).toBe(revision + 3);
      expect(mailbox(after, "e1").revision).toBe(mailbox(before, "e1").revision + 3);
      expect(mailbox(after, "e1").messages.map((message) => message.id)).toEqual([
        first.id,
        second.id,
      ]);
      // Plain reads: an asymmetric matcher would be written into the shared snapshot.
      expect(mailbox(after, "e1").messages[0]!.ackedAt).toBe(acked.ackedAt!);
      expect(mailbox(after, "e1").messages[0]!.userSeenAt).toBeString();
      expect(mailbox(after, "e1").messages[1]!.discardedAt).toBeString();
      for (const unchanged of ["e2", "e3", "e10"]) {
        expect(mailbox(after, unchanged)).toBe(mailbox(before, unchanged));
      }
      expect(after).toEqual(await mailStore.load());
      expect(readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")).toEqual(
        await mailStore.load(),
      );
      await expect(storage.ackAgentMail("e1", "agent", "unknown")).rejects.toMatchObject({
        code: "message-not-found",
      });
    });
  });

  test("discarding a queued message removes it from the inject queue", async () => {
    await withWorld(async ({ dataDir, storage, mailStore, send }) => {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, defaultInjectPolicy: "idle" },
        },
      });
      const queued = await send("e2", "e1");
      const kept = await send("e3", "e10");
      const queue = (await mailStore.snapshot()).pendingInject.map((entry) => entry.messageId);
      expect(queue).toEqual([queued.id, kept.id]);
      await withoutWholeStore(mailStore, () => storage.discardAgentMail("e1", "agent", queued.id));
      const stored = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
      expect(stored.pendingInject.map((entry) => entry.messageId)).toEqual([kept.id]);
      expect(mailbox(stored, "e1").messages[0]).toMatchObject({
        placement: "expired",
        placementReason: "discarded",
      });
      expect((await mailStore.snapshot()).pendingInject).toEqual(stored.pendingInject);
    });
  });

  test("inside an atomic scope a mutation reads and saves the buffered store", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      const sent = await send("e2", "e1");
      const { context } = storageInternals(storage);
      await context.atomically(async () => {
        const value = await mailStore.load();
        mailbox(value, "e1").title = "buffered";
        await mailStore.save(value);
        expect((await mailStore.mailbox(agentMailboxId("e1", "agent")))!.title).toBe("buffered");
        await storage.ackAgentMail("e1", "agent", sent.id);
      });
      const after = mailbox(await mailStore.snapshot(), "e1");
      expect(after.title).toBe("buffered");
      expect(after.messages[0]!.ackedAt).toBeString();
    });
  });
});

describe("keyed reads of an unusual store", () => {
  test("see a write committed by another connection", async () => {
    await withWorld(async ({ dataDir, mailStore, send }) => {
      await send("e1", "e2");
      await mailStore.mailbox(agentMailboxId("e3", "agent"));
      const stored = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
      mailbox(stored, "e3").title = "elsewhere";
      seedStore(dataDir, "agent-mail.json", stored);
      expect((await mailStore.mailbox(agentMailboxId("e3", "agent")))!.title).toBe("elsewhere");
      expect((await mailStore.environmentMailboxes("e3"))[0]!.title).toBe("elsewhere");
    });
  });

  test("fall back to the whole store when it is held as one document", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      await send("e1", "e2");
      const value = await mailStore.load();
      mailbox(value, "e2").title = "document mailbox";
      const { database } = storageInternals(storage).context;
      database.transaction(() => {
        database.writeRawDocumentInTransaction("agent-mail", JSON.stringify(value));
      });
      expect((await mailStore.mailbox(agentMailboxId("e2", "agent")))!.title).toBe(
        "document mailbox",
      );
      expect((await storage.listAgentMailPullTabIds("e2")).length).toBe(2);
    });
  });

  test("read an unreadable row as the whole-store read does, and other rows by key", async () => {
    await withWorld(async ({ dataDir, mailStore, send }) => {
      await send("e1", "e2");
      const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE));
      try {
        db.query(
          "UPDATE store_rows SET value = '{ not json' WHERE store = 'agent-mail' AND collection = 'mailboxes' AND key = ?",
        ).run(agentMailboxId("e2", "agent"));
        db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'agent-mail'").run();
      } finally {
        db.close();
      }
      // The whole-store read treats the store as unreadable, and so does a
      // keyed read that meets the bad row; a healthy row still reads by key.
      expect((await mailStore.snapshot()).mailboxes).toEqual({});
      expect(await mailStore.mailbox(agentMailboxId("e2", "agent"))).toBeUndefined();
      expect(await mailStore.environmentMailboxes("e2")).toEqual([]);
      expect((await mailStore.mailbox(agentMailboxId("e1", "agent")))?.environmentId).toBe("e1");
    });
  });

  test("refuse an envelope of an unsupported version as the whole-store read does", async () => {
    await withWorld(async ({ dataDir, mailStore, send }) => {
      await send("e1", "e2");
      const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE));
      try {
        const { document } = db
          .query("SELECT document FROM stores WHERE name = 'agent-mail'")
          .get() as { document: string };
        db.query(
          "UPDATE stores SET document = ?, revision = revision + 1 WHERE name = 'agent-mail'",
        ).run(JSON.stringify({ ...JSON.parse(document), version: 2 }));
      } finally {
        db.close();
      }
      await expect(mailStore.snapshot()).rejects.toThrow("Unsupported agent mail store");
      await expect(mailStore.mailbox(agentMailboxId("e1", "agent"))).rejects.toThrow(
        "Unsupported agent mail store",
      );
    });
  });
});
