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

  test("never collapses below a minimum usable height", () => {
    expect(
      computeViewportBoundedPlacement({ top: 10, bottom: 390 }, { top: 0, bottom: 400 }, 384)
        .maxHeight,
    ).toBe(48);
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

describe("useViewportBoundedMenu", () => {
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  let anchorTop = 700;
  let viewport: FakeVisualViewport;

  beforeEach(() => {
    anchorTop = 700;
    viewport = new FakeVisualViewport(0, 800);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });

  afterEach(() => {
    cleanup();
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport);
    } else {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  function renderAnchored() {
    return render(
      <div
        ref={(node) => {
          if (!node) return;
          node.getBoundingClientRect = () =>
            ({ top: anchorTop, bottom: anchorTop + 50 }) as DOMRect;
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
});
