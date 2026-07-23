import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type MenuLike = {
  buildFromTemplate(template: MenuItemConstructorOptions[]): { popup(options: { window: BrowserWindow }): void };
};

type ContextMenuWebContents = {
  on(event: "context-menu", listener: (event: unknown, params: ContextMenuParams) => void): void;
};

const hasSelection = (params: ContextMenuParams): boolean => params.selectionText.length > 0;

function createEditableMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  return [
    { role: "undo", enabled: params.editFlags.canUndo },
    { role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "delete", enabled: params.editFlags.canDelete },
    { type: "separator" },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
}

function createSelectionMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  return [
    { role: "copy", enabled: params.editFlags.canCopy || hasSelection(params) },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
}

export function createContextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return createEditableMenuTemplate(params);
  }

  if (hasSelection(params)) {
    return createSelectionMenuTemplate(params);
  }

  return [];
}

export function installDefaultContextMenu(
  window: BrowserWindow & { webContents: ContextMenuWebContents },
  menu: MenuLike,
): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = createContextMenuTemplate(params);
    if (template.length === 0) {
      return;
    }

    menu.buildFromTemplate(template).popup({ window });
  });
}
