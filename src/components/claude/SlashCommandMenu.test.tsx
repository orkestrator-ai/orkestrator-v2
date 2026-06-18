import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu";

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
    expect(onSelect).toHaveBeenCalledWith({ name: "/clear", description: "Clear context" });
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
});
