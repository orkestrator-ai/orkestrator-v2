import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessageSummary,
  AgentMailSummaryEntry,
  MailboxPresence,
} from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { AgentMailBanner } from "./AgentMailBanner";

import * as backend from "@/lib/backend/agent-mail";

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
  options: {
    placementReason?: string;
    presence?: MailboxPresence;
    policy?: "off" | "idle";
    noAgent?: boolean;
  } = {},
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
      capabilities: options.noAgent
        ? { canPull: false, canSend: false, canInject: false }
        : { canPull: true, canSend: true, canInject: true },
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
  afterEach(() => mock.restore());
  beforeEach(() => {
    cleanup();
    useAgentMailStore.setState(useAgentMailStore.getInitialState());
  });

  test("surfaces pull-only pending delivery in the recipient tab", () => {
    install("stored", { policy: "off" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message in inbox · pull only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deliver now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(useAgentMailStore.getState().panel).toEqual({ focus: mailboxId });
  });

  test("releases newest-first snapshots oldest first, preserving send order for timestamp ties", async () => {
    install("stored");
    const snapshot = useAgentMailStore.getState().mailboxes.get(mailboxId)!;
    snapshot.messages = [
      { ...message("stored"), id: "newer", createdAt: "2026-11-03T12:00:01.000Z" },
      { ...message("stored"), id: "earlier-tie", createdAt: "2026-11-03T12:00:00.000Z" },
      { ...message("stored"), id: "later-tie", createdAt: "2026-11-03T12:00:00.000Z" },
    ];
    const deliver = spyOn(backend, "deliverAgentMailNow").mockResolvedValue({
      ...message("injected"),
      body: "hello",
    });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(deliver.mock.calls.map((call) => call[2])).toEqual([
      "earlier-tie",
      "later-tie",
      "newer",
    ]);
  });

  test("continues after a refusal and refreshes partial success while showing the refused item", async () => {
    install("stored");
    const snapshot = useAgentMailStore.getState().mailboxes.get(mailboxId)!;
    snapshot.messages = ["first", "refused", "last"].map((id) => ({ ...message("stored"), id }));
    const deliver = spyOn(backend, "deliverAgentMailNow")
      .mockResolvedValueOnce({ ...message("injected"), body: "hello" })
      .mockRejectedValueOnce(new Error("Thread reply limit reached"))
      .mockResolvedValueOnce({ ...message("injected"), body: "hello" });
    const refreshMailbox = mock(async () => undefined);
    const refreshSummary = mock(async () => undefined);
    useAgentMailStore.setState({ refreshMailbox, refreshSummary });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    await waitFor(() => expect(refreshMailbox).toHaveBeenCalled());
    const mailboxCalls = refreshMailbox.mock.calls.length;
    const summaryCalls = refreshSummary.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "refused: Thread reply limit reached",
      ),
    );
    expect(deliver.mock.calls.map((call) => call[2])).toEqual(["first", "refused", "last"]);
    expect(refreshMailbox.mock.calls.length).toBeGreaterThan(mailboxCalls);
    expect(refreshSummary.mock.calls.length).toBeGreaterThan(summaryCalls);
  });

  test("describes the pending action when pending and inherited pull-only inbox mail coexist", async () => {
    install("pending-inject");
    const snapshot = useAgentMailStore.getState().mailboxes.get(mailboxId)!;
    snapshot.descriptor.injectOverride = "inherit";
    snapshot.messages.push(message("stored"));
    const deliver = spyOn(backend, "deliverAgentMailNow").mockResolvedValue({
      ...message("injected"),
      body: "hello",
    });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message waiting · delivers when this agent is idle")).toBeTruthy();
    expect(screen.queryByText(/pull only/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(deliver).toHaveBeenCalledWith("env-1", "tab-1", "message-pending-inject"),
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test("says mail for a tab with no agent is waiting, and offers no delivery it cannot make", () => {
    for (const policy of ["off", "idle"] as const) {
      install("stored", { placementReason: "recipient-cannot-inject", policy, noAgent: true });
      const view = render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
      expect(screen.getByText("1 message in inbox · waiting for an agent")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
      expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
      view.unmount();
    }
  });

  test("stored external mail makes no promise of automatic delivery", () => {
    install("stored", { noAgent: true });
    const snapshot = useAgentMailStore.getState().mailboxes.get(mailboxId)!;
    snapshot.messages[0]!.trust = "external";
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message in inbox · waiting for an agent")).toBeTruthy();
    expect(screen.queryByText(/send a first message|and deliver/) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
  });

  test("counts only inbox mail, not delivered or expired mail the agent never acknowledged", () => {
    install("stored", { policy: "off" });
    const state = useAgentMailStore.getState();
    state.summary.get(mailboxId)!.agentUnackedCount = 27;
    state.mailboxes
      .get(mailboxId)!
      .messages.push(
        { ...message("injected"), id: "delivered" },
        { ...message("expired", "sender-deleted"), id: "expired" },
      );
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message in inbox · pull only")).toBeTruthy();
  });

  test("untrusted inbox mail says why it is not delivered and offers no Deliver now", () => {
    install("stored", { policy: "off" });
    const messages = useAgentMailStore.getState().mailboxes.get(mailboxId)!.messages;
    messages[0]!.trust = "external";
    messages.push({ ...message("stored"), id: "cross", trust: "cross-project" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    const text = screen.getByText(/^2 messages in inbox · Mail from another project/);
    expect(text.classList.contains("truncate")).toBe(false);
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
  });

  test("a muted tab's inbox mail offers no Deliver now", () => {
    install("stored", { policy: "off" });
    useAgentMailStore.getState().mailboxes.get(mailboxId)!.descriptor.mutedInbound = true;
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(
      screen.getByText("1 message in inbox · Incoming mail is muted for this tab."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
  });

  test("counts deliverable and undeliverable inbox mail separately", () => {
    install("stored", { policy: "off" });
    useAgentMailStore
      .getState()
      .mailboxes.get(mailboxId)!
      .messages.push({ ...message("stored"), id: "external", trust: "external" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("1 message in inbox · pull only · 1 can't be delivered")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deliver now" })).toBeTruthy();
  });

  test("explains that a delegation report waits for the worker turn", () => {
    install("inject-held", { placementReason: COORDINATOR_DELEGATION_HOLD_REASON });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(
      screen
        .getByText("Worker report waiting · delivers when the worker turn ends")
        .classList.contains("truncate"),
    ).toBe(false);
    expect(screen.queryByText(/agent is idle/) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Deliver now" }) === null).toBe(true);
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

  for (const [placement, placementReason, text] of [
    ["inject-held", "hourly-limit", "Delivery paused: hourly limit · resumes on its own"],
    ["pending-inject", "retrying", "Delivery was refused · retrying automatically"],
    [
      "pending-inject",
      "verifying",
      "Checking whether the last delivery arrived · retries automatically",
    ],
  ] as const)
    test(`explains ${placementReason} delivery`, () => {
      install(placement, { placementReason });
      render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
      expect(screen.getByText(text)).toBeTruthy();
    });

  test("explains a compose draft hold", () => {
    install("pending-inject", { presence: "draft", policy: "idle" });
    render(<AgentMailBanner environmentId="env-1" tabId="tab-1" />);
    expect(screen.getByText("Delivery waiting: you have unsent text in the composer")).toBeTruthy();
  });
});
