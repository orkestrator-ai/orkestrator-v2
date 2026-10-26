import { AgentMailService } from "./agent-mail-service.js";
import { stoppedWorkerMailHook } from "./agent-mail-stopped-worker.js";
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
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

/** The persisted agent-mail store, as far as these tests edit it. */
type StoredMail = {
  mailboxes: Record<string, { messages: Array<{ createdAt: string; wakeAdmittedAt?: string }> }>;
  counterparts?: Record<string, { createdAt: string }>;
};

const PURGE_MARKER = "purge-marker-4b9e1c";

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
          await storage.synchronizeAgentMailboxes();
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
      await storage.synchronizeAgentMailboxes();

      const changes: string[] = [];
      storage.addResourceChangeListener((change) => changes.push(change.resource));
      expect(await storage.promoteStoredAgentMailForMailbox(environmentId, "coordinator-tab")).toBe(
        1,
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

describe("StorageService agent mail routes", () => {
  async function peerFixture() {
    const result = await fixture();
    const config = await result.storage.loadConfig();
    await result.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, wakePeers: true },
    });
    return result;
  }
  async function drainWithStoppedHook(
    storage: StorageService,
    hook: ReturnType<typeof stoppedWorkerMailHook>,
  ) {
    const service = new AgentMailService(
      storage,
      {
        sessionActivitySnapshot: () => "idle",
        reconcileMailInject: async () => "unknown",
        dispatchMailInject: async (input) => ({ outcome: "accepted", requestId: input.requestId }),
      },
      { dispatchMailInject: async () => ({ outcome: "accepted" }) },
      { coordinatorMailForStoppedEnvironment: hook },
    );
    try {
      await service.init();
      await service.drainInjects();
    } finally {
      await service.shutdown();
    }
  }
  const tab = (environmentId: string) =>
    ({ kind: "tab", environmentId, projectId: "p1", tabId: "agent" }) as const;
  const coordinatorSender = (conversationId: string) =>
    ({
      kind: "coordinator",
      projectId: "p1",
      coordinatorId: "coordinator-1",
      conversationId,
      environmentId: coordinatorRuntimeId("coordinator-1", conversationId),
      tabId: `tab-${conversationId}`,
    }) as const;

  /** Two coordinator conversations; conversation-1 launched e1, conversation-2 only messaged e2. */
  async function coordinatorFixture(options: { closeCreator?: boolean } = {}) {
    const { storage, dataDir } = await peerFixture();
    const now = new Date(0).toISOString();
    await storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "coordinator-1",
      projectId: "p1",
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: ["conversation-1", "conversation-2"].map((id) => ({
        id,
        tabId: `tab-${id}`,
        logicalSessionKey: `coordinator-coordinator-1:${id}`,
        agent: "claude" as const,
        title: id,
        createdAt: now,
        mailboxIncarnationId: `incarnation-${id}`,
        ...(options.closeCreator && id === "conversation-1" ? { closedAt: now } : {}),
      })),
      selectedConversationId: "conversation-1",
      repositoryContextRevision: 0,
      createdAt: now,
      updatedAt: now,
    }));
    await storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "launch-e1",
      projectId: "p1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      kind: "environment",
      resourceId: "e1",
      requestId: "launch-e1",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      createdAt: now,
    });
    // A delegation to an existing environment does not make it a worker.
    await storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "delegate-e2",
      projectId: "p1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-2",
      kind: "environment",
      resourceId: "e2",
      requestId: "delegation:ask-e2",
      createdAt: now,
    });
    await storage.synchronizeAgentMailboxes();
    return { storage, dataDir };
  }

  async function inject(storage: StorageService, environmentId: string, tabId: string, id: string) {
    const recipient = (await storage.getAgentMailMailbox(environmentId, tabId)).descriptor;
    await storage.beginAgentMailInject(recipient.mailboxId, id, recipient.incarnationId);
    await storage.finishAgentMailInject(recipient.mailboxId, id, { outcome: "accepted" });
  }

  test("peers wake each other, including a reply from an injected turn", async () => {
    const { storage, dataDir } = await peerFixture();
    try {
      const first = await storage.sendAgentMail(tab("e1"), {
        requestId: "peer-1",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "question",
      });
      expect(first).toMatchObject({ route: "peer", placement: "pending-inject" });
      await inject(storage, "e2", "agent", first.id);
      const reply = await storage.replyAgentMail(tab("e2"), first.id, "peer-2", "answer");
      expect(reply).toMatchObject({ route: "peer", placement: "pending-inject", injectDepth: 1 });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("Wake peers off stores peer mail under the default policy", async () => {
    const { storage, dataDir } = await peerFixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, wakePeers: false },
        },
      });
      const message = await storage.sendAgentMail(tab("e1"), {
        requestId: "peer-off",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "question",
      });
      expect(message).toMatchObject({
        route: "peer",
        placement: "stored",
        placementReason: "inject-policy-off",
      });
      const released = await storage.retryAgentMailInject("e2", "agent", message.id);
      expect(released.placement).toBe("pending-inject");
      expect(released.userReleasedAt).toBeString();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a coordinator-created worker wakes only its own coordinator", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      const main = coordinatorRuntimeId("coordinator-1", "conversation-1");
      const side = coordinatorRuntimeId("coordinator-1", "conversation-2");
      // The selected legacy conversation became the main; the other a side agent.
      expect(
        (await storage.getAgentMailMailbox(main, "tab-conversation-1")).descriptor
          .coordinatorOrigin,
      ).toBeUndefined();
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.coordinatorOrigin).toBe(
        main,
      );
      expect(
        (await storage.getAgentMailMailbox("e2", "agent")).descriptor.coordinatorOrigin,
      ).toBeUndefined();

      // The "coordinator" address needs no tab id and reaches the main.
      const report = await storage.sendAgentMail(tab("e1"), {
        requestId: "report",
        toEnvironmentId: "coordinator",
        toTabId: "",
        body: "done",
      });
      expect(report).toMatchObject({
        route: "coordinator",
        placement: "pending-inject",
        toEnvironmentId: main,
        toTabId: "tab-conversation-1",
      });

      for (const [sender, environmentId] of [
        [tab("e1"), "e2"],
        [tab("e2"), "e1"],
      ] as const) {
        const message = await storage.sendAgentMail(sender, {
          requestId: `isolated-${sender.environmentId}-${environmentId}`,
          toEnvironmentId: environmentId,
          toTabId: "",
          body: "sideways",
        });
        expect(message).toMatchObject({
          route: "isolated",
          placement: "stored",
          placementReason: "isolated-route",
          toTabId: "agent",
        });
      }

      // A coordinator that only messaged an environment can still wake it.
      const delegated = await storage.sendAgentMail(coordinatorSender("conversation-1"), {
        requestId: "delegated",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "please look",
      });
      expect(delegated).toMatchObject({ route: "coordinator", placement: "pending-inject" });

      // Side agents talk to the main coordinator and nobody else.
      await expect(
        storage.sendAgentMail(tab("e1"), {
          requestId: "worker-to-side",
          toEnvironmentId: side,
          toTabId: "",
          body: "wrong door",
        }),
      ).rejects.toMatchObject({ code: "policy-denied" });
      await expect(
        storage.sendAgentMail(coordinatorSender("conversation-2"), {
          requestId: "side-to-worker",
          toEnvironmentId: "e1",
          toTabId: "agent",
          body: "not mine",
        }),
      ).rejects.toMatchObject({ code: "policy-denied" });
      const sideToMain = await storage.sendAgentMail(coordinatorSender("conversation-2"), {
        requestId: "side-to-main",
        toEnvironmentId: "coordinator",
        toTabId: "",
        body: "a thought",
      });
      expect(sideToMain).toMatchObject({ toEnvironmentId: main, placement: "pending-inject" });
      const mainToSide = await storage.sendAgentMail(coordinatorSender("conversation-1"), {
        requestId: "main-to-side",
        toEnvironmentId: side,
        toTabId: "",
        body: "look into this",
      });
      expect(mainToSide).toMatchObject({
        toTabId: "tab-conversation-2",
        placement: "pending-inject",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a worker launched by a closed conversation reports to the current main", async () => {
    const { storage, dataDir } = await coordinatorFixture({ closeCreator: true });
    try {
      // conversation-1 launched e1 and closed; the remaining one is the main.
      const main = coordinatorRuntimeId("coordinator-1", "conversation-2");
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.coordinatorOrigin).toBe(
        main,
      );
      // Its stale address is redirected rather than refused.
      const message = await storage.sendAgentMail(tab("e1"), {
        requestId: "stale-address",
        toEnvironmentId: coordinatorRuntimeId("coordinator-1", "conversation-1"),
        toTabId: "tab-conversation-1",
        body: "done",
      });
      expect(message).toMatchObject({
        toEnvironmentId: main,
        route: "coordinator",
        placement: "pending-inject",
      });
      expect(
        (
          await storage.sendAgentMail(tab("e1"), {
            requestId: "still-isolated",
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: "hello",
          })
        ).route,
      ).toBe("isolated");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("with no main open, coordinator mail waits for the resolver to start one", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      await storage.coordinators.mutateCoordinatorWorkspace("p1", (current) => ({
        ...current!,
        conversations: current!.conversations.map((item) => ({
          ...item,
          closedAt: new Date(0).toISOString(),
        })),
      }));
      await storage.synchronizeAgentMailboxes();
      // The worker stays attached to its coordinator, not loose as a peer.
      expect((await storage.getAgentMailMailbox("e1", "agent")).descriptor.coordinatorOrigin).toBe(
        coordinatorRuntimeId("coordinator-1"),
      );
      await expect(
        storage.sendAgentMail(tab("e1"), {
          requestId: "nobody-home",
          toEnvironmentId: "coordinator",
          toTabId: "",
          body: "done",
        }),
      ).rejects.toMatchObject({ code: "recipient-not-found" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a per-tab idle override no longer stops coordinator replies", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      const coordinatorEnvironmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");
      const request = await storage.sendAgentMail(coordinatorSender("conversation-1"), {
        requestId: "request",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "do the thing",
      });
      await inject(storage, "e1", "agent", request.id);
      // What the banner's "Deliver now" used to write as a side effect.
      await storage.updateAgentMailboxPolicy(coordinatorEnvironmentId, "tab-conversation-1", {
        inject: "idle",
      });
      const report = await storage.replyAgentMail(tab("e1"), request.id, "report", "done");
      expect(report).toMatchObject({ placement: "pending-inject", injectDepth: 1 });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an explicit Off holds routed mail and turning it back on promotes it", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      const coordinatorEnvironmentId = coordinatorRuntimeId("coordinator-1", "conversation-1");
      const request = await storage.sendAgentMail(coordinatorSender("conversation-1"), {
        requestId: "request",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "do the thing",
      });
      await inject(storage, "e1", "agent", request.id);
      await storage.updateAgentMailboxPolicy(coordinatorEnvironmentId, "tab-conversation-1", {
        inject: "off",
      });
      const report = await storage.replyAgentMail(tab("e1"), request.id, "report", "done");
      expect(report).toMatchObject({
        placement: "stored",
        injectDepth: 1,
        placementReason: "inject-policy-off",
      });
      // The default policy is still off: only the routed report is promoted.
      await storage.updateAgentMailboxPolicy(coordinatorEnvironmentId, "tab-conversation-1", {
        inject: "inherit",
      });
      expect(
        await storage.getAgentMailMessage(
          coordinatorEnvironmentId,
          "tab-conversation-1",
          report.id,
        ),
      ).toMatchObject({ placement: "pending-inject" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a peer budget pauses unattended exchange until a user prompt resets it", async () => {
    const { storage, dataDir } = await peerFixture();
    try {
      const budget = DEFAULT_AGENT_MESSAGING_SETTINGS.autonomousWakeBudget;
      const send = (index: number) =>
        storage.sendAgentMail(tab(index % 2 === 0 ? "e1" : "e2"), {
          requestId: `peer-${index}`,
          toEnvironmentId: index % 2 === 0 ? "e2" : "e1",
          toTabId: "agent",
          body: `message ${index}`,
        });
      for (let index = 0; index < budget; index += 1) {
        expect((await send(index)).placement).toBe("pending-inject");
      }
      const held = await send(budget);
      expect(held).toMatchObject({
        placement: "inject-held",
        placementReason: "loop-budget-exhausted",
      });
      // Peers have no coordinator to tell.
      for (const environmentId of ["e1", "e2"]) {
        const inbox = await storage.getAgentMailMailbox(environmentId, "agent");
        expect(inbox.messages.some((message) => message.from.kind === "system")).toBe(false);
      }

      expect(await storage.resetAgentMailBudgetForSession("e2", "env-e2:agent")).toBe(true);
      // Nothing routed since the reset: a second prompt writes nothing.
      expect(await storage.resetAgentMailBudgetForSession("e2", "env-e2:agent")).toBe(false);
      expect(await send(budget + 1)).toMatchObject({ placement: "pending-inject", threadDepth: 0 });
      // The prompt resets the budget; it does not deliver what was already held.
      expect(await storage.getAgentMailMessage("e2", "agent", held.id)).toMatchObject({
        placement: "inject-held",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("the hourly limit holds mail and releases it as the hour passes", async () => {
    const { storage, dataDir } = await peerFixture();
    try {
      const config = await storage.loadConfig();
      await storage.saveConfig({
        ...config,
        global: {
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, hourlyWakeLimit: 2 },
        },
      });
      const send = (index: number) =>
        storage.sendAgentMail(tab("e1"), {
          requestId: `hourly-${index}`,
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: `message ${index}`,
        });
      await send(0);
      await send(1);
      const held = await send(2);
      expect(held).toMatchObject({ placement: "inject-held", placementReason: "hourly-limit" });
      expect(await storage.releaseHourlyHeldAgentMail()).toBe(0);

      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      for (const stored of persisted.mailboxes["e2\0agent"]!.messages) {
        if ((stored as { id?: string }).id !== held.id)
          stored.createdAt = stored.wakeAdmittedAt = new Date(
            Date.now() - 2 * 3_600_000,
          ).toISOString();
      }
      seedStore(dataDir, "agent-mail.json", persisted);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.releaseHourlyHeldAgentMail()).toBe(1);
      expect(await restarted.getAgentMailMessage("e2", "agent", held.id)).toMatchObject({
        placement: "pending-inject",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
  test("default peer mail stays stored until peer wake is enabled", async () => {
    const { storage, dataDir } = await fixture();
    try {
      expect((await storage.loadConfig()).global.agentMessaging?.wakePeers).toBe(false);
      expect(
        await storage.sendAgentMail(tab("e1"), {
          requestId: "default-peer",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "hello",
        }),
      ).toMatchObject({ placement: "stored", placementReason: "inject-policy-off" });
      expect(await storage.listPendingAgentMailInjects()).toHaveLength(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  for (const side of [false, true])
    test(`alternating main/${side ? "side" : "worker"} mail consumes one shared budget`, async () => {
      const { storage, dataDir } = await coordinatorFixture();
      try {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, autonomousWakeBudget: 4 },
        });
        if (!side) await storage.coordinators.openCoordinatorDelegation("launch-e1", "agent");
        const main = coordinatorSender("conversation-1");
        const other = side ? coordinatorSender("conversation-2") : tab("e1");
        for (let index = 0; index < 6; index += 1) {
          const sender = index % 2 === 0 ? main : other;
          const recipient = index % 2 === 0 ? other : main;
          const message = await storage.sendAgentMail(sender, {
            requestId: `alternate-${index}`,
            toEnvironmentId: recipient.environmentId,
            toTabId: recipient.tabId,
            body: `exchange ${index}`,
          });
          expect(message.threadDepth).toBe(index);
          if (index >= 4)
            expect(message).toMatchObject({
              placement: "inject-held",
              placementReason: "loop-budget-exhausted",
            });
          else
            expect(message.placement).toBe(
              !side && index % 2 === 1 ? "inject-held" : "pending-inject",
            );
        }
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });

  test("omitted-tab resolution refreshes layout and idempotent replay survives replacement", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const layout = (ids: string[]) => ({
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf" as const,
          id: "pane",
          tabs: ids.map((id) => ({
            id,
            type: "agent-native" as const,
            nativeAgentData: { environmentId: "e2", platform: "claude" as const },
          })),
          activeTabId: ids[0]!,
        },
      });
      await storage.savePaneLayout("e2", layout([]), 1);
      await storage.synchronizeAgentMailboxes();
      await storage.savePaneLayout("e2", layout(["new-agent"]), 2);
      expect(await storage.resolveAgentMailRecipientTab(tab("e1"), "e2")).toBe("new-agent");
      const input = {
        requestId: "omitted-tab",
        toEnvironmentId: "e2",
        toTabId: "",
        body: "same intent",
      };
      const original = await storage.sendAgentMail(tab("e1"), input);
      await storage.savePaneLayout("e2", layout(["new-agent", "second-agent"]), 3);
      await expect(storage.resolveAgentMailRecipientTab(tab("e1"), "e2")).rejects.toMatchObject({
        code: "recipient-not-found",
      });
      await storage.savePaneLayout("e2", layout(["replacement-a", "replacement-b"]), 4);
      await expect(storage.resolveAgentMailRecipientTab(tab("e1"), "e2")).rejects.toMatchObject({
        code: "recipient-not-found",
      });
      expect((await storage.sendAgentMail(tab("e1"), input)).id).toBe(original.id);
      await expect(
        storage.sendAgentMail(tab("e1"), { ...input, body: "different" }),
      ).rejects.toMatchObject({ code: "idempotency-conflict" });
      await expect(
        storage.sendAgentMail(tab("e1"), { ...input, requestId: "fresh" }),
      ).rejects.toMatchObject({ code: "recipient-not-found" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("aged hourly backlog admits only one window of mail at a time", async () => {
    const { storage, dataDir } = await peerFixture();
    try {
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...config.global,
        agentMessaging: { ...config.global.agentMessaging!, hourlyWakeLimit: 2 },
      });
      for (let i = 0; i < 6; i += 1)
        await storage.sendAgentMail(tab("e1"), {
          requestId: `aged-${i}`,
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: `backlog ${i}`,
        });
      const persisted = readStoredValue<StoredMail>(dataDir, "agent-mail.json")!;
      const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
      for (const message of persisted.mailboxes["e2\0agent"]!.messages)
        message.createdAt = message.wakeAdmittedAt = old;
      seedStore(dataDir, "agent-mail.json", persisted);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await restarted.releaseHourlyHeldAgentMail();
      const messages = (await restarted.getAgentMailMailbox("e2", "agent")).messages;
      expect(messages.filter((message) => message.placementReason === "hourly-limit")).toHaveLength(
        2,
      );
      expect(
        messages.filter(
          (message) =>
            message.wakeAdmittedAt && Date.parse(message.wakeAdmittedAt) > Date.parse(old),
        ),
      ).toHaveLength(2);
      expect(await restarted.releaseHourlyHeldAgentMail()).toBe(0);
      expect(
        await restarted.sendAgentMail(tab("e1"), {
          requestId: "after-release",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "must wait",
        }),
      ).toMatchObject({ placementReason: "hourly-limit" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("stopped-worker hook starts only local family workers once and preserves later stops", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      const starts: string[] = [];
      const hook = stoppedWorkerMailHook(storage, async (id) => {
        starts.push(id);
      });
      const send = (id: string, requestId: string) =>
        storage.sendAgentMail(coordinatorSender("conversation-1"), {
          requestId,
          toEnvironmentId: id,
          toTabId: "agent",
          body: "request",
        });
      await storage.updateEnvironment("e1", { status: "stopped" });
      await storage.updateEnvironment("e2", { status: "stopped" });
      const unrelated = await send("e2", "non-worker");
      await hook("e2", unrelated);
      const first = await send("e1", "start-worker");
      const sibling = await send("e1", "start-worker-sibling");
      const now = Date.now();
      const clock = spyOn(Date, "now");
      try {
        for (let i = 0; i < 3; i += 1) {
          clock.mockReturnValue(now + i * 6 * 60_000);
          await drainWithStoppedHook(storage, hook);
        }
      } finally {
        clock.mockRestore();
      }
      await hook("e1", sibling);
      const restarted = new StorageService(dataDir);
      await restarted.init();
      await stoppedWorkerMailHook(restarted, async (id) => {
        starts.push(id);
      })("e1", first);
      expect(starts).toEqual(["e1"]);
      // A queued request must not reverse a later deliberate stop.
      await storage.updateEnvironment("e1", { status: "running" });
      const beforeStop = await send("e1", "before-stop");
      await storage.updateEnvironment("e1", { status: "stopped" });
      await hook("e1", beforeStop);
      expect(starts).toEqual(["e1"]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("two stopped-container requests share one stable notice without idempotency conflicts", async () => {
    const { storage, dataDir } = await coordinatorFixture();
    try {
      await storage.updateEnvironment("e1", {
        status: "stopped",
        environmentType: "containerized",
      });
      let starts = 0;
      const hook = stoppedWorkerMailHook(storage, async () => {
        starts += 1;
      });
      for (let i = 0; i < 2; i += 1) {
        const message = await storage.sendAgentMail(coordinatorSender("conversation-1"), {
          requestId: `container-${i}`,
          toEnvironmentId: "e1",
          toTabId: "agent",
          body: `request ${i}`,
        });
        expect(message.route).toBe("coordinator");
      }
      await drainWithStoppedHook(storage, hook);
      await drainWithStoppedHook(storage, hook);
      expect(starts).toBe(0);
      const notices = (
        await storage.getAgentMailMailbox(
          coordinatorRuntimeId("coordinator-1", "conversation-1"),
          "tab-conversation-1",
        )
      ).messages.filter((message) => message.requestId.startsWith("worker-stopped:"));
      expect(notices).toHaveLength(1);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
