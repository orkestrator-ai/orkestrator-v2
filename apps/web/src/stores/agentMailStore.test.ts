import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMailMailboxSnapshot, AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { invoke } from "@/lib/native/backend";
import { waitFor } from "@testing-library/react";
import {
  requestAgentMailMailbox,
  refreshObservedAgentMailMailboxes,
  useAgentMailStore,
} from "./agentMailStore";

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
          userUnseenCount: 1,
          agentUnackedCount: 1,
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

  test("reports a later injection failure for a message sent by this client", () => {
    const sent = { ...message(1), placement: "pending-inject" as const };
    useAgentMailStore.getState().trackSent(sent);
    const failed = mailbox(2, 2);
    failed.messages[0] = {
      ...failed.messages[0]!,
      placement: "inject_failed",
      placementReason: "rejected",
    };
    useAgentMailStore.getState().setMailbox(failed);

    expect(useAgentMailStore.getState().failedSent.get(sent.id)).toMatchObject({
      id: sent.id,
      body: sent.body,
    });
    expect(useAgentMailStore.getState().sent.has(sent.id)).toBe(false);
  });

  test("reports failure after an intermediate revision invalidates the body cache", () => {
    const sent = { ...message(1), placement: "pending-inject" as const };
    useAgentMailStore.getState().setMailbox(mailbox(1, 1));
    useAgentMailStore.getState().trackSent(sent);
    const held = mailbox(2, 2);
    held.messages[0] = {
      ...held.messages[0]!,
      placement: "pending-inject",
      placementReason: "busy",
    };
    useAgentMailStore.getState().setMailbox(held);
    expect(useAgentMailStore.getState().bodies.has(sent.id)).toBe(false);

    const failed = mailbox(3, 3);
    failed.messages[0] = {
      ...failed.messages[0]!,
      placement: "inject_failed",
      placementReason: "rejected",
    };
    useAgentMailStore.getState().setMailbox(failed);

    expect(useAgentMailStore.getState().failedSent.get(sent.id)).toMatchObject({
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
    const read = useAgentMailStore.getState().refreshMailbox("env-1", "tab-1");
    useAgentMailStore.getState().clear();
    finish(mailbox(1));
    await read;
    expect(useAgentMailStore.getState().mailboxes.size).toBe(0);
  });

  beforeEach(() => {
    useAgentMailStore.setState(useAgentMailStore.getInitialState());
    useAgentMailStore.getState().clear();
  });
  test("batches same-tick requests and skips loaded or already requested mailboxes", async () => {
    const refreshMailboxes = mock(
      async (_addresses: Array<{ environmentId: string; tabId: string }>) => undefined,
    );
    useAgentMailStore.setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    requestAgentMailMailbox("env-2", "tab-2");
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    expect(refreshMailboxes).toHaveBeenCalledWith([
      { environmentId: "env-1", tabId: "tab-1" },
      { environmentId: "env-2", tabId: "tab-2" },
    ]);
    requestAgentMailMailbox("env-1", "tab-1");
    useAgentMailStore.getState().setMailbox(mailbox(1));
    requestAgentMailMailbox("env-1", "tab-1");
    await Promise.resolve();
    expect(refreshMailboxes).toHaveBeenCalledTimes(1);
  });
  test("failed requests can be retried", async () => {
    const refreshMailboxes = mock(async () => undefined);
    refreshMailboxes.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    useAgentMailStore.setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(2));
  });
  test("clear cancels pending requests and resets loaded/requested state", async () => {
    const refreshMailboxes = mock(async () => undefined);
    useAgentMailStore.setState({ refreshMailboxes });
    requestAgentMailMailbox("env-1", "tab-1");
    useAgentMailStore.getState().clear();
    await Promise.resolve();
    expect(refreshMailboxes).not.toHaveBeenCalled();
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(1));
    useAgentMailStore.getState().setMailbox(mailbox(1));
    useAgentMailStore.getState().updateDraft("pair", { body: "draft" });
    useAgentMailStore.getState().clear();
    expect(useAgentMailStore.getState().drafts.size).toBe(0);
    expect(useAgentMailStore.getState().mailboxes.size).toBe(0);
    requestAgentMailMailbox("env-1", "tab-1");
    await waitFor(() => expect(refreshMailboxes).toHaveBeenCalledTimes(2));
  });
  test("summary reconciliation refreshes cached transcript destinations without local sent tracking", async () => {
    const refreshMailboxes = mock(async () => undefined);
    useAgentMailStore.setState({ refreshMailboxes });
    useAgentMailStore.getState().setMailbox(mailbox(1));
    const entry = { ...mailbox(1).descriptor, revision: 2 };
    useAgentMailStore.getState().setSummary({ revision: 2, mailboxes: [entry] });
    await refreshObservedAgentMailMailboxes();
    expect(refreshMailboxes).toHaveBeenCalledWith([{ environmentId: "env-1", tabId: "tab-1" }]);
    useAgentMailStore.getState().setMailbox(mailbox(2));
    refreshMailboxes.mockClear();
    await refreshObservedAgentMailMailboxes();
    expect(refreshMailboxes).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  useAgentMailStore.getState().clear();
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
});
