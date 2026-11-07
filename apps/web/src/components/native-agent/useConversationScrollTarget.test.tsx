import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { ReactNode } from "react";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { useConversationScrollTarget } from "./useConversationScrollTarget";

type HookProps = Parameters<typeof useConversationScrollTarget>[0];

/** Outside a provider the chat is on the app's command node. */
const at = (
  environmentId: string,
  tabId: string,
  nodeId: BackendId = getWindowScope().commandScope().nodeId,
) => ({ nodeId, environmentId, tabId });

const pending = () => useConversationScrollTargetStore.getState().peek(at("env-1", "tab-1"));

function setup(overrides: Partial<HookProps> = {}) {
  const scrollToIndex = mock((_index: number) => true);
  const initialProps: HookProps = {
    environmentId: "env-1",
    tabId: "tab-1",
    isActive: true,
    messages: [{ id: "u-1" }, { id: "a-1" }, { id: "u-2" }],
    transcriptSettled: true,
    scrollToIndex,
    settledGraceMs: 30,
    highlightMs: 40,
    ...overrides,
  };
  const view = renderHook((props: HookProps) => useConversationScrollTarget(props), {
    initialProps,
  });
  return {
    ...view,
    scrollToIndex: (overrides.scrollToIndex ?? scrollToIndex) as typeof scrollToIndex,
    initialProps,
  };
}

beforeEach(() => resetConversationScrollTargets());
afterEach(() => cleanup());

describe("useConversationScrollTarget", () => {
  test("scrolls to a rendered message, consumes the request and highlights briefly", async () => {
    useConversationScrollTargetStore.getState().request(at("env-1", "tab-1"), { messageId: "u-2" });
    const { result, scrollToIndex } = setup({ highlightMs: 300 });

    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(2, { rowKey: "u-2" }, "message-link"),
    );
    expect(pending()).toBeNull();
    await waitFor(() => expect(result.current).toBe("u-2"));
    await waitFor(() => expect(result.current).toBeNull());
  });

  test("waits for the tab to become active and the message to load", async () => {
    useConversationScrollTargetStore.getState().request(at("env-1", "tab-1"), { turnId: "turn-9" });
    const { rerender, scrollToIndex, initialProps } = setup({
      isActive: false,
      transcriptSettled: false,
      messages: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    rerender({ ...initialProps, isActive: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(pending()).not.toBeNull();

    rerender({
      ...initialProps,
      isActive: true,
      transcriptSettled: true,
      messages: [{ id: "u-1" }, { id: "u-9" }, { id: "a-9" }],
      turnBoundaries: [{ turnId: "turn-9", messageId: "u-9" }],
    });
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(1, { rowKey: "u-9" }, "message-link"),
    );
    expect(pending()).toBeNull();
  });

  test("gives up shortly after the transcript settles without the message", async () => {
    useConversationScrollTargetStore
      .getState()
      .request(at("env-1", "tab-1"), { messageId: "outside-window" });
    const { scrollToIndex, result } = setup();

    await waitFor(() => expect(pending()).toBeNull());
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test("drops an expired request without scrolling", async () => {
    useConversationScrollTargetStore
      .getState()
      .request(at("env-1", "tab-1"), { messageId: "u-1" }, Date.now() - 60_000);
    const { scrollToIndex } = setup();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("retries while the list handle is not ready", async () => {
    let ready = false;
    const scrollToIndex = mock((_index: number) => ready);
    useConversationScrollTargetStore.getState().request(at("env-1", "tab-1"), { messageId: "u-1" });
    setup({ scrollToIndex });

    await waitFor(() => expect(scrollToIndex.mock.calls.length).toBeGreaterThan(1));
    expect(pending()).not.toBeNull();
    act(() => {
      ready = true;
    });
    await waitFor(() => expect(pending()).toBeNull());
  });

  test("ignores requests for other tabs", async () => {
    useConversationScrollTargetStore.getState().request(at("env-1", "tab-2"), { messageId: "u-1" });
    const { scrollToIndex } = setup();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(useConversationScrollTargetStore.getState().peek(at("env-1", "tab-2"))).not.toBeNull();
  });

  test("a scroll target for node A is ignored while node B's chat is shown", async () => {
    const windowScope = new WindowScope();
    try {
      const nodeA = windowScope.open({
        role: "command",
        client: new FakeNodeClient({ nodeId: "bk_node-a" as BackendId }),
      });
      const nodeB = windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "bk_node-b" as BackendId }),
      });
      const scrollToIndex = mock((_index: number) => true);
      renderHook(
        () =>
          useConversationScrollTarget({
            environmentId: "env-1",
            tabId: "tab-1",
            isActive: true,
            messages: [{ id: "u-1" }, { id: "u-2" }],
            transcriptSettled: true,
            scrollToIndex,
            settledGraceMs: 1_000,
          }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <WindowScopeProvider windowScope={windowScope}>
              <NodeScopeProvider scope={nodeB}>{children}</NodeScopeProvider>
            </WindowScopeProvider>
          ),
        },
      );

      act(() => {
        useConversationScrollTargetStore
          .getState()
          .request(at("env-1", "tab-1", nodeA.nodeId), { messageId: "u-2" });
      });
      // Node B's own request, made after A's, is consumed: by then A's has had
      // every chance, so its still being parked proves B's chat ignored it.
      act(() => {
        useConversationScrollTargetStore
          .getState()
          .request(at("env-1", "tab-1", nodeB.nodeId), { messageId: "u-2" });
      });
      await waitFor(() =>
        expect(scrollToIndex).toHaveBeenCalledWith(1, { rowKey: "u-2" }, "message-link"),
      );
      await waitFor(() =>
        expect(
          useConversationScrollTargetStore.getState().peek(at("env-1", "tab-1", nodeB.nodeId)),
        ).toBeNull(),
      );
      expect(scrollToIndex).toHaveBeenCalledTimes(1);
      expect(
        useConversationScrollTargetStore.getState().peek(at("env-1", "tab-1", nodeA.nodeId)),
      ).not.toBeNull();
    } finally {
      cleanup();
      windowScope.dispose();
    }
  });
});
