import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import type { SlashCommandOption } from "@/components/chat/SlashCommandMenu";
import { useSlashCommandMenu } from "./useSlashCommandMenu";

const COMMANDS = [
  { name: "/review", description: "Review changes" },
  { name: "/resume", description: "Resume work" },
  { name: "/compact", description: "Compact context" },
];

function keyEvent(key: string, shiftKey = false, nativeEvent: Record<string, unknown> = {}) {
  return {
    key,
    shiftKey,
    nativeEvent,
    preventDefault: mock(() => {}),
  } as unknown as KeyboardEvent<HTMLElement>;
}

afterEach(() => cleanup());

describe("useSlashCommandMenu", () => {
  test("opens for a leading slash and filters case-insensitively", async () => {
    const { result, rerender } = renderHook(
      ({ text }) =>
        useSlashCommandMenu({
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

  test("stays closed for arguments, ordinary text, and an empty legacy registry", async () => {
    const withArguments = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/review now", setText: () => {} }),
    );
    const withTab = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/review\targ", setText: () => {} }),
    );
    const withNewline = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/review\n", setText: () => {} }),
    );
    const ordinary = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "review", setText: () => {} }),
    );
    const empty = renderHook(() =>
      useSlashCommandMenu({ commands: [], text: "/", setText: () => {} }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(withArguments.result.current.isOpen).toBe(false);
    expect(withTab.result.current.isOpen).toBe(false);
    expect(withNewline.result.current.isOpen).toBe(false);
    expect(ordinary.result.current.isOpen).toBe(false);
    expect(empty.result.current.isOpen).toBe(false);
  });

  test("opens with no rows when the caller has a catalogue state to show", () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: [], text: "/", setText: () => {}, openWhenEmpty: true }),
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.filteredCommands).toEqual([]);
    expect(result.current.selectedIndex).toBe(-1);
    expect(result.current.activeOptionId).toBeUndefined();
    // Nothing to choose: Enter belongs to the composer, which sends the text.
    expect(result.current.handleKeyDown(keyEvent("Enter"))).toBe(false);
  });

  test("clamps arrow navigation and consumes handled keys", async () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/", setText: () => {} }),
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
    const calls: string[] = [];
    const setText = mock((text: string, _command: SlashCommandOption) => calls.push(`set:${text}`));
    const focusInputAtEnd = mock((text: string) => calls.push(`focus:${text}`));
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/rev", setText, focusInputAtEnd }),
    );
    await waitFor(() => expect(result.current.filteredCommands).toHaveLength(1));

    const enter = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enter)).toBe(true);
    });
    expect(setText).toHaveBeenCalledWith("/review ", COMMANDS[0]);
    expect(focusInputAtEnd).toHaveBeenCalledWith("/review ");
    expect(calls).toEqual(["set:/review ", "focus:/review "]);
    expect(enter.preventDefault).toHaveBeenCalled();

    const tabHook = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/com", setText }),
    );
    await waitFor(() => expect(tabHook.result.current.isOpen).toBe(true));
    act(() => {
      expect(tabHook.result.current.handleKeyDown(keyEvent("Tab"))).toBe(true);
    });
    expect(setText).toHaveBeenLastCalledWith("/compact ", COMMANDS[2]);
  });

  test("closes once the inserted command is in the text and does not reopen", () => {
    const { result, rerender } = renderHook(
      ({ text }) => useSlashCommandMenu({ commands: COMMANDS, text, setText: () => {} }),
      { initialProps: { text: "/rev" } },
    );
    expect(result.current.isOpen).toBe(true);
    rerender({ text: "/review " });
    expect(result.current.isOpen).toBe(false);
    rerender({ text: "/review  keep\ttabs and trailing   " });
    expect(result.current.isOpen).toBe(false);
  });

  test("leaves Shift+Tab to the caller so Codex can still toggle Plan/Build", async () => {
    const setText = mock(() => {});
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/com", setText }),
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));
    expect(result.current.filteredCommands).toHaveLength(1);

    const shiftTab = keyEvent("Tab", true);
    act(() => {
      expect(result.current.handleKeyDown(shiftTab)).toBe(false);
    });
    expect(shiftTab.preventDefault).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
  });

  test("ignores every key while an IME composition is active", () => {
    const setText = mock(() => {});
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/", setText }),
    );
    for (const key of ["Enter", "Tab", "ArrowDown", "Escape"]) {
      expect(result.current.handleKeyDown(keyEvent(key, false, { isComposing: true }))).toBe(false);
      expect(result.current.handleKeyDown(keyEvent(key, false, { keyCode: 229 }))).toBe(false);
    }
    expect(setText).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.selectedIndex).toBe(0);
  });

  test("does not consume Shift+Enter, unmatched input, or keys while closed", async () => {
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands: COMMANDS, text: "/missing", setText: () => {} }),
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    expect(result.current.handleKeyDown(keyEvent("Enter", true))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent("x"))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent("Enter"))).toBe(false);
    expect(result.current.handleKeyDown(keyEvent("ArrowDown"))).toBe(false);

    act(() => result.current.closeMenu());
    expect(result.current.handleKeyDown(keyEvent("ArrowDown"))).toBe(false);
  });

  test("Escape and closeMenu close the menu until the text changes", async () => {
    const { result, rerender } = renderHook(
      ({ text }) => useSlashCommandMenu({ commands: COMMANDS, text, setText: () => {} }),
      { initialProps: { text: "/" } },
    );
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    const escape = keyEvent("Escape");
    act(() => {
      expect(result.current.handleKeyDown(escape)).toBe(true);
    });
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);

    rerender({ text: "/r" });
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.closeMenu());
    expect(result.current.isOpen).toBe(false);
  });

  test("searches aliases and descriptions and ranks exact, prefix, alias, then substring", () => {
    const commands: SlashCommandOption[] = [
      { id: "d", name: "/deploy", description: "Ship a review build" },
      { id: "a", name: "/audit", aliases: ["/rev-audit"] },
      { id: "p", name: "/preview" },
      { id: "r2", name: "/reviewer" },
      { id: "r", name: "/review" },
    ];
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands, text: "/rev", setText: () => {} }),
    );
    expect(result.current.filteredCommands.map((command) => command.id)).toEqual([
      "r2",
      "r",
      "a",
      "d",
      "p",
    ]);

    const exact = renderHook(() =>
      useSlashCommandMenu({ commands, text: "/REVIEW", setText: () => {} }),
    );
    expect(exact.result.current.filteredCommands.map((command) => command.id)).toEqual([
      "r",
      "r2",
      "d",
      "p",
    ]);
  });

  test("inserts insertText rather than the display name and opens on a $ spelling", () => {
    const skill: SlashCommandOption = {
      id: "codex:skill:deploy",
      name: "$deploy",
      insertText: "$deploy",
      aliases: ["/skills:deploy"],
      source: "skill",
    };
    const template: SlashCommandOption = {
      id: "t",
      name: "/prompts:fix",
      insertText: "/fix",
      source: "template",
    };
    const setText = mock((_text: string, _command: SlashCommandOption) => {});
    const dollar = renderHook(() =>
      useSlashCommandMenu({ commands: [skill, template], text: "$dep", setText }),
    );
    expect(dollar.result.current.isOpen).toBe(true);
    act(() => {
      dollar.result.current.handleKeyDown(keyEvent("Enter"));
    });
    expect(setText).toHaveBeenLastCalledWith("$deploy ", skill);

    const slash = renderHook(() =>
      useSlashCommandMenu({ commands: [skill, template], text: "/fi", setText }),
    );
    act(() => {
      slash.result.current.handleKeyDown(keyEvent("Enter"));
    });
    expect(setText).toHaveBeenLastCalledWith("/fix ", template);

    const noDollar = renderHook(() =>
      useSlashCommandMenu({ commands: [template], text: "$dep", setText }),
    );
    expect(noDollar.result.current.isOpen).toBe(false);
  });

  test("keeps the highlighted row by identity across a refresh and clamps only when it goes", () => {
    const a = { id: "a", name: "/alpha" };
    const b = { id: "b", name: "/beta" };
    const c = { id: "c", name: "/gamma" };
    const setText = mock((_text: string, _command: SlashCommandOption) => {});
    const { result, rerender } = renderHook(
      ({ commands }) => useSlashCommandMenu({ commands, text: "/", setText }),
      { initialProps: { commands: [a, b, c] as SlashCommandOption[] } },
    );
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.selectedIndex).toBe(1);
    const betaOptionId = result.current.activeOptionId;
    expect(betaOptionId).toBe(result.current.optionId(b));

    // A new revision reorders the rows: Enter must still mean /beta.
    rerender({ commands: [{ ...c }, { ...a }, { ...b, description: "edited" }] });
    expect(result.current.selectedIndex).toBe(2);
    expect(result.current.activeOptionId).toBe(betaOptionId);

    // The untouched top row is pinned too, not just rows reached by arrows.
    rerender({ commands: [a, b, c] });
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowUp"));
    });
    expect(result.current.filteredCommands[result.current.selectedIndex]?.id).toBe("a");
    rerender({ commands: [b, c, a] });
    expect(result.current.filteredCommands[result.current.selectedIndex]?.id).toBe("a");

    // Removed: clamp to the same position rather than jumping to the top.
    rerender({ commands: [b, c] });
    expect(result.current.selectedIndex).toBe(1);
    act(() => {
      result.current.handleKeyDown(keyEvent("Enter"));
    });
    expect(setText).toHaveBeenLastCalledWith("/gamma ", c);
  });

  test("resets the highlight to the best match when the query changes", () => {
    const { result, rerender } = renderHook(
      ({ text }) => useSlashCommandMenu({ commands: COMMANDS, text, setText: () => {} }),
      { initialProps: { text: "/" } },
    );
    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    rerender({ text: "/re" });
    expect(result.current.selectedIndex).toBe(0);
  });

  test("an unavailable row is listed and navigable but explains itself instead of inserting", () => {
    const disabled: SlashCommandOption = {
      id: "x",
      name: "/login",
      availability: {
        state: "unavailable",
        reason: "requires-interactive-ui",
        message: "Needs the provider's own terminal UI",
      },
    };
    const setText = mock(() => {});
    const focus = mock(() => {});
    const { result } = renderHook(() =>
      useSlashCommandMenu({
        commands: [disabled, COMMANDS[0]!],
        text: "/",
        setText,
        focusInputAtEnd: focus,
      }),
    );
    expect(result.current.selectedIndex).toBe(0);
    const enter = keyEvent("Enter");
    act(() => {
      expect(result.current.handleKeyDown(enter)).toBe(true);
    });
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
    expect(result.current.blockedMessage).toBe("Needs the provider's own terminal UI");

    act(() => {
      result.current.handleKeyDown(keyEvent("ArrowDown"));
    });
    expect(result.current.blockedMessage).toBeNull();
  });

  test("option ids are stable, unique, and attribute-safe", () => {
    const commands: SlashCommandOption[] = [
      { id: "claude:/review me", name: "/review" },
      { name: "/legacy" },
    ];
    const { result } = renderHook(() =>
      useSlashCommandMenu({ commands, text: "/", setText: () => {} }),
    );
    const ids = commands.map((command) => result.current.optionId(command));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.startsWith(result.current.listboxId)).toBe(true);
      expect(/\s/.test(id)).toBe(false);
    }
    expect(result.current.activeOptionId).toBe(ids[0]);
  });
});
