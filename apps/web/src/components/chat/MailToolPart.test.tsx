import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  type AgentMailMailboxSnapshot,
} from "@orkestrator/protocol/agent-mail";
import { invoke } from "@/lib/native/backend";
import type { AgentMailToolCall } from "@/lib/chat/agent-mail-tool-call";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { MailToolPart } from "./MailToolPart";

function senderText(): string | null | undefined {
  return document.querySelector("[data-mail-sender]")?.textContent;
}

const invokeMock = invoke as ReturnType<typeof mock>;

const call: AgentMailToolCall = {
  tool: "send_message",
  direction: "out",
  messageId: "old",
  body: "The result",
  to: { environmentId: "recipient", tabId: "agent" },
  from: {
    kind: "tab",
    projectId: "project",
    environmentId: "sender",
    tabId: "agent",
    incarnationId: "inc",
    agent: "claude",
    title: "Sender",
  },
  placement: "pending-inject",
};
function mailbox(revision = 1): AgentMailMailboxSnapshot {
  return {
    descriptor: {
      mailboxId: "recipient\0agent",
      incarnationId: "inc",
      projectId: "project",
      projectName: "Project",
      environmentId: "recipient",
      environmentName: "Recipient",
      environmentStatus: "running",
      tabId: "agent",
      tabType: "agent-native",
      title: "Worker",
      displayName: "Codex worker",
      tabOrdinal: 1,
      agent: "codex",
      kind: "native",
      presence: "idle",
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
    messages: Array.from({ length: 101 }, (_, index) => ({
      version: 1,
      id: index === 100 ? "old" : `m-${index}`,
      threadId: "thread",
      requestId: `request-${index}`,
      createdAt: new Date(0).toISOString(),
      from: { kind: "user" },
      toEnvironmentId: "recipient",
      toTabId: "agent",
      toIncarnationId: "inc",
      bodyBytes: 0,
      trust: "user",
      injectDepth: 0,
      threadDepth: 0,
      placement: "injected",
      ackedAt: "handled",
      revision,
    })),
    total: 101,
    offset: 0,
    limit: 200,
    revision,
  };
}

beforeEach(() => {
  useEnvironmentStore.setState(useEnvironmentStore.getInitialState());
  useAgentMailStore.setState(useAgentMailStore.getInitialState());
  useAgentMailStore.getState().clear();
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  useAgentMailStore.getState().clear();
  invokeMock.mockReset();
});

describe("mounted mail tool tiles", () => {
  test("loads live metadata, retains an old handled message on resource refresh, and opens its pair", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "get_agent_mail_mailboxes") return { revision: 1, mailboxes: [mailbox()] };
      if (command === "get_agent_mail_mailbox") {
        // Model the backend's default 100-row page unless the caller requests all retained metadata.
        const complete = mailbox(2);
        if ((args as { limit?: number }).limit !== AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX)
          return { ...complete, messages: complete.messages.slice(0, 100) };
        return complete;
      }
      throw new Error(`Unexpected command ${command}`);
    });
    render(<MailToolPart call={call} expansionKey="old" />);
    expect(await screen.findByText("Recipient")).toBeTruthy();
    expect(senderText()).toBe("To Recipient · Codex worker");
    expect(screen.getByText("handled")).toBeTruthy();
    await act(async () => useAgentMailStore.getState().refreshMailbox("recipient", "agent"));
    expect(screen.getByText("handled")).toBeTruthy();
    const live = mailbox(3);
    live.messages[100] = { ...live.messages[100]!, placement: "inject_failed", ackedAt: undefined };
    act(() => useAgentMailStore.getState().setMailbox(live));
    expect(screen.getByText("delivery failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(useAgentMailStore.getState().panel?.conversation).toEqual([
      "sender\0agent",
      "recipient\0agent",
    ]);
  });
  test("a missed delivery event converges from a newer summary while the tile is unmounted", async () => {
    const initial = mailbox();
    initial.messages[100] = {
      ...initial.messages[100]!,
      placement: "pending-inject",
      ackedAt: undefined,
    };
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_agent_mail_mailboxes") return { revision: 1, mailboxes: [initial] };
      throw new Error("Unexpected initial request");
    });
    const mounted = render(<MailToolPart call={call} expansionKey="missed" />);
    expect(await screen.findByText("waiting to deliver")).toBeTruthy();
    mounted.unmount();
    expect(useAgentMailStore.getState().sent.size).toBe(0);
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_agent_mail_summary")
        return { revision: 2, mailboxes: [{ ...mailbox(2).descriptor, revision: 2 }] };
      if (command === "get_agent_mail_mailboxes") return { revision: 2, mailboxes: [mailbox(2)] };
      throw new Error("Unexpected resync request");
    });
    await act(async () => useAgentMailStore.getState().refreshSummary());
    render(<MailToolPart call={call} expansionKey="missed" />);
    expect(screen.getByText("handled")).toBeTruthy();
  });
  test("unknown recipients have useful names and missing metadata never restores an obsolete send-time status", () => {
    const { rerender } = render(
      <MailToolPart call={{ ...call, to: undefined }} expansionKey="fallback" />,
    );
    expect(screen.getByText("To another agent")).toBeTruthy();
    expect(screen.queryByText("waiting to deliver") === null).toBe(true);
    rerender(
      <MailToolPart
        call={{ ...call, to: { environmentId: "coordinator" } }}
        expansionKey="fallback"
      />,
    );
    expect(screen.getByText("To Project coordinator")).toBeTruthy();
  });
  test("names the recipient's environment from the environment store until its mailbox loads", async () => {
    invokeMock.mockImplementation(async () => new Promise(() => {}));
    render(<MailToolPart call={call} expansionKey="loading" />);
    // Neither name is known yet: the short environment id and the tab id stand in.
    expect(senderText()).toBe("To recipien · agent");
    act(() =>
      useEnvironmentStore
        .getState()
        .setEnvironments([{ id: "recipient", name: "fix-login-bug", order: 0 } as Environment]),
    );
    expect(senderText()).toBe("To fix-login-bug · agent");
  });
  test("names a recipient on another node from the send result, without asking this node", () => {
    render(
      <MailToolPart
        call={{
          ...call,
          to: {
            environmentId: "leaf-env",
            tabId: "startup-agent",
            environmentName: "fix-login-bug",
            tabName: "Claude 2",
            node: "omarchy-hp",
          },
        }}
        expansionKey="remote"
      />,
    );
    expect(senderText()).toBe("To fix-login-bug · Claude 2 on omarchy-hp");
    expect(invokeMock.mock.calls.length).toBe(0);
  });
  test.each([
    [{ kind: "user" }, "user", "user"],
    [{ kind: "external" }, "external", "external"],
    [call.from, "cross-project", "external"],
  ] as const)("read tile presents sender and trust (%j, %s)", (from, trust, kind) => {
    const { container } = render(
      <MailToolPart
        call={{ ...call, tool: "read_message", direction: "in", from, trust }}
        expansionKey="read"
      />,
    );
    expect(container.querySelector("[data-mail-kind]")?.getAttribute("data-mail-kind")).toBe(kind);
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("The result")).toBeTruthy();
    expect(invokeMock.mock.calls.some(([command]) => command === "get_agent_mail_mailboxes")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(useAgentMailStore.getState().panel?.conversation?.[1]).toBe("recipient\0agent");
  });
});
