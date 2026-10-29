import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentMailboxId } from "@orkestrator/protocol/agent-mail";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { AgentMailStore, PersistedAgentMailStore } from "./storage-agent-mail-store.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import { readStoredValue, seedStore, storageInternals } from "./storage-test-support.js";
import { StorageService } from "./storage.js";

const ENVIRONMENTS = ["e1", "e2", "e3", "e4"] as const;

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-read-model-"));
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
          tabs: [
            {
              id: "agent",
              type: "agent-native",
              displayTitle: `${environmentId} agent`,
              nativeAgentData: { environmentId, platform: "claude" },
            },
          ],
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
  const send = (from: string, to: string) =>
    storage.sendAgentMail(
      { kind: "tab", environmentId: from, projectId: "p1", tabId: "agent" },
      {
        requestId: `request-${(sequence += 1)}`,
        toEnvironmentId: to,
        toTabId: "agent",
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

const mailbox = (store: PersistedAgentMailStore, environmentId: string) =>
  store.mailboxes[agentMailboxId(environmentId, "agent")]!;

describe("agent mail read model", () => {
  test("matches a loaded copy as mail is sent, acknowledged and deleted", async () => {
    await withWorld(async ({ storage, mailStore, send }) => {
      expect(await mailStore.snapshot()).toEqual(await mailStore.load());
      const first = await send("e1", "e2");
      await send("e2", "e3");
      await send("e3", "e1");
      expect(await mailStore.snapshot()).toEqual(await mailStore.load());
      await storage.ackAgentMail("e2", "agent", first.id);
      await storage.markAgentMailSeen("e2", "agent", first.id);
      expect(await mailStore.snapshot()).toEqual(await mailStore.load());
      await storage.deleteAgentMailByEnvironment("e3");
      const snapshot = await mailStore.snapshot();
      expect(snapshot).toEqual(await mailStore.load());
      expect(Object.keys(snapshot.mailboxes)).toEqual(
        Object.keys((await mailStore.load()).mailboxes),
      );
    });
  });

  test("is shared and frozen until the store changes", async () => {
    await withWorld(async ({ mailStore, send }) => {
      await send("e1", "e2");
      const snapshot = await mailStore.snapshot();
      expect(await mailStore.snapshot()).toBe(snapshot);
      const recipient = mailbox(snapshot, "e2");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(recipient.messages[0]!.from)).toBe(true);
      expect(() => {
        recipient.title = "changed";
      }).toThrow(TypeError);
      expect(() => recipient.messages.push(recipient.messages[0]!)).toThrow(TypeError);
      // A loaded copy is still the caller's own.
      const copy = await mailStore.load();
      mailbox(copy, "e2").title = "changed";
      expect(mailbox(await mailStore.snapshot(), "e2").title).not.toBe("changed");
    });
  });

  test("parses only the rows a write changed", async () => {
    await withWorld(async ({ mailStore, send }) => {
      await send("e1", "e2");
      const before = await mailStore.snapshot();
      const parse = spyOn(JSON, "parse");
      try {
        await send("e3", "e2");
        parse.mockClear();
        const after = await mailStore.snapshot();
        // The envelope document, the recipient's mailbox and the new idempotency row.
        expect(parse.mock.calls.length).toBeLessThanOrEqual(3);
        expect(after).not.toBe(before);
        expect(mailbox(after, "e2")).not.toBe(mailbox(before, "e2"));
        expect(mailbox(after, "e2").messages).toHaveLength(2);
        for (const unchanged of ["e1", "e3", "e4"]) {
          expect(mailbox(after, unchanged)).toBe(mailbox(before, unchanged));
        }
      } finally {
        parse.mockRestore();
      }
    });
  });

  test("sees a write committed by another connection", async () => {
    await withWorld(async ({ dataDir, mailStore, send }) => {
      await send("e1", "e2");
      const before = await mailStore.snapshot();
      const stored = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
      mailbox(stored, "e4").mutedInbound = true;
      seedStore(dataDir, "agent-mail.json", stored);
      const after = await mailStore.snapshot();
      expect(mailbox(after, "e4").mutedInbound).toBe(true);
      expect(mailbox(after, "e2")).toBe(mailbox(before, "e2"));
      expect(after).toEqual(await mailStore.load());
    });
  });

  test("reads an unreadable row the way a load does", async () => {
    await withWorld(async ({ dataDir, mailStore, send }) => {
      await send("e1", "e2");
      await mailStore.snapshot();
      const db = new Database(path.join(dataDir, STORAGE_DATABASE_FILE));
      try {
        db.query(
          "UPDATE store_rows SET value = '{ not json' WHERE store = 'agent-mail' AND collection = 'mailboxes' AND key = ?",
        ).run(agentMailboxId("e2", "agent"));
        db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'agent-mail'").run();
      } finally {
        db.close();
      }
      const loaded = await mailStore.load();
      expect(loaded.mailboxes).toEqual({});
      expect(await mailStore.snapshot()).toEqual(loaded);
    });
  });
});
