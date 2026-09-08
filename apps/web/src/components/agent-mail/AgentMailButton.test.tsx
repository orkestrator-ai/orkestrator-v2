import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realSonner from "sonner";
import type {
  AgentMailInboxSnapshot,
  AgentMailMessage,
  AgentMailMessageSummary,
} from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";

const sendAgentMail = mock(async (_input: Record<string, unknown>) => message("stored"));
const listAgentMailboxes = mock(async () => ({
  mailboxes: snapshot.directory,
  total: snapshot.directory.length,
  offset: 0,
  limit: 200,
}));
const listAgentMailSent = mock(async (): Promise<AgentMailMessageSummary[]> => []);
const getAgentMailMessage = mock(async () => message("stored"));
const getAgentMailMailboxes = mock(
  async (addresses: Array<{ environmentId: string; tabId: string }>) => ({
    revision: 1,
    mailboxes: addresses.map(({ environmentId, tabId }) => ({
      ...mailboxSnapshot(),
      descriptor:
        environmentId === peerMailbox.environmentId && tabId === peerMailbox.tabId
          ? peerMailbox
          : snapshot.directory[0]!,
    })),
  }),
);
const retryAgentMailInject = mock(async () => message("pending-inject"));
const discardAgentMailInject = mock(async () => message("expired"));
const updateAgentMailboxPolicy = mock(async () => snapshot.directory[0]!);
const markAgentMailSeen = mock(async () => message("stored"));
const toastError = mock(() => undefined);
const toastSuccess = mock(() => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  sendAgentMail,
  listAgentMailboxes,
  listAgentMailSent,
  getAgentMailMessage,
  getAgentMailMailboxes,
  retryAgentMailInject,
  discardAgentMailInject,
  updateAgentMailboxPolicy,
  markAgentMailSeen,
}));
mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: toastError, success: toastSuccess },
}));

const { AgentMailButton, openAgentMailForTab } = await import("./AgentMailButton");
const { AgentMailBanner } = await import("./AgentMailBanner");

function message(placement: AgentMailMessage["placement"]): AgentMailMessage {
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
    body: "hello",
    bodyBytes: 5,
    trust: "user",
    injectDepth: 0,
    threadDepth: 0,
    placement,
    ...(placement === "bounced" ? { placementReason: "recipient-muted" } : {}),
    revision: 1,
  };
}

