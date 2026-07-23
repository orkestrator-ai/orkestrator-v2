import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import { BrowserPreviewManager } from "../../../apps/desktop/electron/browser-preview-manager";
import {
  initializeBrowserPreviews,
  registerBrowserPreviewWindowActivation,
  registerBrowserPreviewWindowCleanup,
} from "../../../apps/desktop/electron/browser-preview-startup";

class FakeWebContents extends EventEmitter {
  readonly id = 17;
  private url = "";
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    getActiveIndex: () => 0,
    getEntryAtIndex: () => ({ url: this.url, title: "", pageState: "" }),
    goBack: mock(() => undefined),
    goForward: mock(() => undefined),
  };
  readonly setWindowOpenHandler = mock(() => undefined);
  readonly loadURL = mock(async (url: string) => {
    this.url = url;
  });
  readonly reload = mock(() => undefined);
  readonly openDevTools = mock(() => undefined);
  readonly inspectElement = mock(() => undefined);
  readonly close = mock(() => undefined);
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return false;
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly setBackgroundColor = mock(() => undefined);
  readonly setBounds = mock((bounds: typeof this.bounds) => {
    this.bounds = bounds;
  });
  readonly getBounds = mock(() => this.bounds);
  readonly setVisible = mock(() => undefined);
}

describe("browser preview startup wiring", () => {
  test("creates the dedicated locked-down session, auth hooks, manager, and state bridge", async () => {
    let permissionCheck: ((...args: unknown[]) => boolean) | null = null;
    let permissionRequest: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null = null;
    const webRequest = {
      onBeforeSendHeaders: mock(() => undefined),
      onHeadersReceived: mock(() => undefined),
    };
    const browserSession = {
      webRequest,
      setPermissionCheckHandler: mock((handler: typeof permissionCheck) => {
        permissionCheck = handler;
      }),
      setPermissionRequestHandler: mock((handler: typeof permissionRequest) => {
        permissionRequest = handler;
      }),
    };
    const fromPartition = mock(() => browserSession);
    const addChildView = mock(() => undefined);
    const window = {
      isDestroyed: () => false,
      contentView: { addChildView, removeChildView: mock(() => undefined) },
    };
    const emitState = mock(() => undefined);
    const emitOpenLink = mock(() => undefined);
    const openExternal = mock(() => undefined);
    const writeClipboardText = mock(() => undefined);

    const runtime = initializeBrowserPreviews({
      fromPartition: fromPartition as never,
      WebContentsViewCtor: FakeWebContentsView as never,
      menu: { buildFromTemplate: () => ({ popup: () => undefined }) } as never,
      getWindow: () => window as never,
      emitState,
      emitOpenLink,
      openExternal,
      writeClipboardText,
      getAuthorization: () => "Bearer test",
    });

    expect(fromPartition).toHaveBeenCalledWith("persist:orkestrator-browser-previews");
    expect(runtime.browserSession).toBe(browserSession as never);
    expect(runtime.manager).toBeInstanceOf(BrowserPreviewManager);
    expect(permissionCheck?.()).toBe(false);
    const permissionResult = mock(() => undefined);
    permissionRequest?.({}, "geolocation", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
    expect(webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);

    await runtime.manager.attach({
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      visible: true,
    });
    expect(addChildView).toHaveBeenCalledTimes(1);
    expect(emitState).toHaveBeenCalledWith(expect.objectContaining({ tabId: "browser-1" }));
  });

  test("destroys previews on close and only clears the window that actually closed", () => {
    const closedWindow = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] };
    const newerWindow = new EventEmitter();
    const destroyAll = mock(() => undefined);
    let currentWindow: unknown = closedWindow;
    const clearCurrentWindow = mock(() => {
      currentWindow = null;
    });

    registerBrowserPreviewWindowCleanup({
      window: closedWindow as never,
      getManager: () => ({ destroyAll }),
      getCurrentWindow: () => currentWindow as never,
      clearCurrentWindow,
    });
    closedWindow.emit("closed");
    expect(destroyAll).toHaveBeenCalledTimes(1);
    expect(clearCurrentWindow).toHaveBeenCalledTimes(1);

    const staleWindow = new EventEmitter();
    currentWindow = newerWindow;
    registerBrowserPreviewWindowCleanup({
      window: staleWindow as never,
      getManager: () => null,
      getCurrentWindow: () => currentWindow as never,
      clearCurrentWindow,
    });
    staleWindow.emit("closed");
    expect(clearCurrentWindow).toHaveBeenCalledTimes(1);
    expect(currentWindow).toBe(newerWindow);
  });

  test("recreates a missing window on activation and reports recreation failures", async () => {
    let activate: (() => void) | null = null;
    let windowCount = 1;
    const createWindow = mock(async () => undefined);
    const onCreateError = mock(() => undefined);
    registerBrowserPreviewWindowActivation({
      onActivate: (listener) => {
        activate = listener;
      },
      getWindowCount: () => windowCount,
      createWindow,
      onCreateError,
    });

    activate?.();
    expect(createWindow).not.toHaveBeenCalled();

    windowCount = 0;
    activate?.();
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(onCreateError).not.toHaveBeenCalled();

    const failure = new Error("window unavailable");
    createWindow.mockImplementationOnce(async () => {
      throw failure;
    });
    activate?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreateError).toHaveBeenCalledWith(failure);
  });
});
