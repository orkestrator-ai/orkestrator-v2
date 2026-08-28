import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import * as realSonner from "sonner";
import type { AgentMailInboxSnapshot, AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";

const sendAgentMail = mock(async (_input: Record<string, unknown>) => message("stored"));
const toastError = mock(() => undefined);
const toastSuccess = mock(() => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackend,
  sendAgentMail,
}));
mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: toastError, success: toastSuccess },
}));

const { AgentMailButton } = await import("./AgentMailButton");

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
      agent: "claude",
      kind: "native",
      presence: "unknown",
      injectPolicy: "off",
      mutedInbound: false,
      mutedOutbound: false,
      unreadCount: 0,
      capabilities: { canPull: true, canSend: true, canInject: true },
    },
  ],
  mailboxes: [],
  summary: { revision: 1, mailboxes: [] },
};

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

  test("renders no tab inbox when the authoritative summary has no mailbox", () => {
    render(<AgentMailButton environmentId="env-1" tabId="missing" variant="tab" />);
    expect(screen.queryByRole("button", { name: /tab agent inbox/i }) === null).toBe(true);
  });

  test("reuses the compose idempotency key after an ambiguous failure", async () => {
    sendAgentMail
      .mockImplementationOnce(async () => {
        throw new Error("response lost");
      })
      .mockImplementationOnce(async () => message("stored"));
    render(<AgentMailButton />);
    await openComposer();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(2));

    expect(sendAgentMail.mock.calls[0]?.[0].requestId).toBe(
      sendAgentMail.mock.calls[1]?.[0].requestId,
    );
  });

  test("keeps the draft open and reports a muted-recipient bounce", async () => {
    sendAgentMail.mockImplementationOnce(async () => message("bounced"));
    render(<AgentMailButton />);
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendAgentMail).toHaveBeenCalledTimes(2));

    expect(sendAgentMail.mock.calls[0]?.[0].requestId).not.toBe(
      sendAgentMail.mock.calls[1]?.[0].requestId,
    );
  });
});
