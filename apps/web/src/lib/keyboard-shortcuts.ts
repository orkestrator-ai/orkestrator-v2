/**
 * The catalog behind the keyboard shortcuts dialog (⌘⇧K / Ctrl+Shift+K).
 *
 * The handlers themselves live next to the surfaces that own them; this list
 * only describes them. When you add, change or remove a shortcut, update the
 * matching entry here so the dialog stays truthful.
 *
 * App-level shortcuts, which work wherever focus is in the window, are
 * defined once in `APP_SHORTCUTS` (`@orkestrator/protocol/keyboard-shortcuts`),
 * which every key router reads; their entries here take their keys from it
 * through `appShortcutEntry`.
 */

import {
  appShortcut,
  isKeyboardShortcutsChord,
  type AppShortcutId,
  type ShortcutPlatform,
} from "@orkestrator/protocol/keyboard-shortcuts";

export type { ShortcutPlatform };

export interface KeyboardShortcut {
  id: string;
  /** Set on app-level shortcuts: they work wherever focus is in the window. */
  app?: true;
  description: string;
  /** Key caps on macOS, in press order. */
  mac: readonly string[];
  /** Key caps elsewhere. Omitted when the shortcut exists on macOS only. */
  other?: readonly string[];
  /** Extra words the search should match. */
  keywords?: readonly string[];
}

export interface KeyboardShortcutGroup {
  id: string;
  title: string;
  shortcuts: readonly KeyboardShortcut[];
}

/** Shared with the design canvas help overlay to keep both catalogs in sync. */
export const DESIGN_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    id: "design-undo",
    description: "Undo the last design edit",
    mac: ["⌘", "Z"],
    other: ["Ctrl", "Z"],
  },
  {
    id: "design-redo",
    description: "Redo (also Ctrl+Y)",
    mac: ["⌘", "⇧", "Z"],
    other: ["Ctrl", "Shift", "Z"],
  },
  {
    id: "design-fit",
    description: "Fit all frames",
    mac: ["⇧", "1"],
    other: ["Shift", "1"],
  },
  {
    id: "design-zoom-selection",
    description: "Zoom to the selection",
    mac: ["⇧", "2"],
    other: ["Shift", "2"],
  },
  {
    id: "design-zoom-100",
    description: "Zoom the canvas to 100%",
    mac: ["⌘", "0"],
    other: ["Ctrl", "0"],
  },
  {
    id: "design-preview",
    description: "Toggle preview mode",
    mac: ["P"],
    other: ["P"],
  },
  {
    id: "design-delete",
    description: "Delete the selected frame",
    mac: ["⌫ / Delete"],
    other: ["Delete / Backspace"],
    keywords: ["backspace", "remove"],
  },
  {
    id: "design-help",
    description: "Show design canvas shortcuts",
    mac: ["?"],
    other: ["?"],
  },
  {
    id: "design-zoom-in",
    description: "Zoom the canvas in",
    mac: ["+ / ="],
    other: ["+ / ="],
  },
  {
    id: "design-zoom-out",
    description: "Zoom the canvas out",
    mac: ["- / _"],
    other: ["- / _"],
  },
  {
    id: "design-move",
    description: "Move the focused frame (Shift: 10px)",
    mac: ["Arrow keys"],
    other: ["Arrow keys"],
  },
  {
    id: "design-resize",
    description: "Resize the focused frame (Shift: 10px)",
    mac: ["⌥", "Arrow keys"],
    other: ["Alt", "Arrow keys"],
  },
  {
    id: "design-escape",
    description: "Cancel a gesture, exit preview, clear selection, close panels",
    mac: ["Esc"],
    other: ["Esc"],
  },
  {
    id: "design-select",
    description: "Select the frame",
    mac: ["Click a frame title"],
    other: ["Click a frame title"],
  },
  {
    id: "design-zoom-pointer",
    description: "Zoom at the pointer",
    mac: ["⌘ / Ctrl", "Scroll / Pinch"],
    other: ["Ctrl", "Scroll / Pinch"],
  },
  {
    id: "design-pan",
    description: "Pan the canvas",
    mac: ["Scroll / Shift+Scroll / Middle-drag"],
    other: ["Scroll / Shift+Scroll / Middle-drag"],
  },
];

