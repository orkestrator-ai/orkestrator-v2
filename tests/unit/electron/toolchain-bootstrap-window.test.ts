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
    class FakeBrowserWindow {
      readonly webContents = {
        on: mock((event: string, listener: (event: { preventDefault(): void }) => void) => {
          if (event === "will-navigate") navigationListener = listener;
        }),
        send: mock(() => undefined),
        setWindowOpenHandler: mock(() => undefined),
      };
      readonly loadURL = mock(async (_url: string) => undefined);
      readonly isDestroyed = mock(() => destroyed);

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
});
