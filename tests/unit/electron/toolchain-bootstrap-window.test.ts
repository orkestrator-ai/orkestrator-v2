import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindowConstructorOptions } from "electron";
import { PRODUCT_NAME } from "../../../apps/desktop/electron/app-constants";
import {
  createToolchainBootstrapWindow,
  reportToolchainProgress,
} from "../../../apps/desktop/electron/toolchain-bootstrap-window";

describe("toolchain bootstrap window", () => {
  test("loads a locked-down local progress page and forwards status over IPC", async () => {
    let destroyed = false;
    let navigationListener: ((event: { preventDefault(): void }) => void) | undefined;
    let preloadErrorListener: ((_event: unknown, path: string, error: Error) => void) | undefined;
    class FakeBrowserWindow {
      readonly webContents = {
        on: mock((event: string, listener: (event: { preventDefault(): void }) => void) => {
          if (event === "will-navigate") navigationListener = listener;
        }),
        send: mock(() => undefined),
        setWindowOpenHandler: mock(() => undefined),
        once: mock((event: string, listener: (_event: unknown, path: string, error: Error) => void) => {
          if (event === "preload-error") preloadErrorListener = listener;
        }),
      };
      readonly loadURL = mock(async (_url: string) => undefined);
      readonly isDestroyed = mock(() => destroyed);
      readonly close = mock(() => { destroyed = true; });

      constructor(readonly options: BrowserWindowConstructorOptions) {}
    }

    const window = await createToolchainBootstrapWindow({
      BrowserWindowCtor: FakeBrowserWindow as never,
      dirname: "/app/electron",
    }) as unknown as FakeBrowserWindow;

    expect(window.options).toMatchObject({
      title: `${PRODUCT_NAME} — Preparing tools`,
      width: 520,
      height: 300,
      resizable: false,
      webPreferences: {
        preload: "/app/electron/toolchain-bootstrap-preload.js",
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const loadedUrl = window.loadURL.mock.calls[0]?.[0] ?? "";
    expect(loadedUrl).toStartWith("data:text/html;charset=utf-8,");
    expect(decodeURIComponent(loadedUrl.split(",")[1] ?? "")).toContain("Preparing pinned tools");

    const preventDefault = mock(() => undefined);
    navigationListener?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(preloadErrorListener).toBeDefined();

    const progress = {
      phase: "downloading" as const,
      tool: "codex" as const,
      completedTools: 0,
      totalTools: 3,
      bytesReceived: 10,
      bytesTotal: 100,
      message: "Downloading Codex",
    };
    reportToolchainProgress(window as never, progress);
    expect(window.webContents.send).toHaveBeenCalledWith("orkestrator:toolchain-progress", progress);

    destroyed = true;
    reportToolchainProgress(window as never, progress);
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  test("closes and rejects when the bootstrap preload fails", async () => {
    let preloadErrorListener: ((_event: unknown, path: string, error: Error) => void) | undefined;
    class FailingBrowserWindow {
      readonly webContents = {
        on: mock(() => undefined),
        send: mock(() => undefined),
        setWindowOpenHandler: mock(() => undefined),
        once: mock((_event: string, listener: (_event: unknown, path: string, error: Error) => void) => {
          preloadErrorListener = listener;
        }),
      };
      readonly loadURL = mock(() => new Promise<void>(() => undefined));
      readonly isDestroyed = mock(() => false);
      readonly close = mock(() => undefined);
    }

    const creating = createToolchainBootstrapWindow({
      BrowserWindowCtor: FailingBrowserWindow as never,
      dirname: "/app/electron",
    });
    preloadErrorListener?.({}, "/app/electron/toolchain-bootstrap-preload.js", new Error("syntax error"));

    await expect(creating).rejects.toThrow("syntax error");
  });
});
