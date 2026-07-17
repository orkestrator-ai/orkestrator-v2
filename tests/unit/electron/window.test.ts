import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import { PRODUCT_NAME } from "../../../apps/backend/src/core/constants";
import {
  createMainWindow,
  isTrustedRendererUrl,
} from "../../../apps/desktop/electron/window";

function createHarness() {
  const windows: FakeBrowserWindow[] = [];
  const webContentsListeners = new Map<string, (event: any) => void>();
  const menu = {
    buildFromTemplate: mock((template: MenuItemConstructorOptions[]) => ({
      template,
      popup: mock(() => undefined),
    })),
  };

  class FakeBrowserWindow {
    readonly webContents = {
      on: mock((event: string, listener: (event: any) => void) => {
        webContentsListeners.set(event, listener);
      }),
      setWindowOpenHandler: mock((_handler: () => { action: "deny" }) => undefined),
      openDevTools: mock(() => undefined),
    };
    readonly loadFile = mock(async (_filePath: string) => undefined);
    readonly loadURL = mock(async (_url: string) => undefined);

    constructor(readonly options: BrowserWindowConstructorOptions) {
      windows.push(this);
    }
  }

  return { FakeBrowserWindow, menu, webContentsListeners, windows };
}

describe("createMainWindow", () => {
  test("matches only the configured renderer location", () => {
    const trustedFileUrl = "file:///app/web/index.html";

    expect(isTrustedRendererUrl(`${trustedFileUrl}#settings`, trustedFileUrl)).toBe(
      true,
    );
    expect(
      isTrustedRendererUrl(
        "file://remote-host/app/web/index.html",
        trustedFileUrl,
      ),
    ).toBe(false);
    expect(isTrustedRendererUrl("not a URL", trustedFileUrl)).toBe(false);
    expect(
      isTrustedRendererUrl(
        "http://127.0.0.1:5173/settings",
        "http://127.0.0.1:5173",
      ),
    ).toBe(true);
    expect(
      isTrustedRendererUrl(
        "http://127.0.0.1:5174/settings",
        "http://127.0.0.1:5173",
      ),
    ).toBe(false);
  });

  test("creates the production BrowserWindow, installs context menu support, and loads the renderer file", async () => {
    const harness = createHarness();

    const window = await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
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
        preload: path.join("/app/apps/desktop/dist/electron", "preload.js"),
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
      dirname: "/app/apps/desktop/dist/electron",
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
      dirname: "/app/apps/desktop/dist/electron",
      isDev: true,
      appPath: "/app",
    });

    expect(harness.windows[0].loadURL).toHaveBeenCalledWith("http://127.0.0.1:1420");
  });

  test("blocks untrusted navigation and renderer-created windows", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
      isDev: false,
      appPath: "/app",
    });

    const onWillNavigate = harness.webContentsListeners.get("will-navigate");
    expect(onWillNavigate).toBeTruthy();

    const trustedNavigation = {
      url: pathToFileURL(path.join("/app", "dist", "index.html")).href,
      preventDefault: mock(() => undefined),
    };
    onWillNavigate?.(trustedNavigation);
    expect(trustedNavigation.preventDefault).not.toHaveBeenCalled();

    const untrustedNavigation = {
      url: "https://malicious.example/collect",
      preventDefault: mock(() => undefined),
    };
    onWillNavigate?.(untrustedNavigation);
    expect(untrustedNavigation.preventDefault).toHaveBeenCalledTimes(1);

    const openHandler = harness.windows[0].webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler?.()).toEqual({ action: "deny" });
  });

  test("loads the renderer from an explicit rendererRoot and trusts only that location", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
      isDev: false,
      appPath: "/app",
      rendererRoot: "/custom/renderer",
    });

    const customIndexUrl = pathToFileURL(path.join("/custom/renderer", "index.html")).href;
    expect(harness.windows[0].loadFile).toHaveBeenCalledWith(
      path.join("/custom/renderer", "index.html"),
    );

    const onWillNavigate = harness.webContentsListeners.get("will-navigate");
    const trustedNavigation = { url: customIndexUrl, preventDefault: mock(() => undefined) };
    onWillNavigate?.(trustedNavigation);
    expect(trustedNavigation.preventDefault).not.toHaveBeenCalled();

    const defaultLocationNavigation = {
      url: pathToFileURL(path.join("/app", "dist", "index.html")).href,
      preventDefault: mock(() => undefined),
    };
    onWillNavigate?.(defaultLocationNavigation);
    expect(defaultLocationNavigation.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("keeps preview subframes away from the packaged renderer in production", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
      isDev: false,
      appPath: "/app",
    });

    for (const eventName of ["will-frame-navigate", "will-redirect"]) {
      const listener = harness.webContentsListeners.get(eventName);
      expect(listener).toBeTruthy();

      const rendererFileNavigation = {
        url: pathToFileURL(path.join("/app", "dist", "index.html")).href,
        isMainFrame: false,
        preventDefault: mock(() => undefined),
      };
      listener?.(rendererFileNavigation);
      expect(rendererFileNavigation.preventDefault).toHaveBeenCalledTimes(1);

      const malformedNavigation = {
        url: "not a URL",
        isMainFrame: false,
        preventDefault: mock(() => undefined),
      };
      expect(() => listener?.(malformedNavigation)).not.toThrow();
      expect(malformedNavigation.preventDefault).not.toHaveBeenCalled();
    }
  });

  test("keeps preview subframes away from the privileged renderer origin", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
      isDev: true,
      appPath: "/app",
      devServerUrl: "http://127.0.0.1:5173",
    });

    for (const eventName of ["will-frame-navigate", "will-redirect"]) {
      const listener = harness.webContentsListeners.get(eventName);
      expect(listener).toBeTruthy();

      const previewNavigation = {
        url: "http://localhost:3000/dashboard",
        isMainFrame: false,
        preventDefault: mock(() => undefined),
      };
      listener?.(previewNavigation);
      expect(previewNavigation.preventDefault).not.toHaveBeenCalled();

      const rendererNavigation = {
        url: "http://127.0.0.1:5173/settings",
        isMainFrame: false,
        preventDefault: mock(() => undefined),
      };
      listener?.(rendererNavigation);
      expect(rendererNavigation.preventDefault).toHaveBeenCalledTimes(1);

      const rendererMainFrameNavigation = {
        url: "http://127.0.0.1:5173/settings",
        isMainFrame: true,
        preventDefault: mock(() => undefined),
      };
      listener?.(rendererMainFrameNavigation);
      expect(rendererMainFrameNavigation.preventDefault).not.toHaveBeenCalled();
    }
  });

  test("allows only the configured development origin", async () => {
    const harness = createHarness();

    await createMainWindow({
      BrowserWindowCtor: harness.FakeBrowserWindow as never,
      menu: harness.menu,
      dirname: "/app/apps/desktop/dist/electron",
      isDev: true,
      appPath: "/app",
      devServerUrl: "http://127.0.0.1:5173",
    });

    const onWillNavigate = harness.webContentsListeners.get("will-navigate");
    const sameOriginNavigation = {
      url: "http://127.0.0.1:5173/settings",
      preventDefault: mock(() => undefined),
    };
    onWillNavigate?.(sameOriginNavigation);
    expect(sameOriginNavigation.preventDefault).not.toHaveBeenCalled();

    const differentOriginNavigation = {
      url: "http://127.0.0.1:5174/",
      preventDefault: mock(() => undefined),
    };
    onWillNavigate?.(differentOriginNavigation);
    expect(differentOriginNavigation.preventDefault).toHaveBeenCalledTimes(1);
  });
});
