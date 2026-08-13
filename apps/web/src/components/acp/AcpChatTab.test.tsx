import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AcpApproval, AcpMessageWindow, AcpSessionSnapshot } from "@/lib/acp-client";
// The merge is pure and is the contract under test in several cases below, so
// keep the real implementation and stub only the network calls around it.
import * as realAcpClient from "@/lib/acp-client";

const realAcpClientSnapshot = { ...realAcpClient };

const awaitBridgeReady = mock(async () => ({ status: "ready" as const, port: 4099, authToken: "token" }));
const ensureNativeAgentSession = mock(async () => ({ providerSessionId: "new-session" }));
const adoptNativeAgentSession = mock(async () => ({ providerSessionId: "persisted-session" }));
const dispatchNativeAgentPrompt = mock(async () => ({ providerSessionId: "persisted-session" }));
const getAcpSession = mock(async (): Promise<AcpSessionSnapshot> => ({
  id: "persisted-session",
  provider: "cursor" as const,
  status: "idle" as const,
  messages: [],
  baseIndex: 0,
  revision: 1,
}));
const getAcpMessageWindow = mock(
  async (_client: unknown, _sessionId: string, fromIndex: number): Promise<AcpMessageWindow> => ({
    messages: [],
    baseIndex: fromIndex,
    totalMessages: fromIndex,
    revision: 1,
    status: "idle" as const,
  }),
);
const getAcpApprovals = mock(async (): Promise<AcpApproval[]> => []);
const resolveAcpApproval = mock(async () => undefined);
const cancelAcpPrompt = mock(async () => undefined);
const updateTabNativeSessionId = mock(() => undefined);
const clearTabInitialPrompt = mock(() => undefined);

mock.module("@/lib/backend", () => ({
  adoptNativeAgentSession,
  awaitBridgeReady,
  dispatchNativeAgentPrompt,
  ensureNativeAgentSession,
}));
mock.module("@/lib/acp-client", () => ({
  ...realAcpClientSnapshot,
  cancelAcpPrompt,
  createAcpClient: (baseUrl: string, authToken: string) => ({ baseUrl, authToken }),
  getAcpApprovals,
  getAcpSession,
  getAcpMessageWindow,
  resolveAcpApproval,
}));

afterAll(() => {
  mock.module("@/lib/acp-client", () => realAcpClientSnapshot);
});
mock.module("@/stores/paneLayoutStore", () => ({
  usePaneLayoutStore: (selector: (state: {
    updateTabNativeSessionId: typeof updateTabNativeSessionId;
    clearTabInitialPrompt: typeof clearTabInitialPrompt;
  }) => unknown) => selector({ updateTabNativeSessionId, clearTabInitialPrompt }),
}));
mock.module("@/stores/environmentStore", () => ({
  useEnvironmentStore: (selector: (state: { getEnvironmentById: () => undefined }) => unknown) =>
    selector({ getEnvironmentById: () => undefined }),
}));

import { AcpChatTab } from "./AcpChatTab";

const data = {
  provider: "cursor" as const,
  environmentId: "environment-1",
  sessionId: "persisted-session",
};

beforeEach(() => {
  for (const fn of [
    awaitBridgeReady,
    ensureNativeAgentSession,
    adoptNativeAgentSession,
    dispatchNativeAgentPrompt,
    getAcpSession,
    getAcpMessageWindow,
    getAcpApprovals,
    resolveAcpApproval,
    cancelAcpPrompt,
    updateTabNativeSessionId,
    clearTabInitialPrompt,
  ]) fn.mockClear();
  awaitBridgeReady.mockImplementation(async () => ({ status: "ready" as const, port: 4099, authToken: "token" }));
  adoptNativeAgentSession.mockImplementation(async () => ({ providerSessionId: "persisted-session" }));
  dispatchNativeAgentPrompt.mockImplementation(async () => ({ providerSessionId: "persisted-session" }));
  getAcpSession.mockImplementation(async () => ({
    id: "persisted-session",
    provider: "cursor" as const,
    status: "idle" as const,
    messages: [],
    baseIndex: 0,
    revision: 1,
  }));
  getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
    messages: [],
    baseIndex: fromIndex,
    totalMessages: fromIndex,
    revision: 1,
    status: "idle" as const,
  }));
  getAcpApprovals.mockImplementation(async () => []);
});

afterEach(cleanup);

