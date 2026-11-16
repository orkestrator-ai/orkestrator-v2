import type { AppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";
import type { BrowserWindow, Session } from "electron";
import type {
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";
import {
  BrowserPreviewManager,
  type BrowserPreviewManagerOptions,
} from "./browser-preview-manager.js";

const CLIPBOARD_WRITE_PERMISSION = "clipboard-sanitized-write";

export interface InitializeBrowserPreviewsOptions {
  WebContentsViewCtor: BrowserPreviewManagerOptions["WebContentsViewCtor"];
  menu: BrowserPreviewManagerOptions["menu"];
  getWindow: () => BrowserWindow | null;
  emitState: (state: BrowserPreviewState) => void;
  emitOpenLink: (event: BrowserPreviewOpenLinkEvent) => void;
  openExternal: (url: string) => Promise<void> | void;
  writeClipboardText: (text: string) => void;
  focusAddressBar: (tabId: string) => void;
  requestPreviewShortcut: (tabId: string, shortcut: AppShortcutId) => void;
  transport?: BrowserPreviewManagerOptions["transport"];
  openServiceExternally?: BrowserPreviewManagerOptions["openServiceExternally"];
  captureStore?: BrowserPreviewManagerOptions["captureStore"];
  emitCaptureEvent?: BrowserPreviewManagerOptions["emitCaptureEvent"];
  nativeImage?: BrowserPreviewManagerOptions["nativeImage"];
}

export interface BrowserPreviewRuntime {
  manager: BrowserPreviewManager;
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

/**
 * A window runtime's preview manager. Every view is a service preview on its
 * service's own partition (`configurePreviewServiceSession`); no view loads
 * the gateway or uses a shared partition.
 */
export function initializeBrowserPreviews({
  WebContentsViewCtor,
  menu,
  getWindow,
  emitState,
  emitOpenLink,
  openExternal,
  writeClipboardText,
  focusAddressBar,
  requestPreviewShortcut,
  transport,
  openServiceExternally,
  captureStore,
  emitCaptureEvent,
  nativeImage,
}: InitializeBrowserPreviewsOptions): BrowserPreviewRuntime {
  const manager = new BrowserPreviewManager({
    WebContentsViewCtor,
    menu,
    getWindow,
    emitState,
    emitOpenLink,
    openExternal,
    writeClipboardText,
    focusAddressBar,
    requestPreviewShortcut,
    ...(transport ? { transport } : {}),
    ...(openServiceExternally ? { openServiceExternally } : {}),
    ...(captureStore ? { captureStore } : {}),
    ...(emitCaptureEvent ? { emitCaptureEvent } : {}),
    ...(nativeImage ? { nativeImage } : {}),
  });
  return { manager };
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
