import type { BrowserWindow, Session } from "electron";
import type { BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
import {
  BrowserPreviewManager,
  type BrowserPreviewManagerOptions,
} from "./browser-preview-manager.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";

const BROWSER_PREVIEW_PARTITION = "persist:orkestrator-browser-previews";

export interface InitializeBrowserPreviewsOptions {
  fromPartition: (partition: string) => Session;
  WebContentsViewCtor: BrowserPreviewManagerOptions["WebContentsViewCtor"];
  menu: BrowserPreviewManagerOptions["menu"];
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
  focusAddressBar: (tabId: string) => void;
  getAuthorization: (url: string) => string | null;
}

export interface BrowserPreviewRuntime {
  manager: BrowserPreviewManager;
  browserSession: Session;
}

export function initializeBrowserPreviews({
  fromPartition,
  WebContentsViewCtor,
  menu,
  getWindow,
  emitState,
  focusAddressBar,
  getAuthorization,
}: InitializeBrowserPreviewsOptions): BrowserPreviewRuntime {
  const browserSession = fromPartition(BROWSER_PREVIEW_PARTITION);
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const manager = new BrowserPreviewManager({
    WebContentsViewCtor,
    browserSession,
    menu,
    getWindow,
    emitState,
    focusAddressBar,
  });
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
    getManager()?.destroyAll();
    if (getCurrentWindow() === window) clearCurrentWindow();
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
  onActivate(() => {
    if (getWindowCount() !== 0) return;
    void createWindow().catch(onCreateError);
  });
}
