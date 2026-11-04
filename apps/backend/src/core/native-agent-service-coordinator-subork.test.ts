/**
 * `/subork` in a coordinator conversation goes to the coordinator as the same
 * instruction an environment tab's agent gets: call `ask_agents`, which its
 * control MCP offers. Provider fakes only.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
  stripCoordinatorContext,
  type CoordinatorConversation,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { parseSuborkRequestCarrier, SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import { NativeAgentService } from "./native-agent-service.js";
import {
  createProviderStub,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";
import { createProject } from "./storage.js";

const HEAD = "a".repeat(40);

describe("/subork in a coordinator conversation", () => {
  test("sends the coordinator the instruction to call ask_agents", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-coordinator-subork-"));
    const storage = await createStorage(dataDir);
    const checkout = path.join(dataDir, "checkout");
    await fs.mkdir(checkout);
    const project = await storage.addProject(createProject("remote", checkout));
    const now = new Date(0).toISOString();
    const conversation: CoordinatorConversation = {
      id: "conversation-1",
      tabId: "coordinator-tab",
      logicalSessionKey: "",
      agent: "codex",
      title: "Coordinator",
      createdAt: now,
      mailboxIncarnationId: "incarnation-1",
      role: "main",
    };
    conversation.logicalSessionKey = coordinatorConversationSessionKey(
      "coordinator-1",
      conversation,
    );
    await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "coordinator-1",
      projectId: project.id,
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: [conversation],
      selectedConversationId: "conversation-1",
      repositoryContextRevision: 0,
      createdAt: now,
      updatedAt: now,
      repositoryStatus: {
        projectId: project.id,
        repositoryRoot: checkout,
        revision: 1,
        branch: "main",
        detached: false,
        unborn: false,
        headCommit: HEAD,
        upstream: "origin/main",
        upstreamCommit: HEAD,
        remote: "origin",
        ahead: 0,
        behind: 0,
        remoteState: "fresh",
        fetchedAt: now,
        trackedChanges: 0,
        untrackedChanges: 0,
        conflicts: 0,
        mergeInProgress: false,
        rebaseInProgress: false,
        sequencerInProgress: false,
        operationState: "idle",
        repositoryOperationBlockedReason: null,
        branches: [],
        lastError: null,
      } as ProjectGitStatus,
    }));
    const provider = createProviderStub("codex");
    const service = new NativeAgentService(storage, refusingInvoke, {
      provider: async () => provider.provider,
      beginCoordinatorTurn: () => () => undefined,
    });
    try {
      await service.dispatchPrompt({
        environmentId: coordinatorRuntimeId("coordinator-1", "conversation-1"),
        agent: "codex",
        logicalSessionKey: conversation.logicalSessionKey,
        requestId: "request-1",
        prompt: "/subork ask opus 5.5 and grok 4.7 to rate this code change out of 10",
        command: { kind: "typed" },
      });
      const sent = provider.send.mock.calls[0]![1];
      expect(parseSuborkRequestCarrier(stripCoordinatorContext(sent))).toEqual({
        request: "ask opus 5.5 and grok 4.7 to rate this code change out of 10",
      });
      expect(sent).toContain(SUBORK_TOOL_NAME);
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
