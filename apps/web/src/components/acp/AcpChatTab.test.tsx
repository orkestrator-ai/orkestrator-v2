import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { AcpApproval, AcpMessageWindow, AcpSessionSnapshot } from "@/lib/acp-client";
// The merge is pure and is the contract under test in several cases below, so
// keep the real implementation and stub only the network calls around it.
import * as realAcpClient from "@/lib/acp-client";
// The tab renders through the shared NativeChatShell, so keep the real shell
// and the real NativeMessage: the prop wiring between them is exactly what
// these tests need to hold. Only the virtualizer is stubbed, because
// react-virtuoso cannot measure a viewport in happy-dom and would render no
// rows at all.
import * as realReactVirtuoso from "react-virtuoso";

const realAcpClientSnapshot = { ...realAcpClient };
const realReactVirtuosoSnapshot = { ...realReactVirtuoso };

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
mock.module("react-virtuoso", () => ({
  ...realReactVirtuosoSnapshot,
  Virtuoso: forwardRef<any, any>((props, ref) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
      scrollTo: () => undefined,
      getState: (callback: (state: unknown) => void) => callback(undefined),
    }), []);
    useEffect(() => {
      props.scrollerRef?.(scrollerRef.current);
      props.atBottomStateChange?.(true);
      return () => props.scrollerRef?.(null);
    }, [props.scrollerRef, props.atBottomStateChange]);

    const data = props.data ?? [];
    const Empty = props.components?.EmptyPlaceholder;
    const Footer = props.components?.Footer;
    return (
      <div ref={scrollerRef}>
        {data.length === 0 && Empty ? <Empty context={props.context} /> : null}
        {data.map((item: any, index: number) => (
          <div key={props.computeItemKey?.(index, item) ?? index}>
            {props.itemContent(index, item)}
          </div>
        ))}
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  }),
}));

afterAll(() => {
  mock.module("@/lib/acp-client", () => realAcpClientSnapshot);
  mock.module("react-virtuoso", () => realReactVirtuosoSnapshot);
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

  test("renders reasoning as a collapsed thinking disclosure, not as assistant prose", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "Final answer",
        parts: [
          { type: "reasoning" as const, text: "Deliberating about the repository" },
          { type: "text" as const, text: "Final answer" },
        ],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    // The bridge's `reasoning` part maps onto the shell's `thinking` type, which
    // counts as tool activity — so it collapses behind the "Thinking" disclosure
    // while the answer itself stays plain prose. Mapping reasoning to `text`
    // instead would silently promote the agent's scratchpad to an answer.
    expect(await screen.findByText("Final answer")).toBeTruthy();
    const disclosure = (await screen.findByText("Thinking")).closest("button");
    expect(disclosure).toBeTruthy();
    const reasoning = screen.getByText("Deliberating about the repository");
    expect(disclosure!.contains(reasoning)).toBe(true);

    fireEvent.click(disclosure!);
    await waitFor(() => {
      const shown = screen.getAllByText("Deliberating about the repository");
      expect(shown.some((node) => !disclosure!.contains(node))).toBe(true);
    });
  });

  test("drives the shared chat shell: docked composer, pinned approvals, and scroll affordance", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "Working",
        parts: [{ type: "text" as const, text: "Working" }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
    }));
    getAcpApprovals.mockImplementation(async () => [{
      id: "approval-1",
      title: "Run command",
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    }]);

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    // The real shell owns these, so they only appear if the tab actually wired
    // messages, blocking cards, the composer and the scroll state into it.
    expect(await screen.findByText("Working")).toBeTruthy();
    const approval = await screen.findByText("Run command");
    const dock = screen.getByTestId("compose-dock");
    // Blocking prompts are pinned with the composer rather than left in the
    // transcript, so answering one never requires scrolling.
    expect(dock.contains(approval)).toBe(true);
    expect(dock.contains(screen.getByPlaceholderText("Message Cursor Agent"))).toBe(true);
    expect(screen.getByTestId("transcript-bottom-spacer")).toBeTruthy();
    // A running turn shows the shell's thinking indicator, not a bare spinner.
    expect(screen.getByLabelText("Stop")).toBeTruthy();
    // The stubbed virtualizer reports "at bottom", so the shell must not offer
    // the scroll-down affordance.
    expect(screen.queryByLabelText("Scroll to bottom of conversation")).toBeNull();
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

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("bridge is down")).toBeTruthy();
    // Match the other native tabs: connection errors replace the chat shell
    // instead of leaving a dead composer and a second status header visible.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    fireEvent.click(retry);
    // The second attempt uses the healthy default and reaches the composer.
    expect(await screen.findByText("Ask Cursor Agent to work on this repository.")).toBeTruthy();
    expect(awaitBridgeReady).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
