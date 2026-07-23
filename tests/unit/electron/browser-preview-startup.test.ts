import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";
import { BrowserPreviewManager } from "../../../apps/desktop/electron/browser-preview-manager";
import {
  createBrowserPreviewAddressFocusHandler,
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
  private visible = false;
  readonly setBackgroundColor = mock(() => undefined);
  readonly setBounds = mock((bounds: typeof this.bounds) => {
    this.bounds = bounds;
  });
  readonly getBounds = mock(() => this.bounds);
  readonly setVisible = mock((visible: boolean) => {
    this.visible = visible;
  });
  readonly getVisible = mock(() => this.visible);
}

describe("browser preview startup wiring", () => {
  test("focuses a live window and always emits the requested tab", () => {
    const focus = mock(() => undefined);
    const emitFocus = mock(() => undefined);
    let currentWindow: {
      isDestroyed: () => boolean;
      webContents: { focus: () => void };
    } | null = {
      isDestroyed: () => false,
      webContents: { focus },
    };
    const handleFocus = createBrowserPreviewAddressFocusHandler({
      getWindow: () => currentWindow as never,
      emitFocus,
    });

    handleFocus("browser-live");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(emitFocus).toHaveBeenLastCalledWith("browser-live");

    currentWindow = {
      isDestroyed: () => true,
      webContents: { focus },
    };
    handleFocus("browser-destroyed");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(emitFocus).toHaveBeenLastCalledWith("browser-destroyed");

    currentWindow = null;
    handleFocus("browser-missing");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(emitFocus).toHaveBeenLastCalledWith("browser-missing");
    expect(emitFocus).toHaveBeenCalledTimes(3);
  });

  test("requires scoped visible user activation, installs preview-only auth, and wires address focus", async () => {
    const createdViews: FakeWebContentsView[] = [];
    class CapturingFakeWebContentsView extends FakeWebContentsView {
      constructor() {
        super();
        createdViews.push(this);
      }
    }
    let permissionCheck:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
          details: { isMainFrame: boolean },
        ) => boolean)
      | null = null;
    let permissionRequest:
      | ((
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
          details: { isMainFrame: boolean; requestingUrl: string },
        ) => void)
      | null = null;
    let beforeHeaders:
      | ((details: any, callback: (response: any) => void) => void)
      | null = null;
    let receivedHeaders:
      | ((details: any, callback: (response: any) => void) => void)
      | null = null;
    const webRequest = {
      onBeforeSendHeaders: mock(
        (_filter: unknown, listener: typeof beforeHeaders) => {
          beforeHeaders = listener;
        },
      ),
      onHeadersReceived: mock(
        (_filter: unknown, listener: typeof receivedHeaders) => {
          receivedHeaders = listener;
        },
      ),
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
    const focusAddressBar = mock(() => undefined);

    const runtime = initializeBrowserPreviews({
      fromPartition: fromPartition as never,
      WebContentsViewCtor: CapturingFakeWebContentsView as never,
      menu: { buildFromTemplate: () => ({ popup: () => undefined }) } as never,
      getWindow: () => window as never,
      emitState,
      focusAddressBar,
      getAuthorization: (url) =>
        url.startsWith("https://desk.example/__orkestrator/")
          ? "Bearer test"
          : null,
    });

    expect(fromPartition).toHaveBeenCalledWith("persist:orkestrator-browser-previews");
    expect(runtime.browserSession).toBe(browserSession as never);
    expect(runtime.manager).toBeInstanceOf(BrowserPreviewManager);
    expect(
      permissionCheck?.(
        {},
        "clipboard-sanitized-write",
        "http://localhost:3000",
        { isMainFrame: true },
      ),
    ).toBe(false);
    expect(
      permissionCheck?.({}, "clipboard-read", "http://localhost:3000", {
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      permissionCheck?.(
        {},
        "clipboard-sanitized-write",
        "https://embedded.example",
        { isMainFrame: false },
      ),
    ).toBe(false);

    await runtime.manager.attach({
      tabId: "browser-1",
      url: "http://localhost:3000/",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      visible: true,
    });
    const previewView = addChildView.mock.calls[0]![0] as unknown as FakeWebContentsView;
    const previewContents = previewView.webContents;

    const ambientWriteResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      ambientWriteResult,
      {
        isMainFrame: true,
        requestingUrl: "http://localhost:3000/",
      },
    );
    expect(ambientWriteResult).toHaveBeenCalledWith(false);

    previewContents.emit("input-event", {}, { type: "mouseDown" });
    const activatedWriteResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      activatedWriteResult,
      {
        isMainFrame: true,
        requestingUrl: "http://localhost:3000/copy",
      },
    );
    expect(activatedWriteResult).toHaveBeenCalledWith(true);

    const reusedActivationResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      reusedActivationResult,
      {
        isMainFrame: true,
        requestingUrl: "http://localhost:3000/copy-again",
      },
    );
    expect(reusedActivationResult).toHaveBeenCalledWith(false);

    previewContents.emit("input-event", {}, { type: "keyDown" });
    runtime.manager.setVisible("browser-1", false);
    const hiddenWriteResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      hiddenWriteResult,
      {
        isMainFrame: true,
        requestingUrl: "http://localhost:3000/hidden",
      },
    );
    expect(hiddenWriteResult).toHaveBeenCalledWith(false);

    runtime.manager.setVisible("browser-1", true);
    previewContents.emit("input-event", {}, { type: "mouseDown" });
    const wrongScopeResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      wrongScopeResult,
      {
        isMainFrame: true,
        requestingUrl:
          "https://desk.example/__orkestrator/browser/loopback/3000/",
      },
    );
    expect(wrongScopeResult).toHaveBeenCalledWith(false);

    await runtime.manager.navigate(
      "browser-1",
      "https://desk.example/__orkestrator/browser/loopback/3000/",
    );
    previewContents.emit("input-event", {}, { type: "pointerDown" });
    const gatewayWriteResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      gatewayWriteResult,
      {
        isMainFrame: true,
        requestingUrl:
          "https://desk.example/__orkestrator/browser/loopback/3000/copy",
      },
    );
    expect(gatewayWriteResult).toHaveBeenCalledWith(true);

    const unrelatedPermissionResult = mock(() => undefined);
    permissionRequest?.(previewContents, "geolocation", unrelatedPermissionResult, {
      isMainFrame: true,
      requestingUrl: previewContents.getURL(),
    });
    expect(unrelatedPermissionResult).toHaveBeenCalledWith(false);

    const subframeClipboardWriteResult = mock(() => undefined);
    permissionRequest?.(
      previewContents,
      "clipboard-sanitized-write",
      subframeClipboardWriteResult,
      { isMainFrame: false, requestingUrl: previewContents.getURL() },
    );
    expect(subframeClipboardWriteResult).toHaveBeenCalledWith(false);

    const previewRequestResult = mock(() => undefined);
    beforeHeaders?.(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "mainFrame",
        requestHeaders: {},
      },
      previewRequestResult,
    );
    expect(previewRequestResult).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer test",
        Origin: "https://orkestrator.dev",
      },
    });

    const privilegedRequestResult = mock(() => undefined);
    beforeHeaders?.(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "mainFrame",
        requestHeaders: {
          Authorization: "Bearer ambient",
          Cookie: "gateway=ambient",
        },
      },
      privilegedRequestResult,
    );
    expect(privilegedRequestResult).toHaveBeenCalledWith({
      requestHeaders: {},
    });

    const previewResponseResult = mock(() => undefined);
    receivedHeaders?.(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "mainFrame",
        responseHeaders: {
          "Access-Control-Allow-Origin": ["https://desk.example"],
        },
      },
      previewResponseResult,
    );
    expect(previewResponseResult).toHaveBeenCalledWith({
      responseHeaders: { "Access-Control-Allow-Origin": ["*"] },
    });

    expect(addChildView).toHaveBeenCalledTimes(1);
    expect(emitState).toHaveBeenCalledWith(expect.objectContaining({ tabId: "browser-1" }));

    const inputEvent = { preventDefault: mock(() => undefined) };
    createdViews[0]?.webContents.emit("before-input-event", inputEvent, {
      type: "keyDown",
      key: "l",
      meta: true,
      control: false,
      alt: false,
      shift: false,
    });
    expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusAddressBar).toHaveBeenCalledTimes(1);
    expect(focusAddressBar).toHaveBeenCalledWith("browser-1");
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

    const throwingWindow = new EventEmitter();
    const teardownFailure = new Error("preview teardown failed");
    const throwingDestroyAll = mock(() => {
      throw teardownFailure;
    });
    const clearThrowingWindow = mock(() => {
      currentWindow = null;
    });
    currentWindow = throwingWindow;
    registerBrowserPreviewWindowCleanup({
      window: throwingWindow as never,
      getManager: () => ({ destroyAll: throwingDestroyAll }),
      getCurrentWindow: () => currentWindow as never,
      clearCurrentWindow: clearThrowingWindow,
    });

    expect(() => throwingWindow.emit("closed")).toThrow(teardownFailure);
    expect(throwingDestroyAll).toHaveBeenCalledTimes(1);
    expect(clearThrowingWindow).toHaveBeenCalledTimes(1);
    expect(currentWindow).toBeNull();
    throwingWindow.emit("closed");
    expect(throwingDestroyAll).toHaveBeenCalledTimes(1);
  });

  test("single-flights missing-window recreation and reports retry failures", async () => {
    let activate: (() => void) | null = null;
    let windowCount = 1;
    let resolveCreation!: () => void;
    const createWindow = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveCreation = resolve;
        }),
    );
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
    activate?.();
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(onCreateError).not.toHaveBeenCalled();
    activate?.();
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledTimes(1);

    resolveCreation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failure = new Error("window unavailable");
    createWindow.mockImplementationOnce(async () => {
      throw failure;
    });
    activate?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCreateError).toHaveBeenCalledWith(failure);
  });
});
