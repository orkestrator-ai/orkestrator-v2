import { describe, expect, test } from "bun:test";
import {
  agentMailboxId,
  agentMailParticipantKey,
  type AgentMailMessage,
  type MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import {
  agentMailConversationBetween,
  listAgentMailConversations,
} from "./agent-mail-conversations.ts";

const LIVE = agentMailboxId("env-live", "tab");
const GONE = agentMailboxId("env-gone", "tab");

const descriptor = {
  mailboxId: LIVE,
  environmentId: "env-live",
  tabId: "tab",
  environmentName: "Live",
  projectId: "p",
  displayName: "Claude 1",
  agent: "claude",
  capabilities: { canPull: true, canSend: true, canInject: true },
} as MailboxDescriptor;

function message(id: string, createdAt: string, body: string): AgentMailMessage {
  return {
    version: 1,
    id,
    threadId: id,
    requestId: id,
    createdAt,
    from: {
      kind: "tab",
      projectId: "p",
      environmentId: "env-gone",
      tabId: "tab",
      incarnationId: "i",
      agent: "codex",
      title: "Codex 2 · worker",
    },
    toEnvironmentId: "env-live",
    toTabId: "tab",
    toIncarnationId: "i",
    body,
    bodyBytes: body.length,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "stored",
    revision: 1,
  };
}

describe("agent mail conversations", () => {
  test.each([
    ["worker", "worker on omarchy-hp", undefined],
    ["Claude 2", "Claude 2 on omarchy-hp", "worker"],
  ])(
    "keeps the node sender's environment distinct from title %s",
    (title, displayName, environmentName) => {
      const from = {
        kind: "node" as const,
        role: "agent" as const,
        nodeId: "bk_hp",
        nodeName: "omarchy-hp",
        projectId: "p",
        environmentId: "leaf-env",
        tabId: "tab",
        title,
        environmentName: "worker",
      };
      const key = agentMailParticipantKey(from);
      const mailboxes = [
        {
          descriptor,
          messages: [{ ...message("node-mail", "2026-10-18T10:00:00.000Z", "Report"), from }],
        },
      ];
      const [summary] = listAgentMailConversations(mailboxes, { cutoff: 0 });
      const conversation = agentMailConversationBetween(mailboxes, key, LIVE, {
        cutoff: 0,
        revision: 1,
      });
      for (const participants of [summary!.participants, conversation.participants]) {
        const participant = participants.find((candidate) => candidate.key === key)!;
        expect(participant.displayName).toBe(displayName);
        expect(participant.environmentName).toBe(environmentName);
      }
    },
  );

  test("keep a removed sender's name from its messages and skip expired mail", () => {
    const mailboxes = [
      {
        descriptor,
        messages: [
          message("old", "2020-01-01T00:00:00.000Z", "expired"),
          message("new", "2026-10-18T10:00:00.000Z", "x".repeat(400)),
        ],
      },
    ];
    const cutoff = Date.parse("2026-01-01T00:00:00.000Z");
    const [summary] = listAgentMailConversations(mailboxes, { cutoff });
    expect(summary!.messageCount).toBe(1);
    expect(summary!.lastPreview.length).toBe(160);
    expect(summary!.lastPreview.endsWith("…")).toBe(true);
    const gone = summary!.participants.find(({ key }) => key === GONE)!;
    expect(gone).toMatchObject({
      displayName: "Codex 2 · worker",
      agent: "codex",
      closed: true,
      canReceive: false,
    });

    const conversation = agentMailConversationBetween(mailboxes, GONE, LIVE, {
      cutoff,
      revision: 7,
    });
    expect(conversation.messages.map(({ id }) => id)).toEqual(["new"]);
    expect(conversation.revision).toBe(7);
  });
});
