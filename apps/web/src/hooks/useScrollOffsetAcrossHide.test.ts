import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useScrollOffsetAcrossHide } from "./useScrollOffsetAcrossHide";

const OriginalResizeObserver = globalThis.ResizeObserver;

describe("useScrollOffsetAcrossHide", () => {
  let notifyResize: () => void;
  let disconnected: boolean;
  let element: HTMLDivElement;
  let clientHeight: number;

  beforeEach(() => {
    disconnected = false;
    clientHeight = 400;
    element = document.createElement("div");
    Object.defineProperty(element, "clientHeight", { get: () => clientHeight });
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        disconnected = true;
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  const render = () => renderHook(() => useScrollOffsetAcrossHide({ current: element })).result;

  const scrollTo = (top: number) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
  };

  const hide = () => {
    clientHeight = 0;
    act(() => notifyResize());
  };

  test("puts the offset back after WebKit resets it on show, before the observer runs", () => {
    const isHidden = render();
    scrollTo(700);
    hide();
    expect(isHidden.current()).toBe(true);

    // The engine's order: measurable again, offset gone, `scroll` first.
    clientHeight = 400;
    scrollTo(0);
    expect(isHidden.current()).toBe(true);

    act(() => notifyResize());
    expect(isHidden.current()).toBe(false);
    expect(element.scrollTop).toBe(700);
  });

  test("a resize of a visible scroller leaves the reader's offset alone", () => {
    const isHidden = render();
    scrollTo(700);
    element.scrollTop = 650;
    clientHeight = 300;
    act(() => notifyResize());
    expect(isHidden.current()).toBe(false);
    expect(element.scrollTop).toBe(650);
  });

  test("a reader's scroll after the show is remembered for the next hide", () => {
    render();
    scrollTo(700);
    hide();
    clientHeight = 400;
    act(() => notifyResize());
    scrollTo(120);
    hide();
    clientHeight = 400;
    scrollTo(0);
    act(() => notifyResize());
    expect(element.scrollTop).toBe(120);
  });

  test("starts hidden when mounted inside a hidden tab, then shows at the top", () => {
    clientHeight = 0;
    const isHidden = render();
    expect(isHidden.current()).toBe(true);
    clientHeight = 400;
    act(() => notifyResize());
    expect(isHidden.current()).toBe(false);
    expect(element.scrollTop).toBe(0);
  });

  test("stops observing on unmount", () => {
    const { unmount } = renderHook(() => useScrollOffsetAcrossHide({ current: element }));
    unmount();
    expect(disconnected).toBe(true);
  });
});
