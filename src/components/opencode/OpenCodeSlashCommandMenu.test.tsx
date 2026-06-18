import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OpenCodeSlashCommandMenu } from "./OpenCodeSlashCommandMenu";

describe("OpenCodeSlashCommandMenu", () => {
  afterEach(() => cleanup());

  test("renders selected and unselected treatments and selects commands", () => {
    const onSelect = mock(() => {});
    const commands = [
      { name: "/models", description: "List models" },
      { name: "/session", description: "Session info" },
    ];

    render(
      <OpenCodeSlashCommandMenu
        commands={commands}
        selectedIndex={0}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );

    const menu = screen.getByText("Slash Commands").closest(".rounded-xl") as HTMLElement;
    expect(menu.className).toContain("bg-zinc-900/95");

    const selected = screen.getByRole("button", { name: /models/i });
    const unselected = screen.getByRole("button", { name: /session/i });
    expect(selected.className).toContain("bg-zinc-800/80");
    expect(unselected.className).toContain("hover:bg-zinc-800/70");

    fireEvent.click(selected);
    expect(onSelect).toHaveBeenCalledWith(commands[0]);
  });

  test("returns null for an empty command list", () => {
    const { container } = render(
      <OpenCodeSlashCommandMenu
        commands={[]}
        selectedIndex={0}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
