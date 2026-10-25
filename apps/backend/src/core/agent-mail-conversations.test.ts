import { describe, expect, test } from "bun:test";
import {
  agentMailboxId,
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
