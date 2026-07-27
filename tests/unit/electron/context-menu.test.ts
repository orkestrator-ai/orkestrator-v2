import { describe, expect, mock, test } from "bun:test";
import {
  createContextMenuTemplate,
  installDefaultContextMenu,
} from "../../../apps/desktop/electron/context-menu";
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

  test("preserves disabled states for unavailable editable actions", () => {
    const template = createContextMenuTemplate(createParams({
      isEditable: true,
      formControlType: "text-area",
    }));

    for (const item of template) {
      if (item.type === "separator") {
        continue;
      }

      expect(item.enabled).toBe(false);
    }
  });

  test("puts spelling suggestions before edit actions and invokes the selected correction", () => {
    const replaceMisspelling = mock((_suggestion: string) => undefined);
    const addToDictionary = mock((_word: string) => undefined);
    const template = createContextMenuTemplate(createParams({
      isEditable: true,
      formControlType: "text-area",
      misspelledWord: "mispelled",
      dictionarySuggestions: ["misspelled", "misapplied"],
    }), {
      replaceMisspelling,
      addToDictionary,
    });

    expect(template.slice(0, 4).map((item) => item.label ?? item.type)).toEqual([
      "misspelled",
      "misapplied",
      "Add to Dictionary",
      "separator",
    ]);

    template[0]?.click?.(undefined as never, undefined as never, undefined as never);
    template[2]?.click?.(undefined as never, undefined as never, undefined as never);

    expect(replaceMisspelling).toHaveBeenCalledWith("misspelled");
    expect(addToDictionary).toHaveBeenCalledWith("mispelled");
  });

  test("does not add spelling actions when the clicked word is spelled correctly", () => {
    const template = createContextMenuTemplate(createParams({
      isEditable: true,
      formControlType: "text-area",
      dictionarySuggestions: ["unused"],
    }), {
      replaceMisspelling: mock(() => undefined),
      addToDictionary: mock(() => undefined),
    });

    expect(template[0]?.role).toBe("undo");
    expect(template.some((item) => item.label === "Add to Dictionary")).toBe(false);
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

  test("keeps copy enabled for selected text even when edit flags do not advertise copy", () => {
    const template = createContextMenuTemplate(createParams({
      selectionText: "agent transcript",
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
    }));

    expect(template.find((item) => item.role === "copy")?.enabled).toBe(true);
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

  test("uses the window webContents to replace a misspelled word", () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null;
    const popup = mock(() => undefined);
    let builtTemplate: MenuItemConstructorOptions[] = [];
    const buildFromTemplate = mock((template: MenuItemConstructorOptions[]) => {
      builtTemplate = template;
      return { template, popup };
    });
    const replaceMisspelling = mock((_suggestion: string) => undefined);
    const addWordToSpellCheckerDictionary = mock((_word: string) => true);
    const window = {
      webContents: {
        on: mock((_event: "context-menu", listener: (event: unknown, params: ContextMenuParams) => void) => {
          contextMenuListener = listener;
        }),
        replaceMisspelling,
        session: { addWordToSpellCheckerDictionary },
      },
    };

    installDefaultContextMenu(window as never, { buildFromTemplate });
    contextMenuListener?.({}, createParams({
      isEditable: true,
      misspelledWord: "mispelled",
      dictionarySuggestions: ["misspelled"],
    }));

    builtTemplate.find((item) => item.label === "misspelled")?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    builtTemplate.find((item) => item.label === "Add to Dictionary")?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );

    expect(replaceMisspelling).toHaveBeenCalledWith("misspelled");
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith("mispelled");
  });

  test("does not build or pop a menu when no actions are available", () => {
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
    contextMenuListener?.({}, createParams());

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
