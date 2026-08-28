import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

export type MenuLike = {
  buildFromTemplate(template: MenuItemConstructorOptions[]): {
    popup(options: { window: BrowserWindow }): void;
  };
};

type ContextMenuWebContents = {
  on(event: "context-menu", listener: (event: unknown, params: ContextMenuParams) => void): void;
  copyImageAt(x: number, y: number): void;
  replaceMisspelling(suggestion: string): void;
  session: {
    addWordToSpellCheckerDictionary(word: string): boolean;
  };
};

const hasSelection = (params: ContextMenuParams): boolean => params.selectionText.length > 0;

export type ContextMenuActions = {
  replaceMisspelling(suggestion: string): void;
  addToDictionary(word: string): void;
  copyImageAt(x: number, y: number): void;
  writeClipboardText(text: string): void;
};

function createSpellcheckMenuTemplate(
  params: ContextMenuParams,
  actions?: ContextMenuActions,
): MenuItemConstructorOptions[] {
  if (!params.misspelledWord || !actions) {
    return [];
  }

  return [
    ...params.dictionarySuggestions.map((suggestion) => ({
      label: suggestion,
      click: () => actions.replaceMisspelling(suggestion),
    })),
    {
      label: "Add to Dictionary",
      click: () => actions.addToDictionary(params.misspelledWord),
    },
    { type: "separator" as const },
  ];
}

function createEditableMenuTemplate(
  params: ContextMenuParams,
  actions?: ContextMenuActions,
): MenuItemConstructorOptions[] {
  return [
    ...createSpellcheckMenuTemplate(params, actions),
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

function createImageMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const filename = params.suggestedFilename;
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Copy",
      enabled: true,
      click: () => actions.copyImageAt(params.x, params.y),
    },
    {
      label: "Copy Filename",
      enabled: filename.trim().length > 0,
      click: () => {
        if (filename.trim().length > 0) actions.writeClipboardText(filename);
      },
    },
  ];

  if (hasSelection(params)) {
    template.push({ type: "separator" }, ...createSelectionMenuTemplate(params));
  }

  return template;
}

export function createContextMenuTemplate(
  params: ContextMenuParams,
  actions?: ContextMenuActions,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return createEditableMenuTemplate(params, actions);
  }

  if (params.mediaType === "image" && params.hasImageContents && actions) {
    return createImageMenuTemplate(params, actions);
  }

  if (hasSelection(params)) {
    return createSelectionMenuTemplate(params);
  }

  return [];
}

export function installDefaultContextMenu(
  window: BrowserWindow & { webContents: ContextMenuWebContents },
  menu: MenuLike,
  writeClipboardText: (text: string) => void,
): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = createContextMenuTemplate(params, {
      replaceMisspelling: (suggestion) => {
        window.webContents.replaceMisspelling(suggestion);
      },
      addToDictionary: (word) => {
        window.webContents.session.addWordToSpellCheckerDictionary(word);
      },
      copyImageAt: (x, y) => {
        window.webContents.copyImageAt(x, y);
      },
      writeClipboardText,
    });
    if (template.length === 0) {
      return;
    }

    menu.buildFromTemplate(template).popup({ window });
  });
}
