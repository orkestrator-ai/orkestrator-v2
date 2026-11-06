import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture } from "./agent-mail-service-test-support.js";

test("holds mail for a conversation whose platform is off, and nobody else's", async () => {
  const { storage, dataDir } = await fixture();
  const delivered: string[] = [];
  try {
    const now = new Date(0).toISOString();
    const conversation = (id: string, agent: "claude" | "codex", role: "main" | "side") => ({
      id,
      tabId: `tab-${id}`,
      logicalSessionKey: `coordinator-coordinator-1:${id}`,
      agent,
      title: id,
      createdAt: now,
      mailboxIncarnationId: `incarnation-${id}`,
      role,
      ...(role === "side" ? { sideOrdinal: 1 } : {}),
    });
    await storage.coordinators.mutateCoordinatorWorkspace("project", () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "coordinator-1",
      projectId: "project",
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: [
        conversation("main", "codex", "main"),
        conversation("side", "claude", "side"),
      ],
      selectedConversationId: "main",
      repositoryContextRevision: 0,
      createdAt: now,
      updatedAt: now,
    }));
    await storage.synchronizeAgentMailboxes();
    const coordinatorRoute = {
      kind: "coordinator" as const,
      projectId: "project",
      coordinatorId: "coordinator-1",
      conversationId: "main",
      environmentId: coordinatorRuntimeId("coordinator-1", "main"),
      tabId: "tab-main",
    };
    const toSide = await storage.sendAgentMail(coordinatorRoute, {
      requestId: "to-side",
      toEnvironmentId: coordinatorRuntimeId("coordinator-1", "side"),
      toTabId: "tab-side",
      body: "For the side agent.",
    });
    await storage.sendAgentMail(
      { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
      {
        requestId: "to-main",
        toEnvironmentId: "coordinator",
        toTabId: "",
        body: "For the main.",
      },
    );
    const config = await storage.loadConfig();
    const enabled = (enabledAgentPlatforms: ("claude" | "codex")[]) =>
      storage.saveConfig({ ...config, global: { ...config.global, enabledAgentPlatforms } });
    await enabled(["codex"]);
    const service = new AgentMailService(
      storage,
      {
        reconcileMailInject: async () => "unknown",
        sessionActivitySnapshot: () => "idle",
        dispatchMailInject: async (input) => {
          delivered.push(input.environmentId);
          return { outcome: "accepted", requestId: input.requestId };
        },
      },
      { dispatchMailInject: async () => ({ outcome: "accepted" }) },
    );
    await service.init();
    await service.drainInjects();

    expect(delivered).toEqual([coordinatorRuntimeId("coordinator-1", "main")]);
    const side = coordinatorRuntimeId("coordinator-1", "side");
    expect(await storage.getAgentMailMessage(side, "tab-side", toSide.id)).toMatchObject({
      placement: "pending-inject",
    });
    // Waiting left no backoff behind: the next pass after it returns delivers.
    await enabled(["codex", "claude"]);
    await service.drainInjects();
    expect(delivered).toEqual([coordinatorRuntimeId("coordinator-1", "main"), side]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
