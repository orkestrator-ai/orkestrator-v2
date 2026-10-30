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
    key: "/",
    code: "Slash",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...init,
  };
}

describe("isKeyboardShortcutsChord", () => {
  test("accepts Command or Control with Shift and /, typed as / or as ?", () => {
    // macOS reports ⌘⇧/ as "/"; browsers report Ctrl+Shift+/ as "?".
    expect(isKeyboardShortcutsChord(chord({ metaKey: true }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "?" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "?" }))).toBe(true);
  });

  test("rejects other modifier combinations", () => {
    // ⌘/ without Shift is not the chord.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, shiftKey: false }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, shiftKey: false }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, altKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({}))).toBe(false);
  });

  test("on Windows, AltGr arrives as Ctrl+Alt and never opens the dialog", () => {
    // Chromium reports AltGr as ctrlKey + altKey on Windows; AltGr+Shift+/
    // types a character on several layouts and must reach the focused field.
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, altKey: true, key: "¿" }))).toBe(false);
  });

  test("on Linux, Super+Shift+/ is the Meta form and is accepted like Ctrl+Shift+/", () => {
    // Chromium reports the Super/Windows key as metaKey. Window managers may
    // keep it, so Ctrl+Shift+/ is the documented chord outside macOS.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "?" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "?" }))).toBe(true);
  });

  test("matches the physical Slash key on a layout that types no ASCII character there", () => {
    // Russian ЙЦУКЕН types "." on the Slash key, and "," with Shift; a
    // layout typing a non-ASCII character there falls back to the key.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "ё" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ ctrlKey: true, key: "Unidentified" }))).toBe(true);
  });

  test("follows the typed / on a layout that puts it elsewhere", () => {
    // German QWERTZ types "/" with Shift on the 7 key, and "-" on the Slash key.
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "/", code: "Digit7" }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "_", code: "Slash" }))).toBe(false);
  });

  test("tolerates a missing code", () => {
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, code: undefined }))).toBe(true);
    expect(isKeyboardShortcutsChord(chord({ metaKey: true, key: "ё", code: undefined }))).toBe(
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
  test("⌘K and Ctrl+K are search on every platform; ⌘⇧/ and Ctrl+Shift+/ the shortcuts dialog", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(
        matchAppShortcut(chord({ ...modifier, shiftKey: false, key: "k", code: "KeyK" })),
      ).toBe("search-projects");
      // ⌘⇧K and Ctrl+Shift+K are no longer app shortcuts.
      expect(matchAppShortcut(chord({ ...modifier, key: "K", code: "KeyK" }))).toBeNull();
      expect(matchAppShortcut(chord({ ...modifier, key: "/" }))).toBe("show-shortcuts");
      expect(matchAppShortcut(chord({ ...modifier, key: "?" }))).toBe("show-shortcuts");
    }
  });

  test("needs exactly one of ⌘ and Ctrl, and no Alt", () => {
    expect(matchAppShortcut(chord({ shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, ctrlKey: true, shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, altKey: true, shiftKey: false }))).toBeNull();
    expect(matchAppShortcut(chord({ metaKey: true, key: "j", code: "KeyJ" }))).toBeNull();
  });

  test("uses the physical key only when the layout types no Latin letter", () => {
    const k = { code: "KeyK", shiftKey: false };
    expect(matchAppShortcut(chord({ ...k, ctrlKey: true, key: "л" }))).toBe("search-projects");
    // Dvorak: the physical K key types T, and the key typing K sits on KeyV.
    expect(matchAppShortcut(chord({ ...k, metaKey: true, key: "t" }))).toBeNull();
    expect(matchAppShortcut(chord({ ...k, metaKey: true, key: "k", code: "KeyV" }))).toBe(
      "search-projects",
    );
    // An Electron Input on macOS can carry the control character for Ctrl+K.
    expect(matchAppShortcut(chord({ ...k, ctrlKey: true, key: "\v" }))).toBe("search-projects");
  });

  test("⌘, and Ctrl+, open settings; the typed comma wins over its key position", () => {
    const comma = { key: ",", code: "Comma", shiftKey: false };
    expect(matchAppShortcut(chord({ ...comma, metaKey: true }))).toBe("open-settings");
    expect(matchAppShortcut(chord({ ...comma, ctrlKey: true }))).toBe("open-settings");
    // Shift+, types "<" on a US layout: not the settings chord.
    expect(matchAppShortcut(chord({ ...comma, key: "<", metaKey: true, shiftKey: true }))).toBe(
      null,
    );
    expect(matchAppShortcut(chord({ ...comma, metaKey: true, altKey: true }))).toBeNull();
    // AZERTY types "," on the M key, and ";" on the Comma key.
    expect(matchAppShortcut(chord({ ...comma, code: "KeyM", metaKey: true }))).toBe(
      "open-settings",
    );
    expect(matchAppShortcut(chord({ ...comma, key: ";", metaKey: true }))).toBeNull();
    // A Cyrillic layout types "б" on the Comma key.
    expect(matchAppShortcut(chord({ ...comma, key: "б", metaKey: true }))).toBe("open-settings");
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

  test("the shortcuts dialog and settings are claimed everywhere with either modifier", () => {
    for (const shortcut of [dialog, appShortcut("open-settings")])
      for (const platform of ["mac", "other"] as const)
        for (const focus of ["page", "text", "terminal"] as const)
          for (const keys of [
            { metaKey: true, ctrlKey: false },
            { metaKey: false, ctrlKey: true },
          ])
            expect(appClaimsShortcut(shortcut, keys, platform, focus)).toBe(true);
  });
});
