import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMailMailboxSnapshot, AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { invoke } from "@/lib/native/backend";
import { waitFor } from "@testing-library/react";
import {
  agentMailStore,
  refreshObservedAgentMailMailboxes,
  requestAgentMailMailbox,
} from "./agentMailStore";
import { appCommandStore } from "@/test/app-command-store";

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
      displayName: "Claude 1 · Agent",
      tabOrdinal: 1,
      agent: "claude",
      kind: "native",
      presence: "unknown",
      injectPolicy: "off",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 1,
      userUnseenCount: 1,
      agentUnackedCount: 1,
      pendingInjectCount: 0,
      failedInjectCount: 0,
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
  beforeEach(() => appCommandStore(agentMailStore).getState().clear());

  test("rejects summary and mailbox revision regressions", () => {
    appCommandStore(agentMailStore)
      .getState()
      .setSummary({
        revision: 5,
        mailboxes: [
          {
            mailboxId: "env-1\0tab-1",
            projectId: "project-1",
            environmentId: "env-1",
            tabId: "tab-1",
            unreadCount: 1,
            userUnseenCount: 1,
            agentUnackedCount: 1,
            pendingInjectCount: 0,
            failedInjectCount: 0,
            revision: 5,
          },
        ],
      });
    appCommandStore(agentMailStore).getState().setSummary({ revision: 4, mailboxes: [] });
    expect(appCommandStore(agentMailStore).getState().summary.size).toBe(1);

    appCommandStore(agentMailStore).getState().setMailbox(mailbox(5));
    appCommandStore(agentMailStore)
      .getState()
      .setMailbox({ ...mailbox(4), messages: [] });
    expect(
      appCommandStore(agentMailStore).getState().mailboxes.get("env-1\0tab-1")?.messages,
    ).toHaveLength(1);
  });

  test("invalidates changed bodies and removes caches absent from the summary", () => {
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(1));
    appCommandStore(agentMailStore).setState({ bodies: new Map([["message-1", message(1)]]) });
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(2, 2));
    expect(appCommandStore(agentMailStore).getState().bodies.has("message-1")).toBe(false);

    appCommandStore(agentMailStore).setState({ bodies: new Map([["message-1", message(2)]]) });
    appCommandStore(agentMailStore).getState().setSummary({ revision: 3, mailboxes: [] });
    expect(appCommandStore(agentMailStore).getState().mailboxes.size).toBe(0);
    expect(appCommandStore(agentMailStore).getState().bodies.size).toBe(0);
  });

  test("reports a later injection failure for a message sent by this client", () => {
    const sent = { ...message(1), placement: "pending-inject" as const };
    appCommandStore(agentMailStore).getState().trackSent(sent);
    const failed = mailbox(2, 2);
    failed.messages[0] = {
      ...failed.messages[0]!,
      placement: "inject_failed",
      placementReason: "rejected",
    };
    appCommandStore(agentMailStore).getState().setMailbox(failed);

    expect(appCommandStore(agentMailStore).getState().failedSent.get(sent.id)).toMatchObject({
      id: sent.id,
      body: sent.body,
    });
    expect(appCommandStore(agentMailStore).getState().sent.has(sent.id)).toBe(false);
  });

  test("reports failure after an intermediate revision invalidates the body cache", () => {
    const sent = { ...message(1), placement: "pending-inject" as const };
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(1, 1));
    appCommandStore(agentMailStore).getState().trackSent(sent);
    const held = mailbox(2, 2);
    held.messages[0] = {
      ...held.messages[0]!,
      placement: "pending-inject",
      placementReason: "busy",
    };
    appCommandStore(agentMailStore).getState().setMailbox(held);
    expect(appCommandStore(agentMailStore).getState().bodies.has(sent.id)).toBe(false);

    const failed = mailbox(3, 3);
    failed.messages[0] = {
      ...failed.messages[0]!,
      placement: "inject_failed",
      placementReason: "rejected",
    };
    appCommandStore(agentMailStore).getState().setMailbox(failed);

    expect(appCommandStore(agentMailStore).getState().failedSent.get(sent.id)).toMatchObject({
      id: sent.id,
      body: sent.body,
      placement: "inject_failed",
      placementReason: "rejected",
    });
  });
});

describe("transcript mailbox requests", () => {
  test("clear fences an in-flight mailbox response", async () => {
    let finish!: (snapshot: AgentMailMailboxSnapshot) => void;
    const invokeMock = invoke as ReturnType<typeof mock>;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<AgentMailMailboxSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const read = appCommandStore(agentMailStore).getState().refreshMailbox("env-1", "tab-1");
    appCommandStore(agentMailStore).getState().clear();
    finish(mailbox(1));
    await read;
    expect(appCommandStore(agentMailStore).getState().mailboxes.size).toBe(0);
  });

  beforeEach(() => {
    appCommandStore(agentMailStore).setState(appCommandStore(agentMailStore).getInitialState());
    appCommandStore(agentMailStore).getState().clear();
  });
  test("batches same-tick requests and skips loaded or already requested mailboxes", async () => {
    const refreshMailboxes = mock(
      async (_addresses: Array<{ environmentId: string; tabId: string }>) => undefined,
    );
    appCommandStore(agentMailStore).setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    requestAgentMailMailbox("env-2", "tab-2");
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    expect(refreshMailboxes).toHaveBeenCalledWith([
      { environmentId: "env-1", tabId: "tab-1" },
      { environmentId: "env-2", tabId: "tab-2" },
    ]);
    requestAgentMailMailbox("env-1", "tab-1");
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(1));
    requestAgentMailMailbox("env-1", "tab-1");
    await Promise.resolve();
    expect(refreshMailboxes).toHaveBeenCalledTimes(1);
  });
  test("failed requests can be retried", async () => {
    const refreshMailboxes = mock(async () => undefined);
    refreshMailboxes.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    appCommandStore(agentMailStore).setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(2));
  });
  test("clear cancels pending requests and resets loaded/requested state", async () => {
    const refreshMailboxes = mock(async () => undefined);
    appCommandStore(agentMailStore).setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    appCommandStore(agentMailStore).getState().clear();
    await Promise.resolve();
    expect(refreshMailboxes).not.toHaveBeenCalled();
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(1));
    appCommandStore(agentMailStore).getState().updateDraft("pair", { body: "draft" });
    appCommandStore(agentMailStore).getState().clear();
    expect(appCommandStore(agentMailStore).getState().drafts.size).toBe(0);
    expect(appCommandStore(agentMailStore).getState().mailboxes.size).toBe(0);
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(2));
  });
  test("summary reconciliation refreshes cached transcript destinations without local sent tracking", async () => {
    const refreshMailboxes = mock(async () => undefined);
    appCommandStore(agentMailStore).setState({ refreshMailboxes });
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(1));
    const entry = { ...mailbox(1).descriptor, revision: 2 };
    appCommandStore(agentMailStore)
      .getState()
      .setSummary({ revision: 2, mailboxes: [entry] });
    await refreshObservedAgentMailMailboxes();
    expect(refreshMailboxes).toHaveBeenCalledWith([{ environmentId: "env-1", tabId: "tab-1" }]);
    appCommandStore(agentMailStore).getState().setMailbox(mailbox(2));
    refreshMailboxes.mockClear();
    await refreshObservedAgentMailMailboxes();
    expect(refreshMailboxes).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  appCommandStore(agentMailStore).getState().clear();
  appCommandStore(agentMailStore).setState(appCommandStore(agentMailStore).getInitialState());
});
