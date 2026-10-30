import { describe, expect, test } from "bun:test";
import { APP_SHORTCUTS, matchAppShortcut } from "@orkestrator/protocol/keyboard-shortcuts";
import {
  KEYBOARD_SHORTCUT_GROUPS,
  detectShortcutPlatform,
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

  test("Windows and Linux key caps name Ctrl, Shift and Alt instead of macOS symbols", () => {
    for (const shortcut of KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)) {
      for (const key of shortcut.other ?? []) {
        expect({ id: shortcut.id, key }).toEqual({
          id: shortcut.id,
          key: expect.not.stringMatching(/[⌘⌥⌃⇧↵⌫]|\b(Cmd|Command|Option)\b/),
        });
      }
    }
  });

  test("macOS key caps use the modifier symbols", () => {
    for (const shortcut of KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)) {
      for (const key of shortcut.mac) {
        expect({ id: shortcut.id, key }).toEqual({
          id: shortcut.id,
          key: expect.not.stringMatching(/^(Ctrl|Shift|Alt|Enter)$/),
        });
      }
    }
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
    expect(ids(filterKeyboardShortcuts("view menu", "other"))).toEqual(["show-shortcuts"]);
  });

  test("matches key names and symbols", () => {
    expect(ids(filterKeyboardShortcuts("cmd shift slash", "mac"))).toContain("show-shortcuts");
    expect(ids(filterKeyboardShortcuts("⌘⇧/", "mac"))).toEqual(["show-shortcuts"]);
    expect(ids(filterKeyboardShortcuts("ctrl shift slash", "other"))).toContain("show-shortcuts");
    expect(ids(filterKeyboardShortcuts("cmd k", "mac"))).toContain("search-projects");
  });

  test('"slash" and "?" find the shortcuts dialog', () => {
    for (const platform of ["mac", "other"] as const) {
      expect(ids(filterKeyboardShortcuts("slash", platform))).toContain("show-shortcuts");
      expect(ids(filterKeyboardShortcuts("?", platform))).toContain("show-shortcuts");
    }
  });

  test("drops groups with no matches", () => {
    const groups = filterKeyboardShortcuts("address bar", "mac");
    expect(groups.map((group) => group.id)).toEqual(["editors"]);
    expect(filterKeyboardShortcuts("no such shortcut", "mac")).toEqual([]);
  });
});

describe("detectShortcutPlatform", () => {
  test.each([
    ["MacIntel", "mac"],
    ["iPad", "mac"],
    ["Linux x86_64", "other"],
    ["Linux aarch64", "other"],
    ["Win32", "other"],
  ] as const)("reads %s as %s", (platform, expected) => {
    expect(detectShortcutPlatform({ platform, userAgent: "" })).toBe(expected);
  });

  test("falls back to the user agent when the platform is blank", () => {
    expect(
      detectShortcutPlatform({
        platform: "",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      }),
    ).toBe("mac");
    expect(
      detectShortcutPlatform({
        platform: "",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Electron/45.0.0",
      }),
    ).toBe("other");
    expect(
      detectShortcutPlatform({
        platform: "",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      }),
    ).toBe("other");
  });

  test("treats a missing navigator as Windows/Linux", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
      expect(detectShortcutPlatform()).toBe("other");
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "navigator", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
    }
  });
});

describe("app-level shortcuts", () => {
  const all = KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);

  test("the catalog lists exactly the shortcuts every key router routes", () => {
    expect(
      all
        .filter((shortcut) => shortcut.app)
        .map((shortcut) => shortcut.id)
        .sort(),
    ).toEqual(APP_SHORTCUTS.map((shortcut) => shortcut.id).sort());
  });

  test("each one's advertised keys are the chord the routers match, on both platforms", () => {
    for (const shortcut of all.filter((entry) => entry.app)) {
      for (const keys of [shortcut.mac, shortcut.other!]) {
        const chord = {
          key: keys.at(-1)!.toLowerCase(),
          metaKey: keys.includes("⌘"),
          ctrlKey: keys.includes("Ctrl"),
          shiftKey: keys.includes("⇧") || keys.includes("Shift"),
          altKey: false,
        };
        expect(matchAppShortcut(chord)).toBe(shortcut.id as (typeof APP_SHORTCUTS)[number]["id"]);
      }
    }
  });
});

describe("isKeyboardShortcutsShortcut", () => {
  test("accepts Cmd+Shift+/ and Ctrl+Shift+/, reported as / or ?", () => {
    for (const key of ["/", "?"]) {
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        expect(
          isKeyboardShortcutsShortcut(keydown({ key, code: "Slash", shiftKey: true, ...modifier })),
        ).toBe(true);
      }
    }
  });

  test("no longer opens on Cmd+Shift+K or Ctrl+Shift+K", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(
        isKeyboardShortcutsShortcut(
          keydown({ key: "K", code: "KeyK", shiftKey: true, ...modifier }),
        ),
      ).toBe(false);
    }
  });

  test("the advertised toggle keys match the owning shortcut handler", () => {
    const shortcut = KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).find(
      (shortcut) => shortcut.id === "show-shortcuts",
    )!;
    for (const keys of [shortcut.mac, shortcut.other!]) {
      expect(
        isKeyboardShortcutsShortcut(
          keydown({
            key: keys.at(-1)!,
            metaKey: keys.includes("⌘"),
            ctrlKey: keys.includes("Ctrl"),
            shiftKey: keys.includes("⇧") || keys.includes("Shift"),
          }),
        ),
      ).toBe(true);
    }
  });

  test("uses the typed / instead of a different layout's physical Slash key", () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      // German: Shift+7 types /, and the Slash position types -.
      expect(
        isKeyboardShortcutsShortcut(
          keydown({ key: "-", code: "Slash", shiftKey: true, ...modifier }),
        ),
      ).toBe(false);
      expect(
        isKeyboardShortcutsShortcut(
          keydown({ key: "/", code: "Digit7", shiftKey: true, ...modifier }),
        ),
      ).toBe(true);
    }
  });

  test("falls back to the physical Slash key on a layout that types no ASCII there", () => {
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: ".", code: "Slash", metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "ю", code: "Slash", metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "ю", code: "Period", metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  test("leaves Cmd+/ and other combinations alone", () => {
    expect(isKeyboardShortcutsShortcut(keydown({ key: "/", code: "Slash", metaKey: true }))).toBe(
      false,
    );
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "/", code: "Slash", metaKey: true, ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      isKeyboardShortcutsShortcut(
        keydown({ key: "/", code: "Slash", metaKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(false);
    expect(isKeyboardShortcutsShortcut(keydown({ key: "?", code: "Slash", shiftKey: true }))).toBe(
      false,
    );
  });
});
