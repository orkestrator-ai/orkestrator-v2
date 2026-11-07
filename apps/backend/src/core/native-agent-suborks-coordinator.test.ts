/**
 * A coordinator conversation's `ask_agents`: the control MCP tool's command
 * revalidates the conversation, runs the suborks in the project home (the
 * coordinator's own checkout) and delivers the answers to the conversation's
 * mailbox, where its session's rows and Stop find them. Provider fakes only.
 */
import { registrarFrom } from "./commands-registry-contracts.js";
import { afterEach, describe, expect, test } from "bun:test";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
  type CoordinatorConversation,
} from "@orkestrator/protocol/coordinator";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorSuborkActions } from "./coordinator-subork-actions.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { suborkWorld, type SuborkWorld } from "./native-agent-suborks-test-support.js";

const worlds: SuborkWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

const RUNTIME = coordinatorRuntimeId("coordinator-1", "conversation-1");
const SCOPE = { projectId: "p1", coordinatorId: "coordinator-1", conversationId: "conversation-1" };

async function coordinatorWorld(options: { homeFails?: boolean; agentless?: boolean } = {}) {
  const w = await suborkWorld();
  worlds.push(w);
  const now = new Date(0).toISOString();
  const conversation: CoordinatorConversation = {
    id: "conversation-1",
    tabId: "coordinator-tab",
    logicalSessionKey: "",
    ...(options.agentless ? {} : { agent: "claude" as const }),
    title: "Coordinator",
    createdAt: now,
    mailboxIncarnationId: "incarnation-1",
    role: "main",
  };
  conversation.logicalSessionKey = coordinatorConversationSessionKey("coordinator-1", conversation);
  await w.storage.coordinators.mutateCoordinatorWorkspace("p1", () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: "coordinator-1",
    projectId: "p1",
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [conversation],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 0,
    createdAt: now,
    updatedAt: now,
  }));
  await w.storage.synchronizeAgentMailboxes();
  const commands = new Map<string, CommandHandler>();
  const homes: string[] = [];
  // The fixture's `e1` stands in for the project home, the checkout's environment.
  commands.set("ensure_project_home_environment", async (args) => {
    homes.push(String((args as { projectId: string }).projectId));
    if (options.homeFails) throw new Error("This project has no local checkout configured");
    return w.storage.getEnvironment("e1");
  });
  registerCoordinatorSuborkActions(
    registrarFrom((name, handler) => commands.set(name, handler)),
    { commands },
  );
  const context = { storage: w.storage, suborks: w.service } as unknown as CommandContext;
  return {
    w,
    homes,
    conversation,
    ask: (input: Record<string, unknown>) =>
      commands.get("ask_coordinator_suborks")!({ scope: SCOPE, input }, context) as Promise<{
        batchId: string;
        next: string;
        suborks: { name: string; status: string; agent?: string; error?: string }[];
      }>,
  };
}

