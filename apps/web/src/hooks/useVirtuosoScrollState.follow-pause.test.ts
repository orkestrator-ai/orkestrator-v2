import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVirtuosoScrollState } from "./useVirtuosoScrollState";

afterEach(() => cleanup());

/** A scroller with controllable geometry. */
function scroller(initial: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const element = document.createElement("div");
  let scrollHeight = initial.scrollHeight;
  Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(element, "clientHeight", { get: () => initial.clientHeight });
  element.scrollTop = initial.scrollTop;
  return {
    element,
    grow(by: number) {
      scrollHeight += by;
    },
  };
}

describe("useVirtuosoScrollState follow pausing", () => {
  test("a pause stops follow; releasing it brings a sticky reader to growth that arrived meanwhile", () => {
    const { result } = renderHook(() => useVirtuosoScrollState());
    const view = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => result.current.scrollProps.scrollerRef(view.element));
    expect(result.current.scrollProps.followOutput(true)).toBe("auto");

    act(() => result.current.scrollProps.setFollowPaused("selection", true));
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    view.grow(500);
    result.current.scrollProps.totalListHeightChanged(1500);
    // The reader keeps their place while selecting.
    expect(view.element.scrollTop).toBe(600);

    // A second reason holds the pause after the first is released.
    act(() => result.current.scrollProps.setFollowPaused("find", true));
    act(() => result.current.scrollProps.setFollowPaused("selection", false));
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    expect(view.element.scrollTop).toBe(600);

    act(() => result.current.scrollProps.setFollowPaused("find", false));
    expect(result.current.scrollProps.followOutput(true)).toBe("auto");
    expect(view.element.scrollTop).toBe(1100);
  });

  test("releasing a pause without intervening growth does not move the reader", () => {
    const { result } = renderHook(() => useVirtuosoScrollState());
    const view = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 250 });
    act(() => result.current.scrollProps.scrollerRef(view.element));
    act(() => result.current.scrollProps.setFollowPaused("find", true));
    act(() => result.current.scrollProps.setFollowPaused("find", false));
    expect(view.element.scrollTop).toBe(250);
  });

  test("a reader who scrolled up during the pause is not pulled down on release", () => {
    const { result } = renderHook(() => useVirtuosoScrollState());
    const view = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    act(() => result.current.scrollProps.scrollerRef(view.element));
    act(() => result.current.scrollProps.setFollowPaused("selection", true));
    view.grow(500);
    result.current.scrollProps.totalListHeightChanged(1500);
    // User scrolls up with the wheel while paused: stick intent is released.
    view.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    view.element.scrollTop = 200;
    view.element.dispatchEvent(new Event("scroll"));
    act(() => result.current.scrollProps.setFollowPaused("selection", false));
    expect(view.element.scrollTop).toBe(200);
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
  });
});
