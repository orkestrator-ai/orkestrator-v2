import { describe, expect, setSystemTime, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentMailboxId, agentMailConversationKey } from "@orkestrator/protocol/agent-mail";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { StorageService } from "./storage.js";

const E1 = agentMailboxId("e1", "agent");
const E2 = agentMailboxId("e2", "agent");
const E3 = agentMailboxId("e3", "agent");

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-mail-conversations-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: "p1",
    name: "p1",
    gitUrl: "https://example.invalid/p1.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (const environmentId of ["e1", "e2", "e3"]) {
    await storage.addEnvironment({
      id: environmentId,
      projectId: "p1",
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

function tab(environmentId: string) {
  return { kind: "tab" as const, environmentId, projectId: "p1", tabId: "agent" };
}

describe("StorageService agent mail conversations", () => {
  test("seen receipts exclude earlier history and messages arriving after the displayed snapshot", async () => {
    const { storage, dataDir } = await fixture();
    try {
      for (let index = 0; index < 51; index++) {
        await storage.sendAgentMail(
          { kind: "external" },
          {
            requestId: `external-${index}`,
            toEnvironmentId: "e2",
            toTabId: "agent",
            body: "Outside",
          },
        );
      }
      const loaded = await storage.getAgentMailConversation("external", E2);
      expect(loaded.total).toBe(51);
      expect(loaded.messages).toHaveLength(50);
      const late = await storage.sendAgentMail(
        { kind: "external" },
        {
          requestId: "late",
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "Late",
        },
      );
      expect(
        await storage.markAgentMailConversationSeen(
          "external",
          E2,
          loaded.messages.map(({ id }) => id),
        ),
      ).toBe(50);
      expect(
        (await storage.getAgentMailMessage("e2", "agent", late.id)).userSeenAt,
      ).toBeUndefined();
      const all = await storage.getAgentMailConversation("external", E2, { limit: 200 });
      expect(all.messages.filter(({ userSeenAt }) => !userSeenAt)).toHaveLength(2);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("joins both directions of a pair, oldest first, and lists each pair once", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const ask = await storage.sendAgentMail(tab("e1"), {
        requestId: "ask",
        toEnvironmentId: "e2",
        toTabId: "agent",
        subject: "Parser",
        body: "Please inspect the parser.",
      });
      const answer = await storage.sendAgentMail(tab("e2"), {
        requestId: "answer",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "Done:\n\n  the   parser is fine.",
        replyToMessageId: ask.id,
      });
      await storage.sendAgentMail(tab("e1"), {
        requestId: "elsewhere",
        toEnvironmentId: "e3",
        toTabId: "agent",
        body: "Unrelated.",
      });
      await storage.sendAgentMail(
        { kind: "user" },
        { requestId: "from-user", toEnvironmentId: "e2", toTabId: "agent", body: "Hi" },
      );

      const conversation = await storage.getAgentMailConversation(E2, E1);
      expect(conversation.key).toBe(agentMailConversationKey(E1, E2));
      expect(conversation.messages.map(({ id }) => id)).toEqual([ask.id, answer.id]);
      expect(conversation.messages[0]!.body).toBe("Please inspect the parser.");
      expect(conversation.total).toBe(2);
      expect(conversation.participants.map(({ key }) => key).toSorted()).toEqual(
        [E1, E2].toSorted(),
      );
      expect(conversation.participants.every(({ canReceive }) => canReceive)).toBe(true);

      const limited = await storage.getAgentMailConversation(E1, E2, { limit: 1 });
      expect(limited.messages.map(({ id }) => id)).toEqual([answer.id]);
      expect(limited.total).toBe(2);

      const all = await storage.listAgentMailConversations();
      expect(all.conversations.map(({ key }) => key).toSorted()).toEqual(
        [
          agentMailConversationKey(E1, E2),
          agentMailConversationKey(E1, E3),
          agentMailConversationKey("user", E2),
        ].toSorted(),
      );
      const pair = all.conversations.find(({ key }) => key === agentMailConversationKey(E1, E2))!;
      expect(pair.messageCount).toBe(2);
      expect(pair.lastMessage.id).toBe(answer.id);
      expect(pair.lastPreview).toBe("Done: the parser is fine.");
      expect("body" in pair.lastMessage).toBe(false);
      // The person always sits second in a pair they are part of.
      const withUser = all.conversations.find(
        ({ key }) => key === agentMailConversationKey("user", E2),
      )!;
      expect(withUser.participants.map(({ kind }) => kind)).toEqual(["agent", "user"]);

      const forE3 = await storage.listAgentMailConversations({ participant: E3 });
      expect(forE3.conversations.map(({ key }) => key)).toEqual([agentMailConversationKey(E1, E3)]);
      expect(forE3.conversations[0]!.participants[0]!.key).toBe(E3);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps send order for mail sent within one millisecond", async () => {
    const { storage, dataDir } = await fixture();
    setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
    try {
      const sent = [];
      for (let index = 0; index < 20; index++) {
        sent.push(
          await storage.sendAgentMail(tab(index % 2 === 0 ? "e1" : "e2"), {
            requestId: `same-ms-${index}`,
            toEnvironmentId: index % 2 === 0 ? "e2" : "e1",
            toTabId: "agent",
            body: `Message ${index}`,
          }),
        );
      }
      const conversation = await storage.getAgentMailConversation(E1, E2);
      expect(conversation.messages.map(({ id }) => id)).toEqual(sent.map(({ id }) => id));
      const listed = await storage.listAgentMailConversations();
      expect(listed.conversations).toHaveLength(1);
      expect(listed.conversations[0]!.lastMessage.id).toBe(sent.at(-1)!.id);
      expect(listed.conversations[0]!.lastPreview).toBe("Message 19");
    } finally {
      setSystemTime();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("marks a conversation seen in one write and counts only mail that needs the person", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const first = await storage.sendAgentMail(tab("e1"), {
        requestId: "one",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "One",
      });
      const second = await storage.sendAgentMail(tab("e2"), {
        requestId: "two",
        toEnvironmentId: "e1",
        toTabId: "agent",
        body: "Two",
      });
      const external = await storage.sendAgentMail(
        { kind: "external" },
        { requestId: "outside", toEnvironmentId: "e2", toTabId: "agent", body: "Outside" },
      );

      const summary = await storage.getAgentMailSummary();
      const e2 = summary.mailboxes.find(({ mailboxId }) => mailboxId === E2)!;
      // Agent-to-agent mail is the agents' business; unseen external mail is the person's.
      expect(e2.userUnseenCount).toBe(2);
      expect(e2.attentionCount).toBe(1);
      const listed = await storage.listAgentMailConversations();
      expect(listed.conversations[0]!.key).toBe(agentMailConversationKey("external", E2));
      expect(listed.conversations[0]!.attentionCount).toBe(1);

      expect(
        await storage.markAgentMailConversationSeen(E1, E2, [first.id, second.id, external.id]),
      ).toBe(2);
      expect(
        await storage.markAgentMailConversationSeen(E1, E2, [first.id, second.id, external.id]),
      ).toBe(0);
      expect((await storage.getAgentMailMessage("e2", "agent", first.id)).userSeenAt).toBeString();
      expect(
        (await storage.getAgentMailMessage("e2", "agent", external.id)).userSeenAt,
      ).toBeUndefined();

      expect(await storage.markAgentMailConversationSeen("external", E2, [external.id])).toBe(1);
      const after = await storage.getAgentMailSummary();
      expect(after.mailboxes.find(({ mailboxId }) => mailboxId === E2)!.attentionCount).toBe(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
