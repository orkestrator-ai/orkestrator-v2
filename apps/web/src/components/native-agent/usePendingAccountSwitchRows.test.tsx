import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMessageSummary,
} from "@orkestrator/protocol/agent-mail";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { withAccountSwitchRows } from "@/lib/chat/account-switch-rows";
import type { NativeMessage as NativeMessageRow } from "@/lib/chat/native-message-types";
import { invoke } from "@/lib/native/backend";
import { agentMailStore } from "@/stores/agentMailStore";
import { appCommandStore } from "@/test/app-command-store";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { usePendingAccountSwitchRows } from "./usePendingAccountSwitchRows";

const invokeMock = invoke as ReturnType<typeof mock>;

const SWITCH: AgentMailMessageSummary = {
  version: 1,
  id: "switch",
  threadId: "switch",
  requestId: "switch",
  createdAt: "2026-11-14T10:00:00.000Z",
  from: {
    kind: "system",
    projectId: "project",
    source: "workflow",
    resourceId: "account-auto-switch:claude",
  },
  toEnvironmentId: "coordinator",
  toTabId: "main",
  toIncarnationId: "inc",
  subject: "Claude Code moved to b@example.com on mini",
  bodyBytes: 10,
  trust: "same-project",
  injectDepth: 0,
  threadDepth: 0,
  notice: {
    resource: { kind: "account-switch", id: "claude", label: "mini" },
    accountSwitch: { provider: "Claude Code", from: "a@example.com", to: "b@example.com" },
    state: "account-switched",
    tone: "info",
  },
  rideAlong: true,
  placement: "pending-inject",
  revision: 1,
};

function mailbox(messages: AgentMailMessageSummary[], revision = 1): AgentMailMailboxSnapshot {
  return {
    descriptor: {
      mailboxId: "coordinator\0main",
      incarnationId: "inc",
      projectId: "project",
      projectName: "Project",
      environmentId: "coordinator",
      environmentName: "Coordinator",
      environmentStatus: "running",
      tabId: "main",
      tabType: "agent-native",
      title: "Main",
      displayName: "Main",
      tabOrdinal: 1,
      agent: "claude",
      kind: "native",
      presence: "idle",
      injectPolicy: "idle",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 0,
      userUnseenCount: 0,
      agentUnackedCount: 0,
      pendingInjectCount: 1,
      failedInjectCount: 0,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
    messages,
    total: messages.length,
    offset: 0,
    limit: 100,
    revision,
  };
}

function Transcript({
  transcript,
  enabled = true,
}: {
  transcript: NativeMessageRow[];
  enabled?: boolean;
}) {
  const rows = usePendingAccountSwitchRows("coordinator", "main", enabled);
  return (
    <>
      {withAccountSwitchRows(transcript, rows).map((message) => (
        <NativeMessage key={message.id} message={message} />
      ))}
    </>
  );
}

function switchRows(container: HTMLElement) {
  return container.querySelectorAll("[data-account-switch-notice]");
}

beforeEach(() => {
  appCommandStore(agentMailStore).getState().clear();
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  appCommandStore(agentMailStore).getState().clear();
  invokeMock.mockReset();
});

describe("a coordinator's waiting account switch", () => {
  test("shows as one line from its mailbox, with no turn, and again after a reload", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_agent_mail_mailboxes")
        return { revision: 1, mailboxes: [mailbox([SWITCH])] };
      throw new Error(`Unexpected command ${command}`);
    });
    const first = renderInAppCommandScope(<Transcript transcript={[]} />);
    await waitFor(() => expect(switchRows(first.container)).toHaveLength(1));
    expect(first.container.textContent).toContain("a@example.comb@example.com");
    expect(first.container.querySelector("[data-mail-tile]") === null).toBe(true);
    first.unmount();
    // A reload starts from an empty store and reads the backend's mailbox again.
    appCommandStore(agentMailStore).getState().clear();
    const reloaded = renderInAppCommandScope(<Transcript transcript={[]} />);
    await waitFor(() => expect(switchRows(reloaded.container)).toHaveLength(1));
  });

  test("is drawn once when its carrier is delivered with a later turn", async () => {
    appCommandStore(agentMailStore)
      .getState()
      .setMailbox(mailbox([SWITCH]));
    const { container, rerender } = renderInAppCommandScope(<Transcript transcript={[]} />);
    expect(switchRows(container)).toHaveLength(1);
    // The turn another message started carried it: the mailbox says delivered
    // and the transcript holds the carrier's own row.
    const delivered: NativeMessageRow = {
      id: "peer-mail-switch",
      role: "system",
      content: "",
      parts: [],
      createdAt: "2026-11-14T10:05:00.000Z",
      peerMail: {
        messageId: "switch",
        kind: "notice",
        sender: "Orkestrator workflow",
        warning: "Orkestrator status notice.",
        body: "",
        notice: SWITCH.notice!,
      },
    };
    act(() =>
      appCommandStore(agentMailStore)
        .getState()
        .setMailbox(mailbox([{ ...SWITCH, placement: "injected", revision: 2 }], 2)),
    );
    rerender(<Transcript transcript={[delivered]} />);
    expect(switchRows(container)).toHaveLength(1);
    // Even if the mailbox still lagged behind, the carrier row is the one shown.
    act(() =>
      appCommandStore(agentMailStore)
        .getState()
        .setMailbox(mailbox([SWITCH], 3)),
    );
    expect(switchRows(container)).toHaveLength(1);
  });

  test("a tab that is not a coordinator does not ask for its mailbox", () => {
    renderInAppCommandScope(<Transcript transcript={[]} enabled={false} />);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
