import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { useConversationScrollTarget } from "./useConversationScrollTarget";

type HookProps = Parameters<typeof useConversationScrollTarget>[0];

const pending = () => useConversationScrollTargetStore.getState().peek("env-1", "tab-1");

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
    useConversationScrollTargetStore.getState().request("env-1", "tab-1", { messageId: "u-2" });
    const { result, scrollToIndex } = setup({ highlightMs: 300 });

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(2));
    expect(pending()).toBeNull();
    await waitFor(() => expect(result.current).toBe("u-2"));
    await waitFor(() => expect(result.current).toBeNull());
  });

  test("waits for the tab to become active and the message to load", async () => {
    useConversationScrollTargetStore.getState().request("env-1", "tab-1", { turnId: "turn-9" });
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
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(1));
    expect(pending()).toBeNull();
  });

  test("gives up shortly after the transcript settles without the message", async () => {
    useConversationScrollTargetStore
      .getState()
      .request("env-1", "tab-1", { messageId: "outside-window" });
    const { scrollToIndex, result } = setup();

    await waitFor(() => expect(pending()).toBeNull());
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test("drops an expired request without scrolling", async () => {
    useConversationScrollTargetStore
      .getState()
      .request("env-1", "tab-1", { messageId: "u-1" }, Date.now() - 60_000);
    const { scrollToIndex } = setup();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("retries while the list handle is not ready", async () => {
    let ready = false;
    const scrollToIndex = mock((_index: number) => ready);
    useConversationScrollTargetStore.getState().request("env-1", "tab-1", { messageId: "u-1" });
    setup({ scrollToIndex });

    await waitFor(() => expect(scrollToIndex.mock.calls.length).toBeGreaterThan(1));
    expect(pending()).not.toBeNull();
    act(() => {
      ready = true;
    });
    await waitFor(() => expect(pending()).toBeNull());
  });

  test("ignores requests for other tabs", async () => {
    useConversationScrollTargetStore.getState().request("env-1", "tab-2", { messageId: "u-1" });
    const { scrollToIndex } = setup();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(useConversationScrollTargetStore.getState().peek("env-1", "tab-2")).not.toBeNull();
  });
});
