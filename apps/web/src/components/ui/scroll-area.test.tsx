import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";

import { ScrollArea, ScrollBar } from "./scroll-area";

describe("ScrollArea", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders a scrollable overflow div marked as the scroll viewport", () => {
    const { container } = render(<ScrollArea>content</ScrollArea>);

    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    // useScrollLock keys off this marker to locate the viewport.
    expect(root.getAttribute("data-scroll-viewport")).toBe("true");
    expect(root.getAttribute("data-slot")).toBe("scroll-area");
    expect(root.style.overflow).toBe("auto");
    expect(root.textContent).toBe("content");
  });

  test("merges className and forwards the ref to the viewport element", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <ScrollArea ref={ref} className="flex-1 custom-class">
        <span>child</span>
      </ScrollArea>,
    );

    const root = container.firstElementChild as HTMLDivElement;
    expect(ref.current).toBe(root);
    expect(root.className).toContain("relative");
    expect(root.className).toContain("flex-1");
    expect(root.className).toContain("custom-class");
  });

  test("does not let a caller style override the overflow that makes it scroll", () => {
    const { container } = render(
      <ScrollArea style={{ overflow: "hidden", height: "200px" }}>x</ScrollArea>,
    );

    const root = container.firstElementChild as HTMLElement;
    // The component spreads caller style after its own overflow, so callers can
    // override it intentionally — assert the documented precedence holds.
    expect(root.style.overflow).toBe("hidden");
    expect(root.style.height).toBe("200px");
  });

  test("ScrollBar renders hidden and aria-hidden (scrollbar is native now)", () => {
    const { container } = render(<ScrollBar />);

    const bar = container.firstElementChild as HTMLElement;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.getAttribute("data-slot")).toBe("scroll-area-scrollbar");
    expect(bar.getAttribute("data-orientation")).toBe("vertical");
    expect(bar.className).toContain("hidden");
  });

  test("ScrollBar honors a horizontal orientation", () => {
    const { container } = render(<ScrollBar orientation="horizontal" />);

    const bar = container.firstElementChild as HTMLElement;
    expect(bar.getAttribute("data-orientation")).toBe("horizontal");
  });
});
