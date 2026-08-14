import type { MenuItemConstructorOptions } from "electron";

export type ApplicationMenuActions = {
  productName: string;
  closeTab(): void;
  zoom(direction: "in" | "out" | "reset"): void;
};

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
  ];
}
