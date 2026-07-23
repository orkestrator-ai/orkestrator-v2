import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import { BrowserPreviewManager } from "../../../apps/desktop/electron/browser-preview-manager";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

class FakeWebContents extends EventEmitter {
  currentUrl = "";
  destroyed = false;
  canGoBackValue = false;
  canGoForwardValue = false;
  activeIndex = 0;
  historyEntries: Array<{ title: string; url: string }> = [];
  loadURLImplementation: (url: string) => Promise<void> = async () => undefined;
  readonly loadURL = mock((url: string) => {
    this.currentUrl = url;
    return this.loadURLImplementation(url);
  });
  readonly reload = mock(() => undefined);
  readonly openDevTools = mock(() => undefined);
  readonly inspectElement = mock(() => undefined);
  readonly setWindowOpenHandler = mock((_handler: unknown) => undefined);
  readonly close = mock(() => {
    this.destroyed = true;
  });
  readonly navigationHistory = {
    canGoBack: mock(() => this.canGoBackValue),
    canGoForward: mock(() => this.canGoForwardValue),
    getActiveIndex: mock(() => this.activeIndex),
    getEntryAtIndex: mock((index: number) => this.historyEntries[index]),
    goBack: mock(() => {
      this.activeIndex -= 1;
    }),
    goForward: mock(() => {
      this.activeIndex += 1;
    }),
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
  let windowAvailable = true;
  let windowDestroyed = false;
  const window = { isDestroyed: () => windowDestroyed, contentView };
  const emitState = mock(() => undefined);
  const emitOpenLink = mock(() => undefined);
  const openExternal = mock(() => undefined);
  const writeClipboardText = mock(() => undefined);
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
    getWindow: () => (windowAvailable ? (window as never) : null),
    emitState,
    emitOpenLink,
    openExternal,
    writeClipboardText,
  });
  return {
    manager,
    views,
    contentView,
    emitState,
    emitOpenLink,
    openExternal,
    writeClipboardText,
    menuTemplates,
    popup,
    window,
    setWindowAvailable(value: boolean) {
      windowAvailable = value;
    },
    setWindowDestroyed(value: boolean) {
      windowDestroyed = value;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
    const windowOpenHandler = view.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => {
      action: string;
    };
    expect(windowOpenHandler()).toEqual({ action: "deny" });
  });

  test("reuses a tab view, exposes native history, and opens DevTools only for that view", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const view = harness.views[0]!;
    view.webContents.canGoBackValue = true;
    view.webContents.canGoForwardValue = true;
    view.webContents.activeIndex = 1;
    view.webContents.historyEntries = [
      { title: "Previous", url: "http://localhost:3000/previous" },
      { title: "Current", url: input.url },
      { title: "Next", url: "http://localhost:3000/next" },
    ];

    await harness.manager.attach({
      ...input,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    harness.manager.goBack(input.tabId);
    view.webContents.activeIndex = 1;
    harness.manager.goForward(input.tabId);
    harness.manager.openDevTools(input.tabId);

    expect(harness.views).toHaveLength(1);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(view.webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(view.webContents.openDevTools).toHaveBeenCalledWith({
      mode: "detach",
    });
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

  test("offers link actions that open a preview tab, the external browser, and the clipboard", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const linkURL = "http://localhost:3000/docs?q=1#intro";

    contents.emit("context-menu", {}, createContextMenuParams({ linkURL }));

    const template = harness.menuTemplates[0]!;
    expect(template.slice(0, 3).map((item) => item.label)).toEqual([
      "Open Link in New Tab",
      "Open in External Browser",
      "Copy Link Address",
    ]);
    const openInTab = template.find((item) => item.label === "Open Link in New Tab");
    const openExternal = template.find((item) => item.label === "Open in External Browser");
    const copy = template.find((item) => item.label === "Copy Link Address");

    openInTab?.click?.(undefined as never, undefined as never, undefined as never);
    openExternal?.click?.(undefined as never, undefined as never, undefined as never);
    copy?.click?.(undefined as never, undefined as never, undefined as never);

    expect(harness.emitOpenLink).toHaveBeenCalledWith({
      tabId: input.tabId,
      url: linkURL,
    });
    expect(harness.openExternal).toHaveBeenCalledWith(linkURL);
    expect(harness.writeClipboardText).toHaveBeenCalledWith(linkURL);
  });

  test("maps gateway preview links back to backend-local addresses for new tabs", async () => {
    const harness = createHarness();
    await harness.manager.attach({
      ...input,
      url: "https://desk.example/__orkestrator/browser/loopback/3000/",
    });
    const contents = harness.views[0]!.webContents;
    const linkURL = "https://desk.example/__orkestrator/browser/loopback/3000/docs?q=1#intro";

    contents.emit("context-menu", {}, createContextMenuParams({ linkURL }));
    const openInTab = harness.menuTemplates[0]!.find(
      (item) => item.label === "Open Link in New Tab",
    );
    openInTab?.click?.(undefined as never, undefined as never, undefined as never);

    expect(harness.emitOpenLink).toHaveBeenCalledWith({
      tabId: input.tabId,
      url: "http://localhost:3000/docs?q=1#intro",
    });
  });

  test("keeps link actions visible but disables unsafe or unsupported navigation", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;

    contents.emit("context-menu", {}, createContextMenuParams({ linkURL: "javascript:alert(1)" }));

    const template = harness.menuTemplates[0]!;
    expect(template.find((item) => item.label === "Open Link in New Tab")?.enabled).toBe(false);
    expect(template.find((item) => item.label === "Open in External Browser")?.enabled).toBe(false);
    template.find((item) => item.label === "Copy Link Address")
      ?.click?.(undefined as never, undefined as never, undefined as never);

    expect(harness.emitOpenLink).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.writeClipboardText).toHaveBeenCalledWith("javascript:alert(1)");
  });

  test("blocks top-level navigation outside the preview scope", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const allowed = {
      url: "http://localhost:3000/dashboard",
      preventDefault: mock(() => undefined),
    };
    const blocked = {
      url: "https://example.com/collect",
      preventDefault: mock(() => undefined),
    };

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
    expect(view.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(view.webContents.destroyed).toBe(true);
  });

  test("rejects invalid tab IDs, URLs, and non-finite bounds", async () => {
    for (const tabId of ["", "x".repeat(257), 42] as unknown[]) {
      const harness = createHarness();
      await expect(harness.manager.attach({ ...input, tabId: tabId as string })).rejects.toThrow(
        "browser preview tab ID",
      );
    }

    for (const url of [
      "not a URL",
      "https://localhost:3000/",
      "ftp://localhost:3000/",
      "https://desk.example/__orkestrator/browser/loopback/0000/",
    ]) {
      const harness = createHarness();
      await expect(harness.manager.attach({ ...input, url })).rejects.toThrow(
        "loopback or authenticated gateway-preview URL",
      );
    }

    const harness = createHarness();
    await expect(
      harness.manager.attach({
        ...input,
        bounds: { ...input.bounds, width: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toThrow("finite browser preview bounds");
  });

  test("normalizes bounds, hides zero-area previews, and reuses or reloads attached URLs", async () => {
    const harness = createHarness();
    await harness.manager.attach({
      ...input,
      bounds: { x: -10.7, y: -1, width: 0.4, height: -20 },
    });
    const view = harness.views[0]!;

    expect(view.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(view.visible).toBe(false);

    await harness.manager.attach({
      ...input,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(view.visible).toBe(true);

    const changed = await harness.manager.attach({
      ...input,
      url: "http://127.0.0.1:4000/next",
      visible: false,
    });
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith("http://127.0.0.1:4000/next");
    expect(changed.url).toBe("http://127.0.0.1:4000/next");
    expect(view.visible).toBe(false);
  });

  test("updates bounds and visibility and returns null for visibility of a missing preview", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const view = harness.views[0]!;

    const bounded = harness.manager.setBounds(input.tabId, {
      x: 1.2,
      y: 2.7,
      width: 4.5,
      height: 5.4,
    });
    expect(view.bounds).toEqual({ x: 1, y: 3, width: 5, height: 5 });
    expect(bounded.tabId).toBe(input.tabId);
    expect(() =>
      harness.manager.setBounds(input.tabId, {
        ...input.bounds,
        height: Number.NaN,
      }),
    ).toThrow("finite browser preview bounds");

    view.bounds = { x: 0, y: 0, width: 0, height: 10 };
    expect(harness.manager.setVisible(input.tabId, true)?.loading).toBe(true);
    expect(view.visible).toBe(false);
    expect(harness.manager.setVisible("missing", false)).toBeNull();
    expect(() => harness.manager.setVisible("", true)).toThrow("browser preview tab ID");
  });

  test("throws consistently for operations on missing previews", async () => {
    const harness = createHarness();

    expect(() => harness.manager.setBounds("missing", input.bounds)).toThrow("is not attached");
    await expect(harness.manager.navigate("missing", input.url)).rejects.toThrow("is not attached");
    expect(() => harness.manager.goBack("missing")).toThrow("is not attached");
    expect(() => harness.manager.goForward("missing")).toThrow("is not attached");
    expect(() => harness.manager.reload("missing")).toThrow("is not attached");
    expect(() => harness.manager.openDevTools("missing")).toThrow("is not attached");
  });

  test("reload clears errors and history-disabled actions are no-ops", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    contents.emit("did-fail-load", {}, -2, "Connection failed", input.url, true);

    const back = harness.manager.goBack(input.tabId);
    const forward = harness.manager.goForward(input.tabId);
    const reloaded = harness.manager.reload(input.tabId);

    expect(contents.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(contents.navigationHistory.goForward).not.toHaveBeenCalled();
    expect(back.error).toBe("Connection failed");
    expect(forward.error).toBe("Connection failed");
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(reloaded.error).toBeNull();
  });

  test("authorizes validated back and forward destinations across preview scopes", async () => {
    const harness = createHarness();
    await harness.manager.attach({
      ...input,
      url: "http://localhost:4000/current",
    });
    const contents = harness.views[0]!.webContents;
    contents.canGoBackValue = true;
    contents.canGoForwardValue = true;
    contents.activeIndex = 1;
    contents.historyEntries = [
      { title: "Port 3000", url: "http://localhost:3000/previous" },
      { title: "Port 4000", url: "http://localhost:4000/current" },
      {
        title: "Gateway 5000",
        url: "https://desk.example/__orkestrator/browser/loopback/5000/next",
      },
    ];

    harness.manager.goBack(input.tabId);
    contents.currentUrl = contents.historyEntries[0]!.url;
    contents.emit("did-navigate", {}, contents.currentUrl);
    const backAllowed = {
      url: "http://localhost:3000/dashboard",
      preventDefault: mock(() => undefined),
    };
    const oldScopeBlocked = {
      url: "http://localhost:4000/dashboard",
      preventDefault: mock(() => undefined),
    };
    contents.emit("will-navigate", backAllowed);
    contents.emit("will-navigate", oldScopeBlocked);
    expect(backAllowed.preventDefault).not.toHaveBeenCalled();
    expect(oldScopeBlocked.preventDefault).toHaveBeenCalledTimes(1);

    contents.activeIndex = 1;
    harness.manager.goForward(input.tabId);
    contents.currentUrl = contents.historyEntries[2]!.url;
    contents.emit("did-navigate", {}, contents.currentUrl);
    const gatewayAllowed = {
      url: "https://desk.example/__orkestrator/browser/loopback/5000/dashboard",
      preventDefault: mock(() => undefined),
    };
    contents.emit("will-navigate", gatewayAllowed);
    expect(gatewayAllowed.preventDefault).not.toHaveBeenCalled();
  });

  test("blocks invalid history destinations without invoking Chromium navigation", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    contents.canGoBackValue = true;
    contents.activeIndex = 1;
    contents.historyEntries = [
      { title: "External", url: "https://example.com/" },
      { title: "Current", url: input.url },
    ];

    const state = harness.manager.goBack(input.tabId);

    expect(contents.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(state.error).toBe("Blocked browser history navigation outside preview scope");
  });

  test("prevents out-of-scope main-frame redirects but ignores subframe redirects", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const allowed = {
      url: "http://localhost:3000/redirected",
      isMainFrame: true,
      preventDefault: mock(() => undefined),
    };
    const blocked = {
      url: "http://localhost:4000/redirected",
      isMainFrame: true,
      preventDefault: mock(() => undefined),
    };
    const subframe = {
      url: "https://example.com/frame",
      isMainFrame: false,
      preventDefault: mock(() => undefined),
    };

    contents.emit("will-redirect", allowed);
    contents.emit("will-redirect", blocked);
    contents.emit("will-redirect", subframe);

    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1);
    expect(subframe.preventDefault).not.toHaveBeenCalled();
  });

  test("publishes loading, committed navigation, and in-page navigation state", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    contents.emit("did-fail-load", {}, -2, "Old failure", input.url, true);
    harness.emitState.mockClear();

    contents.emit("did-start-loading");
    expect(harness.emitState).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true, error: null }));
    contents.emit("did-stop-loading");
    expect(harness.emitState).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false }));

    contents.currentUrl = "http://localhost:3000/committed";
    contents.emit("did-navigate", {}, contents.currentUrl);
    expect(harness.emitState).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "http://localhost:3000/committed" }),
    );

    harness.emitState.mockClear();
    contents.currentUrl = "http://localhost:3000/committed#section";
    contents.emit("did-navigate-in-page", {}, contents.currentUrl, false);
    expect(harness.emitState).not.toHaveBeenCalled();
    contents.emit("did-navigate-in-page", {}, contents.currentUrl, true);
    expect(harness.emitState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "http://localhost:3000/committed#section",
      }),
    );
  });

  test("does not accept committed or in-page URLs outside the authorized scope", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;

    contents.currentUrl = "https://example.com/committed";
    contents.emit("did-navigate", {}, contents.currentUrl);
    contents.emit("did-navigate-in-page", {}, contents.currentUrl, true);

    expect(harness.emitState).toHaveBeenLastCalledWith(expect.objectContaining({ url: contents.currentUrl }));
    const pageAttempt = {
      url: "http://localhost:4000/escape",
      preventDefault: mock(() => undefined),
    };
    contents.emit("will-navigate", pageAttempt);
    expect(pageAttempt.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("handles load failures, cancellation, and renderer termination events", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    harness.emitState.mockClear();

    contents.emit("did-fail-load", {}, -2, "Connection refused", input.url, false);
    contents.emit("did-fail-load", {}, -3, "Aborted", input.url, true);
    expect(harness.emitState).not.toHaveBeenCalled();

    contents.emit("did-fail-load", {}, -2, "Connection refused", input.url, true);
    expect(harness.emitState).toHaveBeenLastCalledWith(
      expect.objectContaining({ loading: false, error: "Connection refused" }),
    );

    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(harness.emitState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        loading: false,
        error: "Preview renderer stopped (crashed)",
      }),
    );
  });

  test("records current loadURL errors including Error and non-Error rejections", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    contents.loadURLImplementation = async () => {
      throw new Error("connection failed");
    };

    const errorState = await harness.manager.navigate(input.tabId, "http://localhost:3000/error");
    expect(errorState).toMatchObject({
      loading: false,
      error: "connection failed",
    });

    contents.loadURLImplementation = async () => {
      throw "plain failure";
    };

    const state = await harness.manager.navigate(input.tabId, "http://localhost:3000/failure");

    expect(state).toMatchObject({ loading: false, error: "plain failure" });
    expect(harness.emitState).toHaveBeenLastCalledWith(expect.objectContaining({ error: "plain failure" }));
  });

  test("ignores errors from superseded loads", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const first = deferred();
    const second = deferred();
    contents.loadURLImplementation = (url) => (url.endsWith("/first") ? first.promise : second.promise);

    const firstNavigation = harness.manager.navigate(input.tabId, "http://localhost:3000/first");
    const secondNavigation = harness.manager.navigate(input.tabId, "http://localhost:3000/second");
    first.reject(new Error("ERR_ABORTED (-3)"));
    await flushPromises();

    expect(harness.emitState).not.toHaveBeenLastCalledWith(expect.objectContaining({ error: "ERR_ABORTED (-3)" }));
    second.resolve();
    const [firstState, secondState] = await Promise.all([firstNavigation, secondNavigation]);
    expect(firstState.error).toBeNull();
    expect(secondState.error).toBeNull();
    expect(secondState.url).toBe("http://localhost:3000/second");
  });

  test("ignores a load rejection after its preview is destroyed", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const pending = deferred();
    contents.loadURLImplementation = () => pending.promise;
    const navigation = harness.manager.navigate(input.tabId, "http://localhost:3000/pending");
    harness.manager.destroy(input.tabId);
    harness.emitState.mockClear();

    pending.reject(new Error("late failure"));
    await navigation;

    expect(harness.emitState).not.toHaveBeenCalled();
  });

  test("ignores a load rejection after webContents is destroyed", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    const pending = deferred();
    contents.loadURLImplementation = () => pending.promise;
    const navigation = harness.manager.navigate(input.tabId, "http://localhost:3000/pending");
    contents.destroyed = true;
    harness.emitState.mockClear();

    pending.reject(new Error("late failure"));
    const state = await navigation;

    expect(harness.emitState).not.toHaveBeenCalled();
    expect(state.url).toBe("");
  });

  test("suppresses context menus without a usable window and ignores inspect after destruction", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const contents = harness.views[0]!.webContents;
    harness.setWindowAvailable(false);
    contents.emit("context-menu", {}, createContextMenuParams());
    expect(harness.menuTemplates).toHaveLength(0);

    harness.setWindowAvailable(true);
    contents.emit("context-menu", {}, createContextMenuParams());
    const interrogate = harness.menuTemplates[0]!.find((item) => item.label === "Interrogate");
    contents.destroyed = true;
    interrogate?.click?.(undefined as never, undefined as never, undefined as never);
    expect(contents.inspectElement).not.toHaveBeenCalled();
  });

  test("requires a usable window when creating a preview", async () => {
    const unavailable = createHarness();
    unavailable.setWindowAvailable(false);
    await expect(unavailable.manager.attach(input)).rejects.toThrow("main window is not available");

    const destroyed = createHarness();
    destroyed.setWindowDestroyed(true);
    await expect(destroyed.manager.attach(input)).rejects.toThrow("main window is not available");
  });

  test("destroy is idempotent and handles destroyed windows and webContents", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    const first = harness.views[0]!;
    harness.setWindowDestroyed(true);
    first.webContents.destroyed = true;

    harness.manager.destroy(input.tabId);
    harness.manager.destroy(input.tabId);

    expect(harness.contentView.removeChildView).not.toHaveBeenCalled();
    expect(first.webContents.close).not.toHaveBeenCalled();
    expect(() => harness.manager.destroy("")).toThrow("browser preview tab ID");
  });

  test("destroyAll closes every remaining preview and destroyed snapshots are inert", async () => {
    const harness = createHarness();
    await harness.manager.attach(input);
    await harness.manager.attach({
      ...input,
      tabId: "browser-2",
      url: "http://127.0.0.1:4000/",
    });
    const first = harness.views[0]!;
    const second = harness.views[1]!;
    first.webContents.destroyed = true;

    const destroyedState = harness.manager.setVisible(input.tabId, true);
    expect(destroyedState).toEqual({
      tabId: input.tabId,
      url: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      error: null,
    });

    harness.manager.destroyAll();
    expect(harness.contentView.removeChildView).toHaveBeenCalledTimes(2);
    expect(first.webContents.close).not.toHaveBeenCalled();
    expect(second.webContents.close).toHaveBeenCalledTimes(1);
  });
});
