import { describe, expect, test } from "bun:test";
import {
  APP_SHORTCUTS,
  appClaimsShortcut,
  appShortcut,
  isAppShortcutId,
  isKeyboardShortcutsChord,
  isKeyboardShortcutsRequest,
  matchAppShortcut,
  type ShortcutChord,
  type ShortcutFocus,
  type ShortcutPlatform,
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

describe("matchAppShortcut", () => {
  test("⌘K and Ctrl+K are search on every platform; with Shift they are the shortcuts dialog", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(matchAppShortcut(chord({ ...modifier, shiftKey: false, key: "k" }))).toBe(
        "search-projects",
      );
      expect(matchAppShortcut(chord({ ...modifier, key: "K" }))).toBe("show-shortcuts");
    }
  });

  test("needs exactly one of ⌘ and Ctrl, and no Alt", () => {
    expect(matchAppShortcut(chord({ shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, ctrlKey: true, shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, altKey: true, shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, key: "j", code: "KeyJ" }))).toBeNull();
  });

  test("uses the physical key only when the layout types no Latin letter", () => {
    expect(matchAppShortcut(chord({ ctrlKey: true, shiftKey: false, key: "л" }))).toBe(
      "search-projects",
    );
    expect(matchAppShortcut(chord({ metaKey: true, shiftKey: false, key: "t" }))).toBeNull();
    // An Electron Input on macOS can carry the control character for Ctrl+K.
    expect(matchAppShortcut(chord({ ctrlKey: true, shiftKey: false, key: "\v" }))).toBe(
      "search-projects",
    );
  });

  test("every catalogued shortcut is reachable, by a unique chord", () => {
    const chords = new Set(APP_SHORTCUTS.map((shortcut) => `${shortcut.key}:${shortcut.shift}`));
    expect(chords.size).toBe(APP_SHORTCUTS.length);
    for (const shortcut of APP_SHORTCUTS) {
      expect(isAppShortcutId(shortcut.id)).toBe(true);
      expect(appShortcut(shortcut.id)).toBe(shortcut);
      expect(
        matchAppShortcut(chord({ metaKey: true, key: shortcut.key, shiftKey: shortcut.shift })),
      ).toBe(shortcut.id);
    }
    expect(isAppShortcutId("close-tab")).toBe(false);
  });
});

describe("appClaimsShortcut", () => {
  const search = appShortcut("search-projects");
  const dialog = appShortcut("show-shortcuts");
  const cases: [ShortcutPlatform, ShortcutFocus, "meta" | "ctrl", boolean][] = [
    // ⌘K is never a text-editing key: it opens search from anywhere.
    ["mac", "page", "meta", true],
    ["mac", "text", "meta", true],
    ["mac", "terminal", "meta", true],
    // Ctrl+K on macOS: kill-line in text fields and shells, search elsewhere.
    ["mac", "page", "ctrl", true],
    ["mac", "text", "ctrl", false],
    ["mac", "terminal", "ctrl", false],
    // Ctrl+K elsewhere is the platform's primary chord, except in a shell.
    ["other", "page", "ctrl", true],
    ["other", "text", "ctrl", true],
    ["other", "terminal", "ctrl", false],
    ["other", "terminal", "meta", true],
  ];
  test.each(cases)(
    "search on %s in a %s focus with %s: %p",
    (platform, focus, modifier, claims) => {
      const keys = { metaKey: modifier === "meta", ctrlKey: modifier === "ctrl" };
      expect(appClaimsShortcut(search, keys, platform, focus)).toBe(claims);
    },
  );

  test("the shortcuts dialog is claimed everywhere with either modifier", () => {
    for (const platform of ["mac", "other"] as const)
      for (const focus of ["page", "text", "terminal"] as const)
        for (const keys of [
          { metaKey: true, ctrlKey: false },
          { metaKey: false, ctrlKey: true },
        ])
          expect(appClaimsShortcut(dialog, keys, platform, focus)).toBe(true);
  });
});
