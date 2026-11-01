import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import type {
  AgentMailConversation,
  AgentMailConversationSummary,
  AgentMailMessage,
  AgentMailParticipant,
  MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";
import {
  mockToastError as toastError,
  mockToastInfo as toastInfo,
} from "../../../../../tests/mocks/sonner";

const AGENT_1 = "env-1\0tab-1";
const AGENT_2 = "env-2\0tab-2";

const listAgentMailConversations = mock(
  async (
    _participant?: string,
  ): Promise<{ revision: number; conversations: AgentMailConversationSummary[] }> => ({
    revision: 1,
    conversations: [],
  }),
);
const getAgentMailConversation = mock(
  async (_a: string, _b: string, _limit?: number): Promise<AgentMailConversation> =>
    conversation([agent1, user], []),
);
const markAgentMailConversationSeen = mock(async () => ({ marked: 0 }));
const sendAgentMail = mock(async (_input: Record<string, unknown>) => mail("stored"));
const retryAgentMailInject = mock(async () => mail("pending-inject"));
const deliverAgentMailNow = mock(
  async (_environmentId: string, _tabId: string, _messageId: string): Promise<AgentMailMessage> =>
    mail("injected"),
);
const discardAgentMailInject = mock(async () => mail("expired"));
const updateAgentMailboxPolicy = mock(async (_input: Record<string, unknown>) => descriptor());
const listAgentMailboxes = mock(async () => ({
  mailboxes: [
    descriptor(),
    descriptor({
      mailboxId: AGENT_2,
      environmentId: "env-2",
      tabId: "tab-2",
      displayName: "Codex 2",
    }),
  ],
  total: 2,
  offset: 0,
  limit: 200,
}));
const openInBrowser = mock(async (_url: string) => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  listAgentMailConversations,
  getAgentMailConversation,
  markAgentMailConversationSeen,
  sendAgentMail,
  retryAgentMailInject,
  deliverAgentMailNow,
  discardAgentMailInject,
  updateAgentMailboxPolicy,
  listAgentMailboxes,
  openInBrowser,
}));

const { AgentMailButton } = await import("./AgentMailButton");
const { AgentMailPanel } = await import("./AgentMailPanel");
const { AgentMailBanner } = await import("./AgentMailBanner");
const { openAgentMailForTab } = await import("./agent-mail-ui");

function descriptor(overrides: Partial<MailboxDescriptor> = {}): MailboxDescriptor {
  return {
    mailboxId: AGENT_1,
    incarnationId: "incarnation-1",
    projectId: "project-1",
    projectName: "Project",
    environmentId: "env-1",
    environmentName: "Environment",
    environmentStatus: "running",
    tabId: "tab-1",
    tabType: "agent-native",
    title: "Claude 1",
    displayName: "Claude 1",
    tabOrdinal: 1,
    agent: "claude",
    kind: "native",
    presence: "idle",
    injectPolicy: "off",
    injectOverride: "inherit",
    mutedInbound: false,
    mutedOutbound: false,
    unreadCount: 0,
    userUnseenCount: 0,
    agentUnackedCount: 0,
    pendingInjectCount: 0,
    failedInjectCount: 0,
    capabilities: { canPull: true, canSend: true, canInject: true },
    ...overrides,
  };
}

const agent1: AgentMailParticipant = {
  key: AGENT_1,
  kind: "agent",
  displayName: "Claude 1",
  agent: "claude",
  environmentId: "env-1",
  tabId: "tab-1",
  canReceive: true,
};
const agent2: AgentMailParticipant = {
  key: AGENT_2,
  kind: "agent",
  displayName: "Codex 2",
  agent: "codex",
  environmentId: "env-2",
  tabId: "tab-2",
  canReceive: true,
};
const user: AgentMailParticipant = {
  key: "user",
  kind: "user",
  displayName: "You",
  agent: null,
  canReceive: false,
};

function mail(
  placement: AgentMailMessage["placement"],
  overrides: Partial<AgentMailMessage> = {},
): AgentMailMessage {
  return {
    version: 1,
    id: `message-${placement}`,
    threadId: "thread-1",
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
    revision: 1,
    ...overrides,
  };
}