/** The entry of an app-level shortcut, with its keys from `APP_SHORTCUTS`. */
function appShortcutEntry(
  id: AppShortcutId,
  entry: Omit<KeyboardShortcut, "id" | "app" | "mac" | "other">,
): KeyboardShortcut {
  const { key, shift } = appShortcut(id);
  const letter = key.toUpperCase();
  return {
    id,
    app: true,
    ...entry,
    mac: shift ? ["⌘", "⇧", letter] : ["⌘", letter],
    other: shift ? ["Ctrl", "Shift", letter] : ["Ctrl", letter],
  };
}

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    id: "general",
    title: "General",
    shortcuts: [
      appShortcutEntry("show-shortcuts", {
        description: "Show keyboard shortcuts",
        // Also View › Keyboard Shortcuts… in the desktop app's menu bar.
        keywords: ["help", "keybindings", "hotkeys", "view menu"],
      }),
      appShortcutEntry("search-projects", {
        description: "Search projects and environments",
        keywords: ["command palette", "switch", "jump"],
      }),
      {
        id: "open-file",
        description: "Open a file in the environment",
        mac: ["⌘", "⇧", "P"],
        keywords: ["quick open", "find file"],
      },
      {
        id: "new-window",
        description: "New window",
        mac: ["⌘", "N"],
        other: ["Ctrl", "N"],
      },
      {
        id: "zoom-in",
        description: "Zoom in",
        mac: ["⌘", "="],
        other: ["Ctrl", "="],
        keywords: ["bigger", "larger", "scale"],
      },
      {
        id: "zoom-out",
        description: "Zoom out",
        mac: ["⌘", "-"],
        other: ["Ctrl", "-"],
        keywords: ["smaller", "scale"],
      },
      {
        id: "zoom-reset",
        description: "Reset zoom to actual size",
        mac: ["⌘", "0"],
        other: ["Ctrl", "0"],
        keywords: ["scale", "100%"],
      },
    ],
  },
  {
    id: "tabs",
    title: "Tabs and panels",
    shortcuts: [
      {
        id: "new-agent-tab",
        description: "New agent tab",
        mac: ["⌘", "T"],
        keywords: ["chat", "claude", "codex"],
      },
      {
        id: "new-terminal-tab",
        description: "New terminal tab",
        mac: ["⌘", "R"],
        keywords: ["shell"],
      },
      {
        id: "close-tab",
        description: "Close the active tab",
        mac: ["⌘", "W"],
      },
      {
        id: "select-tab",
        description: "Switch to tab 1–9",
        mac: ["⌃", "1–9"],
        other: ["Ctrl", "1–9"],
        keywords: ["number", "digit"],
      },
      {
        id: "toggle-files-panel",
        description: "Toggle the files panel",
        mac: ["⌘", "E"],
        keywords: ["explorer", "changes", "sidebar"],
      },
      {
        id: "open-in-editor",
        description: "Open the environment in your editor",
        mac: ["⌘", "O"],
        keywords: ["vs code", "vscode", "cursor"],
      },
      {
        id: "copy-environment-url",
        description: "Copy the environment URL",
        mac: ["⌃", "⇧", "C"],
        other: ["Ctrl", "Shift", "C"],
        keywords: ["address", "port", "localhost"],
      },
    ],
  },
  {
    id: "environment",
    title: "Environment actions",
    shortcuts: [
      {
        id: "run-commands",
        description: "Run the environment's run commands",
        mac: ["⌘", "G"],
        keywords: ["start", "scripts", "dev server"],
      },
      {
        id: "configure-scripts",
        description: "Create or configure a run script",
        mac: ["⌘", "⇧", "G"],
      },
      {
        id: "create-pr",
        description: "Create a pull request",
        mac: ["⌘", "P"],
        keywords: ["pr", "github"],
      },
      {
        id: "configure-pr",
        description: "Configure the pull request or resolve conflicts",
        mac: ["⌘", "⇧", "U"],
        keywords: ["pr", "merge", "conflicts"],
      },
      {
        id: "configure-review",
        description: "Configure a code review",
        mac: ["⌘", "⇧", "R"],
      },
      {
        id: "multi-review",
        description: "Start a multi review",
        mac: ["⌘", "M"],
        keywords: ["code review", "models"],
      },
      {
        id: "configure-multi-review",
        description: "Configure a multi review",
        mac: ["⌘", "⇧", "M"],
      },
    ],
  },
  {
    id: "chat",
    title: "Agent chat",
    shortcuts: [
      {
        id: "chat-send",
        description: "Send the message",
        mac: ["↵"],
        other: ["Enter"],
        keywords: ["submit", "prompt"],
      },
      {
        id: "chat-newline",
        description: "Insert a new line",
        mac: ["⇧", "↵"],
        other: ["Shift", "Enter"],
      },
      {
        id: "chat-cycle-mode",
        description: "Cycle the conversation mode",
        mac: ["⇧", "Tab"],
        other: ["Shift", "Tab"],
        keywords: ["plan", "build"],
      },
      {
        id: "chat-stop",
        description: "Stop the current turn",
        mac: ["Esc"],
        other: ["Esc"],
        keywords: ["interrupt", "cancel", "escape"],
      },
      {
        id: "chat-queued-prompts",
        description: "Pick a queued prompt to steer, from the input's first line",
        mac: ["↑"],
        other: ["↑"],
        keywords: ["queue", "queued", "steer", "arrow", "up", "down"],
      },
      {
        id: "chat-find",
        description: "Find in the conversation",
        mac: ["⌘", "F"],
        other: ["Ctrl", "F"],
        keywords: ["search", "transcript"],
      },
      {
        id: "chat-find-next",
        description: "Next find match",
        mac: ["↵"],
        other: ["Enter"],
      },
      {
        id: "chat-find-previous",
        description: "Previous find match",
        mac: ["⇧", "↵"],
        other: ["Shift", "Enter"],
      },
      {
        id: "chat-mention",
        description: "Mention a file",
        mac: ["@"],
        other: ["@"],
      },
      {
        id: "chat-slash-command",
        description: "Open slash commands",
        mac: ["/"],
        other: ["/"],
      },
      {
        id: "send-comment",
        description: "Send a pull request comment or agent mail",
        mac: ["⌘", "↵"],
        other: ["Ctrl", "Enter"],
      },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    shortcuts: [
      {
        id: "terminal-compose",
        description: "Toggle the compose bar",
        mac: ["⌘", "I"],
        other: ["Ctrl", "I"],
      },
      {
        id: "terminal-copy",
        description: "Copy the selection",
        mac: ["⌘", "C"],
        other: ["Ctrl", "Shift", "C"],
      },
      {
        id: "terminal-paste",
        description: "Paste text or an image",
        mac: ["⌘", "V"],
        other: ["Ctrl", "V"],
      },
      {
        id: "terminal-select-all",
        description: "Select all output",
        mac: ["⌘", "A"],
      },
      {
        id: "terminal-newline",
        description: "Insert a new line without submitting",
        mac: ["⇧", "↵"],
        other: ["Shift", "Enter"],
      },
      {
        id: "terminal-open-link",
        description: "Open a link in your browser",
        mac: ["⌘", "Click"],
        other: ["Ctrl", "Click"],
        keywords: ["url"],
      },
      {
        id: "terminal-open-link-tab",
        description: "Open a link in a browser tab",
        mac: ["⌘", "⇧", "Click"],
        other: ["Ctrl", "Shift", "Click"],
        keywords: ["url"],
      },
    ],
  },
  {
    id: "editors",
    title: "Browser and editors",
    shortcuts: [
      {
        id: "browser-address",
        description: "Focus the browser address bar",
        mac: ["⌘", "L"],
        other: ["Ctrl", "L"],
        keywords: ["url", "location"],
      },
      {
        id: "markdown-save",
        description: "Save the markdown file",
        mac: ["⌘", "S"],
        other: ["Ctrl", "S"],
      },
    ],
  },
  {
    id: "design",
    title: "Design canvas",
    shortcuts: DESIGN_KEYBOARD_SHORTCUTS,
  },
];

