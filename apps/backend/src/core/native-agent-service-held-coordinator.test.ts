import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { createNativeAgentDisplayTail } from "./native-agent-display-tails.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProject } from "./storage.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const CONVERSATION = "held";
const SIBLING = "sibling";
const logicalKey = (id: string) =>
  coordinatorConversationSessionKey("coordinator-1", { id, tabId: `tab-${id}` });
const session = (id: string) => ({
  environmentId: coordinatorRuntimeId("coordinator-1", id),
  agent: "codex" as const,
  logicalSessionKey: logicalKey(id),
});
const liveWindow = { messages: 100, targetBytes: 512 * 1024 };

/**
 * What "connecting" means for a conversation that may not run. The pane reads
 * while paused or after a failed start, and those reads must never reach what
 * starts a provider. `providerStarts` counts every resolution, because resolving
 * a provider is what starts its bridge.
 */
async function withHeldConversation(
  hold: "paused" | "startup-failed",
  run: (input: {
    service: Parameters<Parameters<typeof withService>[1]>[0]["service"];
    providerStarts: () => number;
  }) => Promise<void>,
) {
  let starts = 0;
  const stub = createProviderStub("codex");
  await withService(
    {
      prefix: `ork-held-coordinator-${hold}-`,
      provider: async () => {
        starts += 1;
        return stub.provider;
      },
    },
    async ({ storage, service }) => {
      const now = new Date(0).toISOString();
      const project = await storage.addProject(createProject("remote", tmpdir()));
      const conversation = (id: string, role: "main" | "side") => ({
        id,
        tabId: `tab-${id}`,
        logicalSessionKey: logicalKey(id),
        agent: "codex" as const,
        title: id,
        createdAt: now,
        mailboxIncarnationId: `incarnation-${id}`,
        role,
        ...(role === "side" ? { sideOrdinal: 1 } : {}),
      });
      await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: project.id,
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [conversation(CONVERSATION, "side"), conversation(SIBLING, "main")],
        selectedConversationId: CONVERSATION,
        repositoryContextRevision: 1,
        createdAt: now,
        updatedAt: now,
      }));
      for (const id of [CONVERSATION, SIBLING]) {
        const key = nativeAgentSessionStorageKey(
          session(id).environmentId,
          "codex",
          session(id).logicalSessionKey,
        );
        await storage.adoptNativeAgentSession({
          key,
          ...session(id),
          providerSessionId: `provider-${id}`,
        });
        await storage.putNativeAgentDisplayTail(
          key,
          createNativeAgentDisplayTail({
            ...session(id),
            providerSessionId: `provider-${id}`,
            historyEpoch: `epoch-${id}`,
            messages: [{ id: `row-${id}`, role: "assistant", content: "Saved answer", parts: [] }],
            updatedAt: now,
          })!,
        );
      }
      await storage.coordinators.mutateCoordinatorWorkspace(project.id, (workspace) => ({
        ...workspace!,
        ...(hold === "paused" ? { lifecycleState: "paused" as const } : {}),
        conversations: workspace!.conversations.map((item) =>
          hold === "startup-failed" && item.id === CONVERSATION
            ? { ...item, startupError: "bridge did not become healthy" }
            : item,
        ),
      }));
      await run({ service, providerStarts: () => starts });
    },
  );
}

describe.each(["paused", "startup-failed"] as const)("a %s coordinator conversation", (hold) => {
  test("answers every read a connecting pane sends from saved data, starting nothing", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = session(CONVERSATION);
      const transcript = await service.getTranscriptUpdate({
        ...input,
        viewVersion: 1,
        liveWindow,
      });
      expect(transcript).toMatchObject({
        status: "snapshot",
        value: { messages: [{ id: `row-${CONVERSATION}` }], freshness: "cached" },
      });
      const state = await service.getSessionStateUpdate({ ...input, viewVersion: 1 });
      expect(state).toMatchObject({
        status: "snapshot",
        value: { turn: { phase: "idle" }, interactions: [] },
      });
      expect(
        await service.getDiscoveryUpdate({ ...input, viewVersion: 1, sections: ["models"] }),
      ).toMatchObject({ status: "missing" });
      expect(
        await service.getLiveUpdate({
          ...input,
          viewVersion: 1,
          liveWindow,
          transcriptToken: "stale",
          stateToken: "stale",
        } as never),
      ).toMatchObject({ transcript: { status: "snapshot" }, state: { status: "snapshot" } });
      expect(await service.getProjection(input)).toMatchObject({
        messages: [{ id: `row-${CONVERSATION}` }],
        turn: { phase: "idle" },
      });

      expect(providerStarts()).toBe(0);
    });
  });

  test("repeats an unchanged background read without a body or a provider", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = session(CONVERSATION);
      const first = await service.getTranscriptUpdate({ ...input, viewVersion: 1, liveWindow });
      if (first.status !== "snapshot") throw new Error(`unexpected ${first.status}`);
      expect(
        await service.getTranscriptUpdate({
          ...input,
          viewVersion: 1,
          liveWindow,
          knownToken: first.token,
        }),
      ).toMatchObject({ status: "unchanged" });
      const state = await service.getSessionStateUpdate({ ...input, viewVersion: 1 });
      if (state.status !== "snapshot") throw new Error(`unexpected ${state.status}`);
      expect(
        await service.getSessionStateUpdate({ ...input, viewVersion: 1, knownToken: state.token }),
      ).toMatchObject({ status: "unchanged" });
      expect(providerStarts()).toBe(0);
    });
  });

  test("refuses to establish a session or start a turn, starting no provider", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = session(CONVERSATION);
      await expect(
        service.adoptSession({ ...input, providerSessionId: `provider-${CONVERSATION}` }),
      ).rejects.toThrow();
      await expect(service.ensureSession(input)).rejects.toThrow();
      await expect(
        service.dispatchPrompt({ ...input, prompt: "Hello", requestId: "held-prompt" } as never),
      ).rejects.toThrow();
      expect(providerStarts()).toBe(0);
    });
  });
});

describe("a conversation that failed to start", () => {
  test("leaves its sibling running against its provider", async () => {
    await withHeldConversation("startup-failed", async ({ service, providerStarts }) => {
      await service.getSessionStateUpdate({ ...session(CONVERSATION), viewVersion: 1 });
      expect(providerStarts()).toBe(0);
      await service.getSessionStateUpdate({ ...session(SIBLING), viewVersion: 1 });
      expect(providerStarts()).toBeGreaterThan(0);
    });
  });
});

test("a paused coordinator holds its sibling conversations too", async () => {
  await withHeldConversation("paused", async ({ service, providerStarts }) => {
    await service.getSessionStateUpdate({ ...session(SIBLING), viewVersion: 1 });
    expect(providerStarts()).toBe(0);
  });
});
