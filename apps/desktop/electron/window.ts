import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_NAME } from "./app-constants.js";
import { installDefaultContextMenu } from "./context-menu.js";
import { resolveRendererIndexPath } from "./paths.js";

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow;
type ContextMenuMenu = Parameters<typeof installDefaultContextMenu>[1];

export type CreateMainWindowOptions = {
  BrowserWindowCtor: BrowserWindowConstructor;
  menu: ContextMenuMenu;
  dirname: string;
  isDev: boolean;
  appPath: string;
  rendererRoot?: string;
  devServerUrl?: string;
};

export function isTrustedRendererUrl(candidateUrl: string, trustedRendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const trusted = new URL(trustedRendererUrl);

    if (trusted.protocol === "http:" || trusted.protocol === "https:") {
      return candidate.origin === trusted.origin;
    }

    if (trusted.protocol === "file:") {
      return (
        candidate.protocol === "file:" &&
        candidate.host === trusted.host &&
        candidate.pathname === trusted.pathname
      );
    }

    return candidate.href === trusted.href;
  } catch {
    return false;
  }
}

export async function createMainWindow(options: CreateMainWindowOptions): Promise<BrowserWindow> {
  const rendererIndexPath = options.rendererRoot
    ? path.join(options.rendererRoot, "index.html")
    : resolveRendererIndexPath(options.appPath);
  const trustedRendererUrl = options.isDev
    ? options.devServerUrl ?? "http://127.0.0.1:1420"
    : pathToFileURL(rendererIndexPath).href;
  const mainWindow = new options.BrowserWindowCtor({
    title: PRODUCT_NAME,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(options.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installDefaultContextMenu(mainWindow, options.menu);
  mainWindow.webContents.on("will-navigate", (event) => {
    if (!isTrustedRendererUrl(event.url, trustedRendererUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (options.isDev) {
    await mainWindow.loadURL(trustedRendererUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }

  return mainWindow;
}
