import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessageSummary,
  AgentMailSummaryEntry,
  MailboxPresence,
} from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { AgentMailBanner } from "./AgentMailBanner";

const mailboxId = "env-1\0tab-1";

function message(
  placement: AgentMailMessageSummary["placement"],
  placementReason?: string,
): AgentMailMessageSummary {
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
    bodyBytes: 5,
    trust: "user",
    injectDepth: 0,
    threadDepth: 0,
    placement,
    ...(placementReason ? { placementReason } : {}),
    revision: 1,
  };
}

function install(
  placement: AgentMailMessageSummary["placement"],
  options: { placementReason?: string; presence?: MailboxPresence; policy?: "off" | "idle" } = {},
): void {
  const pending = placement === "pending-inject" || placement === "inject-held" ? 1 : 0;
  const failed = placement === "inject_failed" ? 1 : 0;
  const summary: AgentMailSummaryEntry = {
    mailboxId,
    projectId: "project-1",
    environmentId: "env-1",
    tabId: "tab-1",
    unreadCount: 1,
    userUnseenCount: 1,
    agentUnackedCount: 1,
    pendingInjectCount: pending,
    failedInjectCount: failed,
    revision: 2,
  };
  const snapshot: AgentMailMailboxSnapshot = {
    descriptor: {
      mailboxId,
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
      presence: options.presence ?? "idle",
      injectPolicy: options.policy ?? "off",
      injectOverride: options.policy ?? "off",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 1,
      userUnseenCount: 1,
      agentUnackedCount: 1,
      pendingInjectCount: pending,
      failedInjectCount: failed,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
    messages: [message(placement, options.placementReason)],
    total: 1,
    offset: 0,
    limit: 100,
    revision: 2,
  };
  useAgentMailStore.setState({
    revision: 2,
    summary: new Map([[mailboxId, summary]]),
    mailboxes: new Map([[mailboxId, snapshot]]),
    refreshSummary: async () => undefined,
    refreshMailbox: async () => undefined,
  });
}

describe("AgentMailBanner", () => {
  beforeEach(() => {
    cleanup();
    useAgentMailStore.setState(useAgentMailStore.getInitialState());
  });

  test("surfaces pull-only pending delivery in the recipient tab", () => {
    install("stored", { policy: "off" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message in inbox · pull only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open inbox" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to deliver when idle" })).toBeTruthy();
  });

  test("rehydrates its authoritative summary even when cached state has a revision", async () => {
    install("stored", { policy: "off" });
    const refreshSummary = mock(async () => undefined);
    useAgentMailStore.setState({ refreshSummary });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    await waitFor(() => expect(refreshSummary).toHaveBeenCalledTimes(1));
  });

  test("surfaces failed and loop-paused delivery actions", () => {
    install("inject_failed", { placementReason: "rejected" });
    const view = render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("Delivery failed: rejected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();

    install("inject-held", { placementReason: "loop-budget-exhausted" });
    view.rerender(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("Delivery paused: loop budget")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  test("explains a compose draft hold", () => {
    install("pending-inject", { presence: "draft", policy: "idle" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("Delivery waiting: you have unsent text in the composer")).toBeTruthy();
  });
});
