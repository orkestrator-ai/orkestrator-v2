import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { HoverTooltipContent, useHoverTooltip } from "./hover-tooltip";

type TooltipSide = "bottom" | "right";
type TooltipAlign = "center" | "start";

function makeRect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setAnchorRect(anchor: HTMLElement, getRect: () => DOMRect) {
  Object.defineProperty(anchor, "getBoundingClientRect", {
    configurable: true,
    value: getRect,
  });
}

function ContextMenuButtonWithHoverTooltip({
  openDelay = 0,
  closeDelay = 100,
  side = "bottom",
  align = "center",
  sideOffset = 4,
}: {
  openDelay?: number;
  closeDelay?: number;
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tooltip = useHoverTooltip(openDelay, closeDelay);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={anchorRef}
          type="button"
          onMouseEnter={tooltip.show}
          onMouseLeave={tooltip.hide}
        >
          Run
        </button>
      </ContextMenuTrigger>
      <HoverTooltipContent
        anchorRef={anchorRef}
        open={tooltip.open}
        side={side}
        align={align}
        sideOffset={sideOffset}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
      >
        Run command
      </HoverTooltipContent>
      <ContextMenuContent>
        <ContextMenuItem>Run with Codex</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function OpenTooltipWithoutAnchor() {
  const anchorRef = useRef<HTMLElement | null>(null);

  return (
    <HoverTooltipContent anchorRef={anchorRef} open>
      Missing anchor
    </HoverTooltipContent>
  );
}

describe("HoverTooltipContent", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows tooltip content without nesting Radix tooltip and context-menu triggers", async () => {
    render(<ContextMenuButtonWithHoverTooltip />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByText("Run command")).toBeTruthy();
    });
  });

  test("waits for the open delay before showing a new tooltip", async () => {
    render(<ContextMenuButtonWithHoverTooltip openDelay={150} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Run" }));

    // Tooltip should not appear immediately on hover.
    expect(screen.queryByText("Run command")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Run command")).toBeTruthy();
    });
  });

  test("cancels a pending tooltip when the cursor leaves before the delay", async () => {
    render(<ContextMenuButtonWithHoverTooltip openDelay={150} />);

    const button = screen.getByRole("button", { name: "Run" });
    fireEvent.mouseEnter(button);
    fireEvent.mouseLeave(button);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(screen.queryByText("Run command")).toBeNull();
  });

  test("keeps tooltip visible for the close delay before hiding", async () => {
    render(<ContextMenuButtonWithHoverTooltip closeDelay={50} />);

    const button = screen.getByRole("button", { name: "Run" });
    fireEvent.mouseEnter(button);

    await waitFor(() => {
      expect(screen.getByText("Run command")).toBeTruthy();
    });

    fireEvent.mouseLeave(button);

    expect(screen.getByText("Run command")).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByText("Run command")).toBeNull();
    });
  });

  test("positions bottom center tooltips from the anchor center and side offset", async () => {
    render(<ContextMenuButtonWithHoverTooltip />);

    const button = screen.getByRole("button", { name: "Run" });
    setAnchorRect(button, () => makeRect({ left: 100, top: 50, width: 40, height: 20 }));

    fireEvent.mouseEnter(button);

    const tooltip = await waitFor(() => screen.getByText("Run command"));

    expect(tooltip.style.left).toBe("120px");
    expect(tooltip.style.top).toBe("74px");
    expect(tooltip.style.transform).toBe("translateX(-50%)");
  });

  test("positions bottom start tooltips from the anchor edge and custom side offset", async () => {
    render(<ContextMenuButtonWithHoverTooltip align="start" sideOffset={12} />);

    const button = screen.getByRole("button", { name: "Run" });
    setAnchorRect(button, () => makeRect({ left: 100, top: 50, width: 40, height: 20 }));

    fireEvent.mouseEnter(button);

    const tooltip = await waitFor(() => screen.getByText("Run command"));

    expect(tooltip.style.left).toBe("100px");
    expect(tooltip.style.top).toBe("82px");
    expect(tooltip.style.transform).toBe("");
  });

  test("centers the arrow for center-aligned bottom tooltips", async () => {
    render(<ContextMenuButtonWithHoverTooltip />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Run" }));

    const arrow = await waitFor(() => {
      const element = document.body.querySelector('[data-slot="hover-tooltip-arrow"]');
      expect(element).toBeTruthy();
      return element;
    });

    expect(arrow?.className).toContain("left-1/2");
    expect(arrow?.className).toContain("-translate-x-1/2");
    expect(arrow?.className).not.toContain("left-4");
  });

  test("keeps leading arrow placement for start-aligned bottom tooltips", async () => {
    render(<ContextMenuButtonWithHoverTooltip align="start" />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Run" }));

    const arrow = await waitFor(() => {
      const element = document.body.querySelector('[data-slot="hover-tooltip-arrow"]');
      expect(element).toBeTruthy();
      return element;
    });

    expect(arrow?.className).toContain("left-4");
    expect(arrow?.className).not.toContain("left-1/2");
  });

  test("positions and centers the arrow for center-aligned right tooltips", async () => {
    render(<ContextMenuButtonWithHoverTooltip side="right" />);

    const button = screen.getByRole("button", { name: "Run" });
    setAnchorRect(button, () => makeRect({ left: 100, top: 50, width: 40, height: 20 }));

    fireEvent.mouseEnter(button);

    const tooltip = await waitFor(() => screen.getByText("Run command"));
    const arrow = document.body.querySelector('[data-slot="hover-tooltip-arrow"]');

    expect(tooltip.style.left).toBe("144px");
    expect(tooltip.style.top).toBe("60px");
    expect(tooltip.style.transform).toBe("translateY(-50%)");
    expect(arrow?.className).toContain("top-1/2");
    expect(arrow?.className).toContain("-translate-y-1/2");
    expect(arrow?.className).not.toContain("top-4");
  });

  test("keeps leading arrow placement for start-aligned right tooltips", async () => {
    render(<ContextMenuButtonWithHoverTooltip side="right" align="start" />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Run" }));

    const arrow = await waitFor(() => {
      const element = document.body.querySelector('[data-slot="hover-tooltip-arrow"]');
      expect(element).toBeTruthy();
      return element;
    });

    expect(arrow?.className).toContain("top-4");
    expect(arrow?.className).not.toContain("top-1/2");
  });

  test("updates tooltip position on resize and scroll", async () => {
    render(<ContextMenuButtonWithHoverTooltip />);

    const button = screen.getByRole("button", { name: "Run" });
    let rect = makeRect({ left: 10, top: 20, width: 40, height: 20 });
    setAnchorRect(button, () => rect);

    fireEvent.mouseEnter(button);

    const tooltip = await waitFor(() => screen.getByText("Run command"));

    expect(tooltip.style.left).toBe("30px");
    expect(tooltip.style.top).toBe("44px");

    rect = makeRect({ left: 50, top: 60, width: 20, height: 10 });
    fireEvent.resize(window);

    await waitFor(() => {
      expect(tooltip.style.left).toBe("60px");
      expect(tooltip.style.top).toBe("74px");
    });

    rect = makeRect({ left: 70, top: 80, width: 10, height: 10 });
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(tooltip.style.left).toBe("75px");
      expect(tooltip.style.top).toBe("94px");
    });
  });

  test("does not render when opened before the anchor ref is available", () => {
    render(<OpenTooltipWithoutAnchor />);

    expect(screen.queryByText("Missing anchor")).toBeNull();
  });
});