const snapshot: AgentMailInboxSnapshot = {
  revision: 1,
  directory: [
    {
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
      unreadCount: 0,
      userUnseenCount: 0,
      agentUnackedCount: 0,
      pendingInjectCount: 0,
      failedInjectCount: 0,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
  ],
  mailboxes: [],
  summary: { revision: 1, mailboxes: [] },
};

const peerMailbox = {
  ...snapshot.directory[0]!,
  mailboxId: "env-2\0tab-2",
  incarnationId: "incarnation-2",
  environmentId: "env-2",
  environmentName: "Peer environment",
  tabId: "tab-2",
  displayName: "Claude 2 · Peer",
  title: "Claude 2 · Peer",
  tabOrdinal: 2,
};

function mailboxSnapshot(messages: AgentMailInboxSnapshot["mailboxes"][number]["messages"] = []) {
  return {
    descriptor: snapshot.directory[0]!,
    messages,
    total: messages.length,
    offset: 0,
    limit: 100,
    revision: 1,
  };
}

function installTabMailbox(messages: AgentMailInboxSnapshot["mailboxes"][number]["messages"] = []) {
  const current = mailboxSnapshot(messages);
  useAgentMailStore.setState({
    summary: new Map([
      [
        current.descriptor.mailboxId,
        {
          mailboxId: current.descriptor.mailboxId,
          projectId: current.descriptor.projectId,
          environmentId: current.descriptor.environmentId,
          tabId: current.descriptor.tabId,
          unreadCount: messages.length,
          userUnseenCount: messages.length,
          agentUnackedCount: messages.length,
          pendingInjectCount: 0,
          failedInjectCount: 0,
          revision: current.revision,
        },
      ],
    ]),
    mailboxes: new Map([[current.descriptor.mailboxId, current]]),
    refreshMailbox: mock(async () => undefined),
    refreshSummary: mock(async () => undefined),
  });
}

function installBannerMailbox(
  placement: AgentMailMessage["placement"],
  options: { presence?: "idle" | "working"; policy?: "off" | "idle"; reason?: string } = {},
) {
  const full = {
    ...message(placement),
    ...(options.reason ? { placementReason: options.reason } : {}),
  };
  const { body: _body, ...summaryMessage } = full;
  const pending = placement === "pending-inject" || placement === "inject-held" ? 1 : 0;
  const failed = placement === "inject_failed" ? 1 : 0;
  const descriptor = {
    ...snapshot.directory[0]!,
    presence: options.presence ?? ("idle" as const),
    injectPolicy: options.policy ?? ("idle" as const),
    injectOverride: options.policy ?? ("idle" as const),
    pendingInjectCount: pending,
    failedInjectCount: failed,
  };
  useAgentMailStore.setState({
    revision: 2,
    summary: new Map([
      [
        descriptor.mailboxId,
        {
          mailboxId: descriptor.mailboxId,
          projectId: descriptor.projectId,
          environmentId: descriptor.environmentId,
          tabId: descriptor.tabId,
          unreadCount: 1,
          userUnseenCount: 1,
          agentUnackedCount: 1,
          pendingInjectCount: pending,
          failedInjectCount: failed,
          revision: 2,
        },
      ],
    ]),
    mailboxes: new Map([
      [
        descriptor.mailboxId,
        {
          descriptor,
          messages: [summaryMessage],
          total: 1,
          offset: 0,
          limit: 100,
          revision: 2,
        },
      ],
    ]),
    refreshMailbox: mock(async () => undefined),
    refreshSummary: mock(async () => undefined),
  });
}

function setMessagingEnabled(enabled: boolean): void {
  const config = structuredClone(useConfigStore.getInitialState().config);
  config.global.agentMessaging = { ...config.global.agentMessaging!, enabled };
  useConfigStore.setState({ config });
}

async function openComposer(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Agent inbox" }));
  fireEvent.click(await screen.findByRole("button", { name: "New" }));
  fireEvent.change(screen.getByLabelText("Message destination"), {
    target: { value: "env-1\0tab-1" },
  });
  fireEvent.change(screen.getByPlaceholderText("Markdown message"), {
    target: { value: "hello" },
  });
}

beforeEach(() => {
  cleanup();
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
  useAgentMailStore.setState({ refreshInbox: mock(async () => snapshot) });
  sendAgentMail.mockClear();
  sendAgentMail.mockImplementation(async () => message("stored"));
  toastError.mockClear();
  toastSuccess.mockClear();
  listAgentMailboxes.mockClear();
  listAgentMailboxes.mockImplementation(async () => ({
    mailboxes: [snapshot.directory[0]!, peerMailbox],
    total: 2,
    offset: 0,
    limit: 200,
  }));
  listAgentMailSent.mockClear();
  listAgentMailSent.mockImplementation(async () => []);
  getAgentMailMessage.mockClear();
  getAgentMailMessage.mockImplementation(async () => message("stored"));
  getAgentMailMailboxes.mockClear();
  getAgentMailMailboxes.mockImplementation(async (addresses) => ({
    revision: 1,
    mailboxes: addresses.map(({ environmentId, tabId }) => ({
      ...mailboxSnapshot(),
      descriptor:
        environmentId === peerMailbox.environmentId && tabId === peerMailbox.tabId
          ? peerMailbox
          : snapshot.directory[0]!,
    })),
  }));
  retryAgentMailInject.mockClear();
  retryAgentMailInject.mockImplementation(async () => message("pending-inject"));
  discardAgentMailInject.mockClear();
  discardAgentMailInject.mockImplementation(async () => message("expired"));
  updateAgentMailboxPolicy.mockClear();
  updateAgentMailboxPolicy.mockImplementation(async () => snapshot.directory[0]!);
  markAgentMailSeen.mockClear();
  setMessagingEnabled(true);
});

afterAll(() => {
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
  mock.module("@/lib/backend", () => realBackend);
  mock.module("sonner", () => realSonner);
});

describe("AgentMailButton", () => {
  test("renders no messaging surface when the feature is disabled", () => {
    setMessagingEnabled(false);
    render(<AgentMailButton />);
    expect(screen.queryByRole("button", { name: "Agent inbox" }) === null).toBe(true);
  });

  test("reuses the compose idempotency key after an ambiguous failure", async () => {
    sendAgentMail
      .mockImplementationOnce(async () => {
        throw new Error("response lost");
      })
      .mockImplementationOnce(async () => message("stored"));
    render(<AgentMailButton />);
    await openComposer();

    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(2));

    expect(sendAgentMail.mock.calls[0]?.[0].requestId).toBe(
      sendAgentMail.mock.calls[1]?.[0].requestId,
    );
  });

  test("keeps the draft open and reports a muted-recipient bounce", async () => {
    sendAgentMail.mockImplementationOnce(async () => message("bounced"));
    render(<AgentMailButton />);
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    expect((screen.getByPlaceholderText("Markdown message") as HTMLTextAreaElement).value).toBe(
      "hello",
    );
  });

  test("uses a new idempotency key after a definitive bounce", async () => {
    sendAgentMail
      .mockImplementationOnce(async () => message("bounced"))
      .mockImplementationOnce(async () => message("stored"));
    render(<AgentMailButton />);
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(2));

    expect(sendAgentMail.mock.calls[0]?.[0].requestId).not.toBe(
      sendAgentMail.mock.calls[1]?.[0].requestId,
    );
  });

  test("filters destinations that cannot pull agent mail", async () => {
    const browser = {
      ...snapshot.directory[0]!,
      mailboxId: "env-1\0browser",
      tabId: "browser",
      tabType: "browser",
      displayName: "Browser 2",
      title: "Browser 2",
      agent: null,
      kind: "ui" as const,
      capabilities: { canPull: false, canSend: false, canInject: false },
    };
    useAgentMailStore.setState({
      refreshInbox: mock(async () => ({
        ...snapshot,
        directory: [...snapshot.directory, browser],
      })),
    });
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Agent inbox" }));
    fireEvent.click(await screen.findByRole("button", { name: "New" }));

    expect(screen.queryByText("Browser 2") === null).toBe(true);
    expect(screen.getAllByText("Claude 1 · Agent").length).toBeGreaterThan(0);
  });

  test("opens the composer addressed to the tab from the window event", async () => {
    render(<AgentMailButton />);
    expect(screen.queryByPlaceholderText("Markdown message") === null).toBe(true);

    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    expect(await screen.findByPlaceholderText("Markdown message")).toBeTruthy();
    expect((screen.getByLabelText("Message destination") as HTMLSelectElement).value).toBe(
      "env-1\0tab-1",
    );
    fireEvent.change(screen.getByPlaceholderText("Markdown message"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    expect(sendAgentMail.mock.calls[0]?.[0]).toMatchObject({
      toEnvironmentId: "env-1",
      toTabId: "tab-1",
    });
  });

  test("opens the tab's inbox settings from the window event without a composer", async () => {
    render(<AgentMailButton />);

    act(() => openAgentMailForTab("env-1", "tab-1", "settings"));
    expect(await screen.findByLabelText("Automatic delivery policy")).toBeTruthy();
    expect(screen.getAllByText("Claude 1 · Agent").length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText("Markdown message") === null).toBe(true);
    fireEvent.change(screen.getByLabelText("Automatic delivery policy"), {
      target: { value: "idle" },
    });
    await waitFor(() =>
      expect(updateAgentMailboxPolicy).toHaveBeenCalledWith({
        environmentId: "env-1",
        tabId: "tab-1",
        inject: "idle",
      }),
    );
  });

  test("fetches a tab mailbox the directory does not list yet", async () => {
    useAgentMailStore.setState({
      refreshInbox: mock(async () => ({ ...snapshot, directory: [] })),
    });
    getAgentMailMailboxes.mockImplementation(async () => ({
      revision: 1,
      mailboxes: [{ ...mailboxSnapshot(), descriptor: peerMailbox }],
    }));
    render(<AgentMailButton />);

    act(() => openAgentMailForTab("env-2", "tab-2", "compose"));
    await waitFor(() =>
      expect(getAgentMailMailboxes).toHaveBeenCalledWith([
        { environmentId: "env-2", tabId: "tab-2" },
      ]),
    );
    expect(await screen.findByLabelText("Automatic delivery policy")).toBeTruthy();
    expect((screen.getByLabelText("Message destination") as HTMLSelectElement).value).toBe(
      "env-2\0tab-2",
    );
  });

  test("shows recipients missing from the directory in the Sent view", async () => {
    installTabMailbox();
    const sent = {
      ...message("stored"),
      id: "sent-to-peer",
      from: {
        kind: "tab" as const,
        environmentId: "env-1",
        projectId: "project-1",
        tabId: "tab-1",
        incarnationId: "incarnation-1",
        agent: "claude" as const,
        title: "Claude 1 · Agent",
      },
      toEnvironmentId: "env-2",
      toTabId: "tab-2",
      toIncarnationId: "incarnation-2",
    };
    const { body: _body, ...summary } = sent;
    listAgentMailSent.mockImplementation(async () => [summary]);
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Agent inbox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sent" }));
    expect(await screen.findByText("To Claude 2 · Peer")).toBeTruthy();
  });

  test("explains a recipient compose draft in the sender status line", async () => {
    installTabMailbox();
    listAgentMailboxes.mockImplementation(async () => ({
      mailboxes: [snapshot.directory[0]!, { ...peerMailbox, presence: "draft" }],
      total: 2,
      offset: 0,
      limit: 200,
    }));
    getAgentMailMailboxes.mockImplementation(async () => ({
      revision: 1,
      mailboxes: [
        {
          ...mailboxSnapshot(),
          descriptor: { ...peerMailbox, presence: "draft" },
        },
      ],
    }));
    const sent = {
      ...message("pending-inject"),
      id: "sent-to-draft",
      from: {
        kind: "tab" as const,
        environmentId: "env-1",
        projectId: "project-1",
        tabId: "tab-1",
        incarnationId: "incarnation-1",
        agent: "claude" as const,
        title: "Claude 1 · Agent",
      },
      toEnvironmentId: "env-2",
      toTabId: "tab-2",
      toIncarnationId: "incarnation-2",
    };
    const { body: _body, ...summary } = sent;
    listAgentMailSent.mockImplementation(async () => [summary]);
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Agent inbox" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sent" }));
    expect(await screen.findByText("Peer environment · recipient is composing")).toBeTruthy();
  });

  test("collapses a thread to its newest message and shows the message count", async () => {
    const older = {
      ...message("stored"),
      id: "older-message",
      threadId: "thread-with-history",
      subject: "Older subject",
      createdAt: new Date(0).toISOString(),
    };
    const newer = {
      ...older,
      id: "newer-message",
      subject: "Newest subject",
      createdAt: new Date(1_000).toISOString(),
    };
    const { body: _olderBody, ...olderSummary } = older;
    const { body: _newerBody, ...newerSummary } = newer;
    installTabMailbox([olderSummary, newerSummary]);
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Agent inbox, 2 unseen/ }));

    expect(await screen.findByText("Thread · 2 messages")).toBeTruthy();
    expect(screen.getByText("Newest subject")).toBeTruthy();
    expect(screen.queryByText("Older subject") === null).toBe(true);
  });

  test("keeps mailbox policy controls available when the inbox is empty", async () => {
    installTabMailbox();
    render(<AgentMailButton />);
    act(() => openAgentMailForTab("env-1", "tab-1", "settings"));

    expect(await screen.findByLabelText("Automatic delivery policy")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mute inbound" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mute outbound" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Automatic delivery policy"), {
      target: { value: "idle" },
    });
    await waitFor(() =>
      expect(updateAgentMailboxPolicy).toHaveBeenCalledWith({
        environmentId: "env-1",
        tabId: "tab-1",
        inject: "idle",
      }),
    );
  });

  test("describes recipient presence in the send action", async () => {
    for (const [presence, expected] of [
      ["idle", "Send · recipient idle, delivers now"],
      ["draft", "Send · recipient is composing"],
      ["working", "Send · recipient busy, delivers when idle"],
    ] as const) {
      cleanup();
      useAgentMailStore.setState(useAgentMailStore.getInitialState());
      useAgentMailStore.setState({
        refreshInbox: mock(async () => ({
          ...snapshot,
          directory: [{ ...snapshot.directory[0]!, injectPolicy: "idle" as const, presence }],
        })),
      });
      render(<AgentMailButton />);
      await openComposer();
      expect(screen.getByRole("button", { name: expected })).toBeTruthy();
    }
  });

  test("replies from the inbox to the original sender", async () => {
    const incoming = {
      ...message("stored"),
      id: "incoming",
      from: {
        kind: "tab" as const,
        environmentId: "env-2",
        projectId: "project-1",
        tabId: "tab-2",
        incarnationId: "incarnation-2",
        agent: "claude" as const,
        title: "Claude 2 · Peer",
      },
    };
    const { body: _body, ...incomingSummary } = incoming;
    installTabMailbox([incomingSummary]);
    getAgentMailMessage.mockImplementation(async () => incoming);
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Agent inbox, 1 unseen/ }));
    fireEvent.click(await screen.findByText("From Claude 2 · Peer"));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Markdown message"), {
      target: { value: "Acknowledged" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));

    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    expect(sendAgentMail.mock.calls[0]?.[0]).toMatchObject({
      toEnvironmentId: "env-2",
      toTabId: "tab-2",
      replyToMessageId: "incoming",
    });
  });

  test("closes an expanded body when a newer authoritative revision arrives", async () => {
    const incoming = {
      ...message("stored"),
      id: "incoming",
      body: "authoritative body",
      userSeenAt: new Date(0).toISOString(),
    };
    const { body: _body, ...incomingSummary } = incoming;
    const current = mailboxSnapshot([incomingSummary]);
    useAgentMailStore.setState({
      mailboxes: new Map([[current.descriptor.mailboxId, current]]),
      refreshSummary: mock(async () => undefined),
    });
    getAgentMailMessage.mockImplementation(async () => incoming);
    render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Agent inbox" }));
    fireEvent.click(await screen.findByText("From You"));
    expect(await screen.findByText("authoritative body")).toBeTruthy();

    act(() =>
      useAgentMailStore.getState().setMailbox({
        ...current,
        revision: 2,
        messages: [{ ...incomingSummary, revision: 2 }],
      }),
    );
    await waitFor(() => expect(screen.queryByText("authoritative body") === null).toBe(true));
  });

  test("reports discard failures and hides discard while submission is in flight", async () => {
    const failed = {
      ...message("inject_failed"),
      placementReason: "rejected",
      userSeenAt: new Date(0).toISOString(),
    };
    const { body: _body, ...failedSummary } = failed;
    installTabMailbox([failedSummary]);
    getAgentMailMessage.mockImplementation(async () => failed);
    discardAgentMailInject.mockImplementationOnce(async () => {
      throw new Error("submission won");
    });
    const view = render(<AgentMailButton />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /Agent inbox, 1 unseen/ }));
    fireEvent.click(await screen.findByText("From You"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect((await screen.findByRole("alert")).textContent).toContain("submission won");

    const submitting = {
      ...failed,
      placement: "inject-held" as const,
      placementReason: "submitting",
      revision: 2,
    };
    const { body: _submittingBody, ...submittingSummary } = submitting;
    act(() => installTabMailbox([submittingSummary]));
    getAgentMailMessage.mockImplementation(async () => submitting);
    view.rerender(<AgentMailButton />);
    fireEvent.click(await screen.findByText("From You"));
    expect(screen.queryByRole("button", { name: "Discard" }) === null).toBe(true);
  });

  test("reports rejected banner actions", async () => {
    installBannerMailbox("inject_failed", { reason: "rejected" });
    retryAgentMailInject.mockImplementationOnce(async () => {
      throw new Error("retry failed");
    });
    discardAgentMailInject.mockImplementationOnce(async () => {
      throw new Error("discard failed");
    });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByRole("alert")).textContent).toContain("retry failed");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("discard failed"));
  });

  test("delivers pending mail only when the recipient is available", async () => {
    installBannerMailbox("stored", { presence: "idle", policy: "off" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to deliver when idle" }));
    await waitFor(() => {
      expect(updateAgentMailboxPolicy).toHaveBeenCalledWith({
        environmentId: "env-1",
        tabId: "tab-1",
        inject: "idle",
      });
      expect(retryAgentMailInject).toHaveBeenCalledWith("env-1", "tab-1", "message-1");
    });

    cleanup();
    updateAgentMailboxPolicy.mockClear();
    retryAgentMailInject.mockClear();
    installBannerMailbox("pending-inject", { presence: "working", policy: "idle" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    expect(updateAgentMailboxPolicy).not.toHaveBeenCalled();
    expect(retryAgentMailInject).not.toHaveBeenCalled();
  });

  test("includes the unseen count in the global button's accessible name", () => {
    useAgentMailStore.setState({
      summary: new Map([
        [
          "env-1\0tab-1",
          {
            mailboxId: "env-1\0tab-1",
            projectId: "project-1",
            environmentId: "env-1",
            tabId: "tab-1",
            unreadCount: 3,
            userUnseenCount: 3,
            agentUnackedCount: 3,
            pendingInjectCount: 0,
            failedInjectCount: 0,
            revision: 1,
          },
        ],
      ]),
    });
    render(<AgentMailButton />);
    expect(screen.getByRole("button", { name: "Agent inbox, 3 unseen" })).toBeTruthy();
  });
});
