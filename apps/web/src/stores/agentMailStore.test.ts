import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMailMailboxSnapshot, AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "./agentMailStore";

function message(revision = 1): AgentMailMessage {
  return {
    version: 1,
    id: "message-1",
    threadId: "message-1",
    requestId: "request-1",
    createdAt: new Date(0).toISOString(),
    from: { kind: "user" },
    toEnvironmentId: "env-1",
    toTabId: "tab-1",
    toIncarnationId: "incarnation-1",
    body: "secret body",
    bodyBytes: 11,
    trust: "user",
    injectDepth: 0,
    threadDepth: 0,
    placement: "stored",
    revision,
  };
}

function mailbox(revision: number, messageRevision = 1): AgentMailMailboxSnapshot {
  const { body: _body, ...summary } = message(messageRevision);
  return {
    descriptor: {
      mailboxId: "env-1\0tab-1",
      incarnationId: "incarnation-1",
      projectId: "project-1",
      projectName: "Project",
      environmentId: "env-1",
      environmentName: "Environment",
      environmentStatus: "running",
      tabId: "tab-1",
      tabType: "agent-native",
      title: "Agent",
      agent: "claude",
      kind: "native",
      presence: "unknown",
      injectPolicy: "off",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 1,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
    messages: [summary],
    total: 1,
    offset: 0,
    limit: 100,
    revision,
  };
}

describe("agentMailStore authoritative adoption", () => {
  beforeEach(() => useAgentMailStore.getState().clear());

  test("rejects summary and mailbox revision regressions", () => {
    useAgentMailStore.getState().setSummary({
      revision: 5,
      mailboxes: [
        {
          mailboxId: "env-1\0tab-1",
          projectId: "project-1",
          environmentId: "env-1",
          tabId: "tab-1",
          unreadCount: 1,
          pendingInjectCount: 0,
          failedInjectCount: 0,
          revision: 5,
        },
      ],
    });
    useAgentMailStore.getState().setSummary({ revision: 4, mailboxes: [] });
    expect(useAgentMailStore.getState().summary.size).toBe(1);

    useAgentMailStore.getState().setMailbox(mailbox(5));
    useAgentMailStore.getState().setMailbox({ ...mailbox(4), messages: [] });
    expect(useAgentMailStore.getState().mailboxes.get("env-1\0tab-1")?.messages).toHaveLength(1);
  });

  test("invalidates changed bodies and removes caches absent from the summary", () => {
    useAgentMailStore.getState().setMailbox(mailbox(1));
    useAgentMailStore.setState({ bodies: new Map([["message-1", message(1)]]) });
    useAgentMailStore.getState().setMailbox(mailbox(2, 2));
    expect(useAgentMailStore.getState().bodies.has("message-1")).toBe(false);

    useAgentMailStore.setState({ bodies: new Map([["message-1", message(2)]]) });
    useAgentMailStore.getState().setSummary({ revision: 3, mailboxes: [] });
    expect(useAgentMailStore.getState().mailboxes.size).toBe(0);
    expect(useAgentMailStore.getState().bodies.size).toBe(0);
  });
});
