import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  AGENT_MAIL_MAX_IDEMPOTENCY_ROWS,
  AGENT_MAIL_MAX_STORE_BYTES,
} from "@orkestrator/protocol/agent-mail";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import {
  readStoredValue,
  seedStore,
  storageFilesContain,
  storageInternals,
} from "./storage-test-support.js";
import { StorageService } from "./storage.js";
import { fixture, type StoredMail } from "./agent-mail-storage-test-support.js";

const PURGE_MARKER = "purge-marker-4b9e1c";

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
      expect((await second.listAgentMailSentByMailbox("e1", "agent")).map(({ id }) => id)).toEqual([
        sent.id,
      ]);
      expect((await fs.stat(path.join(dataDir, STORAGE_DATABASE_FILE))).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("excludes expired messages from tab and user sent-history queries", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "expired-tab-sent",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "old tab message",
        },
      );
      await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "expired-user-sent",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "old user message",
        },
      );
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, retentionDays: 1 },
        },
      });
      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      for (const stored of persisted.mailboxes["e2\0agent"]!.messages) {
        stored.createdAt = new Date(0).toISOString();
      }
      seedStore(dataDir, "agent-mail.json", persisted);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.listAgentMailSentByMailbox("e1", "agent")).toEqual([]);
      expect(await restarted.listUserSentAgentMail()).toEqual([]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("uses the shared naming order and environment-wide ordinal", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const session = await storage.createSession("e1", "local", "agent", "claude");
      await storage.updateSession(session.id, { name: "Renamed parser" });
      storage.setAgentMailRuntimeProvider(() => ({ title: "Automatic title" }));
      await storage.synchronizeAgentMailboxes();
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.displayName).toBe(
        "Claude 1 · Renamed parser",
      );

      await storage.removeSession(session.id);
      await storage.synchronizeAgentMailboxes();
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.displayName).toBe(
        "Claude 1 · Automatic title",
      );

      storage.setAgentMailRuntimeProvider(null);
      await storage.synchronizeAgentMailboxes();
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.displayName).toBe(
        "Claude 1 · e1 agent",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("read paths use the synchronized directory without touching pane layouts", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const sent = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "read-only-directory",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "hello",
        },
      );
      storageInternals(storage).repos.sessions.loadPaneLayoutsForReconciliation = async () => {
        throw new Error("read path touched pane layouts");
      };
      await expect(storage.getAgentMailSummary()).resolves.toBeDefined();
      await expect(storage.getAgentMailMailbox("e2", "agent")).resolves.toBeDefined();
      await expect(
        storage.getAgentMailMailboxes([{ environmentId: "e2", tabId: "agent" }]),
      ).resolves.toBeDefined();
      await expect(storage.getAgentMailInboxSnapshot()).resolves.toBeDefined();
      await expect(storage.listAgentMailboxes()).resolves.toBeDefined();
      await expect(storage.listPendingAgentMailInjects()).resolves.toBeDefined();
      expect((await storage.listAgentMailSentByMailbox("e1", "agent"))[0]?.id).toBe(sent.id);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("refreshes the directory on send only when a pane-layout revision changed", async () => {
    const { storage, dataDir } = await fixture();
    try {
      let synchronizations = 0;
      const mail = storageInternals(storage).repos.agentMailboxes;
      const synchronize = mail.synchronizeAgentMailboxes.bind(mail);
      mail.synchronizeAgentMailboxes = async () => {
        synchronizations += 1;
        await synchronize();
      };
      await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "unchanged-layout",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "Existing mailbox.",
        },
      );
      expect(synchronizations).toBe(0);

      const layout = await storage.getPaneLayout("e2");
      if (!layout) throw new Error("fixture layout missing");
      await storage.savePaneLayout(
        "e2",
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
                displayTitle: "e2 agent",
                nativeAgentData: { environmentId: "e2", platform: "claude" },
              },
              {
                id: "new-agent",
                type: "agent-native",
                nativeAgentData: { environmentId: "e2", platform: "codex" },
              },
            ],
            activeTabId: "new-agent",
          },
        },
        layout.revision,
      );
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          {
            requestId: "changed-layout",
            toEnvironmentId: "e2",
            toTabId: "new-agent",
            body: "New mailbox.",
          },
        ),
      ).resolves.toMatchObject({ toTabId: "new-agent" });
      expect(synchronizations).toBe(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("treats synchronized coordinator mailboxes as directory-fresh without pane layouts", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const now = new Date(0).toISOString();
      await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: "p1",
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-1",
            tabId: "coordinator-tab",
            logicalSessionKey: "coordinator-coordinator-1:conversation-1",
            agent: "codex",
            title: "Coordinator",
            createdAt: now,
            mailboxIncarnationId: "coordinator-incarnation-1",
          },
        ],
        selectedConversationId: "conversation-1",
        repositoryContextRevision: 0,
        createdAt: now,
        updatedAt: now,
      }));
      await storage.synchronizeAgentMailboxes();
      let synchronizations = 0;
      const mail = storageInternals(storage).repos.agentMailboxes;
      mail.synchronizeAgentMailboxes = async () => {
        synchronizations += 1;
      };
      await mail.ensureAgentMailDirectoryFresh([
        coordinatorRuntimeId("coordinator-1", "conversation-1"),
      ]);
      expect(synchronizations).toBe(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("backs off held injection and suppresses repeated hold announcements", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      config.global.agentMessaging = {
        ...config.global.agentMessaging!,
        defaultInjectPolicy: "idle",
      };
      await storage.saveConfig(config);
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
        {
          requestId: "held-backoff",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "wait",
        },
      );
      const descriptor = (await storage.getAgentMailMailbox("e2", "agent")).descriptor;
      const changes: string[] = [];
      storage.addResourceChangeListener((change) => changes.push(change.resource));

      await storage.beginAgentMailInject(
        descriptor.mailboxId,
        message.id,
        descriptor.incarnationId,
      );
      await storage.finishAgentMailInject(descriptor.mailboxId, message.id, {
        outcome: "held",
        reason: "busy",
      });
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
      expect(
        await storage.listPendingAgentMailInjects(100, { includeDeferred: true }),
      ).toMatchObject([{ deferredUntil: expect.any(String) }]);
      expect(changes).toContain("agent-mail-summary");

      await storage.retryAgentMailInject("e2", "agent", message.id);
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
      changes.length = 0;
      await storage.beginAgentMailInject(
        descriptor.mailboxId,
        message.id,
        descriptor.incarnationId,
      );
      await storage.finishAgentMailInject(descriptor.mailboxId, message.id, {
        outcome: "held",
        reason: "busy",
      });
      expect(changes).toEqual([]);
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
      await expect(
        storage.sendAgentMail(
          { kind: "system", projectId: "p1", source: "workflow", resourceId: "workflow-1" },
          { requestId: "system-cross", toEnvironmentId: "e3", toTabId: "agent", body: "done" },
        ),
      ).resolves.toMatchObject({ trust: "cross-project", placement: "stored" });

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

  test("promotes pull-only stored mail when the user enables idle delivery", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "off" });
      const stored = await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "promote-pull-only",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "Deliver this after explicit promotion.",
        },
      );
      expect(stored.placement).toBe("stored");

      await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "idle" });
      expect(await storage.getAgentMailMessage("e2", "agent", stored.id)).toMatchObject({
        placement: "pending-inject",
        injectRequestId: `mail-inject-${stored.id}`,
      });
      // A later retry only resets backoff; it must not queue the message twice.
      await storage.retryAgentMailInject("e2", "agent", stored.id);
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each(["off-to-inherit", "unmute-inherit"] as const)(
    "promotes stored mail with inherited idle policy: %s",
    async (transition) => {
      const { storage, dataDir } = await fixture();
      try {
        const config = await storage.loadConfig();
        config.global.agentMessaging = {
          ...config.global.agentMessaging!,
          defaultInjectPolicy: "idle",
        };
        await storage.saveConfig(config);
        await storage.updateAgentMailboxPolicy(
          "e2",
          "agent",
          transition === "off-to-inherit"
            ? { inject: "off" }
            : { inject: "inherit", mutedInbound: true },
        );
        // Muting mail already stored leaves it eligible for the unmute transition.
        if (transition === "unmute-inherit")
          await storage.updateAgentMailboxPolicy("e2", "agent", {
            inject: "off",
            mutedInbound: false,
          });
        const message = await storage.sendAgentMail(
          { kind: "user" },
          {
            requestId: transition,
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: "Deliver when inherited policy allows.",
          },
        );
        expect(message.placement).toBe("stored");
        if (transition === "unmute-inherit")
          await storage.updateAgentMailboxPolicy("e2", "agent", {
            inject: "inherit",
            mutedInbound: true,
          });
        expect((await storage.getAgentMailMessage("e2", "agent", message.id)).placement).toBe(
          "stored",
        );
        const descriptor = await storage.updateAgentMailboxPolicy(
          "e2",
          "agent",
          transition === "off-to-inherit" ? { inject: "inherit" } : { mutedInbound: false },
        );
        expect(descriptor).toMatchObject({ injectOverride: "inherit", injectPolicy: "idle" });
        expect(
          (await storage.listPendingAgentMailInjects()).map(({ message }) => message.id),
        ).toEqual([message.id]);
        await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "inherit" });
        expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each(["policy", "assignment"] as const)(
    "%s promotion excludes tombstoned and prior-incarnation mail",
    async (trigger) => {
      const { storage, dataDir } = await fixture();
      try {
        const now = new Date(0).toISOString();
        const environmentId =
          trigger === "policy" ? "e2" : coordinatorRuntimeId("coordinator-1", "conversation-1");
        const tabId = trigger === "policy" ? "agent" : "coordinator-tab";
        if (trigger === "assignment") {
          await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
            version: COORDINATOR_WORKSPACE_VERSION,
            id: "coordinator-1",
            projectId: "p1",
            executionPolicy: COORDINATOR_EXECUTION_POLICY,
            lifecycleState: "ready",
            conversations: [
              {
                id: "conversation-1",
                tabId,
                logicalSessionKey: "coordinator-coordinator-1:conversation-1",
                title: "Coordinator",
                createdAt: now,
                mailboxIncarnationId: "old-incarnation",
              },
            ],
            selectedConversationId: "conversation-1",
            repositoryContextRevision: 0,
            createdAt: now,
            updatedAt: now,
          }));
          await storage.synchronizeAgentMailboxes();
        } else {
          await storage.updateAgentMailboxPolicy(environmentId, tabId, { inject: "off" });
        }
        const old = await storage.sendAgentMail(
          { kind: "user" },
          {
            requestId: "old-mail",
            toEnvironmentId: environmentId,
            toTabId: tabId,
            body: "For the former recipient.",
          },
        );
        expect(old.placement).toBe("stored");
        const originalLayout = await storage.getPaneLayout(environmentId);
        if (trigger === "assignment") {
          // Assignment supplies the capability, but the conversation is closed
          // before any promotion is allowed to run.
          await storage.coordinators.mutateCoordinatorWorkspace("p1", (workspace) => ({
            ...workspace!,
            conversations: workspace!.conversations.map((conversation) => ({
              ...conversation,
              agent: "codex" as const,
            })),
          }));
          await storage.coordinators.mutateCoordinatorWorkspace("p1", (workspace) => ({
            ...workspace!,
            conversations: workspace!.conversations.map((conversation) => ({
              ...conversation,
              closedAt: now,
            })),
          }));
        } else {
          await storage.savePaneLayout(
            environmentId,
            { ...originalLayout!, root: { kind: "leaf", id: "pane", tabs: [], activeTabId: null } },
            originalLayout!.revision,
          );
        }
        await storage.synchronizeAgentMailboxes();
        expect(
          (await storage.getAgentMailMailbox(environmentId, tabId)).descriptor.tombstonedAt,
        ).toBeDefined();
        if (trigger === "assignment")
          expect(await storage.promoteStoredAgentMailForMailbox(environmentId, tabId)).toBe(0);
        else await storage.updateAgentMailboxPolicy(environmentId, tabId, { inject: "idle" });
        expect((await storage.getAgentMailMessage(environmentId, tabId, old.id)).placement).toBe(
          "stored",
        );
        expect(await storage.listPendingAgentMailInjects()).toEqual([]);
        if (trigger === "assignment") {
          await storage.coordinators.mutateCoordinatorWorkspace("p1", (workspace) => ({
            ...workspace!,
            conversations: workspace!.conversations.map((conversation) => ({
              ...conversation,
              closedAt: undefined,
              mailboxIncarnationId: "new-incarnation",
            })),
          }));
        } else {
          const closed = await storage.getPaneLayout(environmentId);
          await storage.savePaneLayout(environmentId, originalLayout!, closed!.revision);
        }
        await storage.synchronizeAgentMailboxes();
        expect(
          (await storage.getAgentMailMailbox(environmentId, tabId)).descriptor.incarnationId,
        ).not.toBe(old.toIncarnationId);
        if (trigger === "assignment")
          expect(await storage.promoteStoredAgentMailForMailbox(environmentId, tabId)).toBe(0);
        else await storage.updateAgentMailboxPolicy(environmentId, tabId, { inject: "idle" });
        expect((await storage.getAgentMailMessage(environmentId, tabId, old.id)).placement).toBe(
          "stored",
        );
        expect(await storage.listPendingAgentMailInjects()).toEqual([]);
        const current = await storage.sendAgentMail(
          { kind: "user" },
          {
            requestId: "current-mail",
            toEnvironmentId: environmentId,
            toTabId: tabId,
            body: "For the new recipient.",
          },
        );
        if (trigger === "assignment") {
          expect(current.placement).toBe("stored");
          expect(await storage.promoteStoredAgentMailForMailbox(environmentId, tabId)).toBe(1);
        } else {
          expect(current.placement).toBe("pending-inject");
        }
        expect(
          (await storage.listPendingAgentMailInjects()).map(({ message }) => message.id),
        ).toEqual([current.id]);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test("enabling delivery skips handled mail and does not re-run when already on", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "off" });
      const send = (requestId: string) =>
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { requestId, toEnvironmentId: "e2", toTabId: "agent", body: requestId },
        );
      const acked = await send("acked");
      await storage.ackAgentMail("e2", "agent", acked.id);
      const waiting = await send("waiting");

      await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "idle", mutedInbound: true });
      expect((await storage.getAgentMailMessage("e2", "agent", waiting.id)).placement).toBe(
        "stored",
      );
      await storage.updateAgentMailboxPolicy("e2", "agent", { mutedInbound: false });
      expect(
        (await storage.listPendingAgentMailInjects()).map(({ message }) => message.id),
      ).toEqual([waiting.id]);
      expect((await storage.getAgentMailMessage("e2", "agent", acked.id)).placement).toBe("stored");

      // Already idle: unrelated policy edits do not resurrect discarded mail.
      await storage.discardAgentMail("e2", "agent", waiting.id);
      await storage.updateAgentMailboxPolicy("e2", "agent", { inject: "idle" });
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("refuses mail a tab addresses to its own mailbox", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { requestId: "self", toEnvironmentId: "e1", toTabId: "agent", body: "to the parent" },
        ),
      ).rejects.toMatchObject({ code: "policy-denied" });
      expect(await storage.listAgentMailSentByMailbox("e1", "agent")).toHaveLength(0);
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

  test("keeps injection lineage after ack so non-peer mail cannot auto-inject ping-pong", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: {
            ...config.global.agentMessaging!,
            defaultInjectPolicy: "idle",
            wakePeers: false,
          },
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
      expect(outbound).toMatchObject({
        injectDepth: 1,
        placement: "stored",
        placementReason: "reply-to-injected-turn",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("holds coordinator exchange at the loop budget until a new request or Resume", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const now = new Date(0).toISOString();
      await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: "p1",
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-1",
            tabId: "coordinator-tab",
            logicalSessionKey: "coordinator-coordinator-1:conversation-1",
            agent: "codex",
            title: "Coordinator",
            createdAt: now,
            mailboxIncarnationId: "coordinator-incarnation-1",
          },
        ],
        selectedConversationId: "conversation-1",
        repositoryContextRevision: 0,
        createdAt: now,
        updatedAt: now,
      }));
      await storage.synchronizeAgentMailboxes();
      const coordinatorEnvironmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");
      const coordinator = {
        kind: "coordinator" as const,
        projectId: "p1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        environmentId: coordinatorEnvironmentId,
        tabId: "coordinator-tab",
      };
      const worker = { kind: "tab" as const, environmentId: "e1", projectId: "p1", tabId: "agent" };
      await expect(
        storage.sendAgentMail(
          { ...coordinator, coordinatorId: "forged-coordinator" },
          {
            requestId: "forged-coordinator",
            toEnvironmentId: "e1",
            toTabId: "agent",
            body: "reject this",
          },
        ),
      ).rejects.toMatchObject({ code: "capability-denied" });
      await storage.updateAgentMailboxPolicy("e1", "agent", { inject: "off" });
      const explicitlyOff = await storage.sendAgentMail(coordinator, {
        requestId: "explicitly-off",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "store this",
      });
      expect(explicitlyOff.placement).toBe("stored");
      await storage.updateAgentMailboxPolicy("e1", "agent", { inject: "inherit" });

      const request = await storage.sendAgentMail(coordinator, {
        requestId: "request-0",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "start",
      });
      expect(request).toMatchObject({ placement: "pending-inject", threadDepth: 0 });
      const budget = DEFAULT_AGENT_MESSAGING_SETTINGS.autonomousWakeBudget;
      const sendFromWorker = (index: number) =>
        storage.sendAgentMail(worker, {
          requestId: `worker-${index}`,
          toEnvironmentId: coordinatorEnvironmentId,
          toTabId: "coordinator-tab",
          subject: `Subject ${index}`,
          body: `report ${index}`,
        });
      // Unsolicited worker mail spends the budget whatever its subject.
      let last = request;
      for (let index = 1; index < budget; index += 1) {
        last = await sendFromWorker(index);
        expect(last.placement).toBe("pending-inject");
      }
      const held = await sendFromWorker(budget);
      expect(held).toMatchObject({
        placement: "inject-held",
        placementReason: "loop-budget-exhausted",
        threadDepth: budget,
      });
      const another = await sendFromWorker(budget + 1);
      expect(another.placementReason).toBe("loop-budget-exhausted");
      // The coordinator is told once per budget, not once per held message.
      const notices = (
        await storage.getAgentMailMailbox(coordinatorEnvironmentId, "coordinator-tab")
      ).messages.filter((message) => message.from.kind === "system");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ route: "coordinator", placement: "pending-inject" });

      // A new coordinator request is a new delegation and a new budget.
      const followUp = await storage.sendAgentMail(
        coordinator,
        {
          requestId: "request-1",
          toEnvironmentId: "e1",
          toTabId: "agent",
          body: "next question",
        },
        { newDelegation: true },
      );
      expect(followUp).toMatchObject({ placement: "pending-inject", threadDepth: 0 });
      expect(await sendFromWorker(budget + 2)).toMatchObject({
        placement: "pending-inject",
        threadDepth: 1,
      });

      for (let index = 2; index <= budget; index += 1) await sendFromWorker(budget + 1 + index);
      const secondNotices = (
        await storage.getAgentMailMailbox(coordinatorEnvironmentId, "coordinator-tab")
      ).messages.filter((message) => message.from.kind === "system");
      expect(secondNotices).toHaveLength(2);
      expect(new Set(secondNotices.map((message) => message.requestId)).size).toBe(2);

      // Resume releases everything held for the tab in one action.
      const resumed = await storage.retryAgentMailInject(
        coordinatorEnvironmentId,
        "coordinator-tab",
        held.id,
      );
      expect(resumed).toMatchObject({ placement: "pending-inject", threadDepth: 0 });
      expect(
        await storage.getAgentMailMessage(coordinatorEnvironmentId, "coordinator-tab", another.id),
      ).toMatchObject({ placement: "pending-inject", threadDepth: 0 });
      const pending = (await storage.listPendingAgentMailInjects()).map(
        ({ message: entry }) => entry.id,
      );
      expect(pending).toContain(held.id);
      expect(pending).toContain(another.id);
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
        { requestId: "purge", toEnvironmentId: "e2", toTabId: "agent", body: PURGE_MARKER },
      );
      expect(storageFilesContain(dataDir, PURGE_MARKER)).toBe(true);
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
      expect(storageFilesContain(dataDir, PURGE_MARKER)).toBe(false);
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

      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      persisted.mailboxes["e2\0agent"]!.messages[0]!.createdAt = new Date(0).toISOString();
      seedStore(dataDir, "agent-mail.json", persisted);
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

      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      persisted.mailboxes["e2\0agent"]!.messages[0]!.createdAt = new Date(0).toISOString();
      seedStore(dataDir, "agent-mail.json", persisted);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await restarted.pruneAgentMail(1);

      await expect(restarted.getAgentMailMessage("e2", "agent", message.id)).rejects.toMatchObject({
        code: "message-not-found",
      });
      expect(
        readStoredValue<StoredMail>(dataDir, "agent-mail.json")!.mailboxes["e2\0agent"],
      ).toBeUndefined();
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

      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      persisted.counterparts![message.id]!.createdAt = new Date(0).toISOString();
      seedStore(dataDir, "agent-mail.json", persisted);
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

  test("enforces the thread hop bound on unrouted mail", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, wakePeers: false },
        },
      });
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
      const store = readStoredValue<Record<string, unknown>>(dataDir, "agent-mail.json")!;
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
      seedStore(dataDir, "agent-mail.json", store);
      await expect(
        storage.sendAgentMail(
          { kind: "tab", environmentId: "e1", projectId: "p1", tabId: "agent" },
          { requestId: "over-rows", toEnvironmentId: "e2", toTabId: "agent", body: "hello" },
        ),
      ).rejects.toMatchObject({ code: "store-full" });

      store.idempotency = {};
      store.padding = "x".repeat(AGENT_MAIL_MAX_STORE_BYTES);
      seedStore(dataDir, "agent-mail.json", store);
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
      seedStore(dataDir, "agent-mail.json", {});
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await expect(restarted.getAgentMailSummary()).rejects.toThrow("Unsupported agent mail store");
      seedStore(dataDir, "agent-mail.json", { version: 2, mailboxes: {}, idempotency: {} });
      await expect(restarted.getAgentMailSummary()).rejects.toThrow("Unsupported agent mail store");
      seedStore(dataDir, "agent-mail.json", ["not", "a", "store"]);
      await expect(restarted.getAgentMailSummary()).rejects.toThrow(
        "Agent mail store is malformed",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("promoting an unassigned coordinator mailbox wakes exactly the mail retry would", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const now = new Date(0).toISOString();
      // No `agent`: a coordinator conversation has none until its first prompt,
      // and a mailbox with no agent cannot be injected into, so mail that
      // arrives meanwhile is filed as `stored`.
      await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: "p1",
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-1",
            tabId: "coordinator-tab",
            logicalSessionKey: "coordinator-coordinator-1:conversation-1",
            title: "Coordinator",
            createdAt: now,
            mailboxIncarnationId: "coordinator-incarnation-1",
          },
        ],
        selectedConversationId: "conversation-1",
        repositoryContextRevision: 0,
        createdAt: now,
        updatedAt: now,
      }));
      await storage.synchronizeAgentMailboxes();
      const environmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");

      const deliverable = await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "unassigned-deliverable",
          toEnvironmentId: environmentId,
          toTabId: "coordinator-tab",
          body: "A worker finished while nothing was chosen.",
        },
      );
      const acked = await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "unassigned-acked",
          toEnvironmentId: environmentId,
          toTabId: "coordinator-tab",
          body: "Already handled.",
        },
      );
      const discarded = await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "unassigned-discarded",
          toEnvironmentId: environmentId,
          toTabId: "coordinator-tab",
          body: "Not wanted.",
        },
      );
      for (const message of [deliverable, acked, discarded]) {
        expect(message.placement).toBe("stored");
      }
      await storage.ackAgentMail(environmentId, "coordinator-tab", acked.id);
      await storage.discardAgentMail(environmentId, "coordinator-tab", discarded.id);

      // Still unassigned: nothing may be woken, because nothing can receive it.
      expect(await storage.promoteStoredAgentMailForMailbox(environmentId, "coordinator-tab")).toBe(
        0,
      );

      await storage.coordinators.mutateCoordinatorWorkspace("p1", (workspace) => ({
        ...workspace!,
        conversations: workspace!.conversations.map((conversation) => ({
          ...conversation,
          agent: "codex" as const,
        })),
      }));
      const changes: string[] = [];
      storage.addResourceChangeListener((change) => changes.push(change.resource));
      await storage.synchronizeAgentMailboxes();
      // Synchronization now recovers the backlog without a one-time assignment hook.
      expect(await storage.promoteStoredAgentMailForMailbox(environmentId, "coordinator-tab")).toBe(
        0,
      );
      // Acknowledged and discarded mail is not resurrected by assignment; this
      // is the same eligibility rule `retryAgentMailInject` applies.
      const mailbox = await storage.getAgentMailMailbox(environmentId, "coordinator-tab");
      const placements = new Map(
        mailbox.messages.map((message) => [message.id, message.placement]),
      );
      expect(placements.get(deliverable.id)).toBe("pending-inject");
      expect(placements.get(acked.id)).toBe("stored");
      expect(placements.get(discarded.id)).not.toBe("pending-inject");
      expect(
        (await storage.listPendingAgentMailInjects()).map(({ message }) => message.id),
      ).toEqual([deliverable.id]);
      expect(changes).toContain("agent-mail-summary");

      // Idempotent: assignment can be retried, and a second pass must not
      // enqueue the same message twice.
      expect(await storage.promoteStoredAgentMailForMailbox(environmentId, "coordinator-tab")).toBe(
        0,
      );
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("promotion refuses a mailbox that cannot receive, and an unknown one", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const current = await storage.getPaneLayout("e1");
      if (!current) throw new Error("layout missing");
      // Terminal claude can pull and send but cannot be woken. Mail must stay
      // stored, not move into a queue that will never drain.
      await storage.savePaneLayout(
        "e1",
        {
          version: current.version,
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
              { id: "term", type: "claude", displayTitle: "Terminal" },
            ],
            activeTabId: "agent",
          },
        },
        current.revision,
      );
      await storage.synchronizeAgentMailboxes();
      const stored = await storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: "terminal-stored",
          toEnvironmentId: "e1",
          toTabId: "term",
          body: "Nothing here can deliver this.",
        },
      );
      expect(stored.placement).toBe("stored");
      expect(await storage.promoteStoredAgentMailForMailbox("e1", "term")).toBe(0);
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
      // A mailbox that does not exist is a no-op, not a throw: assignment is
      // best-effort and must not strand the conversation.
      expect(await storage.promoteStoredAgentMailForMailbox("missing", "coordinator-tab")).toBe(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
