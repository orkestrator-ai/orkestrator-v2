/**
 * The app-level keyboard shortcuts (⌘K search, ⌘⇧K shortcuts dialog) and the
 * shortcuts dialog's desktop menu event, shared by the renderer (which owns
 * the UI they open), Electron main (which owns the View menu item and the
 * native views that keys can land in instead) and the design frame runtime.
 */

/** The View menu's accelerator label. */
export const KEYBOARD_SHORTCUTS_ACCELERATOR = "CmdOrCtrl+Shift+K";

/** Electron main → renderer: show the keyboard shortcuts dialog. */
export const KEYBOARD_SHORTCUTS_EVENT = "menu-keyboard-shortcuts";

/**
 * Electron main → a window's shell renderer: a window-owned app shortcut
 * (payload: its `AppShortcutId`) was typed in a native view the app runs no
 * key router in, such as an artifact.
 */
export const APP_SHORTCUT_EVENT = "app-shortcut";

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

/** The app shortcuts: see `APP_SHORTCUTS`. */
export type AppShortcutId = "show-shortcuts" | "search-projects";

/** The platform a chord was typed on: macOS, or anything else. */
export type ShortcutPlatform = "mac" | "other";

/**
 * What kind of surface has keyboard focus when an app shortcut is typed:
 * a terminal (xterm), a text field (input, textarea, contenteditable, a code
 * editor), or anything else in the page.
 */
export type ShortcutFocus = "terminal" | "text" | "page";

/**
 * A keyboard shortcut that belongs to the application rather than to the
 * surface that has focus, so it works wherever focus is in the window:
 * the sidebar, the main area, the composer, a terminal, a leaf node's
 * workspace realm, a design frame or an artifact.
 *
 * Every router reads this list: Electron main (`before-input-event` on every
 * WebContents), each app document's capture-phase key router, and the design
 * frame runtime. Adding a shortcut here (and its handler and its entry in the
 * web catalogue, `apps/web/src/lib/keyboard-shortcuts.ts`) routes it
 * everywhere; there is no other list.
 */
export interface AppShortcut {
  id: AppShortcutId;
  /** The Latin letter, lower case, typed with ⌘ or Ctrl. */
  key: string;
  shift: boolean;
  /**
   * Which document opens the UI. `window`: the window's shell renderer,
   * which owns the sidebar; a realm forwards the shortcut to it. `document`:
   * the app document that has focus, realm included (each one renders its
   * own copy of the UI).
   */
  owner: "window" | "document";
  /**
   * Whether the shortcut is taken from a page shown in a browser preview.
   * The previewed page is the user's own product; ⌘K is the web's usual
   * command-palette key, so it stays with the page.
   */
  fromPreviews: boolean;
  /**
   * Whether plain Ctrl+key (without ⌘) edits text where focus is: Ctrl+K is
   * kill-line in a shell (readline, zsh, nano) on every platform and in a
   * macOS text field (Cocoa's Emacs bindings). There it stays with the
   * surface; ⌘K, and Ctrl+K anywhere else, is the app's.
   */
  ctrlEditsText: boolean;
}

export const APP_SHORTCUTS: readonly AppShortcut[] = [
  {
    id: "show-shortcuts",
    key: "k",
    shift: true,
    owner: "document",
    fromPreviews: true,
    ctrlEditsText: false,
  },
  {
    id: "search-projects",
    key: "k",
    shift: false,
    owner: "window",
    fromPreviews: false,
    ctrlEditsText: true,
  },
];

export function isAppShortcutId(value: unknown): value is AppShortcutId {
  return APP_SHORTCUTS.some((shortcut) => shortcut.id === value);
}

export function appShortcut(id: AppShortcutId): AppShortcut {
  return APP_SHORTCUTS.find((shortcut) => shortcut.id === id)!;
}

/**
 * The app shortcut a chord is, if any. ⌘ or Ctrl is accepted on every
 * platform (but not both), so users coming from another platform are served.
 * Self-contained, with the list passed in, so app-owned design sandboxes can
 * serialize it together with `APP_SHORTCUTS`.
 *
 * `key` wins when it is a Latin letter, so Dvorak and other remapped Latin
 * layouts use the letter they type. A layout that types no Latin letter
 * there (Cyrillic, Greek, Hebrew…) reports its own character, so the
 * physical key position (`code`) decides instead.
 */
export function matchAppShortcut(
  chord: ShortcutChord,
  shortcuts: readonly Pick<AppShortcut, "id" | "key" | "shift">[] = APP_SHORTCUTS,
): AppShortcutId | null {
  if (chord.metaKey === chord.ctrlKey || chord.altKey) return null;
  const key = chord.key;
  const letter =
    typeof key === "string" && /^[a-z]$/i.test(key)
      ? key.toLowerCase()
      : typeof chord.code === "string" && /^Key[A-Z]$/.test(chord.code)
        ? chord.code.slice(3).toLowerCase()
        : null;
  if (!letter) return null;
  for (const shortcut of shortcuts) {
    if (shortcut.key === letter && shortcut.shift === chord.shiftKey) return shortcut.id;
  }
  return null;
}

/**
 * Whether the app takes `shortcut` from the focused surface, or leaves the
 * key to it (see `AppShortcut.ctrlEditsText`).
 */
export function appClaimsShortcut(
  shortcut: Pick<AppShortcut, "ctrlEditsText">,
  chord: Pick<ShortcutChord, "metaKey" | "ctrlKey">,
  platform: ShortcutPlatform,
  focus: ShortcutFocus,
): boolean {
  if (!shortcut.ctrlEditsText || chord.metaKey || !chord.ctrlKey) return true;
  if (focus === "terminal") return false;
  return !(focus === "text" && platform === "mac");
}

/** ⌘⇧K / Ctrl+Shift+K; either modifier is accepted, as with ⌘K. */
export function isKeyboardShortcutsChord(chord: ShortcutChord): boolean {
  return matchAppShortcut(chord) === "show-shortcuts";
}

// Self-contained so designBootstrap can serialize the same focus policy.
/** What kind of surface `target` is, for `appClaimsShortcut`. */
export function shortcutFocus(target: EventTarget | null): ShortcutFocus {
  if (!(target instanceof Element)) return "page";
  // xterm's helper textarea is a text field, but its keys go to a shell.
  if (target.closest(".xterm")) return "terminal";
  if (target.closest(".monaco-editor")) return "text";
  if (target instanceof HTMLElement && target.isContentEditable) return "text";
  if (target instanceof HTMLInputElement)
    return [
      "button",
      "checkbox",
      "color",
      "file",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(target.type)
      ? "page"
      : "text";
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    ? "text"
    : "page";
}
