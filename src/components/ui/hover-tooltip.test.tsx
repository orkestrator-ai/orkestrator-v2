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

function ContextMenuButtonWithHoverTooltip({ openDelay = 0 }: { openDelay?: number }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tooltip = useHoverTooltip(openDelay);

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
});
