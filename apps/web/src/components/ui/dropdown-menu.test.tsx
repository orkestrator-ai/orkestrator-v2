import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { OverlayPortalLayer } from "./overlay-portal-layer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

afterEach(cleanup);

/**
 * Radix opens a submenu from its trigger rather than from a `defaultOpen` on
 * `DropdownMenuSub`, so drive it the way a keyboard user would and return the
 * rendered sub-content.
 */
function openSubmenu(triggerName = "More"): HTMLElement {
  fireEvent.keyDown(screen.getByRole("menuitem", { name: triggerName }), { key: "ArrowRight" });
  const submenu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]');
  expect(submenu).toBeTruthy();
  return submenu!;
}

describe("DropdownMenu primitives", () => {
  test("portals at the default overlay layer outside a raised surface", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.querySelector('[data-slot="dropdown-menu-content"]')?.className).toContain(
      "z-50",
    );
  });

  test("inherits a raised overlay portal layer from an ancestor", () => {
    render(
      <OverlayPortalLayer className="z-[70]">
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>One</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </OverlayPortalLayer>,
    );

    const menu = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(menu?.className).toContain("z-[70]");
    expect(menu?.className).not.toContain("z-50");
  });

  test("keeps a caller className while still honoring the raised layer", () => {
    render(
      <OverlayPortalLayer className="z-[70]">
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Models">Open</DropdownMenuTrigger>
          <DropdownMenuContent className="custom-menu">
            <DropdownMenuItem>Haiku</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </OverlayPortalLayer>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Models" }));
    const menu = screen
      .getByRole("menuitem", { name: "Haiku" })
      .closest('[data-slot="dropdown-menu-content"]');
    expect(menu?.className).toContain("custom-menu");
    expect(menu?.className).toContain("z-[70]");
  });

  test("keeps a submenu at the default overlay layer outside a raised surface", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(openSubmenu().className).toContain("z-50");
  });

  test("raises a submenu onto the same layer as its parent menu", () => {
    render(
      <OverlayPortalLayer className="z-[70]">
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Nested</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </OverlayPortalLayer>,
    );

    const submenu = openSubmenu();
    expect(submenu.className).toContain("z-[70]");
    expect(submenu.className).not.toContain("z-50");
  });
});
