import { describe, expect, mock, test } from "bun:test";
import { KEYBOARD_SHORTCUTS_EVENT } from "@orkestrator/protocol/keyboard-shortcuts";
import {
  isKeyboardShortcutsInput,
  requestKeyboardShortcuts,
  type KeyboardShortcutsRenderer,
} from "../electron/keyboard-shortcuts-menu";

function renderer(destroyed = false) {
  const calls: string[] = [];
  const contents: KeyboardShortcutsRenderer = {
    id: 7,
    isDestroyed: () => destroyed,
    focus: mock(() => {
      calls.push("focus");
    }),
    send: mock((channel: string, ...args: unknown[]) => {
      calls.push(`send:${channel}:${args.join(",")}`);
    }),
  };
  return { contents, calls };
}

describe("requestKeyboardShortcuts", () => {
  test("focuses the renderer, then delivers the request on the renderer event channel", () => {
    const { contents, calls } = renderer();
    requestKeyboardShortcuts(contents, "open");
    requestKeyboardShortcuts(contents, "toggle");
    expect(calls).toEqual([
      "focus",
      `send:orkestrator:event:${KEYBOARD_SHORTCUTS_EVENT},open`,
      "focus",
      `send:orkestrator:event:${KEYBOARD_SHORTCUTS_EVENT},toggle`,
    ]);
  });

  test("does nothing without a live renderer", () => {
    const { contents, calls } = renderer(true);
    requestKeyboardShortcuts(contents, "open");
    requestKeyboardShortcuts(null, "open");
    expect(calls).toEqual([]);
  });
});

describe("isKeyboardShortcutsInput", () => {
  const input = {
    type: "keyDown",
    key: "K",
    code: "KeyK",
    meta: true,
    control: false,
    shift: true,
    alt: false,
  };

  test("matches the chord on key down only", () => {
    expect(isKeyboardShortcutsInput(input)).toBe(true);
    expect(isKeyboardShortcutsInput({ ...input, type: "rawKeyDown" })).toBe(true);
    expect(isKeyboardShortcutsInput({ ...input, meta: false, control: true })).toBe(true);
    expect(isKeyboardShortcutsInput({ ...input, type: "keyUp" })).toBe(false);
    expect(isKeyboardShortcutsInput({ ...input, shift: false })).toBe(false);
  });
});
