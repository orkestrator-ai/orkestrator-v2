import type { MenuItemConstructorOptions } from "electron";

export type ApplicationMenuWindow = {
  id: number;
  title: string;
  focused: boolean;
};

export type ApplicationMenuActions = {
  productName: string;
  windows: ApplicationMenuWindow[];
  newWindow(): void;
  closeTab(): void;
  selectWindow(id: number): void;
  zoom(direction: "in" | "out" | "reset"): void;
};

/**
 * Give each open window a distinct label. Two windows can share a connection
 * and therefore the same title, which would make the menu ambiguous to pick
 * from.
 */
function windowMenuLabels(windows: ApplicationMenuWindow[]): string[] {
  const totals = new Map<string, number>();
  for (const window of windows) {
    totals.set(window.title, (totals.get(window.title) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return windows.map((window) => {
    if ((totals.get(window.title) ?? 0) <= 1) return window.title;
    const index = (seen.get(window.title) ?? 0) + 1;
    seen.set(window.title, index);
    return `${window.title} (${index})`;
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

/** Build the desktop menu without importing Electron runtime state in tests. */
export function createApplicationMenuTemplate(
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: actions.productName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
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
          accelerator: "Command+W",
          click: actions.closeTab,
        },
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
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        ...windowMenuItems(actions),
      ],
    },
  ];
}
