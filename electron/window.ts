import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { PRODUCT_NAME } from "./backend/constants.js";
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
  devServerUrl?: string;
};

export async function createMainWindow(options: CreateMainWindowOptions): Promise<BrowserWindow> {
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

  if (options.isDev) {
    await mainWindow.loadURL(options.devServerUrl ?? "http://127.0.0.1:1420");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(resolveRendererIndexPath(options.appPath));
  }

  return mainWindow;
}
