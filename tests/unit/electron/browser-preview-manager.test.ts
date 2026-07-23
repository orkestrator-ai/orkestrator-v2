import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import { BrowserPreviewManager } from "../../../apps/desktop/electron/browser-preview-manager";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

class FakeWebContents extends EventEmitter {
  currentUrl = "";
  destroyed = false;
  canGoBackValue = false;
  canGoForwardValue = false;
  readonly loadURL = mock(async (url: string) => {
    this.currentUrl = url;
  });
  readonly reload = mock(() => undefined);
  readonly openDevTools = mock(() => undefined);
  readonly inspectElement = mock(() => undefined);
  readonly setWindowOpenHandler = mock(() => undefined);
  readonly close = mock(() => {
    this.destroyed = true;
  });
  readonly navigationHistory = {
    canGoBack: mock(() => this.canGoBackValue),
    canGoForward: mock(() => this.canGoForwardValue),
    goBack: mock(() => undefined),
    goForward: mock(() => undefined),
  };

  getURL() {
    return this.currentUrl;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function createHarness() {
  const views: FakeView[] = [];
  class FakeView {
    readonly webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    readonly setBackgroundColor = mock(() => undefined);
    readonly setBounds = mock((bounds: typeof this.bounds) => {
      this.bounds = bounds;
    });
    readonly getBounds = mock(() => this.bounds);
    readonly setVisible = mock((visible: boolean) => {
      this.visible = visible;
    });

    constructor(readonly options: unknown) {
      views.push(this);
    }
  }

  const contentView = {
    addChildView: mock(() => undefined),
    removeChildView: mock(() => undefined),
  };
  const window = { isDestroyed: () => false, contentView };
  const emitState = mock(() => undefined);
  const popup = mock(() => undefined);
  const menuTemplates: MenuItemConstructorOptions[][] = [];
  const menu = {
    buildFromTemplate: mock((template: MenuItemConstructorOptions[]) => {
      menuTemplates.push(template);
      return { popup };
    }),
  };
  const manager = new BrowserPreviewManager({
    WebContentsViewCtor: FakeView as never,
    browserSession: { id: "preview-session" } as never,
    menu,
    getWindow: () => window as never,
    emitState,
  });
  return { manager, views, contentView, emitState, menuTemplates, popup, window };
}

function createContextMenuParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "http://localhost:3000/",
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
  };
}

const input = {
  tabId: "browser-1",
  url: "http://localhost:3000/",
  bounds: { x: 20.4, y: 40.6, width: 800.2, height: 600.8 },
  visible: true,
};

describe("BrowserPreviewManager", () => {
  test("creates a sandboxed view in the dedicated session and attaches it to the window", async () => {
    const harness = createHarness();

    const state = await harness.manager.attach(input);
    const view = harness.views[0]!;

    expect(harness.views).toHaveLength(1);
    expect(view.options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: true,
        session: { id: "preview-session" },
      },
    });
    expect(harness.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.bounds).toEqual({ x: 20, y: 41, width: 800, height: 601 });
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledWith("http://localhost:3000/");
    expect(state).toMatchObject({ tabId: "browser-1", loading: true });
  });

  test("reuses a tab view, exposes native history, and opens DevTools only for that view", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const view = harness.views[0]!;
    view.webContents.canGoBackValue = true;
    view.webContents.canGoForwardValue = true;

    await harness.manager.attach({ ...input, bounds: { x: 1, y: 2, width: 3, height: 4 } });
    harness.manager.goBack(input.tabId);
    harness.manager.goForward(input.tabId);
    harness.manager.openDevTools(input.tabId);

    expect(harness.views).toHaveLength(1);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(view.webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(view.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
  });

  test("offers Interrogate and inspects the clicked element in that preview", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;

    contents.emit("context-menu", {}, createContextMenuParams({ x: 123, y: 456 }));

    const template = harness.menuTemplates[0]!;
    const interrogate = template.find((item) => item.label === "Interrogate");
    expect(interrogate).toBeDefined();
    expect(harness.popup).toHaveBeenCalledWith({ window: harness.window });

    interrogate?.click?.(undefined as never, undefined as never, undefined as never);

    expect(contents.inspectElement).toHaveBeenCalledWith(123, 456);
    expect(harness.views).toHaveLength(1);
  });

  test("blocks top-level navigation outside the preview scope", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const allowed = { url: "http://localhost:3000/dashboard", preventDefault: mock(() => undefined) };
    const blocked = { url: "https://example.com/collect", preventDefault: mock(() => undefined) };

    contents.emit("will-navigate", allowed);
    contents.emit("will-navigate", blocked);

    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1);
    await expect(harness.manager.navigate(input.tabId, "https://example.com/")).rejects.toThrow(
      "loopback or authenticated gateway-preview URL",
    );
  });

  test("accepts gateway-preview URLs and destroys owned webContents explicitly", async () => {
    const harness = createHarness();
    await harness.manager.attach({
      ...input,
      url: "https://desk.example/__orkestrator/browser/loopback/3000/",
    });
    const view = harness.views[0]!;

    harness.manager.destroy(input.tabId);

    expect(harness.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(view.webContents.destroyed).toBe(true);
  });
});
