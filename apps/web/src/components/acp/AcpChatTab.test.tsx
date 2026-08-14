import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { AcpApproval, AcpMessageWindow, AcpSessionSnapshot } from "@/lib/acp-client";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
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

function sessionSnapshot(overrides: Partial<AcpSessionSnapshot> = {}): AcpSessionSnapshot {
  return {
    id: "persisted-session",
    provider: "cursor",
    status: "idle",
    messages: [],
    baseIndex: 0,
    revision: 1,
    composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
    ...overrides,
  };
}

const awaitBridgeReady = mock(async () => ({ status: "ready" as const, port: 4099, authToken: "token" }));
const ensureNativeAgentSession = mock(async () => ({ providerSessionId: "new-session" }));
const adoptNativeAgentSession = mock(async () => ({ providerSessionId: "persisted-session" }));
const dispatchNativeAgentPrompt = mock(async () => ({ providerSessionId: "persisted-session" }));
const getAcpSession = mock(async (): Promise<AcpSessionSnapshot> => sessionSnapshot());
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
const setAcpSessionConfig = mock(async () => EMPTY_NATIVE_AGENT_COMPOSER_STATE);
const updateTabNativeSessionId = mock(() => undefined);
const clearTabInitialPrompt = mock(() => undefined);
const clearTabInitialAgentOptions = mock(() => undefined);

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
  setAcpSessionConfig,
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
    clearTabInitialAgentOptions: typeof clearTabInitialAgentOptions;
  }) => unknown) => selector({
    updateTabNativeSessionId,
    clearTabInitialPrompt,
    clearTabInitialAgentOptions,
  }),
}));
mock.module("@/stores/environmentStore", () => ({
  useEnvironmentStore: (selector: (state: { getEnvironmentById: () => undefined }) => unknown) =>
    selector({ getEnvironmentById: () => undefined }),
}));

import { AcpChatTab } from "./AcpChatTab";

