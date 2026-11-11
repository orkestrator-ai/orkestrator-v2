import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRestorePlaceAfterHistoryDrop } from "./useRestorePlaceAfterHistoryDrop";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { clearPersistedVirtuosoState, useVirtuosoScrollState } from "./useVirtuosoScrollState";

afterEach(() => {
  cleanup();
  clearPersistedVirtuosoState("return-key");
});

/**
 * A scroller holding one row (`k5`) whose document position the test sets, so
 * a "reflow" can move it between mounts.
 */
function scrollerWithRow(rowDocumentTop: () => number) {
  const element = document.createElement("div");
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => 5000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, 4400));
    },
  });
  element.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
  element.innerHTML = '<div data-chat-message-index="5" data-chat-message-key="k5"></div>';
  const row = element.firstElementChild as HTMLElement;
  row.getBoundingClientRect = () =>
    ({ top: rowDocumentTop() - top, bottom: rowDocumentTop() - top + 200, height: 200 }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function handle() {
  return {
    scrollToIndex: mock(() => {}),
    scrollTo: mock(() => {}),
    getState: (callback: (snapshot: unknown) => void) => callback({ ranges: [], scrollTop: 0 }),
    cancelPendingNavigation: mock(() => {}),
  };
}

describe("returning a detached reader to their semantic place", () => {
  test("a remount after a reflow restores the persisted row at its viewport offset", async () => {
    let rowTop = 2000;
    const first = renderHook(
      ({ isActive }) => useVirtuosoScrollState({ isActive, persistKey: "return-key" }),
      { initialProps: { isActive: true } },
    );
    first.result.current.virtuosoRef.current = handle() as never;
    const firstScroller = scrollerWithRow(() => rowTop);
    firstScroller.scrollTop = 4400;
    act(() => first.result.current.scrollProps.scrollerRef(firstScroller));
    // The reader scrolls up and reads with k5 80px below the viewport top.
    act(() => {
      firstScroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      firstScroller.scrollTop = 1920;
      firstScroller.dispatchEvent(new Event("scroll"));
    });
    expect(first.result.current.scrollProps.followOutput(true)).toBe(false);
    first.rerender({ isActive: false });
    first.unmount();
    firstScroller.remove();

    // A wider pane: the same row now sits 300px further down the document.
    rowTop = 2300;
    const second = renderHook(() =>
      useVirtuosoScrollState({ isActive: true, persistKey: "return-key" }),
    );
    second.result.current.virtuosoRef.current = handle() as never;
    const secondScroller = scrollerWithRow(() => rowTop);
    act(() => second.result.current.scrollProps.scrollerRef(secondScroller));
    await waitFor(() => expect(secondScroller.scrollTop).toBe(2220));
    expect(second.result.current.scrollProps.followOutput(true)).toBe(false);
    expect(second.result.current.getScrollDiagnostics().lastOutcome).toBe("converged");
    secondScroller.remove();
  });

  test("a remount reserves activation while paging to its persisted source part", async () => {
    const first = renderHook(
      ({ isActive }) => useVirtuosoScrollState({ isActive, persistKey: "return-key" }),
      { initialProps: { isActive: true } },
    );
    first.result.current.virtuosoRef.current = handle() as never;
    const oldScroller = scrollerWithRow(() => 2000);
    oldScroller.firstElementChild!.setAttribute("data-transcript-part-id", "call5");
    oldScroller.scrollTop = 4400;
    act(() => {
      first.result.current.scrollProps.scrollerRef(oldScroller);
    });
    act(() => {
      oldScroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      oldScroller.scrollTop = 1920;
      oldScroller.dispatchEvent(new Event("scroll"));
    });
    // A workspace switch may unmount directly without an inactive commit.
    first.unmount();
    oldScroller.remove();
    const tail: NativeMessage[] = [
      { id: "tail", role: "assistant", content: "", createdAt: "2026-11-06", parts: [] },
    ];
    const loadEarlier = mock(() => new Promise<void>(() => {}));
    const second = renderHook(
      ({ messages }) => {
        const scroll = useVirtuosoScrollState({ isActive: true, persistKey: "return-key" });
        const restoring = useRestorePlaceAfterHistoryDrop({
          sessionKey: "return-key",
          messages,
          controller: scroll.scrollProps.controller,
          loading: false,
          canLoadEarlier: true,
          loadEarlier,
          scrollToIndex: scroll.scrollToIndex,
        });
        return { ...scroll, restoring };
      },
      { initialProps: { messages: tail } },
    );
    expect(second.result.current.scrollProps.controller.readingAnchor?.partId).toBe("call5");
    expect(second.result.current.restoring).toBe(true);
    const virtualizer = handle();
    second.result.current.virtuosoRef.current = virtualizer as never;
    const scroller = scrollerWithRow(() => 2300);
    scroller.firstElementChild!.setAttribute("data-transcript-part-id", "call5");
    act(() => second.result.current.scrollProps.scrollerRef(scroller));
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    second.rerender({
      messages: [
        {
          ...tail[0]!,
          id: "k5",
          parts: [{ type: "text", content: "restored", sourcePartId: "call5" }],
        },
        ...tail,
      ],
    });
    await waitFor(() => expect(scroller.scrollTop).toBe(2220));
    expect(second.result.current.restoring).toBe(false);
    scroller.remove();
  });

  test("a follower is not restored to a row: growth keeps them at the end", async () => {
    const first = renderHook(
      ({ isActive }) => useVirtuosoScrollState({ isActive, persistKey: "return-key" }),
      { initialProps: { isActive: true } },
    );
    first.result.current.virtuosoRef.current = handle() as never;
    first.rerender({ isActive: false });
    first.unmount();
    const second = renderHook(() =>
      useVirtuosoScrollState({ isActive: true, persistKey: "return-key" }),
    );
    const scrollerHandle = handle();
    second.result.current.virtuosoRef.current = scrollerHandle as never;
    const scroller = scrollerWithRow(() => 2000);
    act(() => second.result.current.scrollProps.scrollerRef(scroller));
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(scrollerHandle.scrollToIndex).not.toHaveBeenCalled();
    expect(second.result.current.scrollProps.followOutput(true)).toBe("auto");
    act(() => second.result.current.scrollProps.totalListHeightChanged(5000));
    expect(scroller.scrollTop).toBe(4400);
    scroller.remove();
  });
});

describe("a `latest` view hidden inside an active host", () => {
  /** A detached reader at 1920 (k5 80px below the top) in a `latest` view. */
  function detachedLatestView() {
    const view = renderHook(
      ({ isActive, visible }) =>
        useVirtuosoScrollState({ isActive, visible, activation: "latest" }),
      { initialProps: { isActive: true, visible: true } },
    );
    const virtualizer = handle();
    view.result.current.virtuosoRef.current = virtualizer as never;
    const scroller = scrollerWithRow(() => 2000);
    scroller.scrollTop = 4400;
    act(() => view.result.current.scrollProps.scrollerRef(scroller));
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      scroller.scrollTop = 1920;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(view.result.current.scrollProps.followOutput(true)).toBe(false);
    return { view, virtualizer, scroller };
  }

  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 40)));

  test("returning from another view in the same tab keeps the reader's place", async () => {
    const { view, virtualizer, scroller } = detachedLatestView();
    view.rerender({ isActive: true, visible: false });
    view.rerender({ isActive: true, visible: true });
    await settle();
    expect(scroller.scrollTop).toBe(1920);
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();
    expect(view.result.current.scrollProps.followOutput(true)).toBe(false);
    scroller.remove();
  });

  test("a follower back from another view catches up to the end", async () => {
    const view = renderHook(
      ({ isActive, visible }) =>
        useVirtuosoScrollState({ isActive, visible, activation: "latest" }),
      { initialProps: { isActive: true, visible: true } },
    );
    view.result.current.virtuosoRef.current = handle() as never;
    const scroller = scrollerWithRow(() => 2000);
    scroller.scrollTop = 4400;
    act(() => view.result.current.scrollProps.scrollerRef(scroller));
    view.rerender({ isActive: true, visible: false });
    // Output arrived while hidden and left the hidden offset short of the end.
    scroller.scrollTop = 3000;
    view.rerender({ isActive: true, visible: true });
    await waitFor(() => expect(scroller.scrollTop).toBe(4400));
    expect(view.result.current.scrollProps.followOutput(true)).toBe("auto");
    scroller.remove();
  });

  test("returning to the tab still shows the latest message", async () => {
    const { view, scroller } = detachedLatestView();
    view.rerender({ isActive: false, visible: true });
    view.rerender({ isActive: true, visible: true });
    await waitFor(() => expect(scroller.scrollTop).toBe(4400));
    expect(view.result.current.scrollProps.followOutput(true)).toBe("auto");
    scroller.remove();
  });

  test("leaving the tab while the view was hidden counts as a tab return", async () => {
    const { view, scroller } = detachedLatestView();
    view.rerender({ isActive: true, visible: false });
    view.rerender({ isActive: false, visible: false });
    view.rerender({ isActive: true, visible: false });
    await settle();
    expect(scroller.scrollTop).toBe(1920);
    view.rerender({ isActive: true, visible: true });
    await waitFor(() => expect(scroller.scrollTop).toBe(4400));
    scroller.remove();
  });

  test("a view return after a tab return is a view return again", async () => {
    const { view, scroller } = detachedLatestView();
    view.rerender({ isActive: false, visible: true });
    view.rerender({ isActive: true, visible: true });
    await waitFor(() => expect(scroller.scrollTop).toBe(4400));
    // A browser fires `scroll` for the navigation's write; this fake does not.
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      scroller.scrollTop = 1920;
      scroller.dispatchEvent(new Event("scroll"));
    });
    view.rerender({ isActive: true, visible: false });
    view.rerender({ isActive: true, visible: true });
    await settle();
    expect(scroller.scrollTop).toBe(1920);
    scroller.remove();
  });
});
