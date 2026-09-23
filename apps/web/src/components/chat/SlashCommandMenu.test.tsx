import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu";

/**
 * Restores the assertions from the two per-agent menus this component replaced
 * (`claude/SlashCommandMenu.test.tsx` and
 * `opencode/OpenCodeSlashCommandMenu.test.tsx`). The three compose-bar suites
 * all stub this module, so without this file the real component — including its
 * click-outside listener — has no coverage at all.
 */
describe("SlashCommandMenu", () => {
  afterEach(() => cleanup());

  test("renders selected and unselected treatments and selects commands", () => {
    const onSelect = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[
          { name: "/plan", description: "Make a plan" },
          { name: "/clear", description: "Clear context" },
        ]}
        selectedIndex={1}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    const menu = screen.getByText("Slash Commands").closest(".rounded-xl") as HTMLElement;
    expect(menu.className).toContain("bg-zinc-900/95");

    const selected = screen.getByRole("button", { name: /clear/i });
    const unselected = screen.getByRole("button", { name: /plan/i });
    expect(selected.className).toContain("bg-zinc-800/80");
    expect(unselected.className).toContain("hover:bg-zinc-800/70");

    fireEvent.click(selected);
    // The whole command object, not just its name — the compose bars insert
    // `command.name` and read `description` for the title attribute.
    expect(onSelect).toHaveBeenCalledWith({
      name: "/clear",
      description: "Clear context",
    });
  });

  test("closes when clicking outside", () => {
    const onClose = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[{ name: "/plan" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  test("stays open when the click lands inside the menu", () => {
    const onClose = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[{ name: "/plan" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: /plan/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("renders nothing when there are no commands to show", () => {
    // The caller filters as the user types; an empty result must collapse the
    // menu rather than leaving an empty popover floating over the composer.
    const { container } = render(
      <SlashCommandMenu commands={[]} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("omits the description column for a command without one", () => {
    render(
      <SlashCommandMenu
        commands={[{ name: "/plan" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /plan/i });
    expect(button.textContent).toBe("/plan");
    expect(button.getAttribute("title")).toBe("/plan");
  });

  test("detaches its click-outside listener on unmount", () => {
    const onClose = mock(() => {});
    const { unmount } = render(
      <SlashCommandMenu
        commands={[{ name: "/plan" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    unmount();
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("groups interleaved command sources under one header each", () => {
    render(
      <SlashCommandMenu
        commands={[
          { name: "/builtin-a", source: "builtin" },
          { name: "/project-a", source: "project" },
          { name: "/builtin-b", source: "builtin" },
          { name: "/unknown" },
        ]}
        selectedIndex={2}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText("Built in")).toHaveLength(1);
    expect(screen.getAllByText("Project")).toHaveLength(1);
    expect(screen.getAllByText("Other")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /builtin-b/i }).className).toContain(
      "bg-zinc-800/80",
    );
  });
});

describe("SlashCommandMenu placement", () => {
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

  afterEach(() => {
    cleanup();
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport);
    } else {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  function renderAt(top: number, bottom: number) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: Object.assign(new EventTarget(), { offsetTop: 0, height: 400 }),
    });
    const { container } = render(
      <div
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
        }}
      >
        <SlashCommandMenu
          commands={[{ name: "/help", description: "Show help", source: "builtin" }]}
          selectedIndex={0}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </div>,
    );
    return container.querySelector<HTMLElement>("[data-side]")!;
  }

  test("bounds the list above the composer", () => {
    const menu = renderAt(250, 300);
    expect(menu.dataset.side).toBe("top");
    expect(menu.style.maxHeight).toBe("238px");
  });

  test("flips below with its 256px preferred height", () => {
    const menu = renderAt(30, 80);
    expect(menu.dataset.side).toBe("bottom");
    expect(menu.style.top).toBe("100%");
    expect(menu.style.maxHeight).toBe("256px");
  });
});