/** Words a symbol key cap answers to, so "cmd shift k" finds ⌘⇧K. */
const KEY_ALIASES: Record<string, string> = {
  "⌘": "cmd command meta",
  "⇧": "shift",
  "⌥": "alt option opt",
  "⌃": "ctrl control",
  "↵": "enter return",
  "⌫": "backspace delete",
  Ctrl: "control",
  Esc: "escape",
};

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "other";
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "mac" : "other";
}

export function shortcutKeys(
  shortcut: KeyboardShortcut,
  platform: ShortcutPlatform,
): readonly string[] | undefined {
  return platform === "mac" ? shortcut.mac : shortcut.other;
}

function searchableText(
  group: KeyboardShortcutGroup,
  shortcut: KeyboardShortcut,
  keys: readonly string[],
): string {
  return [
    shortcut.description,
    group.title,
    ...(shortcut.keywords ?? []),
    ...keys,
    ...keys.map((key) => KEY_ALIASES[key] ?? ""),
    keys.join(""),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * The groups and shortcuts available on `platform` whose text matches every
 * word of `query`. Groups left empty by the filter are dropped.
 */
export function filterKeyboardShortcuts(
  query: string,
  platform: ShortcutPlatform,
  groups: readonly KeyboardShortcutGroup[] = KEYBOARD_SHORTCUT_GROUPS,
): KeyboardShortcutGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const result: KeyboardShortcutGroup[] = [];
  for (const group of groups) {
    const shortcuts = group.shortcuts.filter((shortcut) => {
      const keys = shortcutKeys(shortcut, platform);
      if (!keys) return false;
      const text = searchableText(group, shortcut, keys);
      return terms.every((term) => text.includes(term));
    });
    if (shortcuts.length > 0) result.push({ ...group, shortcuts });
  }
  return result;
}

/** ⌘⇧K on macOS, Ctrl+Shift+K elsewhere; either modifier is accepted, as with ⌘K. */
export function isKeyboardShortcutsShortcut(event: KeyboardEvent): boolean {
  return isKeyboardShortcutsChord(event);
}
