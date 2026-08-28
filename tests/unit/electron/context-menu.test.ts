import { describe, expect, mock, test } from "bun:test";
import {
  createContextMenuTemplate,
  installDefaultContextMenu,
  type ContextMenuActions,
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
  return template.filter((item) => item.type !== "separator").map((item) => item.role);
}

function createActions(overrides: Partial<ContextMenuActions> = {}): ContextMenuActions {
  return {
    replaceMisspelling: mock(() => undefined),
    addToDictionary: mock(() => undefined),
    copyImageAt: mock(() => undefined),
    writeClipboardText: mock(() => undefined),
    ...overrides,
  };
}

describe("Electron context menu", () => {
  test("builds the full edit menu for editable fields", () => {
    const template = createContextMenuTemplate(
      createParams({
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
      }),
    );

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
    const template = createContextMenuTemplate(
      createParams({
        isEditable: true,
        formControlType: "text-area",
      }),
    );

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
    const template = createContextMenuTemplate(
      createParams({
        isEditable: true,
        formControlType: "text-area",
        misspelledWord: "mispelled",
        dictionarySuggestions: ["misspelled", "misapplied"],
      }),
      createActions({
        replaceMisspelling,
        addToDictionary,
      }),
    );

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
    const template = createContextMenuTemplate(
      createParams({
        isEditable: true,
        formControlType: "text-area",
        dictionarySuggestions: ["unused"],
      }),
      createActions(),
    );

    expect(template[0]?.role).toBe("undo");
    expect(template.some((item) => item.label === "Add to Dictionary")).toBe(false);
  });

  test("does not add spelling actions when handlers are unavailable", () => {
    const template = createContextMenuTemplate(
      createParams({
        isEditable: true,
        formControlType: "text-area",
        misspelledWord: "mispelled",
        dictionarySuggestions: ["misspelled"],
      }),
    );

    expect(template[0]?.role).toBe("undo");
    expect(template.some((item) => item.label === "misspelled")).toBe(false);
    expect(template.some((item) => item.label === "Add to Dictionary")).toBe(false);
  });

  test("offers Add to Dictionary when there are no replacement suggestions", () => {
    const replaceMisspelling = mock((_suggestion: string) => undefined);
    const addToDictionary = mock((_word: string) => undefined);
    const template = createContextMenuTemplate(
      createParams({
        isEditable: true,
        formControlType: "text-area",
        misspelledWord: "orkestrator",
        dictionarySuggestions: [],
      }),
      createActions({
        replaceMisspelling,
        addToDictionary,
      }),
    );

    expect(template.slice(0, 2).map((item) => item.label ?? item.type)).toEqual([
      "Add to Dictionary",
      "separator",
    ]);
    expect(template[2]?.role).toBe("undo");
    template[0]?.click?.(undefined as never, undefined as never, undefined as never);
    expect(replaceMisspelling).not.toHaveBeenCalled();
    expect(addToDictionary).toHaveBeenCalledWith("orkestrator");
  });

  test("builds copy actions for selected non-editable text", () => {
    const template = createContextMenuTemplate(
      createParams({
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
      }),
    );

    expect(roles(template)).toEqual(["copy", "selectAll"]);
  });

  test("keeps copy enabled for selected text even when edit flags do not advertise copy", () => {
    const template = createContextMenuTemplate(
      createParams({
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
      }),
    );

    expect(template.find((item) => item.role === "copy")?.enabled).toBe(true);
  });

  test("copies image contents and the suggested filename with separate actions", () => {
    const copyImageAt = mock((_x: number, _y: number) => undefined);
    const writeClipboardText = mock((_text: string) => undefined);
    const template = createContextMenuTemplate(
      createParams({
        x: 42,
        y: 84,
        mediaType: "image",
        hasImageContents: true,
        suggestedFilename: "diagram.png",
      }),
      createActions({
        copyImageAt,
        writeClipboardText,
      }),
    );

    expect(template.map((item) => item.label)).toEqual(["Copy", "Copy Filename"]);
    expect(template[0]?.enabled).toBe(true);
    expect(template[1]).toMatchObject({ enabled: true });

    template[0]?.click?.(undefined as never, undefined as never, undefined as never);
    template[1]?.click?.(undefined as never, undefined as never, undefined as never);
    expect(copyImageAt).toHaveBeenCalledWith(42, 84);
    expect(writeClipboardText).toHaveBeenCalledWith("diagram.png");
  });

  test("keeps selected-text actions in the image menu", () => {
    const template = createContextMenuTemplate(
      createParams({
        mediaType: "image",
        hasImageContents: true,
        selectionText: "selected caption",
        suggestedFilename: "diagram.png",
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
      }),
      createActions(),
    );

    expect(template.map((item) => item.label ?? item.type ?? item.role)).toEqual([
      "Copy",
      "Copy Filename",
      "separator",
      "copy",
      "selectAll",
    ]);
  });

  test("falls back to selected-text actions when image contents or handlers are unavailable", () => {
    const selectedImageParams = createParams({
      mediaType: "image",
      hasImageContents: true,
      selectionText: "selected caption",
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
    });

    expect(roles(createContextMenuTemplate(selectedImageParams))).toEqual(["copy", "selectAll"]);
    expect(
      roles(
        createContextMenuTemplate({
          ...selectedImageParams,
          hasImageContents: false,
        }),
      ),
    ).toEqual(["copy", "selectAll"]);
  });

  test("does not show a native menu for empty non-editable app chrome", () => {
    expect(createContextMenuTemplate(createParams())).toEqual([]);
  });

  test("installs a webContents listener and pops the menu when actions are available", () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null;
    const popup = mock(() => undefined);
    const buildFromTemplate = mock((template: MenuItemConstructorOptions[]) => ({
      template,
      popup,
    }));
    const window = {
      webContents: {
        on: mock(
          (
            event: "context-menu",
            listener: (event: unknown, params: ContextMenuParams) => void,
          ) => {
            expect(event).toBe("context-menu");
            contextMenuListener = listener;
          },
        ),
      },
    };

    installDefaultContextMenu(
      window as never,
      { buildFromTemplate },
      mock(() => undefined),
    );
    contextMenuListener?.({}, createParams({ selectionText: "copy me" }));

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith({ window });
  });

  test("routes the image copy action through the window webContents", () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null;
    let builtTemplate: MenuItemConstructorOptions[] = [];
    const popup = mock(() => undefined);
    const buildFromTemplate = mock((template: MenuItemConstructorOptions[]) => {
      builtTemplate = template;
      return { template, popup };
    });
    const copyImageAt = mock((_x: number, _y: number) => undefined);
    const writeClipboardText = mock((_text: string) => undefined);
    const window = {
      webContents: {
        on: mock(
          (
            _event: "context-menu",
            listener: (event: unknown, params: ContextMenuParams) => void,
          ) => {
            contextMenuListener = listener;
          },
        ),
        copyImageAt,
      },
    };

    installDefaultContextMenu(window as never, { buildFromTemplate }, writeClipboardText);
    contextMenuListener?.(
      {},
      createParams({
        x: 12,
        y: 34,
        mediaType: "image",
        hasImageContents: true,
        suggestedFilename: "chart.png",
      }),
    );
    builtTemplate[0]?.click?.(undefined as never, undefined as never, undefined as never);
    builtTemplate[1]?.click?.(undefined as never, undefined as never, undefined as never);

    expect(copyImageAt).toHaveBeenCalledWith(12, 34);
    expect(writeClipboardText).toHaveBeenCalledWith("chart.png");
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
        on: mock(
          (
            _event: "context-menu",
            listener: (event: unknown, params: ContextMenuParams) => void,
          ) => {
            contextMenuListener = listener;
          },
        ),
        replaceMisspelling,
        session: { addWordToSpellCheckerDictionary },
      },
    };

    installDefaultContextMenu(
      window as never,
      { buildFromTemplate },
      mock(() => undefined),
    );
    contextMenuListener?.(
      {},
      createParams({
        isEditable: true,
        misspelledWord: "mispelled",
        dictionarySuggestions: ["misspelled"],
      }),
    );

    builtTemplate
      .find((item) => item.label === "misspelled")
      ?.click?.(undefined as never, undefined as never, undefined as never);
    builtTemplate
      .find((item) => item.label === "Add to Dictionary")
      ?.click?.(undefined as never, undefined as never, undefined as never);

    expect(replaceMisspelling).toHaveBeenCalledWith("misspelled");
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith("mispelled");
  });

  test("does not build or pop a menu when no actions are available", () => {
    let contextMenuListener: ((event: unknown, params: ContextMenuParams) => void) | null = null;
    const popup = mock(() => undefined);
    const buildFromTemplate = mock((template: MenuItemConstructorOptions[]) => ({
      template,
      popup,
    }));
    const window = {
      webContents: {
        on: mock(
          (
            event: "context-menu",
            listener: (event: unknown, params: ContextMenuParams) => void,
          ) => {
            expect(event).toBe("context-menu");
            contextMenuListener = listener;
          },
        ),
      },
    };

    installDefaultContextMenu(
      window as never,
      { buildFromTemplate },
      mock(() => undefined),
    );
    contextMenuListener?.({}, createParams());

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
