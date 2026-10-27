/**
 * The keyboard shortcuts dialog's chord and its desktop menu event, shared by
 * the renderer (which owns the dialog) and Electron main (which owns the View
 * menu item and the native preview views that keys can land in instead).
 */

/** The View menu's accelerator label. */
export const KEYBOARD_SHORTCUTS_ACCELERATOR = "CmdOrCtrl+Shift+K";

/** Electron main → renderer: show the keyboard shortcuts dialog. */
export const KEYBOARD_SHORTCUTS_EVENT = "menu-keyboard-shortcuts";

/**
 * `open` comes from a menu click: it shows the dialog, or keeps an open one
 * open and returns focus to its search. `toggle` comes from the chord pressed
 * where the renderer cannot see it (a native preview view, or the menu's own
 * key equivalent), so it behaves exactly like pressing it in the renderer.
 */
export type KeyboardShortcutsRequest = "open" | "toggle";

export function isKeyboardShortcutsRequest(value: unknown): value is KeyboardShortcutsRequest {
  return value === "open" || value === "toggle";
}

/** The fields shared by a DOM `KeyboardEvent` and an Electron `Input`. */
export interface ShortcutChord {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * ⌘⇧K / Ctrl+Shift+K; either modifier is accepted, as with ⌘K.
 * Self-contained so app-owned design sandboxes can serialize the matcher.
 * `key` wins when it is a Latin letter,
 * so Dvorak and other remapped Latin layouts use the K they type. A layout
 * that types no Latin letter there (Cyrillic, Greek, Hebrew…) reports its own
 * character, so the physical key position (`code`) decides instead.
 */
export function isKeyboardShortcutsChord(chord: ShortcutChord): boolean {
  function namesK(key: string | undefined, code: string | undefined): boolean {
    if (typeof key === "string" && /^[a-z]$/i.test(key)) return key.toLowerCase() === "k";
    return code === "KeyK";
  }

  const hasModifier = chord.metaKey || chord.ctrlKey;
  const hasBothModifiers = chord.metaKey && chord.ctrlKey;
  return (
    hasModifier &&
    !hasBothModifiers &&
    chord.shiftKey &&
    !chord.altKey &&
    namesK(chord.key, chord.code)
  );
}