function fromAgent(participant: AgentMailParticipant) {
  return {
    kind: "tab" as const,
    projectId: "project-1",
    environmentId: participant.environmentId!,
    tabId: participant.tabId!,
    incarnationId: "incarnation",
    agent: participant.agent,
    title: participant.displayName,
  };
}

function conversation(
  participants: [AgentMailParticipant, AgentMailParticipant],
  messages: AgentMailMessage[],
): AgentMailConversation {
  return {
    revision: 1,
    key: `${participants[0].key}\n${participants[1].key}`,
    participants,
    messages,
    total: messages.length,
  };
}

function setMessagingEnabled(enabled: boolean): void {
  const config = structuredClone(useConfigStore.getInitialState().config);
  config.global.agentMessaging = { ...config.global.agentMessaging!, enabled };
  useConfigStore.setState({ config });
}

function summaryEntry(overrides: { attentionCount?: number; failedInjectCount?: number }) {
  return {
    mailboxId: AGENT_1,
    projectId: "project-1",
    environmentId: "env-1",
    tabId: "tab-1",
    unreadCount: 5,
    userUnseenCount: 5,
    agentUnackedCount: 5,
    pendingInjectCount: 0,
    failedInjectCount: overrides.failedInjectCount ?? 0,
    ...(overrides.attentionCount === undefined ? {} : { attentionCount: overrides.attentionCount }),
    revision: 1,
  };
}

beforeEach(() => {
  cleanup();
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
  useAgentMailStore.setState({
    refreshMailbox: mock(async () => undefined),
    refreshSummary: mock(async () => undefined),
  });
  for (const fn of [
    listAgentMailConversations,
    getAgentMailConversation,
    markAgentMailConversationSeen,
    sendAgentMail,
    retryAgentMailInject,
    deliverAgentMailNow,
    discardAgentMailInject,
    updateAgentMailboxPolicy,
    listAgentMailboxes,
    openInBrowser,
    toastInfo,
    toastError,
  ])
    fn.mockClear();
  listAgentMailConversations.mockImplementation(async () => ({ revision: 1, conversations: [] }));
  getAgentMailConversation.mockImplementation(async () => conversation([agent1, user], []));
  sendAgentMail.mockImplementation(async () => mail("stored"));
  retryAgentMailInject.mockImplementation(async () => mail("pending-inject"));
  deliverAgentMailNow.mockImplementation(async () => mail("injected"));
  setMessagingEnabled(true);
});

afterAll(() => {
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
  mock.module("@/lib/backend", () => realBackend);
});

describe("AgentMailButton", () => {
  test("renders nothing when messaging is disabled", () => {
    setMessagingEnabled(false);
    render(<AgentMailButton />);
    expect(screen.queryByRole("button", { name: /Agent messages/ }) === null).toBe(true);
  });

  test("counts only mail that needs the person and opens the panel", () => {
    useAgentMailStore.setState({
      summary: new Map([
        [AGENT_1, summaryEntry({ attentionCount: 2, failedInjectCount: 1 })],
        // A summary without the field counts its failures.
        ["env-2\0tab-2", { ...summaryEntry({ failedInjectCount: 1 }), mailboxId: "env-2\0tab-2" }],
      ]),
    });
    render(<AgentMailButton />);
    fireEvent.click(screen.getByRole("button", { name: "Agent messages, 3 need you" }));
    expect(useAgentMailStore.getState().panel).toEqual({});
  });

  test("shows no badge for the agents' own unseen traffic", () => {
    useAgentMailStore.setState({
      summary: new Map([[AGENT_1, summaryEntry({ attentionCount: 0 })]]),
    });
    render(<AgentMailButton />);
    expect(screen.getByRole("button", { name: "Agent messages" })).toBeTruthy();
  });
});

