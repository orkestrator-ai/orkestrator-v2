import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import { PRODUCT_NAME } from "../../../electron/backend/constants";
import { createMainWindow } from "../../../electron/window";

function createHarness() {
  const windows: FakeBrowserWindow[] = [];
  const menu = {
    buildFromTemplate: mock((template: MenuItemConstructorOptions[]) => ({
      template,
      popup: mock(() => undefined),
    })),
  };

  class FakeBrowserWindow {
    readonly webContents = {
      on: mock(() => undefined),
      openDevTools: mock(() => undefined),
    };
    readonly loadFile = mock(async (_filePath: string) => undefined);
    readonly loadURL = mock(async (_url: string) => undefined);

    constructor(readonly options: BrowserWindowConstructorOptions) {
      windows.push(this);
    }
  }

  return { FakeBrowserWindow, menu, windows };
}

describe("createMainWindow", () => {
  test("creates the production BrowserWindow, installs context menu support, and loads the renderer file", async () => {
    const harness = createHarness();

    const window = await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/dist-electron/electron",
      isDev: false,
      appPath: "/app",
    });

    expect(window).toBe(harness.windows[0]);
    expect(harness.windows).toHaveLength(1);
    expect(harness.windows[0].options).toMatchObject({
      title: PRODUCT_NAME,
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        preload: path.join("/app/dist-electron/electron", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    expect(harness.windows[0].webContents.on.mock.calls[0]?.[0]).toBe("context-menu");
    expect(harness.windows[0].loadFile).toHaveBeenCalledWith(path.join("/app", "dist", "index.html"));
    expect(harness.windows[0].loadURL).not.toHaveBeenCalled();
    expect(harness.windows[0].webContents.openDevTools).not.toHaveBeenCalled();
  });

  test("loads the configured dev server and opens devtools in development", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/dist-electron/electron",
      isDev: true,
      appPath: "/app",
      devServerUrl: "http://127.0.0.1:5173",
    });

    expect(harness.windows[0].loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
    expect(harness.windows[0].webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    expect(harness.windows[0].loadFile).not.toHaveBeenCalled();
  });

  test("uses the default dev server URL when none is configured", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/dist-electron/electron",
      isDev: true,
      appPath: "/app",
    });

    expect(harness.windows[0].loadURL).toHaveBeenCalledWith("http://127.0.0.1:1420");
  });
});
