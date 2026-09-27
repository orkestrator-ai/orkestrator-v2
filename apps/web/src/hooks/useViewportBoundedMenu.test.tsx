import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { computeViewportBoundedPlacement, useViewportBoundedMenu } from "./useViewportBoundedMenu";

describe("computeViewportBoundedPlacement", () => {
  test("opens above at the preferred height when there is room", () => {
    expect(
      computeViewportBoundedPlacement({ top: 700, bottom: 760 }, { top: 0, bottom: 800 }, 384),
    ).toEqual({
      side: "top",
      maxHeight: 384,
    });
  });

  test("shrinks to the space above the anchor inside the visible viewport", () => {
    // A phone with the keyboard open: the visual viewport is scrolled down and
    // only 250px sit between its top edge and the composer.
    expect(
      computeViewportBoundedPlacement({ top: 350, bottom: 400 }, { top: 100, bottom: 420 }, 384),
    ).toEqual({
      side: "top",
      maxHeight: 238,
    });
  });

  test("flips below when the space above is cramped and there is more room below", () => {
    expect(
      computeViewportBoundedPlacement({ top: 60, bottom: 110 }, { top: 0, bottom: 600 }, 384),
    ).toEqual({
      side: "bottom",
      maxHeight: 384,
    });
    expect(
      computeViewportBoundedPlacement({ top: 60, bottom: 110 }, { top: 0, bottom: 300 }, 384),
    ).toEqual({
      side: "bottom",
      maxHeight: 178,
    });
  });

  test("stays above when cramped but below is even tighter", () => {
    expect(
      computeViewportBoundedPlacement({ top: 100, bottom: 380 }, { top: 0, bottom: 400 }, 384),
    ).toEqual({
      side: "top",
      maxHeight: 88,
    });
  });

  test("keeps small menus above when they fit without flipping", () => {
    expect(
      computeViewportBoundedPlacement({ top: 140, bottom: 190 }, { top: 0, bottom: 800 }, 120),
    ).toEqual({
      side: "top",
      maxHeight: 120,
    });
  });

  test("does not force a row beyond the available space", () => {
    expect(
      computeViewportBoundedPlacement({ top: 42, bottom: 390 }, { top: 0, bottom: 400 }, 384),
    ).toEqual({ side: "top", maxHeight: 30 });
    expect(
      computeViewportBoundedPlacement({ top: 10, bottom: 390 }, { top: 0, bottom: 400 }, 384),
    ).toEqual({ side: "top", maxHeight: 0 });
  });
});

class FakeVisualViewport extends EventTarget {
  constructor(
    public offsetTop: number,
    public height: number,
  ) {
    super();
  }
}

function Probe() {
  const { setMenuRef, style, side } = useViewportBoundedMenu<HTMLDivElement>(384);
  return <div ref={setMenuRef} data-testid="menu" data-side={side} style={style} />;
}

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  unobserve(element: Element) {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect() {
    this.disconnected = true;
  }

  notify() {
    this.callback([], this);
  }
}

describe("useViewportBoundedMenu", () => {
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let anchorTop = 700;
  let anchorHeight = 50;
  let viewport: FakeVisualViewport;

  beforeEach(() => {
    anchorTop = 700;
    anchorHeight = 50;
    FakeResizeObserver.instances = [];
    viewport = new FakeVisualViewport(0, 800);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
  });

  afterEach(() => {
    cleanup();
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport);
    } else {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
    if (originalResizeObserver) {
      Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });

  function renderAnchored() {
    return render(
      <div
        ref={(node) => {
          if (!node) return;
          node.getBoundingClientRect = () =>
            ({ top: anchorTop, bottom: anchorTop + anchorHeight }) as DOMRect;
        }}
      >
        <Probe />
      </div>,
    );
  }

  test("bounds the menu to the visible viewport and tracks keyboard resizes", () => {
    renderAnchored();
    const menu = screen.getByTestId("menu");

    expect(menu.dataset.side).toBe("top");
    expect(menu.style.maxHeight).toBe("384px");
    expect(menu.style.bottom).toBe("100%");

    // The on-screen keyboard opens and the page scrolls the composer up.
    act(() => {
      anchorTop = 320;
      viewport.offsetTop = 120;
      viewport.height = 260;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(menu.dataset.side).toBe("top");
    expect(menu.style.maxHeight).toBe("188px");
  });

  test("opens below the anchor when it sits near the top of the viewport", () => {
    anchorTop = 40;
    renderAnchored();
    const menu = screen.getByTestId("menu");

    expect(menu.dataset.side).toBe("bottom");
    expect(menu.style.top).toBe("100%");
    expect(menu.style.bottom).toBe("");
    expect(menu.style.maxHeight).toBe("384px");
  });

  test("hides a menu when neither side fits a row", () => {
    anchorTop = 10;
    anchorHeight = 380;
    viewport.height = 400;
    renderAnchored();

    const menu = screen.getByTestId("menu");
    expect(menu.style.maxHeight).toBe("0");
    expect(menu.style.visibility).toBe("hidden");

    act(() => {
      anchorTop = 120;
      anchorHeight = 50;
      FakeResizeObserver.instances[0]!.notify();
    });
    expect(menu.style.visibility).toBe("");
    expect(menu.dataset.side).toBe("bottom");
    expect(menu.style.maxHeight).toBe("218px");
  });

  test("recomputes on scroll and composer resize", () => {
    renderAnchored();
    const menu = screen.getByTestId("menu");

    act(() => {
      anchorTop = 300;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(menu.style.maxHeight).toBe("288px");

    act(() => {
      anchorTop = 250;
      FakeResizeObserver.instances[0]!.notify();
    });
    expect(menu.style.maxHeight).toBe("238px");

    act(() => {
      viewport.offsetTop = 100;
      viewport.height = 300;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(menu.style.maxHeight).toBe("138px");
  });

  test("uses and observes the nearest clipping ancestor", () => {
    let clippingTop = 200;
    const { unmount } = render(
      <div
        style={{ overflowY: "hidden" }}
        ref={(node) => {
          if (node) {
            node.getBoundingClientRect = () => ({ top: clippingTop, bottom: 405 }) as DOMRect;
          }
        }}
      >
        <div
          ref={(node) => {
            if (node) {
              node.getBoundingClientRect = () => ({ top: 350, bottom: 400 }) as DOMRect;
            }
          }}
        >
          <Probe />
        </div>
      </div>,
    );
    const menu = screen.getByTestId("menu");
    expect(menu.style.maxHeight).toBe("138px");
    expect(FakeResizeObserver.instances[0]!.observed).toContain(menu.parentElement!.parentElement!);

    act(() => {
      clippingTop = 330;
      FakeResizeObserver.instances[0]!.notify();
    });
    expect(menu.style.maxHeight).toBe("8px");
    expect(menu.style.visibility).toBe("hidden");

    unmount();
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });
});
