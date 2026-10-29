import type { KeyboardEvent as MenuKeyboardEvent, MenuItemConstructorOptions } from "electron";
import {
  KEYBOARD_SHORTCUTS_ACCELERATOR,
  SETTINGS_ACCELERATOR,
  type KeyboardShortcutsRequest,
} from "@orkestrator/protocol/keyboard-shortcuts";

export type ApplicationMenuWindow = {
  id: number;
  title: string;
  focused: boolean;
};

export type ApplicationMenuActions = {
  /** `process.platform`: Windows and Linux get their own menu conventions. */
  platform: NodeJS.Platform;
  productName: string;
  windows: ApplicationMenuWindow[];
  newWindow(): void;
  closeTab(): void;
  selectWindow(id: number): void;
  zoom(direction: "in" | "out" | "reset"): void;
  /** Show the keyboard shortcuts dialog in the focused window's renderer. */
  showKeyboardShortcuts(request: KeyboardShortcutsRequest): void;
  /** Open global settings in the focused window's shell renderer. */
  openSettings(): void;
  /** Present only when this install can update itself. */
  checkForUpdates?(): void;
};

/**
 * Give each open window a distinct label. Two windows can share a connection
 * and therefore the same title, which would make the menu ambiguous to pick
 * from.
 *
 * Titles are numbered only when they are duplicated, but a unique title can
 * still look like a generated suffix (a connection literally named `Local (1)`
 * beside two `Local` windows). Every emitted label is therefore tracked, and a
 * title that would repeat an earlier label is numbered until it is unique.
 */
function windowMenuLabels(windows: ApplicationMenuWindow[]): string[] {
  const totals = new Map<string, number>();
  for (const window of windows) {
    totals.set(window.title, (totals.get(window.title) ?? 0) + 1);
  }
  const used = new Set<string>();
  const nextOrdinal = new Map<string, number>();
  return windows.map((window) => {
    const duplicated = (totals.get(window.title) ?? 0) > 1;
    if (!duplicated && !used.has(window.title)) {
      used.add(window.title);
      return window.title;
    }
    let ordinal = nextOrdinal.get(window.title) ?? 1;
    let label = `${window.title} (${ordinal})`;
    while (used.has(label)) {
      ordinal += 1;
      label = `${window.title} (${ordinal})`;
    }
    nextOrdinal.set(window.title, ordinal + 1);
    used.add(label);
    return label;
  });
}

function windowMenuItems(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  if (actions.windows.length === 0) {
    return [{ label: "No Open Windows", enabled: false }];
  }
  const labels = windowMenuLabels(actions.windows);
  return actions.windows.map((window, index) => ({
    label: labels[index],
    type: "radio" as const,
    checked: window.focused,
    click: () => actions.selectWindow(window.id),
  }));
}

/**
 * Build the desktop menu without importing Electron runtime state in tests.
 *
 * Outside macOS, Electron's `Command` modifier is the Super/Windows key, and
 * the hide, hideOthers, unhide and zoom roles have no action. Windows and
 * Linux therefore get the conventional layout instead: Settings… and Quit at
 * the end of File, About and updates under Help, and no Command accelerators.
 * On macOS Settings… sits in the app menu, where every Mac app keeps it.
 */
export function createApplicationMenuTemplate(
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  const isMac = actions.platform === "darwin";
  const checkForUpdates: MenuItemConstructorOptions[] = actions.checkForUpdates
    ? [{ label: "Check for Updates…", click: actions.checkForUpdates }]
    : [];
  const settings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: SETTINGS_ACCELERATOR,
    // The key is the `open-settings` app shortcut: each app document's key
    // router claims it, and main's before-input-event hook takes it from a
    // native view. Registering it too would deliver one press twice on
    // Windows and Linux; macOS keeps the menu's key equivalent as the
    // fallback for a press no page claimed. Opening is idempotent either way.
    registerAccelerator: false,
    click: actions.openSettings,
  };
  return [
    ...(isMac
      ? [
          {
            label: actions.productName,
            submenu: [
              { role: "about" },
              ...checkForUpdates,
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: actions.newWindow,
        },
        { type: "separator" },
        {
          label: "Close Tab",
          // Ctrl+W is the shell's delete-word, and Command would register
          // Super/Windows+W, which window managers and Windows own.
          ...(isMac ? { accelerator: "Command+W" } : {}),
          click: actions.closeTab,
        },
        ...(isMac
          ? []
          : [
              { type: "separator" } as const,
              settings,
              { type: "separator" } as const,
              { role: "quit" } as const,
            ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => actions.zoom("in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => actions.zoom("out") },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => actions.zoom("reset") },
        { type: "separator" },
        {
          label: "Keyboard Shortcuts…",
          accelerator: KEYBOARD_SHORTCUTS_ACCELERATOR,
          // Main consumes native input before both page and menu dispatch,
          // including child views and subframes. Keep the label (Ctrl+Shift+K
          // on Windows and Linux) and the macOS menu fallback without
          // registering a second Windows/Linux delivery path.
          registerAccelerator: false,
          click: (_item, _window, event: MenuKeyboardEvent) => {
            // Electron also marks Enter-based menu navigation as an
            // accelerator. Only the advertised chord may toggle the dialog.
            const isShortcut =
              event?.triggeredByAccelerator &&
              event.shiftKey &&
              !event.altKey &&
              (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
            actions.showKeyboardShortcuts(isShortcut ? "toggle" : "open");
          },
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac ? [{ role: "zoom" } as const] : []),
        { type: "separator" },
        ...windowMenuItems(actions),
      ],
    },
    ...(isMac
      ? []
      : [
          {
            label: "Help",
            submenu: [
              ...checkForUpdates,
              ...(checkForUpdates.length > 0 ? [{ type: "separator" } as const] : []),
              { role: "about" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]),
  ];
}
