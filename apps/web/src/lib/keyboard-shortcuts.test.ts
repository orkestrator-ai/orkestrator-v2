import { describe, expect, test } from "bun:test";
import {
  KEYBOARD_SHORTCUT_GROUPS,
  filterKeyboardShortcuts,
  isKeyboardShortcutsShortcut,
} from "./keyboard-shortcuts";

function ids(groups: ReturnType<typeof filterKeyboardShortcuts>): string[] {
  return groups.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.id));
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("keyboard shortcut catalog", () => {
  test("ids are unique", () => {
    const all = KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts.map((s) => s.id));
    expect(new Set(all).size).toBe(all.length);
  });

  test("an empty query lists every shortcut on macOS", () => {
    const total = KEYBOARD_SHORTCUT_GROUPS.reduce((sum, group) => sum + group.shortcuts.length, 0);
    expect(ids(filterKeyboardShortcuts("", "mac"))).toHaveLength(total);
  });

  test("macOS-only shortcuts are hidden on other platforms", () => {
    const other = ids(filterKeyboardShortcuts("", "other"));
    expect(other).toContain("search-projects");
    expect(other).not.toContain("new-agent-tab");
  });

  test("matches descriptions, group titles and keywords", () => {
    expect(ids(filterKeyboardShortcuts("files panel", "mac"))).toEqual(["toggle-files-panel"]);
    expect(ids(filterKeyboardShortcuts("design canvas undo", "mac"))).toEqual(["design-undo"]);
    expect(ids(filterKeyboardShortcuts("vscode", "mac"))).toEqual(["open-in-editor"]);
  });

  test("matches key names and symbols", () => {
    expect(ids(filterKeyboardShortcuts("cmd shift k", "mac"))).toContain("show-shortcuts");
    expect(ids(filterKeyboardShortcuts("⌘⇧k", "mac"))).toEqual(["show-shortcuts"]);
    expect(ids(filterKeyboardShortcuts("ctrl shift k", "other"))).toContain("show-shortcuts");
  });

  test("drops groups with no matches", () => {
    const groups = filterKeyboardShortcuts("address bar", "mac");
    expect(groups.map((group) => group.id)).toEqual(["editors"]);
    expect(filterKeyboardShortcuts("no such shortcut", "mac")).toEqual([]);
  });
});

describe("isKeyboardShortcutsShortcut", () => {
  test("accepts Cmd+Shift+K and Ctrl+Shift+K", () => {
    expect(isKeyboardShortcutsShortcut(keydown({ key: "K", metaKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(isKeyboardShortcutsShortcut(keydown({ key: "K", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  test("leaves Cmd+K and other combinations alone", () => {
    expect(isKeyboardShortcutsShortcut(keydown({ key: "k", metaKey: true }))).toBe(false);
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "K", metaKey: true, ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "K", metaKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(false);
    expect(isKeyboardShortcutsShortcut(keydown({ key: "J", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
  });
});
