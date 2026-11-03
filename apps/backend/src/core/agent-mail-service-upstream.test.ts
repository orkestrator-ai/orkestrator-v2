import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture } from "./agent-mail-service-test-support.js";
import { fastForwardBeforeCoordinatorMail } from "./coordinator-mail-upstream.js";

test("a coordinator fetch cannot hold delivery to a worker mailbox", async () => {
  const { storage, dataDir } = await fixture();
  const runtimeId = coordinatorRuntimeId("coordinator-1", "conversation-1");
  const now = new Date().toISOString();
  await storage.coordinators.mutateCoordinatorWorkspace("project", () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: "coordinator-1",
    projectId: "project",
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [
      {
        id: "conversation-1",
        tabId: "coordinator-tab",
        logicalSessionKey: "coordinator-coordinator-1:conversation-1",
        agent: "claude",
        title: "Coordinator",
        createdAt: now,
        mailboxIncarnationId: "coord-incarnation",
        role: "main",
      },
    ],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 0,
    createdAt: now,
    updatedAt: now,
  }));
  await storage.synchronizeAgentMailboxes();
  let release!: (status: ProjectGitStatus) => void;
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  let workerDelivered!: () => void;
  const worker = new Promise<void>((resolve) => {
    workerDelivered = resolve;
  });
  const git = {
    isCheckoutBusy: async () => false,
    fetch: async () => {
      started();
      return new Promise<ProjectGitStatus>((resolve) => {
        release = resolve;
      });
    },
    sync: async () => {
      throw new Error("Unexpected sync");
    },
  };
  let coordinatorDelivered = false;
  const service = new AgentMailService(
    storage,
    {
      reconcileMailInject: async () => "unknown",
      sessionActivitySnapshot: () => "idle",
      mailInjectPresence: async () => "idle",
      dispatchMailInject: async (input) => {
        await fastForwardBeforeCoordinatorMail(
          { storage, git, timeoutMs: 10_000 },
          input.environmentId,
        );
        if (input.environmentId === "recipient") workerDelivered();
        else coordinatorDelivered = true;
        return { outcome: "accepted", requestId: input.requestId };
      },
    },
    { dispatchMailInject: async () => ({ outcome: "accepted" }) },
  );
  let draining: Promise<void> | undefined;
  try {
    // Enqueue before starting the pass, coordinator first.
    for (const [id, tab] of [
      [runtimeId, "coordinator-tab"],
      ["recipient", "agent"],
    ]) {
      await storage.sendAgentMail(
        { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
        { requestId: `mail-${id}`, toEnvironmentId: id!, toTabId: tab!, body: "Report" },
      );
    }
    draining = service.drainInjects();
    await fetching;
    await worker;
    // The coordinator fetch remains pending when the worker receives its mail.
    expect(release).toBeFunction();
    expect(coordinatorDelivered).toBe(false);
  } finally {
    release?.({ behind: 0 } as ProjectGitStatus);
    await draining;
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
