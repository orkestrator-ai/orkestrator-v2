import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_MAIL_MAX_IDEMPOTENCY_ROWS,
  AGENT_MAIL_MAX_STORE_BYTES,
} from "@orkestrator/protocol/agent-mail";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { StorageService } from "./storage.js";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const projectId of ["p1", "p2"]) {
    await storage.addProject({
      id: projectId,
      name: projectId,
      gitUrl: `https://example.invalid/${projectId}.git`,
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
  }
  for (const [environmentId, projectId] of [
    ["e1", "p1"],
    ["e2", "p1"],
    ["e3", "p2"],
  ] as const) {
    await storage.addEnvironment({
      id: environmentId,
      projectId,
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
  return { storage, dataDir };
}

describe("StorageService agent mail", () => {
  test("durably sends, replays idempotently, and keeps ack separate from human seen", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const input = {
        requestId: "request-1",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "Please inspect the parser.",
      };
      const sent = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        input,
      );
      expect(
        await storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          input,
        ),
      ).toEqual(sent);
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { ...input, body: "different" },
        ),
      ).rejects.toMatchObject({ code: "idempotency-conflict" });

      const second = new StorageService(dataDir);
      await second.init();
      expect((await second.getAgentMailMessage("e2", "agent", sent.id)).body).toBe(input.body);
      const seen = await second.markAgentMailSeen("e2", "agent", sent.id);
      expect(seen.userSeenAt).toBeString();
      expect(seen.ackedAt).toBeUndefined();
      const acked = await second.ackAgentMail("e2", "agent", sent.id);
      expect(acked.ackedAt).toBeString();
      expect((await second.getAgentMailStatus(sent.id)).bodyBytes).toBe(
        Buffer.byteLength(input.body),
      );
      expect((await fs.stat(path.join(dataDir, "agent-mail.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("enforces cross-project consent and incarnation-safe replies", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { requestId: "cross", toEnvironmentId: "e3", toTabId: "agent", body: "hello" },
        ),
      ).rejects.toMatchObject({ code: "policy-denied" });

      const inbound = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "thread", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
      );
      const previous = await storage.getPaneLayout("e1");
      if (!previous) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e1",
        {
          version: previous.version,
          containerId: null,
          activePaneId: "pane",
          root: { kind: "leaf", id: "pane", tabs: [], activeTabId: null },
        },
        previous.revision,
      );
      await storage.synchronizeAgentMailboxes();
      const closed = await storage.getPaneLayout("e1");
      if (!closed) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e1",
        {
          version: closed.version,
          containerId: null,
          activePaneId: "pane",
          root: {
            kind: "leaf",
            id: "pane",
            tabs: [
              {
                id: "agent",
                type: "agent-native",
                nativeAgentData: { environmentId: "e1", platform: "claude" },
              },
            ],
            activeTabId: "agent",
          },
        },
        closed.revision,
      );
      await storage.synchronizeAgentMailboxes();
      await expect(
        storage.replyAgentMail(
          { kind: "tab", environmentId: "e2", projectId: "p1", tabId: "agent" },
          inbound.id,
          "reply",
          "late reply",
        ),
      ).rejects.toMatchObject({ code: "recipient-superseded" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps prior-incarnation mail out of a recreated tab's agent inbox", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const inbound = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "old-inbound", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
      );
      const previous = await storage.getPaneLayout("e2");
      if (!previous) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e2",
        {
          version: previous.version,
          containerId: null,
          activePaneId: "pane",
          root: { kind: "leaf", id: "pane", tabs: [], activeTabId: null },
        },
        previous.revision,
      );
      await storage.synchronizeAgentMailboxes();
      const closed = await storage.getPaneLayout("e2");
      if (!closed) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e2",
        {
          version: closed.version,
          containerId: null,
          activePaneId: "pane",
          root: {
            kind: "leaf",
            id: "pane",
            tabs: [
              {
                id: "agent",
                type: "agent-native",
                nativeAgentData: { environmentId: "e2", platform: "claude" },
              },
            ],
            activeTabId: "agent",
          },
        },
        closed.revision,
      );
      await storage.synchronizeAgentMailboxes();

      const current = await storage.getAgentMailMailbox("e2", "agent");
      const agentInbox = await storage.getAgentMailMailbox("e2", "agent", {
        incarnationId: current.descriptor.incarnationId,
      });
      expect(current.messages.map((message) => message.id)).toContain(inbound.id);
      expect(agentInbox.messages).toEqual([]);
      expect(
        (await storage.getAgentMailSummary()).mailboxes.find(
          (mailbox) => mailbox.environmentId === "e2" && mailbox.tabId === "agent",
        )?.unreadCount,
      ).toBe(0);
      await expect(
        storage.replyAgentMail(
          { kind: "tab", environmentId: "e2", projectId: "p1", tabId: "agent" },
          inbound.id,
          "late-reply",
          "I am a different tab incarnation",
        ),
      ).rejects.toMatchObject({ code: "recipient-superseded" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps idle-policy delivery pending while globally paused", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      config.global.agentMessaging = {
        ...config.global.agentMessaging!,
        defaultInjectPolicy: "idle",
        paused: true,
      };
      await storage.saveConfig(config);
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "paused", toEnvironmentId: "e2", toTabId: "agent", body: "wait" },
      );

      expect(message).toMatchObject({ placement: "pending-inject", placementReason: "paused" });
      expect(
        (await storage.listPendingAgentMailInjects()).map(({ message }) => message.id),
      ).toContain(message.id);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not retry or discard an injection while its dispatch is in flight", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, defaultInjectPolicy: "idle" },
        },
      });
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "in-flight", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
      );
      const mailbox = (await storage.getAgentMailMailbox("e2", "agent")).descriptor;
      await storage.beginAgentMailInject(mailbox.mailboxId, message.id, mailbox.incarnationId);

      expect(await storage.retryAgentMailInject("e2", "agent", message.id)).toMatchObject({
        placement: "inject-held",
        placementReason: "submitting",
      });
      await expect(storage.discardAgentMail("e2", "agent", message.id)).rejects.toMatchObject({
        code: "policy-denied",
      });
      expect(
        await storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
          outcome: "accepted",
        }),
      ).toMatchObject({ placement: "injected", injectedAt: expect.any(String) });
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps injection lineage after ack so agents cannot auto-inject ping-pong", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, defaultInjectPolicy: "idle" },
        },
      });
      const inbound = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "lineage-in", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
      );
      const recipient = (await storage.getAgentMailMailbox("e2", "agent")).descriptor;
      await storage.beginAgentMailInject(recipient.mailboxId, inbound.id, recipient.incarnationId);
      await storage.finishAgentMailInject(recipient.mailboxId, inbound.id, {
        outcome: "accepted",
      });
      await storage.ackAgentMail("e2", "agent", inbound.id);

      const outbound = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e2", projectId: "p1", tabId: "agent" },
        { requestId: "lineage-out", toEnvironmentId: "e1", toTabId: "agent", body: "fresh" },
      );
      expect(outbound).toMatchObject({ injectDepth: 1, placement: "stored" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("announces and batch-reconciles mailboxes affected by environment deletion", async () => {
    const { storage, dataDir } = await fixture();
    const changes: Array<{
      resource: string;
      id: string;
      projectId?: string;
      revision: number;
    }> = [];
    storage.setResourceChangeListener((change) => changes.push(change));
    try {
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "purge", toEnvironmentId: "e2", toTabId: "agent", body: "secret" },
      );
      changes.length = 0;
      await storage.updateEnvironment("e1", { deletionRequestedAt: new Date().toISOString() });
      await storage.deleteAgentMailByEnvironment("e1");

      expect(await storage.getAgentMailMessage("e2", "agent", message.id)).toMatchObject({
        body: "",
        placement: "expired",
        placementReason: "sender-deleted",
      });
      expect(changes).toContainEqual({
        resource: "agent-mail",
        id: `e2\0agent`,
        projectId: "p1",
        revision: expect.any(Number),
      });
      const batch = await storage.getAgentMailMailboxes([
        { environmentId: "e1", tabId: "agent" },
        { environmentId: "e2", tabId: "agent" },
      ]);
      expect(batch.mailboxes.map((mailbox) => mailbox.descriptor.environmentId)).toEqual(["e2"]);
      for (const name of (await fs.readdir(dataDir)).filter((entry) =>
        entry.startsWith("agent-mail.json.bak"),
      )) {
        expect(await fs.readFile(path.join(dataDir, name), "utf8")).not.toContain("secret");
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("records muted delivery as a bounce without adding recipient backlog", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await storage.updateAgentMailboxPolicy("e2", "agent", { mutedInbound: true });
      const bounced = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "muted", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
      );
      expect(bounced).toMatchObject({ placement: "bounced", placementReason: "recipient-muted" });
      expect((await storage.getAgentMailMailbox("e2", "agent")).messages).toEqual([]);
      expect(await storage.getAgentMailStatus(bounced.id)).toMatchObject({
        placement: "bounced",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("announces only the mailbox whose authoritative metadata changed", async () => {
    const { storage, dataDir } = await fixture();
    const changes: Array<{ resource: string; id: string }> = [];
    storage.setResourceChangeListener((change) => changes.push(change));
    try {
      await storage.updateEnvironment("e1", { status: "stopped" });
      changes.length = 0;
      await storage.synchronizeAgentMailboxes();
      expect(changes.filter((change) => change.resource === "agent-mail")).toEqual([
        expect.objectContaining({ id: "e1\0agent" }),
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("expires old injected mail even when it was never acknowledged", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, defaultInjectPolicy: "idle" },
        },
      });
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "retention", toEnvironmentId: "e2", toTabId: "agent", body: "old" },
      );
      const mailbox = (await storage.getAgentMailMailbox("e2", "agent")).descriptor;
      await storage.beginAgentMailInject(mailbox.mailboxId, message.id, mailbox.incarnationId);
      await storage.finishAgentMailInject(mailbox.mailboxId, message.id, { outcome: "accepted" });

      const file = path.join(dataDir, "agent-mail.json");
      const persisted = JSON.parse(await fs.readFile(file, "utf8"));
      persisted.mailboxes["e2\0agent"].messages[0].createdAt = new Date(0).toISOString();
      await fs.writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await restarted.pruneAgentMail(1);
      await expect(restarted.getAgentMailMessage("e2", "agent", message.id)).rejects.toMatchObject({
        code: "message-not-found",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("expires unacknowledged mail in a tombstoned mailbox", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "closed-retention", toEnvironmentId: "e2", toTabId: "agent", body: "old" },
      );
      const layout = await storage.getPaneLayout("e2");
      if (!layout) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e2",
        {
          ...layout,
          root: { kind: "leaf", id: "pane", tabs: [], activeTabId: null },
        },
        layout.revision,
      );
      await storage.synchronizeAgentMailboxes();

      const file = path.join(dataDir, "agent-mail.json");
      const persisted = JSON.parse(await fs.readFile(file, "utf8"));
      persisted.mailboxes["e2\0agent"].messages[0].createdAt = new Date(0).toISOString();
      await fs.writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await restarted.pruneAgentMail(1);

      await expect(restarted.getAgentMailMessage("e2", "agent", message.id)).rejects.toMatchObject({
        code: "message-not-found",
      });
      expect(JSON.parse(await fs.readFile(file, "utf8")).mailboxes["e2\0agent"]).toBeUndefined();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("prunes deletion counterpart status records after retention", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "counterpart-retention",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "old",
        },
      );
      await storage.deleteAgentMailByEnvironment("e2");
      expect(await storage.getAgentMailStatus(message.id)).toMatchObject({
        placement: "undeliverable",
      });

      const file = path.join(dataDir, "agent-mail.json");
      const persisted = JSON.parse(await fs.readFile(file, "utf8"));
      persisted.counterparts[message.id].createdAt = new Date(0).toISOString();
      await fs.writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await restarted.pruneAgentMail(1);

      await expect(restarted.getAgentMailStatus(message.id)).rejects.toMatchObject({
        code: "message-not-found",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("refuses a mailbox whose 200-message backlog has no settled eviction candidate", async () => {
    const { storage, dataDir } = await fixture();
    try {
      for (let index = 0; index < 200; index += 1) {
        await storage.sendAgentMail(
          { kind: "user" },
          {
            requestId: `backlog-${index}`,
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: `message ${index}`,
          },
        );
      }
      await expect(
        storage.sendAgentMail(
          { kind: "user" },
          {
            requestId: "backlog-overflow",
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: "one too many",
          },
        ),
      ).rejects.toMatchObject({ code: "mailbox-backlog-full" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("returns closed mailboxes and more than one legacy directory page in one inbox snapshot", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const current = await storage.getPaneLayout("e1");
      if (!current) throw new Error("layout missing");
      const tabs = Array.from({ length: 205 }, (_, index) => ({
        id: `agent-${index}`,
        type: "agent-native" as const,
        nativeAgentData: { environmentId: "e1", platform: "claude" as const },
      }));
      await storage.savePaneLayout(
        "e1",
        {
          version: current.version,
          containerId: null,
          activePaneId: "pane",
          root: { kind: "leaf", id: "pane", tabs, activeTabId: tabs[0]!.id },
        },
        current.revision,
      );
      await storage.synchronizeAgentMailboxes();

      const populated = await storage.getAgentMailInboxSnapshot();
      expect(populated.directory.filter((mailbox) => mailbox.environmentId === "e1")).toHaveLength(
        206,
      );
      expect(await storage.resolveUniqueAgentMailPullTabId("e1")).toBeNull();
      expect(await storage.resolveUniqueAgentMailPullTabId("e2")).toBe("agent");
      const populatedLayout = await storage.getPaneLayout("e1");
      if (!populatedLayout) throw new Error("layout missing");
      await storage.savePaneLayout(
        "e1",
        {
          version: populatedLayout.version,
          containerId: null,
          activePaneId: "pane",
          root: {
            kind: "leaf",
            id: "pane",
            tabs: tabs.slice(1),
            activeTabId: tabs[1]!.id,
          },
        },
        populatedLayout.revision,
      );
      await storage.synchronizeAgentMailboxes();
      const closed = await storage.getAgentMailInboxSnapshot();
      expect(closed.directory.find((mailbox) => mailbox.tabId === "agent-0")).toMatchObject({
        tombstonedAt: expect.any(String),
        presence: "tab_closed",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("enforces the thread hop bound", async () => {
    const { storage, dataDir } = await fixture();
    try {
      let parent = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        { requestId: "hop-0", toEnvironmentId: "e2", toTabId: "agent", body: "zero" },
      );
      for (let depth = 1; depth <= 8; depth += 1) {
        parent = await storage.replyAgentMail(
          {
            kind: "tab",
            environmentId: parent.toEnvironmentId,
            projectId: "p1",
            tabId: parent.toTabId,
          },
          parent.id,
          `hop-${depth}`,
          String(depth),
        );
      }
      await expect(
        storage.replyAgentMail(
          {
            kind: "tab",
            environmentId: parent.toEnvironmentId,
            projectId: "p1",
            tabId: parent.toTabId,
          },
          parent.id,
          "hop-overflow",
          "overflow",
        ),
      ).rejects.toMatchObject({ code: "hop-limit" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("purges every project mailbox and scrubs its messages from surviving projects", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...config.global,
        agentMessaging: { ...config.global.agentMessaging!, allowCrossProject: true },
      });
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "project-purge",
          toEnvironmentId: "e3",
          toTabId: "agent",
          body: "project secret",
        },
      );
      await storage.updateEnvironment("e1", { deletionRequestedAt: new Date().toISOString() });
      await storage.updateEnvironment("e2", { deletionRequestedAt: new Date().toISOString() });
      await storage.deleteAgentMailByProject("p1");

      expect(
        (await storage.getAgentMailInboxSnapshot()).directory.map((row) => row.projectId),
      ).toEqual(["p2"]);
      expect(await storage.getAgentMailMessage("e3", "agent", message.id)).toMatchObject({
        body: "",
        placement: "expired",
        placementReason: "sender-deleted",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("refuses writes at the idempotency-row and serialized-store bounds", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const storePath = path.join(dataDir, "agent-mail.json");
      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
      store.idempotency = Object.fromEntries(
        Array.from({ length: AGENT_MAIL_MAX_IDEMPOTENCY_ROWS }, (_, index) => [
          `row-${index}`,
          {
            senderScope: "test",
            requestId: String(index),
            fingerprint: "fingerprint",
            createdAt: new Date(0).toISOString(),
          },
        ]),
      );
      await fs.writeFile(storePath, `${JSON.stringify(store)}\n`);
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { requestId: "over-rows", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
        ),
      ).rejects.toMatchObject({ code: "store-full" });

      store.idempotency = {};
      store.padding = "x".repeat(AGENT_MAIL_MAX_STORE_BYTES);
      await fs.writeFile(storePath, `${JSON.stringify(store)}\n`);
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          {
            requestId: "over-bytes",
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: "hello",
          },
        ),
      ).rejects.toMatchObject({ code: "store-full" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fails closed when the durable mail store is malformed", async () => {
    const { dataDir } = await fixture();
    try {
      for (const name of await fs.readdir(dataDir)) {
        if (name.startsWith("agent-mail.json.bak")) {
          await fs.rm(path.join(dataDir, name), { force: true });
        }
      }
      await fs.writeFile(path.join(dataDir, "agent-mail.json"), "{}\n");
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await expect(restarted.getAgentMailSummary()).rejects.toThrow("Unsupported agent mail store");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
