import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// Typed from the real signature in `@/lib/backend` rather than inferred from
// this body: `mock(async () => undefined)` infers `Promise<undefined>`, which
// then rejects every `Promise<void>` override and fails `tsc` — invisibly,
// because `bun test` does not typecheck.
const renameEnvironmentFromPrompt = mock(async (): Promise<void> => {});
const getEnvironmentById = mock((_id: string): { name: string } | undefined => undefined);
const environmentStore = { getEnvironmentById };
const useEnvironmentStore = Object.assign(
  (selector: (state: typeof environmentStore) => unknown) => selector(environmentStore),
  { getState: () => environmentStore },
);
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
  renameEnvironmentFromPrompt,
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
  useEnvironmentStore,
}));

import { AcpChatTab } from "./AcpChatTab";
import { useAcpPendingPromptStore } from "@/stores/acpPendingPromptStore";

const data = {
  platform: "cursor" as const,
  environmentId: "environment-1",
  sessionId: "persisted-session",
};

function getAcpPromptInput(container: ParentNode = document): HTMLElement {
  const queryRoot = container instanceof HTMLElement ? container : document.body;
  return within(queryRoot).getByRole("textbox", { name: "Message Cursor Agent" });
}

beforeEach(() => {
  for (const fn of [
    awaitBridgeReady,
    ensureNativeAgentSession,
    adoptNativeAgentSession,
    dispatchNativeAgentPrompt,
    renameEnvironmentFromPrompt,
    getEnvironmentById,
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
  renameEnvironmentFromPrompt.mockImplementation(async () => {});
  getEnvironmentById.mockImplementation(() => undefined);
  // Real store, so the store-backed pending prompt is exercised end to end.
  // It outlives the component by design, so each test starts from empty.
  useAcpPendingPromptStore.setState({ pending: new Map() });
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

/**
 * Drains the microtask queue and one macrotask turn.
 *
 * Several assertions below are about what `submit` has *not* done by the time
 * it settles, so they need the whole continuation — including its `finally` —
 * to have run before they read the DOM.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

  test("uses the shared native compose bar for Grok sessions too", async () => {
    render(
      <AcpChatTab
        tabId="tab-grok"
        data={{ ...data, platform: "grok" }}
        isActive
      />,
    );

    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    expect(within(composeBar).getByRole("textbox", { name: "Message Grok Build" }))
      .toBeTruthy();
    expect(composeBar.querySelector("[data-native-compose-toolbar]")).toBeTruthy();
  });

  test("renders normalized ACP tool calls from the bridge snapshot", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [{
        id: "message-tools",
        role: "assistant" as const,
        content: "",
        parts: [{
          type: "tool-invocation" as const,
          content: "Search for references",
          sourcePartId: "tool:search-1",
          sourceMessageId: "message-tools",
          toolUseId: "search-1",
          toolName: "search",
          toolArgs: { pattern: "value" },
          toolState: "success" as const,
          toolTitle: "Search for references",
          toolOutput: "3 matches",
        }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 4,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive />);

    expect(await screen.findByText("Search")).toBeTruthy();
    expect(screen.getByText("value")).toBeTruthy();
    expect(screen.getByText("success")).toBeTruthy();
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
    const composeBar = screen.getByTestId("acp-native-compose-bar");
    expect(dock.contains(composeBar)).toBe(true);
    expect(dock.contains(getAcpPromptInput(composeBar))).toBe(true);
    expect(screen.getByTestId("transcript-bottom-spacer")).toBeTruthy();
    // A running turn shows the shell's thinking indicator, not a bare spinner.
    expect(screen.getByTitle("Stop current query")).toBeTruthy();
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
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Run the checks";
    fireEvent.input(compose);
    fireEvent.click(screen.getByTitle("Send"));

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

  test("submits Enter but preserves Shift+Enter and IME composition", async () => {
    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);

    compose.textContent = "Use a multiline prompt";
    fireEvent.input(compose);

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    compose.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(dispatchNativeAgentPrompt).not.toHaveBeenCalled();

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    compose.dispatchEvent(composingEnter);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(dispatchNativeAgentPrompt).not.toHaveBeenCalled();

    // The WebKit shape: compositionend already fired, so only keyCode 229
    // still marks this Enter as an IME confirmation. The tab delegates that
    // judgement to MentionableInput, so it has to hold end to end.
    const webkitComposingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: false,
      keyCode: 229,
    });
    compose.dispatchEvent(webkitComposingEnter);
    expect(webkitComposingEnter.defaultPrevented).toBe(false);
    expect(dispatchNativeAgentPrompt).not.toHaveBeenCalled();

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      compose.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Use a multiline prompt" }),
    ));
  });

  test("locks the composer while a manual dispatch is pending", async () => {
    let acceptDispatch!: (value: { providerSessionId: string }) => void;
    dispatchNativeAgentPrompt.mockImplementation(() => new Promise((resolve) => {
      acceptDispatch = resolve;
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Only dispatch once";
    fireEvent.input(compose);

    const send = screen.getByTitle("Send") as HTMLButtonElement;
    fireEvent.click(send);
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(1));

    expect(send.disabled).toBe(true);
    expect(compose.getAttribute("contenteditable")).toBe("false");
    fireEvent.click(send);
    fireEvent.keyDown(compose, { key: "Enter" });
    expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      acceptDispatch({ providerSessionId: "persisted-session" });
    });
    await waitFor(() => {
      expect(compose.getAttribute("contenteditable")).toBe("true");
    });
  });

  test("hands the draft back and unlocks the composer when a manual dispatch fails", async () => {
    dispatchNativeAgentPrompt.mockImplementation(async () => {
      throw new Error("dispatch rejected");
    });

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Keep my words";
    fireEvent.input(compose);

    const send = screen.getByTitle("Send") as HTMLButtonElement;
    fireEvent.click(send);

    expect(await screen.findByText("dispatch rejected")).toBeTruthy();
    // A failed send must return the prompt rather than eat it, and must not
    // leave the composer locked behind the cleared `dispatching` flag.
    await waitFor(() => expect(compose.textContent).toBe("Keep my words"));
    expect(compose.getAttribute("contenteditable")).toBe("true");
    expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(false);
  });

  test("keeps the draft when Enter arrives while a turn is already running", async () => {
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [],
      baseIndex: 0,
      revision: 1,
    }));
    getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
      messages: [],
      baseIndex: fromIndex,
      totalMessages: fromIndex,
      revision: 1,
      status: "running" as const,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Not yet";
    fireEvent.input(compose);

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      compose.dispatchEvent(enter);
    });

    // ACP has no prompt queue, so a mid-turn Enter is a no-op. The one thing it
    // must never do is clear the draft it refused to send.
    expect(dispatchNativeAgentPrompt).not.toHaveBeenCalled();
    expect(compose.textContent).toBe("Not yet");
    expect(screen.getByTitle("Stop current query")).toBeTruthy();
    expect(screen.queryByTitle("Send")).toBeNull();
  });

  test("returns focus to the composer after a send that started there", async () => {
    let acceptDispatch!: (value: { providerSessionId: string }) => void;
    dispatchNativeAgentPrompt.mockImplementation(() => new Promise((resolve) => {
      acceptDispatch = resolve;
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Focus comes back";
    fireEvent.input(compose);
    compose.focus();
    expect(document.activeElement).toBe(compose);

    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      compose.dispatchEvent(enter);
    });
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(1));

    // A real browser drops the caret when contenteditable flips to false.
    // happy-dom does not, so model it here — otherwise the assertion below
    // would pass on focus that never moved.
    expect(compose.getAttribute("contenteditable")).toBe("false");
    compose.blur();
    expect(document.activeElement).not.toBe(compose);

    await act(async () => {
      acceptDispatch({ providerSessionId: "persisted-session" });
    });
    await waitFor(() => expect(document.activeElement).toBe(compose));
  });

  test("does not pull focus back when the send started outside the composer", async () => {
    let acceptDispatch!: (value: { providerSessionId: string }) => void;
    dispatchNativeAgentPrompt.mockImplementation(() => new Promise((resolve) => {
      acceptDispatch = resolve;
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    const compose = getAcpPromptInput(composeBar);
    compose.textContent = "Sent by mouse";
    fireEvent.input(compose);
    compose.blur();
    expect(document.activeElement).not.toBe(compose);

    fireEvent.click(screen.getByTitle("Send"));
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(1));

    await act(async () => {
      acceptDispatch({ providerSessionId: "persisted-session" });
    });
    await waitFor(() => expect(compose.getAttribute("contenteditable")).toBe("true"));
    // Restoring focus is only correct when the composer is what lost it.
    expect(document.activeElement).not.toBe(compose);
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
    fireEvent.click(screen.getByTitle("Stop current query"));
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
    }));
    const view = render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const composeBar = await screen.findByTestId("acp-native-compose-bar");
    expect(getAcpPromptInput(composeBar)).toBeTruthy();
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
    expect(screen.getByTitle("Send")).toBeTruthy();
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
    expect(screen.queryByTitle("Send")).toBeNull();

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
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [],
      baseIndex: 0,
      revision: 1,
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
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "running" as const,
      messages: [],
      baseIndex: 0,
      revision: 1,
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

  test("renames a timestamp-named environment before dispatching the first Cursor prompt", async () => {
    const callOrder: string[] = [];
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    renameEnvironmentFromPrompt.mockImplementation(async () => {
      callOrder.push("rename");
    });
    dispatchNativeAgentPrompt.mockImplementation(async () => {
      callOrder.push("dispatch");
      return { providerSessionId: "persisted-session" };
    });

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Implement the billing export";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalled());
    expect(renameEnvironmentFromPrompt).toHaveBeenCalledWith(
      "environment-1",
      "Implement the billing export",
    );
    expect(callOrder).toEqual(["rename", "dispatch"]);
  });

  test("renames a compact Electron timestamp environment before the first Grok prompt", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "202604151234567" }));

    render(
      <AcpChatTab
        tabId="tab-1"
        data={{ ...data, platform: "grok" }}
        isActive={false}
      />,
    );
    const compose = await screen.findByRole("textbox", { name: "Message Grok Build" });
    compose.textContent = "Add pagination to the review table";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(renameEnvironmentFromPrompt).toHaveBeenCalledWith(
      "environment-1",
      "Add pagination to the review table",
    ));
    expect(dispatchNativeAgentPrompt).toHaveBeenCalled();
  });

  test("does not rename a custom-named environment on the first ACP prompt", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "review-table" }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Keep this branch name";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalled());
    expect(renameEnvironmentFromPrompt).not.toHaveBeenCalled();
  });

  test("does not rename when the ACP session already has messages", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [{
        id: "message-1",
        role: "user" as const,
        content: "Earlier work",
        parts: [{ type: "text" as const, content: "Earlier work" }],
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
      baseIndex: 0,
      revision: 2,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    expect(await screen.findByText("Earlier work")).toBeTruthy();
    const compose = screen.getByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Continue the work";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalled());
    expect(renameEnvironmentFromPrompt).not.toHaveBeenCalled();
  });

  test("continues dispatching the first prompt when renaming fails", async () => {
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    console.warn = consoleWarn as unknown as typeof console.warn;
    const renameError = new Error("rename unavailable");
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    renameEnvironmentFromPrompt.mockImplementation(async () => {
      throw renameError;
    });

    try {
      render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
      const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
      compose.textContent = "Investigate the failing setup flow";
      fireEvent.input(compose);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Investigate the failing setup flow" }),
      ));
      expect(consoleWarn).toHaveBeenCalledWith(
        "[AcpChatTab] Failed to rename environment from prompt:",
        renameError,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("shows the first prompt and naming feedback before the rename completes", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    let resolveRename: (() => void) | undefined;
    renameEnvironmentFromPrompt.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRename = resolve;
      }),
    );

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Audit the flaky reconnect flow";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Audit the flaky reconnect flow")).toBeTruthy();
    expect(screen.getByText("Naming environment...")).toBeTruthy();
    expect(dispatchNativeAgentPrompt).not.toHaveBeenCalled();

    resolveRename?.();

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Audit the flaky reconnect flow" }),
    ));
    await waitFor(() => expect(screen.queryByText("Naming environment...")).toBeNull());
  });

  test("auto-sends initialPrompt through the same rename path", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));

    render(
      <AcpChatTab
        tabId="tab-1"
        data={data}
        isActive={false}
        initialPrompt="Set up the environment for release automation"
      />,
    );

    await waitFor(() => expect(renameEnvironmentFromPrompt).toHaveBeenCalledWith(
      "environment-1",
      "Set up the environment for release automation",
    ));
    expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Set up the environment for release automation",
      requestId: "initial-prompt:environment-1:tab-1",
    }));
  });

  test("keeps the first prompt on screen when the post-dispatch refresh reads a stale window", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Trace the stale window";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The default window mock returns no messages, which is exactly what a poll
    // issued before the dispatch reports — and what `refresh` returns outright
    // when it is skipped because an earlier poll is still in flight. Retiring
    // the local row on the dispatch returning would blank the message here.
    await waitFor(() => expect(getAcpMessageWindow).toHaveBeenCalled());
    await settle();

    expect(screen.getByText("Trace the stale window")).toBeTruthy();
    expect(useAcpPendingPromptStore.getState().pending.get("env-environment-1:tab-1")).toEqual({
      text: "Trace the stale window",
      createdAt: expect.any(String),
      isNaming: false,
    });
  });

  test("retires the local copy once the transcript echoes the prompt", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    getAcpMessageWindow.mockImplementation(async (_client, _sessionId, fromIndex) => ({
      messages: [{
        id: "message-1",
        role: "user" as const,
        content: "Ship the echo",
        parts: [{ type: "text" as const, content: "Ship the echo" }],
        createdAt: "2026-08-14T00:00:00.000Z",
      }],
      baseIndex: fromIndex,
      totalMessages: fromIndex + 1,
      revision: 2,
      status: "idle" as const,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Ship the echo";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(useAcpPendingPromptStore.getState().pending.size).toBe(0));
    await settle();
    // The authoritative row replaced the local one rather than joining it.
    expect(screen.getAllByText("Ship the echo").length).toBe(1);
  });

  test("keeps the pending first prompt across an unmount while the rename runs", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    let resolveRename: (() => void) | undefined;
    renameEnvironmentFromPrompt.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRename = resolve;
      }),
    );

    const first = render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Rename across the switch";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Rename across the switch")).toBeTruthy();

    // Switching to another environment unmounts the tab. The rename and the
    // dispatch it gates are backend work, so neither may be abandoned, and the
    // prompt has to still be there when the user comes back.
    first.unmount();
    resolveRename?.();
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Rename across the switch" }),
    ));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    expect(await screen.findByText("Rename across the switch")).toBeTruthy();
    expect(screen.queryByText("Naming environment...")).toBeNull();
  });

  test("disables Send while the rename gates the first prompt", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    let resolveRename: (() => void) | undefined;
    renameEnvironmentFromPrompt.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRename = resolve;
      }),
    );

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Audit the naming gate";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Naming environment...")).toBeTruthy();

    // The rename is a backend round trip, so this window is seconds long. An
    // enabled Send here is a lie: `submit` rejects it on its re-entry guard and
    // says nothing.
    compose.textContent = "A second thought";
    fireEvent.input(compose);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    resolveRename?.();
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(false));
  });

  test("does not rename when the transcript window starts past the first message", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    // An empty window over an evicted history: the session has run before even
    // though it currently holds no rows, so its name is not up for grabs.
    getAcpSession.mockImplementation(async () => ({
      id: "persisted-session",
      provider: "cursor" as const,
      status: "idle" as const,
      messages: [],
      baseIndex: 4,
      revision: 6,
    }));

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Continue after eviction";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalled());
    expect(renameEnvironmentFromPrompt).not.toHaveBeenCalled();
  });

  test("returns the prompt to the composer and renames only once when the first dispatch fails", async () => {
    getEnvironmentById.mockImplementation(() => ({ name: "20260814-004236" }));
    renameEnvironmentFromPrompt.mockImplementation(async () => {
      // The rename is what the retry's guard reads, so it is the reason a
      // second attempt must not rename again.
      getEnvironmentById.mockImplementation(() => ({ name: "billing-export" }));
    });
    dispatchNativeAgentPrompt.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });

    render(<AcpChatTab tabId="tab-1" data={data} isActive={false} />);
    const compose = await screen.findByRole("textbox", { name: "Message Cursor Agent" });
    compose.textContent = "Implement the billing export";
    fireEvent.input(compose);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // No echo is coming for a dispatch that never landed, so the local row is
    // dropped and the text goes back to the composer instead of stranding it.
    await waitFor(() => expect(screen.getByText("bridge unavailable")).toBeTruthy());
    await waitFor(() => expect(useAcpPendingPromptStore.getState().pending.size).toBe(0));
    expect(compose.textContent).toBe("Implement the billing export");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(dispatchNativeAgentPrompt).toHaveBeenCalledTimes(2));
    expect(renameEnvironmentFromPrompt).toHaveBeenCalledTimes(1);
  });
});
