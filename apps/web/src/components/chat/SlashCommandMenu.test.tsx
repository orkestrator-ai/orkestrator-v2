import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SlashCommandMenu, type SlashCommandOption } from "./SlashCommandMenu";

/**
 * Restores the assertions from the two per-agent menus this component replaced
 * (`claude/SlashCommandMenu.test.tsx` and
 * `opencode/OpenCodeSlashCommandMenu.test.tsx`), plus the catalogue states the
 * native composer shows. The compose-bar suites stub or drive this module, so
 * without this file the real component — including its click-outside
 * listener — has no direct coverage.
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

    const selected = screen.getByRole("option", { name: /clear/i });
    const unselected = screen.getByRole("option", { name: /plan/i });
    expect(selected.className).toContain("bg-zinc-800/80");
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(unselected.className).toContain("hover:bg-zinc-800/70");
    expect(unselected.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(selected);
    // The whole command object, not just its name — the compose bars insert
    // from it and read `description` for the title attribute.
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

  test("stays open, and keeps focus in the composer, when the click lands inside", () => {
    const onClose = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[{ name: "/plan" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    const option = screen.getByRole("option", { name: /plan/i });
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  test("renders nothing for a legacy caller with no rows and no state", () => {
    const { container } = render(
      <SlashCommandMenu commands={[]} selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    );
    expect(container.firstChild === null).toBe(true);
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

    const option = screen.getByRole("option", { name: /plan/i });
    expect(option.textContent).toBe("/plan");
    expect(option.getAttribute("title")).toBe("/plan");
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

  test("draws source headers from runs of the list so visual order is keyboard order", () => {
    render(
      <SlashCommandMenu
        commands={[
          { name: "/builtin-a", source: "builtin" },
          { name: "/builtin-b", source: "builtin" },
          { name: "/project-a", source: "project" },
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
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "/builtin-a",
      "/builtin-b",
      "/project-a",
      "/unknown",
    ]);
    expect(options[2]!.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Project" })).getByRole("option")).toBe(
      options[2]!,
    );
  });

  test("never regroups an interleaved ranked list out of navigation order", () => {
    render(
      <SlashCommandMenu
        commands={[
          { name: "/review", source: "project" },
          { name: "/review-all", source: "builtin" },
          { name: "/preview", source: "project" },
        ]}
        selectedIndex={1}
        onSelect={() => {}}
        onClose={() => {}}
        query="/rev"
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent?.split(/(?=Project|Built in)/)[0])).toEqual([
      "/review",
      "/review-all",
      "/preview",
    ]);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
  });

  test("exposes listbox semantics with stable option ids", () => {
    const optionId = (command: SlashCommandOption) => `menu-option-${command.id}`;
    render(
      <SlashCommandMenu
        commands={[
          { id: "a", name: "/alpha" },
          { id: "b", name: "/beta" },
        ]}
        selectedIndex={1}
        onSelect={() => {}}
        onClose={() => {}}
        listboxId="menu"
        optionId={optionId}
      />,
    );
    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(listbox.id).toBe("menu");
    expect(screen.getByRole("option", { name: /beta/ }).id).toBe("menu-option-b");
    expect(screen.getByRole("status").textContent).toBe("2 commands available");
  });

  test("shows insert text, argument hints and a readable reason on a disabled row", () => {
    const onSelect = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[
          { id: "s", name: "$deploy", insertText: "$deploy", argumentHint: "<env>" },
          {
            id: "x",
            name: "/login",
            availability: { state: "unavailable", message: "Needs the provider's terminal UI" },
          },
        ]}
        selectedIndex={1}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("$deploy")).toBeTruthy();
    expect(screen.getByText("<env>")).toBeTruthy();
    const disabled = screen.getByRole("option", { name: /login/ });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("title")).toBe("Needs the provider's terminal UI");
    expect(disabled.textContent).toContain("Needs the provider's terminal UI");
    // The hook decides what a click on a disabled row does; the menu forwards it.
    fireEvent.click(disabled);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("announces why a chosen row could not be used", () => {
    render(
      <SlashCommandMenu
        commands={[{ id: "x", name: "/login" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
        blockedMessage="Needs the provider's terminal UI"
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Needs the provider's terminal UI");
  });

  test("keeps the composer usable with a progress row while loading", () => {
    render(
      <SlashCommandMenu
        commands={[]}
        selectedIndex={-1}
        onSelect={() => {}}
        onClose={() => {}}
        query="/"
        status={{ state: "loading", providerCommandCount: 0 }}
      />,
    );
    expect(screen.getByText("Loading commands…")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading commands");
    expect(screen.queryByRole("listbox") === null).toBe(true);
  });

  test("says a ready session has no provider commands while still listing Orkestrator actions", () => {
    render(
      <SlashCommandMenu
        commands={[{ id: "orkestrator:compact", name: "/compact", source: "orkestrator" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
        query="/"
        status={{ state: "ready", providerCommandCount: 0 }}
      />,
    );
    expect(screen.getByText("This session has no provider commands.")).toBeTruthy();
    expect(screen.getByText("Orkestrator")).toBeTruthy();
    expect(screen.getByRole("option", { name: /compact/ })).toBeTruthy();
  });

  test("separates an unsupported integration from the actions Orkestrator still offers", () => {
    render(
      <SlashCommandMenu
        commands={[{ id: "orkestrator:steer", name: "/steer", source: "orkestrator" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
        query="/"
        status={{ state: "unsupported", providerCommandCount: 0, onRefresh: () => {} }}
      />,
    );
    expect(screen.getByText("This agent doesn't expose provider commands.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Orkestrator" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh/ }) === null).toBe(true);
  });

  test("keeps stale rows with a refresh action and status", () => {
    const onRefresh = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[{ id: "a", name: "/alpha" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
        query="/"
        status={{
          state: "stale",
          providerCommandCount: 1,
          detail: "The agent couldn't be reached.",
          onRefresh,
        }}
      />,
    );
    expect(screen.getByRole("option", { name: /alpha/ })).toBeTruthy();
    expect(screen.getByText(/may be out of date/).textContent).toContain(
      "The agent couldn't be reached.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh commands" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("explains an unavailable list without internals and shows refresh progress", () => {
    render(
      <SlashCommandMenu
        commands={[]}
        selectedIndex={-1}
        onSelect={() => {}}
        onClose={() => {}}
        query="/"
        status={{
          state: "unavailable",
          providerCommandCount: 0,
          detail: "The agent took too long to answer.",
          onRefresh: () => {},
          refreshing: true,
        }}
      />,
    );
    expect(screen.getByText(/Commands couldn't be loaded\./).textContent).toBe(
      "Commands couldn't be loaded. The agent took too long to answer.",
    );
    const refresh = screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });

  test("keeps an unmatched query visible and offers an explicit send-as-text path", () => {
    const onSendAsText = mock(() => {});
    render(
      <SlashCommandMenu
        commands={[]}
        selectedIndex={-1}
        onSelect={() => {}}
        onClose={() => {}}
        query="/usr/local/bin"
        status={{ state: "ready", providerCommandCount: 3 }}
        literalEscape={{ kind: "offer", onSendAsText }}
      />,
    );
    expect(screen.getByText("/usr/local/bin")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No commands match /usr/local/bin");
    fireEvent.click(screen.getByRole("button", { name: "Send as text" }));
    expect(onSendAsText).toHaveBeenCalledTimes(1);
  });

  test("explains instead of offering an escape the provider cannot honour", () => {
    render(
      <SlashCommandMenu
        commands={[{ id: "r", name: "/review" }]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
        query="/review"
        status={{ state: "ready", providerCommandCount: 1 }}
        literalEscape={{ kind: "explain", message: "Claude reads this as a command." }}
      />,
    );
    expect(screen.getByText("Claude reads this as a command.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send as text" }) === null).toBe(true);
  });
});
