import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_NAME } from "./app-constants.js";
import { installDefaultContextMenu } from "./context-menu.js";
import { resolveRendererIndexPath } from "./paths.js";
import { desktopTitleBarStyle } from "./title-bar-inset.js";
import { installRendererDiagnostics } from "./renderer-diagnostics.js";
import { installRendererPermissionPolicy } from "./renderer-permissions.js";
import { installRendererRecovery } from "./renderer-recovery.js";
import { isTrustedRendererUrl } from "./trusted-renderer-url.js";

export { isTrustedRendererUrl };

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow;
type ContextMenuMenu = Parameters<typeof installDefaultContextMenu>[1];

export type CreateMainWindowOptions = {
  BrowserWindowCtor: BrowserWindowConstructor;
  menu: ContextMenuMenu;
  writeClipboardText: (text: string) => void;
  dirname: string;
  isDev: boolean;
  appPath: string;
  rendererRoot?: string;
  devServerUrl?: string;
  title?: string;
  partition?: string;
  beforeLoad?: (window: BrowserWindow) => void | Promise<void>;
  platform?: NodeJS.Platform;
};

type GuardedWebContents = {
  on(
    event: "will-navigate" | "will-frame-navigate" | "will-redirect",
    listener: (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => void,
  ): unknown;
};

export function trustedRendererUrlFor(options: {
  isDev: boolean;
  devServerUrl?: string;
  rendererIndexPath: string;
}): string {
  return options.isDev
    ? (options.devServerUrl ?? "http://127.0.0.1:1420")
    : pathToFileURL(options.rendererIndexPath).href;
}

/**
 * The renderer only ever navigates within itself, and no subframe may load
 * the renderer. Shared by main windows and backend-scoped panel views.
 */
export function installRendererNavigationGuards(
  webContents: GuardedWebContents,
  trustedRendererUrl: string,
): void {
  webContents.on("will-navigate", (event) => {
    if (!isTrustedRendererUrl(event.url, trustedRendererUrl)) {
      event.preventDefault();
    }
  });
  const preventPreviewNavigationToRenderer = (event: {
    url: string;
    isMainFrame: boolean;
    preventDefault(): void;
  }) => {
    // Direct browser previews preserve their loopback origin so development
    // apps behave like they do in a standalone browser. Never let a subframe
    // navigate onto the renderer itself, where it would become same-origin
    // with the parent and gain access to the app's privileged bridge.
    if (!event.isMainFrame && isTrustedRendererUrl(event.url, trustedRendererUrl)) {
      event.preventDefault();
    }
  };
  webContents.on("will-frame-navigate", preventPreviewNavigationToRenderer);
  webContents.on("will-redirect", preventPreviewNavigationToRenderer);
}

export async function createMainWindow(options: CreateMainWindowOptions): Promise<BrowserWindow> {
  const rendererIndexPath = options.rendererRoot
    ? path.join(options.rendererRoot, "index.html")
    : resolveRendererIndexPath(options.appPath);
  const trustedRendererUrl = options.isDev
    ? (options.devServerUrl ?? "http://127.0.0.1:1420")
    : pathToFileURL(rendererIndexPath).href;
  const mainWindow = new options.BrowserWindowCtor({
    title: options.title ?? PRODUCT_NAME,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: desktopTitleBarStyle(options.platform ?? process.platform),
    webPreferences: {
      preload: path.join(options.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed Chromium evaluates preloads as CommonJS and lets them require
      // only "electron", which is what `bundleElectron` emits for them.
      sandbox: true,
      ...(options.partition ? { partition: options.partition } : {}),
    },
  });

  installDefaultContextMenu(mainWindow, options.menu, options.writeClipboardText);
  installRendererDiagnostics(mainWindow.webContents);
  installRendererRecovery(mainWindow.webContents);
  installRendererNavigationGuards(mainWindow.webContents, trustedRendererUrl);
  installRendererPermissionPolicy(mainWindow.webContents.session, trustedRendererUrl);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  await options.beforeLoad?.(mainWindow);

  if (options.isDev) {
    await mainWindow.loadURL(trustedRendererUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }

  return mainWindow;
}