describe("AgentMailPanel", () => {
  test("seen receipts cover an expanded history window even at the same revision", async () => {
    const older = mail("stored", { id: "older", body: "Earlier history" });
    const latest = mail("stored", { id: "latest", body: "Latest history" });
    getAgentMailConversation.mockImplementation(async (_a, _b, limit) => ({
      ...conversation([agent1, user], limit === 50 ? [latest] : [older, latest]),
      total: 2,
    }));
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    await waitFor(() =>
      expect(markAgentMailConversationSeen).toHaveBeenCalledWith(AGENT_1, "user", ["latest"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await waitFor(() =>
      expect(markAgentMailConversationSeen).toHaveBeenCalledWith(AGENT_1, "user", [
        "older",
        "latest",
      ]),
    );
  });

  test("retains a pair's subject and body across back navigation and closing", async () => {
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    fireEvent.change(await screen.findByPlaceholderText("Message Claude 1"), {
      target: { value: "Draft body" },
    });
    fireEvent.change(screen.getByPlaceholderText("Subject (optional)"), {
      target: { value: "Draft subject" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    act(() => useAgentMailStore.getState().closePanel());
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    expect(
      ((await screen.findByPlaceholderText("Message Claude 1")) as HTMLTextAreaElement).value,
    ).toBe("Draft body");
    expect((screen.getByPlaceholderText("Subject (optional)") as HTMLInputElement).value).toBe(
      "Draft subject",
    );
  });

  test("focused mailbox errors are visible and retry restores compose and settings", async () => {
    const refresh = mock(async () => {
      useAgentMailStore.getState().setMailbox({
        descriptor: descriptor(),
        messages: [],
        total: 0,
        offset: 0,
        limit: 200,
        revision: 1,
      });
    });
    refresh.mockImplementationOnce(async () => {
      throw new Error("Mailbox offline");
    });
    useAgentMailStore.setState({ refreshMailbox: refresh });
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1"));
    expect((await screen.findByRole("alert")).textContent).toContain("Mailbox offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry mailbox" }));
    expect(await screen.findByRole("button", { name: "Message" })).toBeTruthy();
    expect(screen.getByLabelText("Automatic delivery policy")).toBeTruthy();
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test.each([false, true])(
    "recipient search reaches later pages even if the first has no eligible recipients (%s)",
    async (ineligible) => {
      const firstPage = Array.from({ length: 200 }, (_, index) =>
        descriptor({
          mailboxId: `env-${index}\0tab`,
          displayName: `First agent ${index}`,
          ...(ineligible
            ? { capabilities: { canPull: false, canSend: false, canInject: false } }
            : {}),
        }),
      );
      listAgentMailboxes.mockImplementationOnce(async () => ({
        mailboxes: firstPage,
        total: 201,
        offset: 0,
        limit: 200,
      }));
      listAgentMailboxes.mockImplementationOnce(async () => ({
        mailboxes: [descriptor({ mailboxId: AGENT_2, displayName: "Last agent" })],
        total: 201,
        offset: 200,
        limit: 200,
      }));
      render(<AgentMailPanel />);
      act(() => useAgentMailStore.getState().openPanel({}));
      fireEvent.click(await screen.findByRole("button", { name: "New" }));
      fireEvent.change(screen.getByLabelText("Filter agents"), { target: { value: "Last agent" } });
      fireEvent.click(await screen.findByText("Last agent"));
      expect(listAgentMailboxes).toHaveBeenCalledWith({ offset: 200, limit: 200 });
      expect(useAgentMailStore.getState().panel?.conversation).toEqual([AGENT_2, "user"]);
    },
  );

  test("lists conversations and opens one as a thread in both directions", async () => {
    listAgentMailConversations.mockImplementation(async () => ({
      revision: 1,
      conversations: [
        {
          key: `${AGENT_1}\n${AGENT_2}`,
          participants: [agent1, agent2],
          lastMessage: (({ body: _body, ...rest }) => rest)(mail("stored")),
          lastPreview: "The parser is fine.",
          messageCount: 2,
          attentionCount: 1,
        },
      ],
    }));
    getAgentMailConversation.mockImplementation(async () =>
      conversation(
        [agent1, agent2],
        [
          mail("injected", {
            id: "ask",
            from: fromAgent(agent1),
            toEnvironmentId: "env-2",
            toTabId: "tab-2",
            body: "Please check the parser.",
            subject: "Parser",
          }),
          mail("stored", {
            id: "answer",
            from: fromAgent(agent2),
            body: "The parser is fine.",
            ackedAt: "later",
          }),
        ],
      ),
    );
    render(<AgentMailPanel />);
    act(() => useAgentMailStore.getState().openPanel({}));

    const row = await screen.findByTestId("agent-mail-conversation-row");
    expect(row.textContent).toContain("Claude 1");
    expect(row.textContent).toContain("Codex 2");
    expect(row.textContent).toContain("1 needs you");
    fireEvent.click(row);

    expect(await screen.findByText("Please check the parser.")).toBeTruthy();
    expect(screen.getByText("The parser is fine.")).toBeTruthy();
    expect(getAgentMailConversation).toHaveBeenCalledWith(AGENT_1, AGENT_2, 50);
    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText("handled")).toBeTruthy();
    // The person is not part of this conversation: no composer, but a way to start one.
    expect(screen.queryByPlaceholderText(/^Message /) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Message Codex 2" }));
    expect(useAgentMailStore.getState().panel).toEqual({
      focus: AGENT_2,
      conversation: [AGENT_2, "user"],
    });
  });

  test.each([
    ["worker on omarchy-hp", undefined, "worker on omarchy-hp"],
    ["Claude 2 on omarchy-hp", "worker", "worker · Claude 2 on omarchy-hp"],
  ])(
    "names node participant %s in the conversation row and header",
    async (displayName, environmentName, expected) => {
      const remote: AgentMailParticipant = {
        key: "node:bk_hp:leaf-env:tab",
        kind: "agent",
        displayName,
        environmentName,
        agent: null,
        canReceive: false,
      };
      const thread = conversation([agent1, remote], []);
      listAgentMailConversations.mockImplementation(async () => ({
        revision: 1,
        conversations: [
          {
            key: thread.key,
            participants: thread.participants,
            lastMessage: (({ body: _body, ...rest }) => rest)(mail("stored")),
            lastPreview: "Remote report",
            messageCount: 1,
            attentionCount: 0,
          },
        ],
      }));
      getAgentMailConversation.mockImplementation(async () => thread);
      render(<AgentMailPanel />);
      act(() => useAgentMailStore.getState().openPanel({}));
      const row = await screen.findByTestId("agent-mail-conversation-row");
      expect(row.textContent).toContain(expected);
      expect(row.textContent).not.toContain("worker · worker");
      fireEvent.click(row);
      expect(await screen.findByText(expected, { exact: true })).toBeTruthy();
    },
  );

  test("marks an unseen conversation seen once", async () => {
    getAgentMailConversation.mockImplementation(async () =>
      conversation([agent1, user], [mail("stored", { body: "unseen" })]),
    );
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    expect(await screen.findByText("unseen")).toBeTruthy();
    await waitFor(() =>
      expect(markAgentMailConversationSeen).toHaveBeenCalledWith(AGENT_1, "user", [
        "message-stored",
      ]),
    );
    expect(markAgentMailConversationSeen).toHaveBeenCalledTimes(1);
  });

  test("sends from the person's conversation and reuses the request id after an ambiguous failure", async () => {
    sendAgentMail
      .mockImplementationOnce(async () => {
        throw new Error("response lost");
      })
      .mockImplementationOnce(async () => mail("stored"));
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));

    const body = await screen.findByPlaceholderText("Message Claude 1");
    fireEvent.change(body, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect((body as HTMLTextAreaElement).value).toBe("hello");
    act(() => useAgentMailStore.getState().closePanel());
    act(() => useAgentMailStore.getState().openPanel({ conversation: ["user", AGENT_1] }));
    const restored = await screen.findByPlaceholderText("Message Claude 1");
    expect((restored as HTMLTextAreaElement).value).toBe("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(2));
    expect(sendAgentMail.mock.calls[0]?.[0]).toMatchObject({
      toEnvironmentId: "env-1",
      toTabId: "tab-1",
      body: "hello",
    });
    expect(sendAgentMail.mock.calls[0]?.[0].requestId).toBe(
      sendAgentMail.mock.calls[1]?.[0].requestId,
    );
    await waitFor(() => expect((restored as HTMLTextAreaElement).value).toBe(""));
  });

  test("keeps the draft and reports a refused message", async () => {
    sendAgentMail.mockImplementationOnce(async () =>
      mail("bounced", { placementReason: "recipient-muted" }),
    );
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    const body = await screen.findByPlaceholderText("Message Claude 1");
    fireEvent.change(body, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Message was not delivered", {
        description: "recipient-muted",
      }),
    );
    expect((body as HTMLTextAreaElement).value).toBe("hello");
  });

  test("retries a failed delivery at its recipient's address", async () => {
    getAgentMailConversation.mockImplementation(async () =>
      conversation(
        [agent1, agent2],
        [
          mail("inject_failed", {
            id: "failed",
            from: fromAgent(agent1),
            toEnvironmentId: "env-2",
            toTabId: "tab-2",
            userSeenAt: "seen",
          }),
        ],
      ),
    );
    render(<AgentMailPanel />);
    act(() => useAgentMailStore.getState().openPanel({ conversation: [AGENT_1, AGENT_2] }));
    expect(await screen.findByText("delivery failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(retryAgentMailInject).toHaveBeenCalledWith("env-2", "tab-2", "failed"),
    );
  });

  test("shows a focused tab's delivery settings and changes its policy", async () => {
    useAgentMailStore.setState({
      mailboxes: new Map([
        [
          AGENT_1,
          { descriptor: descriptor(), messages: [], total: 0, offset: 0, limit: 100, revision: 1 },
        ],
      ]),
    });
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1"));
    await waitFor(() => expect(listAgentMailConversations).toHaveBeenCalledWith(AGENT_1));
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
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(useAgentMailStore.getState().panel).toEqual({
      focus: AGENT_1,
      conversation: [AGENT_1, "user"],
    });
  });

  test("starts a new conversation from the recipient picker", async () => {
    render(<AgentMailPanel />);
    act(() => useAgentMailStore.getState().openPanel({}));
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByText("Codex 2"));
    expect(useAgentMailStore.getState().panel).toEqual({ conversation: [AGENT_2, "user"] });
  });

  test.each([true, false])(
    "conversation status uses the addressee capability (can receive %s)",
    async (canReceive) => {
      getAgentMailConversation.mockImplementation(async () =>
        conversation(
          [agent1, { ...agent2, agent: canReceive ? "codex" : null, canReceive }],
          [
            mail("stored", {
              from: fromAgent(agent1),
              toEnvironmentId: "env-2",
              toTabId: "tab-2",
              trust: "same-project",
            }),
          ],
        ),
      );
      render(<AgentMailPanel />);
      act(() => useAgentMailStore.getState().openPanel({ conversation: [AGENT_1, AGENT_2] }));
      expect(await screen.findByText(canReceive ? "in inbox" : "waiting for agent")).toBeTruthy();
      expect(Boolean(screen.queryByRole("button", { name: "Deliver now" }))).toBe(canReceive);
    },
  );

  test("does not load remote images and only opens safe web links", async () => {
    getAgentMailConversation.mockImplementation(async () =>
      conversation(
        [agent1, user],
        [
          mail("stored", {
            userSeenAt: "seen",
            body: "![tracker](https://example.com/pixel) [Docs](https://example.com/docs) [Unsafe](javascript:alert(1))",
          }),
        ],
      ),
    );
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    expect(await screen.findByText("[Image: tracker]")).toBeTruthy();
    expect(document.body.querySelector("[data-testid=agent-mail-panel] img") === null).toBe(true);
    expect(screen.queryByRole("link", { name: "Unsafe" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    await waitFor(() => expect(openInBrowser).toHaveBeenCalledWith("https://example.com/docs"));
  });
});

describe("conversation Deliver now actions", () => {
  async function openWaitingConversation() {
    getAgentMailConversation.mockImplementation(async () =>
      conversation([agent1, user], [mail("pending-inject", { id: "waiting-message" })]),
    );
    render(<AgentMailPanel />);
    act(() => openAgentMailForTab("env-1", "tab-1", "compose"));
    fireEvent.click(await screen.findByRole("button", { name: "Deliver now" }));
  }

  test.each([
    {
      reason: "steer-unsupported",
      title: "This agent can't take messages mid-turn",
      description: "It will be delivered when the current turn ends.",
    },
    {
      reason: "steer-refused",
      title: "Couldn't deliver into the running turn",
      description: "It will be delivered when the current turn ends.",
    },
    {
      reason: "steer-too-large",
      title: "This message is too large to deliver mid-turn",
      description: "It will be delivered in full when the current turn ends.",
    },
    {
      reason: "verifying",
      title: "Checking whether it arrived",
      description: "It is confirmed before anything is sent again.",
    },
    {
      reason: "draft",
      title: "Delivery is still waiting",
      description: "You have unsent text in the composer.",
    },
    {
      reason: "busy",
      title: "Delivery is still waiting",
      description: "It will be delivered when this agent is idle.",
    },
  ])(
    "conversation explains $reason and reloads its authoritative messages",
    async ({ reason, title, description }) => {
      deliverAgentMailNow.mockImplementationOnce(async () =>
        mail("pending-inject", { placementReason: reason }),
      );
      await openWaitingConversation();
      await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(title, { description }));
      expect(deliverAgentMailNow).toHaveBeenCalledWith("env-1", "tab-1", "waiting-message");
      await waitFor(() => expect(getAgentMailConversation).toHaveBeenCalledTimes(2));
      expect(updateAgentMailboxPolicy).not.toHaveBeenCalled();
    },
  );

  test("successful conversation delivery refreshes without a waiting notice", async () => {
    await openWaitingConversation();
    await waitFor(() => expect(getAgentMailConversation).toHaveBeenCalledTimes(2));
    expect(deliverAgentMailNow).toHaveBeenCalledWith("env-1", "tab-1", "waiting-message");
    expect(toastInfo).not.toHaveBeenCalled();
    expect(updateAgentMailboxPolicy).not.toHaveBeenCalled();
  });

  test("conversation delivery errors are reported and keep the message available", async () => {
    deliverAgentMailNow.mockImplementationOnce(async () => {
      throw new Error("Delivery unavailable");
    });
    await openWaitingConversation();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not deliver message", {
        description: "Delivery unavailable",
      }),
    );
    expect(screen.getByRole("button", { name: "Deliver now" })).toBeTruthy();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe("AgentMailBanner actions", () => {
  function installBanner(
    placement: AgentMailMessage["placement"],
    options: { presence?: "idle" | "working"; reason?: string } = {},
  ) {
    const { body: _body, ...summary } = mail(placement, {
      id: "message-1",
      ...(options.reason ? { placementReason: options.reason } : {}),
    });
    const pending = placement === "pending-inject" ? 1 : 0;
    const failed = placement === "inject_failed" ? 1 : 0;
    useAgentMailStore.setState({
      revision: 2,
      summary: new Map([
        [AGENT_1, { ...summaryEntry({ failedInjectCount: failed }), pendingInjectCount: pending }],
      ]),
      mailboxes: new Map([
        [
          AGENT_1,
          {
            descriptor: descriptor({
              presence: options.presence ?? "idle",
              pendingInjectCount: pending,
              failedInjectCount: failed,
            }),
            messages: [summary],
            total: 1,
            offset: 0,
            limit: 100,
            revision: 2,
          },
        ],
      ]),
    });
  }

  test("reports rejected banner actions", async () => {
    installBanner("inject_failed", { reason: "rejected" });
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

  test("Deliver now releases one message without touching the tab's policy", async () => {
    installBanner("pending-inject", { presence: "idle" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(deliverAgentMailNow).toHaveBeenCalledWith("env-1", "tab-1", "message-1"),
    );
    expect(updateAgentMailboxPolicy).not.toHaveBeenCalled();
    // Delivered: the banner goes away on refresh, with nothing more to say.
    expect(toastInfo).not.toHaveBeenCalled();
  });

  test("Deliver now asks a busy recipient to take the message mid-turn", async () => {
    installBanner("pending-inject", { presence: "working" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(deliverAgentMailNow).toHaveBeenCalledWith("env-1", "tab-1", "message-1"),
    );
    expect(toastInfo).not.toHaveBeenCalled();
  });

  test("says why when the running turn could not take the message", async () => {
    installBanner("pending-inject", { presence: "working" });
    deliverAgentMailNow.mockImplementationOnce(async () =>
      mail("pending-inject", { id: "message-1", placementReason: "steer-unsupported" }),
    );
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("This agent can't take messages mid-turn", {
        description: "It will be delivered when the current turn ends.",
      }),
    );
  });

  test("names oversized mail on the banner", () => {
    installBanner("pending-inject", { presence: "working", reason: "steer-too-large" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(
      screen.getByText(
        "Message too large for mid-turn delivery · delivers in full when the turn ends",
      ),
    ).toBeTruthy();
  });

  test("names a refused steer on the banner itself", () => {
    installBanner("pending-inject", { presence: "working", reason: "steer-refused" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(
      screen.getByText("Couldn't deliver into the running turn · delivers when the turn ends"),
    ).toBeTruthy();
  });
});
