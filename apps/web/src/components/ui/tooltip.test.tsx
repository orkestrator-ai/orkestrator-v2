import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

describe("TooltipContent", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the shared dark surface and an outward-only arrow outline", async () => {
    render(
      <Tooltip open>
        <TooltipTrigger asChild>
          <button type="button">Settings</button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open settings</TooltipContent>
      </Tooltip>,
    );

    const content = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    const arrow = content.querySelector<SVGElement>('[data-slot="tooltip-arrow"]');

    expect(content.classList.contains("border")).toBe(true);
    expect(content.classList.contains("border-zinc-700/70")).toBe(true);
    expect(content.classList.contains("bg-zinc-900/95")).toBe(true);
    expect(content.classList.contains("text-popover-foreground")).toBe(true);
    expect(arrow).toBeTruthy();
    expect(arrow?.classList.contains("border-r")).toBe(true);
    expect(arrow?.classList.contains("border-b")).toBe(true);
    expect(arrow?.classList.contains("border-l")).toBe(false);
    expect(arrow?.classList.contains("border-t")).toBe(false);
    expect(arrow?.classList.contains("border-zinc-700/70")).toBe(true);
  });
});
