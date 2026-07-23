import type { BrowserWindow, Session } from "electron";
import type {
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import {
  BrowserPreviewManager,
  type BrowserPreviewManagerOptions,
} from "./browser-preview-manager.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";

const BROWSER_PREVIEW_PARTITION = "persist:orkestrator-browser-previews";
const CLIPBOARD_WRITE_PERMISSION = "clipboard-sanitized-write";

export interface InitializeBrowserPreviewsOptions {
  fromPartition: (partition: string) => Session;
  WebContentsViewCtor: BrowserPreviewManagerOptions["WebContentsViewCtor"];
  menu: BrowserPreviewManagerOptions["menu"];
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
  emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => void;
  openExternal: (url: string) => void;
  writeClipboardText: (text: string) => void;
  focusAddressBar: (tabId: string) => void;
  getAuthorization: (url: string) => string | null;
}

export interface BrowserPreviewRuntime {
  manager: BrowserPreviewManager;
  browserSession: Session;
}

export interface BrowserPreviewAddressFocusOptions {
  getWindow: () => BrowserWindow | null;
  emitFocus: (tabId: string) => void;
}

export function createBrowserPreviewAddressFocusHandler({
  getWindow,
  emitFocus,
}: BrowserPreviewAddressFocusOptions): (tabId: string) => void {
  return (tabId) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.focus();
    }
    emitFocus(tabId);
  };
}

export function initializeBrowserPreviews({
  fromPartition,
  WebContentsViewCtor,
  menu,
  getWindow,
  emitState,
  emitOpenLink,
  openExternal,
  writeClipboardText,
  focusAddressBar,
  getAuthorization,
}: InitializeBrowserPreviewsOptions): BrowserPreviewRuntime {
  const browserSession = fromPartition(BROWSER_PREVIEW_PARTITION);
  const manager = new BrowserPreviewManager({
    WebContentsViewCtor,
    browserSession,
    menu,
    getWindow,
    emitState,
    emitOpenLink,
    openExternal,
    writeClipboardText,
    focusAddressBar,
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        permission === CLIPBOARD_WRITE_PERMISSION
          && details.isMainFrame
          && manager.consumeClipboardWriteUserActivation(
            webContents,
            details.requestingUrl,
          ),
      );
    },
  );
  installRemoteGatewayRequestAuth(
    browserSession.webRequest,
    getAuthorization,
    { browserPreviewOnly: true },
  );
  return { manager, browserSession };
}

export interface BrowserPreviewWindowCleanupOptions {
  window: BrowserWindow;
  getManager: () => Pick<BrowserPreviewManager, "destroyAll"> | null;
  getCurrentWindow: () => BrowserWindow | null;
  clearCurrentWindow: () => void;
}

export function registerBrowserPreviewWindowCleanup({
  window,
  getManager,
  getCurrentWindow,
  clearCurrentWindow,
}: BrowserPreviewWindowCleanupOptions): void {
  window.once("closed", () => {
    try {
      getManager()?.destroyAll();
    } finally {
      if (getCurrentWindow() === window) clearCurrentWindow();
    }
  });
}

export interface BrowserPreviewWindowActivationOptions {
  onActivate: (listener: () => void) => void;
  getWindowCount: () => number;
  createWindow: () => Promise<void>;
  onCreateError: (error: unknown) => void;
}

export function registerBrowserPreviewWindowActivation({
  onActivate,
  getWindowCount,
  createWindow,
  onCreateError,
}: BrowserPreviewWindowActivationOptions): void {
  let windowCreation: Promise<void> | null = null;
  onActivate(() => {
    if (getWindowCount() !== 0 || windowCreation) return;
    const attempt = Promise.resolve().then(createWindow);
    windowCreation = attempt;
    void attempt
      .catch(onCreateError)
      .finally(() => {
        if (windowCreation === attempt) windowCreation = null;
      });
  });
}