describe("AcpChatTab", () => {
  test("adopts and rehydrates the session persisted in pane data", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "Recovered response",
        parts: [{ type: "text" as const, text: "Recovered response" }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);

    expect(await screen.findByText("Recovered response")).toBeTruthy();
    expect(adoptNativeAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      logicalSessionKey: "env-environment-1:tab-1",
      providerSessionId: "persisted-session",
    }));
    expect(ensureNativeAgentSession).not.toHaveBeenCalled();
    expect(updateTabNativeSessionId).toHaveBeenCalledWith(
      "tab-1",
      "persisted-session",
      "environment-1",
    );
  });

  test("durably dispatches an initial prompt while inactive and clears it only after acceptance", async () => {
    render(
      <AcpChatTab
        tabId="tab-1"
        data={data}
        isActive={false}
        initialPrompt="Review this change"
      />,
    );

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Review this change",
      requestId: "initial-prompt:environment-1:tab-1",
    })));
    expect(clearTabInitialPrompt).toHaveBeenCalledWith("tab-1", "environment-1");
  });

  test("routes manual prompts through the durable backend dispatcher", async () => {
    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByPlaceholderText("Message Cursor Agent");
    fireEvent.change(compose, { target: { value: "Run the checks" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      logicalSessionKey: "env-environment-1:tab-1",
      prompt: "Run the checks",
      requestId: expect.any(String),
    })));
  });

  test("keeps a rejected initial prompt available for a remount retry", async () => {
    dispatchNativeAgentPrompt.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    const view = render(
      <AcpChatTab tabId="tab-1" data={data} isActive={false} initialPrompt="Retry me" />,
    );
    expect(await screen.findByText("backend unavailable")).toBeTruthy();
    expect(clearTabInitialPrompt).not.toHaveBeenCalled();

    view.unmount();
    dispatchNativeAgentPrompt.mockImplementation(async () => ({ providerSessionId: "persisted-session" }));
    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} initialPrompt="Retry me" />);
    // Wait on the *count*: the first mount already produced a matching call, so
    // asserting only the arguments would pass before the remount dispatched and
    // leave the real assertion racing the second connect.
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(2));
    expect(dispatchNativeAgentPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: "initial-prompt:environment-1:tab-1",
    }));
  });

  test("rehydrates approvals, resolves them, and exposes cancellation and bridge errors", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      error: "Provider warning",
      messages: [],
      baseIndex: 0,
      revision: 2,
    }));
    getAcpApprovals.mockImplementation(async () => [{
      id: "approval-1",
      title: "Run command",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    }]);
    // The turn is still running, so incremental reads must report that too.
    getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
      messages: [],
      baseIndex: fromIndex,
      totalMessages: fromIndex,
      revision: 2,
      status: "running" as const,
      error: "Provider warning",
    }));
    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);

    expect(await screen.findByText("Run command")).toBeTruthy();
    expect(screen.getByText("Provider warning")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(resolveAcpApproval).toHaveBeenCalledWith(
      expect.anything(),
      "persisted-session",
      "approval-1",
      "once",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancelAcpPrompt).toHaveBeenCalledWith(expect.anything(), "persisted-session");
  });

  test("polls an incremental window anchored to its own last message", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [
        {
          id: "message-1",
          role: "user" as const,
          content: "Do the work",
          parts: [{ type: "text" as const, text: "Do the work" }],
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        {
          id: "message-2",
          role: "assistant" as const,
          content: "Partial",
          parts: [{ type: "text" as const, text: "Partial" }],
          createdAt: "2026-08-13T00:00:01.000Z",
        },
      ],
      baseIndex: 0,
      revision: 2,
    }));
    getAcpApprovals.mockImplementation(async () => [{
      id: "approval-1",
      title: "Run command",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    }]);
    // The streaming tail grew; everything before it is already final here.
    getAcpMessageWindow.mockImplementation(async () => ({
      messages: [{
        id: "message-2",
        role: "assistant" as const,
        content: "Partial and then some",
        parts: [{ type: "text" as const, text: "Partial and then some" }],
        createdAt: "2026-08-13T00:00:01.000Z",
      }],
      baseIndex: 1,
      totalMessages: 2,
      revision: 3,
      status: "running" as const,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    expect(await screen.findByText("Partial")).toBeTruthy();

    // Resolving an approval refreshes without waiting for the poll interval.
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() => expect(getAcpMessageWindow).toHaveBeenCalled());
    // Index 1 is the client's own last message, not the whole transcript.
    expect(getAcpMessageWindow).toHaveBeenLastCalledWith(
      expect.anything(),
      "persisted-session",
      1,
    );
    // The final leading message survives the merge; the tail is replaced.
    expect(await screen.findByText("Partial and then some")).toBeTruthy();
    expect(screen.getByText("Do the work")).toBeTruthy();
    expect(screen.queryByText("Partial")).toBeNull();
    // The full snapshot is fetched once on mount and never re-polled.
    expect(getAcpSession).toHaveBeenCalledTimes(1);
  });

  test("rehydrates a turn that completed while the tab was unmounted", async () => {
    // The tab mounts mid-turn, is unmounted, and the turn finishes in the
    // background. Remounting must recover the finished state from the bridge
    // rather than resuming from stale in-component state.
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [],
      baseIndex: 0,
      revision: 2,
    }));
    const view = render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    expect(await screen.findByPlaceholderText("Message Cursor Agent")).toBeTruthy();
    view.unmount();

    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [{
        id: "message-9",
        role: "assistant" as const,
        content: "Finished while you were away",
        parts: [{ type: "text" as const, text: "Finished while you were away" }],
        createdAt: "2026-08-13T00:00:09.000Z",
      }],
      baseIndex: 0,
      revision: 9,
    }));
    getAcpApprovals.mockImplementation(async () => [{
      id: "approval-late",
      title: "Approve the follow-up",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    }]);

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    expect(await screen.findByText("Finished while you were away")).toBeTruthy();
    expect(await screen.findByText("Approve the follow-up")).toBeTruthy();
    // Idle again, so the composer offers Send rather than Stop.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  test("retries the mount handshake from the error banner after a failed connect", async () => {
    awaitBridgeReady.mockImplementationOnce(async () => {
      throw new Error("bridge is down");
    });
    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    const retry = await screen.findByRole("button", { name: "Retry connection" });
    expect(screen.getByText("bridge is down")).toBeTruthy();
    // The composer is visible but dead: no client and no session were reached.
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(retry);
    // The second attempt uses the healthy default and reaches the composer.
    expect(await screen.findByText("Ask Cursor Agent to work on this repository.")).toBeTruthy();
    expect(awaitBridgeReady).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry connection" })).toBeNull();
  });
});
