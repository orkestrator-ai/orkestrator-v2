import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useSlashCommandMenu } from "./useSlashCommandMenu";

const COMMANDS = [
  { name: "/review", description: "Review changes" },
  { name: "/resume", description: "Resume work" },
  { name: "/compact", description: "Compact context" },
];

function keyEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: mock(() => {}),
  } as unknown as KeyboardEvent<HTMLElement>;
}

afterEach(() => cleanup());

describe("useSlashCommandMenu", () => {
  test("opens for a leading slash and filters case-insensitively", async () => {
    const { result, rerender } = renderHook(
      ({ text }) => useSlashCommandMenu({
        commands: COMMANDS,
        text,
        setText: () => {},
      }),
      { initialProps: { text: "/" } },
    );

    await waitFor(() => expect(result.current.isOpen).toBe(true));
    expect(result.current.filteredCommands).toEqual(COMMANDS);

    rerender({ text: "/REV" });
    await waitFor(() => {
      expect(result.current.filteredCommands).toEqual([COMMANDS[0]!]);
      expect(result.current.selectedIndex).toBe(0);
    });
  });

  test("stays closed for arguments, ordinary text, and an empty registry", async () => {
    const withArguments = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/review now",
        setText: () => {},
      }),
    );
    const ordinary = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "review",
        setText: () => {},
      }),
    );
    const empty = renderHook(() =>
      useSlashCommandMenu({
        commands: [],
        text: "/",
        setText: () => {},
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(withArguments.result.current.isOpen).toBe(false);
    expect(ordinary.result.current.isOpen).toBe(false);
    expect(empty.result.current.isOpen).toBe(false);
  });

  test("clamps arrow navigation and consumes handled keys", async () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/",
        setText: () => {},
      }),
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    const up = keyEvent("ArrowUp");
    act(() => {
      expect(result.current.handleKeyDown(up)).toBe(true);
    });
    expect(result.current.selectedIndex).toBe(0);
    expect(up.preventDefault).toHaveBeenCalled();

    for (let index = 0; index < COMMANDS.length + 1; index += 1) {
      act(() => {
        result.current.handleKeyDown(keyEvent("ArrowDown"));
      });
    }
    expect(result.current.selectedIndex).toBe(COMMANDS.length - 1);
  });

  test("accepts with Enter or Tab, writes the command, and restores focus", async () => {
    const setText = mock(() => {});
    const focusInput = mock(() => {});
    const { result } = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/rev",
        setText,
        focusInput,
      }),
    );
    await waitFor(() => expect(result.current.filteredCommands).toHaveLength(1));

    const enter = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enter)).toBe(true);
    });
    expect(setText).toHaveBeenCalledWith("/review ");
    expect(focusInput).toHaveBeenCalledTimes(1);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);

    const tabHook = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/com",
        setText,
      }),
    );
    await waitFor(() => expect(tabHook.result.current.isOpen).toBe(true));
    act(() => {
      expect(tabHook.result.current.handleKeyDown(keyEvent("Tab"))).toBe(true);
    });
    expect(setText).toHaveBeenLastCalledWith("/compact ");
  });

  test("does not consume Shift+Enter, unmatched input, or keys while closed", async () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/missing",
        setText: () => {},
      }),
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    expect(result.current.handleKeyDown(keyEvent("Enter", true))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent("x"))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent("Enter"))).toBe(false);

    act(() => result.current.closeMenu());
    expect(result.current.handleKeyDown(keyEvent("ArrowDown"))).toBe(false);
  });

  test("Escape and closeMenu close the menu", async () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({
        commands: COMMANDS,
        text: "/",
        setText: () => {},
      }),
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    const escape = keyEvent("Escape");
    act(() => {
      expect(result.current.handleKeyDown(escape)).toBe(true);
    });
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.selectCommand(COMMANDS[0]!));
    act(() => result.current.closeMenu());
    expect(result.current.isOpen).toBe(false);
  });
});
