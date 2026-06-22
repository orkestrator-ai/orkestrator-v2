import { describe, expect, mock, test } from "bun:test";
import {
  createContextMenuTemplate,
  installDefaultContextMenu,
} from "../../../electron/context-menu";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

function createParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "app://renderer",
    frameURL: "",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "UTF-8",
    formControlType: "none",
    spellcheckEnabled: true,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
      ...overrides.editFlags,
    },
  };
}

function roles(template: MenuItemConstructorOptions[]): Array<string | undefined> {
  return template
    .filter((item) => item.type !== "separator")
    .map((item) => item.role);
}

describe("Electron context menu", () => {
  test("builds the full edit menu for editable fields", () => {
    const template = createContextMenuTemplate(createParams({
      isEditable: true,
      formControlType: "text-area",
      editFlags: {
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
        canEditRichly: false,
      },
    }));

    expect(roles(template)).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "delete",
      "selectAll",
    ]);
    expect(template.find((item) => item.role === "paste")?.enabled).toBe(true);
  });

  test("builds copy actions for selected non-editable text", () => {
    const template = createContextMenuTemplate(createParams({
      selectionText: "agent transcript",
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }));

    expect(roles(template)).toEqual(["copy", "selectAll"]);
  });

  test("does not show a native menu for empty non-editable app chrome", () => {
    expect(createContextMenuTemplate(createParams())).toEqual([]);
  });

  test("installs a webContents listener and pops the menu when actions are available", () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null;
    const popup = mock(() => undefined);
    const buildFromTemplate = mock((template: MenuItemConstructorOptions[]) => ({ template, popup }));
    const window = {
      webContents: {
        on: mock((event: "context-menu", listener: (event: unknown, params: ContextMenuParams) => void) => {
          expect(event).toBe("context-menu");
          contextMenuListener = listener;
        }),
      },
    };

    installDefaultContextMenu(window as never, { buildFromTemplate });
    contextMenuListener?.({}, createParams({ selectionText: "copy me" }));

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith({ window });
  });
});
