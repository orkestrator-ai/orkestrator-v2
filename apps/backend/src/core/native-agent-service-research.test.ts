import { expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { createProject, StorageService } from "./storage.js";
import { seedStore } from "./storage-test-support.js";

for (const agent of ["codex", "opencode"] as const) {
  test(`${agent} continues a legacy coordinator through research changes and restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-research-transition-"));
    let storage = new StorageService(join(root, "data"));
    await storage.init();
    const checkout = join(root, "checkout");
    await mkdir(checkout);
    const project = await storage.addProject(createProject("remote", checkout));
    const timestamp = new Date(0).toISOString();
    const identity = {
      environmentId: coordinatorRuntimeId("coordinator", "conversation"),
      agent,
      logicalSessionKey: "coordinator-coordinator:conversation",
    };
    await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
      version: COORDINATOR_WORKSPACE_VERSION,
      id: "coordinator",
      projectId: project.id,
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      lifecycleState: "ready",
      conversations: [
        {
          id: "conversation",
          tabId: "tab",
          logicalSessionKey: identity.logicalSessionKey,
          agent,
          title: "Coordinator",
          createdAt: timestamp,
          mailboxIncarnationId: "mail",
        },
      ],
      selectedConversationId: "conversation",
      repositoryContextRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const key = nativeAgentSessionStorageKey(
      identity.environmentId,
      agent,
      identity.logicalSessionKey,
    );
    const oldPolicy = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "coordinator",
      undefined,
      "off",
    );
    const legacy = {
      ...identity,
      key,
      version: 1,
      providerSessionId: "same-conversation",
      origin: "coordinator",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      owner: { kind: "coordinator", projectId: project.id, coordinatorId: "coordinator" },
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      policy: oldPolicy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    seedStore(storage.getDataDir(), "native-agent-sessions.json", {
      [key]: { ...legacy, owner: undefined, executionPolicy: undefined },
    });
    const send = mock(async () => undefined);
    const resumeSession = mock(
      async (
        _id: string,
        _controls?: unknown,
        _policy?: Parameters<
          NonNullable<NativeAgentRuntimeProvider["synchronizeSessionPolicy"]>
        >[1],
      ) => "same-conversation",
    );
    const createSession = mock(async () => "must-not-create");
    const provider = {
      agent,
      send,
      resumeSession,
      ...(agent === "opencode"
        ? {
            synchronizeSessionPolicy: async (
              id: string,
              policy: Parameters<
                NonNullable<NativeAgentRuntimeProvider["synchronizeSessionPolicy"]>
              >[1],
            ) => {
              await resumeSession(id, undefined, policy);
            },
          }
        : {}),
      createSession,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      dispose: async () => undefined,
    } as unknown as NativeAgentRuntimeProvider;
    const makeService = () =>
      new NativeAgentService(
        storage,
        async (command) => {
          throw new Error(`Unexpected command: ${command}`);
        },
        { provider: async () => provider },
      );
    let service = makeService();
    try {
      // Readiness and dispatch may concurrently discover the same legacy row.
      const ready = await Promise.all([
        service.ensureSession(identity),
        service.ensureSession(identity),
      ]);
      expect(ready.every((session) => session.providerSessionId === "same-conversation")).toBe(
        true,
      );
      for (const [index, mode] of (
        [undefined, "off", "search", "search-and-mcp", "off"] as const
      ).entries()) {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({ ...config.global, coordinatorWebResearch: mode });
        if (agent === "opencode" && index === 1) {
          resumeSession.mockRejectedValueOnce(new Error("Policy update failed"));
          await expect(service.ensureSession(identity)).rejects.toThrow("Policy update failed");
          expect(
            (await storage.getNativeAgentSession(key))?.policy?.capabilityPolicy?.allow,
          ).toEqual(["web.search"]);
        }
        if (index >= 2) {
          await service.shutdown();
          storage = new StorageService(join(root, "data"));
          await storage.init();
          service = makeService();
        }
        await service.dispatchPrompt({
          ...identity,
          requestId: `request-${index}`,
          prompt: "Inspect this",
          policy: { ...oldPolicy, approvals: "auto-approve" },
        });
        const saved = await storage.getNativeAgentSession(key);
        expect(saved?.providerSessionId).toBe("same-conversation");
        expect(saved?.policy?.capabilityPolicy?.allow ?? []).toEqual(
          mode === "off" ? [] : ["web.search"],
        );
        expect(saved?.policy?.capabilityPolicy?.deny).toContain("network");
        expect(saved?.policy?.approvals).toBe("deny");
        const prompt = (send.mock.calls.at(-1) as unknown as [string, string])[1];
        expect(prompt).toContain(
          mode === "off"
            ? "Web search and research servers are also off"
            : "For research you may use your web search tool",
        );
        expect(prompt.includes("research MCP servers context7")).toBe(
          mode === undefined || mode === "search-and-mcp",
        );
        if (agent === "opencode")
          expect(resumeSession).toHaveBeenLastCalledWith(
            "same-conversation",
            undefined,
            saved?.policy,
          );
      }
      expect(send).toHaveBeenCalledTimes(5);
      expect(createSession).not.toHaveBeenCalled();
      await service.shutdown();
      // A persisted ownership or unrelated policy mismatch remains a collision.
      for (const change of [
        { owner: { ...legacy.owner, coordinatorId: "forged" } },
        { policy: { ...oldPolicy, approvals: "auto-approve" } },
      ]) {
        seedStore(storage.getDataDir(), "native-agent-sessions.json", {
          [key]: { ...legacy, ...change },
        });
        service = makeService();
        await expect(service.ensureSession(identity)).rejects.toThrow(
          "Native agent session key collision",
        );
        await service.shutdown();
      }
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}
