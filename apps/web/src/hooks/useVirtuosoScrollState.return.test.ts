import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
