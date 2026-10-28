import { describe, expect, test } from "bun:test";
import {
  isKeyboardShortcutsChord,
  isKeyboardShortcutsRequest,
  type ShortcutChord,
} from "./keyboard-shortcuts";

function chord(init: Partial<ShortcutChord>): ShortcutChord {
  return {
    key: "K",
    code: "KeyK",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...init,
  };
}

describe("isKeyboardShortcutsChord", () => {
  test("accepts Command or Control with Shift and K, in either case", () => {
    expect(isKeyboardShortcutsChord(chord({ metaKey: true }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "k" }))).toBe(true);
  });

  test("rejects other modifier combinations", () => {
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, shiftKey: false }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({}))).toBe(false);
  });

  test("on Windows, AltGr arrives as Ctrl+Alt and never opens the dialog", () => {
    // Chromium reports AltGr as ctrlKey + altKey on Windows; AltGr+Shift+K
    // types a character on several layouts and must reach the focused field.
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, altKey: true, key: "Л" }))).toBe(false);
  });

  test("on Linux, Super+Shift+K is the Meta form and is accepted like Ctrl+Shift+K", () => {
    // Chromium reports the Super/Windows key as metaKey. Window managers may
    // keep it, so Ctrl+Shift+K is the documented chord outside macOS.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "k" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "Л" }))).toBe(true);
  });

  test("matches the physical K key on a layout that types no Latin letter there", () => {
    // Russian ЙЦУКЕН: the K position types Л.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "Л" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "л" }))).toBe(true);
    // Greek: the K position types Κ (U+039A), which is not a Latin K.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "Κ" }))).toBe(true);
  });

  test("follows the typed Latin letter on a remapped Latin layout", () => {
    // Dvorak: the physical K key types T, and the key typing K sits on KeyV.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "T", code: "KeyK" }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "K", code: "KeyV" }))).toBe(true);
  });

  test("tolerates a missing code", () => {
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, code: undefined }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "Л", code: undefined }))).toBe(
      false,
    );
  });
});

describe("isKeyboardShortcutsRequest", () => {
  test("accepts only the two request kinds", () => {
    expect(isKeyboardShortcutsRequest("open")).toBe(true);
    expect(isKeyboardShortcutsRequest("toggle")).toBe(true);
    expect(isKeyboardShortcutsRequest("close")).toBe(false);
    expect(isKeyboardShortcutsRequest(undefined)).toBe(false);
  });
});
