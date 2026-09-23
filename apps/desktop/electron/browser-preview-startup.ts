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
  partition?: string;
  WebContentsViewCtor: BrowserPreviewManagerOptions["WebContentsViewCtor"];
  menu: BrowserPreviewManagerOptions["menu"];
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
  emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => void;
  openExternal: (url: string) => void;
  writeClipboardText: (text: string) => void;
  focusAddressBar: (tabId: string) => void;
  getAuthorization: (url: string) => string | null;
  transport?: BrowserPreviewManagerOptions["transport"];
  openServiceExternally?: BrowserPreviewManagerOptions["openServiceExternally"];
}

export interface BrowserPreviewRuntime {
  manager: BrowserPreviewManager;
  browserSession: Session;
}

/**
 * Apply the preview permission policy to a service partition: deny every
 * permission except a user-activated clipboard write inside the preview's own
 * scope. Request hooks are installed separately by the transport manager.
 *
 * Partitions outlive a window runtime (the same slot, connection, and service
 * map to the same session after a connection switch or window reopen), so the
 * handlers are replaced on every call and always consult the latest manager.
 */
export function configurePreviewServiceSession(
  serviceSession: Session,
  getManager: () => Pick<BrowserPreviewManager, "consumeClipboardWriteUserActivation"> | null,
): Session {
  serviceSession.setPermissionCheckHandler(() => false);
  serviceSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const manager = getManager();
    callback(
      Boolean(manager) &&
        permission === CLIPBOARD_WRITE_PERMISSION &&
        details.isMainFrame &&
        manager!.consumeClipboardWriteUserActivation(webContents, details.requestingUrl),
    );
  });
  return serviceSession;
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
  partition = BROWSER_PREVIEW_PARTITION,
  WebContentsViewCtor,
  menu,
  getWindow,
  emitState,
  emitOpenLink,
  openExternal,
  writeClipboardText,
  focusAddressBar,
  getAuthorization,
  transport,
  openServiceExternally,
}: InitializeBrowserPreviewsOptions): BrowserPreviewRuntime {
  const browserSession = fromPartition(partition);
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
    ...(transport ? { transport } : {}),
    ...(openServiceExternally ? { openServiceExternally } : {}),
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      permission === CLIPBOARD_WRITE_PERMISSION &&
        details.isMainFrame &&
        manager.consumeClipboardWriteUserActivation(webContents, details.requestingUrl),
    );
  });
  installRemoteGatewayRequestAuth(browserSession.webRequest, getAuthorization, {
    browserPreviewOnly: true,
  });
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
  /** Runs before window-count and in-flight checks; true consumes the reopen. */
  handleActivate?: () => boolean;
  getWindowCount: () => number;
  createWindow: () => Promise<void>;
  onCreateError: (error: unknown) => void;
}

export function registerBrowserPreviewWindowActivation({
  onActivate,
  handleActivate,
  getWindowCount,
  createWindow,
  onCreateError,
}: BrowserPreviewWindowActivationOptions): void {
  let windowCreation: Promise<void> | null = null;
  onActivate(() => {
    if (handleActivate?.()) return;
    if (getWindowCount() !== 0 || windowCreation) return;
    const attempt = Promise.resolve().then(createWindow);
    windowCreation = attempt;
    void attempt.catch(onCreateError).finally(() => {
      if (windowCreation === attempt) windowCreation = null;
    });
  });
}
