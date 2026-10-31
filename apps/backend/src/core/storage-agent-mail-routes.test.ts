import { AgentMailService } from "./agent-mail-service.js";
import { stoppedWorkerMailHook } from "./agent-mail-stopped-worker.js";
import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { readStoredValue, seedStore } from "./storage-test-support.js";
import { StorageService } from "./storage.js";
import { fixture, type StoredMail } from "./agent-mail-storage-test-support.js";

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