const data = {
  platform: "cursor" as const,
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
    setAcpSessionConfig,
    updateTabNativeSessionId,
    clearTabInitialPrompt,
    clearTabInitialAgentOptions,
  ]) fn.mockClear();
  awaitBridgeReady.mockImplementation(async () => ({ status: "ready" as const, port: 4099, authToken: "token" }));
  adoptNativeAgentSession.mockImplementation(async () => ({ providerSessionId: "persisted-session" }));
  dispatchNativeAgentPrompt.mockImplementation(async () => ({ providerSessionId: "persisted-session" }));
  getAcpSession.mockImplementation(async () => sessionSnapshot());
  getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
    messages: [],
    baseIndex: fromIndex,
    totalMessages: fromIndex,
    revision: 1,
    status: "idle" as const,
  }));
  getAcpApprovals.mockImplementation(async () => []);
  setAcpSessionConfig.mockImplementation(async () => EMPTY_NATIVE_AGENT_COMPOSER_STATE);
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
        parts: [{ type: "text" as const, content: "Recovered response" }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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

  test("clears one-shot composer options after a new ACP session rehydrates", async () => {
    const unboundData = {
      platform: "cursor" as const,
      environmentId: "environment-1",
    };
    ensureNativeAgentSession.mockImplementation(async () => ({ providerSessionId: "new-session" }));
    getAcpSession.mockImplementation(async () => sessionSnapshot({ id: "new-session" }));

    render(
      <AcpChatTab
        tabId="tab-1"
        data={unboundData}
        isActive
        initialAgentModel="composer-2.5"
        initialReasoningEffort="high"
        initialConversationMode="plan"
        initialFastMode
      />,
    );

    await waitFor(() => expect(ensureNativeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "composer-2.5",
        reasoningEffort: "high",
        sessionMode: "plan",
        fastMode: true,
      }),
    ));
    await waitFor(() => expect(clearTabInitialAgentOptions)
      .toHaveBeenCalledWith("tab-1", "environment-1"));
  });

  // Incremental windows carry a composer only on a bridge new enough to send
  // one. An older bridge omitting it must leave the picker alone rather than
  // blanking the model the user is looking at on the very next poll.
  test("keeps the composer when an incremental window carries none", async () => {
    const composer = {
      ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
      models: [{
        id: "composer-2.5",
        platform: "cursor" as const,
        label: "Composer 2.5",
      }],
      selectedModelId: "composer-2.5",
    };
    getAcpSession.mockImplementation(async () => sessionSnapshot({
      status: "running",
      revision: 1,
      composer,
    }));
    getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
      messages: [],
      baseIndex: fromIndex,
      totalMessages: fromIndex,
      revision: 2,
      status: "running" as const,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    expect(await screen.findByText("Composer 2.5")).toBeTruthy();
    await waitFor(() => expect(getAcpMessageWindow).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Composer 2.5")).toBeTruthy());
    expect(screen.queryByText("No models available")).toBeNull();
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
          { type: "thinking" as const, content: "Deliberating about the repository" },
          { type: "text" as const, content: "Final answer" },
        ],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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
        parts: [{ type: "text" as const, content: "Working" }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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
      mode: "build",
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
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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
          parts: [{ type: "text" as const, content: "Do the work" }],
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        {
          id: "message-2",
          role: "assistant" as const,
          content: "Partial",
          parts: [{ type: "text" as const, content: "Partial" }],
          createdAt: "2026-08-13T00:00:01.000Z",
        },
      ],
      baseIndex: 0,
      revision: 2,
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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
        parts: [{ type: "text" as const, content: "Partial and then some" }],
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
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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
        parts: [{ type: "text" as const, content: "Finished while you were away" }],
        createdAt: "2026-08-13T00:00:09.000Z",
      }],
      baseIndex: 0,
      revision: 9,
      composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
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

  test("reconnects and rehydrates when the mounted tab's bridge generation changes", async () => {
    awaitBridgeReady
      .mockImplementationOnce(async () => ({
        status: "ready" as const,
        port: 4099,
        authToken: "token-a",
      }))
      .mockImplementationOnce(async () => ({
        status: "ready" as const,
        port: 4188,
        authToken: "token-b",
      }));
    getAcpApprovals.mockImplementationOnce(async () => [{
      id: "approval-1",
      title: "Trigger refresh",
      options: [],
    }]);
    getAcpMessageWindow.mockImplementationOnce(async () => {
      throw new Error("Unauthorized");
    });
    getAcpSession
      .mockImplementationOnce(async () => ({
        id: "persisted-session",
        provider: "cursor" as const,
        status: "idle" as const,
        messages: [],
        baseIndex: 0,
        revision: 1,
        composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
      }))
      .mockImplementationOnce(async () => ({
        id: "persisted-session",
        provider: "cursor" as const,
        status: "idle" as const,
        messages: [{
          id: "message-after-reconnect",
          role: "assistant" as const,
          content: "Recovered on the new bridge",
          parts: [{ type: "text" as const, content: "Recovered on the new bridge" }],
          createdAt: "2026-08-13T00:00:10.000Z",
        }],
        baseIndex: 0,
        revision: 2,
        composer: EMPTY_NATIVE_AGENT_COMPOSER_STATE,
      }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Recovered on the new bridge")).toBeTruthy();
    expect(awaitBridgeReady).toHaveBeenCalledTimes(2);
    expect(getAcpSession).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:4188", authToken: "token-b" },
      "persisted-session",
    );
    expect(screen.queryByText("Unauthorized")).toBeNull();
  });

  test("backs off instead of reconnecting once per poll when every read keeps failing", async () => {
    // A bridge that hands out working coordinates and then fails every read is
    // the amplifying case: each reconnect runs the readiness handshake, which
    // for a container environment does Docker work in the backend. Running
    // status polls at 350ms, so an unthrottled retry would issue a handshake
    // roughly three times a second for as long as the tab stays open.
    getAcpSession.mockImplementation(async () => sessionSnapshot({
      status: "running",
    }));
    getAcpMessageWindow.mockImplementation(async () => {
      throw new Error("Unauthorized");
    });

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);
    await waitFor(() => expect(awaitBridgeReady.mock.calls.length).toBeGreaterThan(1));

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));

    // Backed off (0ms, 500ms, 1s, 2s, …) the window fits the mount handshake
    // plus about three reconnects; unthrottled it fits roughly eight. A slower
    // machine only lowers the count, so the ceiling stays stable.
    const handshakes = awaitBridgeReady.mock.calls.length;
    expect(handshakes).toBeLessThanOrEqual(5);
    // Still retrying, though: backing off must not become giving up, or a
    // recoverable bridge would strand the tab until the user clicks Retry.
    expect(handshakes).toBeGreaterThan(1);
  });

  test("drops a pending backed-off reconnect when the tab unmounts", async () => {
    getAcpSession.mockImplementation(async () => sessionSnapshot({
      status: "running",
    }));
    getAcpMessageWindow.mockImplementation(async () => {
      throw new Error("Unauthorized");
    });

    const view = render(<AcpChatTab tabId="tab-1" data={data} isActive />);
    // The first failure reconnects immediately; the second is the one held
    // behind a 500ms backoff timer, which is what unmount has to cancel. Wait
    // long enough for the next poll (350ms) to fail and arm that timer, but
    // not long enough for it to fire.
    await waitFor(() => expect(awaitBridgeReady.mock.calls.length).toBeGreaterThan(1));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const beforeUnmount = awaitBridgeReady.mock.calls.length;

    view.unmount();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));

    // Unmount is the one case where abandoning the retry is right: no
    // component is left to rehydrate, and the backend keeps the session.
    expect(awaitBridgeReady.mock.calls.length).toBe(beforeUnmount);
  });

  test("renders the bridge-normalized composer picker and applies config through the adapter", async () => {
    const composer = {
      ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
      models: [{
        id: "composer-2.5",
        platform: "cursor" as const,
        label: "Composer 2.5",
        providerLabel: "Cursor",
        reasoning: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }],
        defaultReasoningId: "medium",
        supportsSpeed: true,
        supportsMode: true,
      }],
      selectedModelId: "composer-2.5",
      selectedReasoningId: "medium",
      fastModeEnabled: false,
      fastModeAvailable: true,
      selectedModeId: "build" as const,
      modes: [
        { id: "build" as const, label: "Build" },
        { id: "plan" as const, label: "Plan" },
      ],
    };
    getAcpSession.mockImplementation(async () => sessionSnapshot({ composer, revision: 4 }));
    setAcpSessionConfig.mockImplementation(async () => ({
      ...composer,
      selectedReasoningId: "high",
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    expect(await screen.findByText("Composer 2.5")).toBeTruthy();
    expect(screen.getByText("Build")).toBeTruthy();
    const picker = screen.getByTitle(/Choose model, reasoning, and speed/);
    fireEvent.pointerDown(picker);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /High/ }));

    await waitFor(() => expect(setAcpSessionConfig).toHaveBeenCalledWith(
      expect.anything(),
      "persisted-session",
      { reasoningId: "high" },
    ));
  });
});