describe("ask_agents from a coordinator conversation", () => {
  test("runs in the project home and answers the conversation", async () => {
    const { w, homes, conversation, ask } = await coordinatorWorld();
    const started = await ask({
      targets: [{ model: "opus 5.5" }, { agent: "codex" }],
      prompt: "Rate this code change out of 10.",
    });
    expect(homes).toEqual(["p1"]);
    expect(started.suborks.map((entry) => entry.status)).toEqual(["starting", "starting"]);
    const stored = w.storage.suborks.getSuborkBatch(started.batchId)!;
    expect(stored.environmentId).toBe(RUNTIME);
    expect(stored.runEnvironmentId).toBe("e1");
    expect(stored.tabId).toBe("coordinator-tab");
    await w.drive(started.batchId);
    // The conversation's own session sees the rows.
    const sessionKey = nativeAgentSessionStorageKey(
      RUNTIME,
      "claude",
      conversation.logicalSessionKey,
    );
    expect(w.service.views(sessionKey)?.[0]?.suborks.map((entry) => entry.status)).toEqual([
      "finished",
      "finished",
    ]);
    // The suborks ran in the home, the coordinator's checkout.
    expect(new Set(w.connectionEnvironments)).toEqual(new Set(["e1"]));
    expect(
      w
        .provider("claude")
        .turns()
        .map((turn) => turn.prompt)
        .join("\n"),
    ).toContain("Rate this code change out of 10.");
    const mailbox = await w.storage.getAgentMailMailbox(RUNTIME, "coordinator-tab", { limit: 10 });
    const delivered = mailbox.messages.find((message) =>
      message.subject?.startsWith("Subork answers"),
    );
    expect(delivered?.subject).toBe("Subork answers: 2 of 2 finished");
    const body = (await w.storage.getAgentMailMessage(RUNTIME, "coordinator-tab", delivered!.id))
      .body;
    expect(body).toContain("claude says hi");
    expect(body).toContain("codex says hi");
  });

  test("muted inbound mail refuses a consultation before creating a home", async () => {
    const { w, homes, ask } = await coordinatorWorld();
    await w.storage.updateAgentMailboxPolicy(RUNTIME, "coordinator-tab", { mutedInbound: true });
    await expect(ask({ targets: [{ agent: "codex" }], prompt: "Look." })).rejects.toThrow("muted");
    expect(homes).toHaveLength(0);
    expect(await w.storage.suborks.listSuborkBatches()).toHaveLength(0);
  });

  test("delivery Off tells the coordinator answers wait in its inbox", async () => {
    const { w, ask } = await coordinatorWorld();
    await w.storage.updateAgentMailboxPolicy(RUNTIME, "coordinator-tab", { inject: "off" });
    const started = await ask({ targets: [{ agent: "codex" }], prompt: "Look." });
    expect(started.next).toContain("will not wake you");
    await w.drive(started.batchId);
    const mailbox = await w.storage.getAgentMailMailbox(RUNTIME, "coordinator-tab", { limit: 10 });
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]!.placement).toBe("stored");
  });

  test("deleting the project home clears live views and frees admission for the surviving caller", async () => {
    const { w, conversation, ask } = await coordinatorWorld();
    const sessionKey = nativeAgentSessionStorageKey(
      RUNTIME,
      "claude",
      conversation.logicalSessionKey,
    );
    const input = {
      targets: Array.from({ length: 4 }, () => ({ agent: "codex" })),
      prompt: "Look.",
    };
    const first = await ask(input);
    const second = await ask(input);
    expect(w.service.views(sessionKey)).toHaveLength(2);
    await w.service.advanceNow(first.batchId);
    await w.settleProviders();
    expect(w.provider("codex").turns().length).toBeGreaterThan(0);
    await w.storage.suborks.deleteSuborkBatchesByEnvironment("e1");
    const announcements = w.announced.length;
    await w.service.advanceNow(first.batchId);
    await w.service.advanceNow(second.batchId);
    expect(w.service.views(sessionKey)).toBeUndefined();
    expect(w.announced.slice(announcements)).toEqual([sessionKey, sessionKey]);
    // The coordinator still exists; a replacement home can accept all four targets.
    const next = await ask(input);
    expect(next.suborks.map((branch) => branch.status)).toEqual(Array(4).fill("starting"));
  });

  test("Stop on the conversation stops its calls", async () => {
    const { w, conversation, ask } = await coordinatorWorld();
    const started = await ask({ targets: [{ agent: "codex" }], prompt: "Look." });
    await w.service.stopForSession(
      nativeAgentSessionStorageKey(RUNTIME, "claude", conversation.logicalSessionKey),
    );
    expect(w.storage.suborks.getSuborkBatch(started.batchId)?.status).toBe("stopped");
  });

  test("a project without a checkout refuses with why, and an unassigned conversation too", async () => {
    const homeless = await coordinatorWorld({ homeFails: true });
    await expect(homeless.ask({ targets: [{ agent: "codex" }], prompt: "Look." })).rejects.toThrow(
      "Suborks run in this project's own checkout, which is not available: This project has no local checkout configured",
    );
    const agentless = await coordinatorWorld({ agentless: true });
    await expect(agentless.ask({ targets: [{ agent: "codex" }], prompt: "Look." })).rejects.toThrow(
      "no agent yet",
    );
  });

  test("a scope that does not name a live conversation is refused before anything starts", async () => {
    const { w, homes } = await coordinatorWorld();
    const commands = new Map<string, CommandHandler>();
    registerCoordinatorSuborkActions(
      registrarFrom((name, handler) => commands.set(name, handler)),
      { commands },
    );
    await expect(
      commands.get("ask_coordinator_suborks")!(
        { scope: { ...SCOPE, conversationId: "someone-else" }, input: { targets: [{}] } },
        { storage: w.storage, suborks: w.service } as unknown as CommandContext,
      ),
    ).rejects.toThrow("Coordinator identity is unavailable");
    expect(homes).toEqual([]);
  });
});
