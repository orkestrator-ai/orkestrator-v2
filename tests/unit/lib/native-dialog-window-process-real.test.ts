import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadNativeDialog() {
  return import("../../../src/lib/native/dialog.ts?real") as Promise<typeof import("../../../src/lib/native/dialog")>;
}

async function loadNativeWindow() {
  return import("../../../src/lib/native/window.ts?real") as Promise<typeof import("../../../src/lib/native/window")>;
}

async function loadNativeProcess() {
  return import("../../../src/lib/native/process.ts?real") as Promise<typeof import("../../../src/lib/native/process")>;
}

afterEach(() => {
  delete window.orkestrator;
});

describe("native dialog/window/process wrappers", () => {
  test("opens dialogs through the preload bridge and returns null without it", async () => {
    const { open } = await loadNativeDialog();
    await expect(open({ directory: true })).resolves.toBeNull();

    const openMock = mock(async () => "/tmp/project");
    window.orkestrator = { dialog: { open: openMock } } as never;

    await expect(open({ directory: true, title: "Choose" })).resolves.toBe("/tmp/project");
    expect(openMock).toHaveBeenCalledWith({ directory: true, title: "Choose" });
  });

  test("starts native window dragging when the bridge is present", async () => {
    const { getCurrentWindow } = await loadNativeWindow();
    const startDragging = mock(async () => undefined);
    window.orkestrator = { window: { startDragging } } as never;

    await getCurrentWindow().startDragging();
    expect(startDragging).toHaveBeenCalled();
  });

  test("window dragging is a no-op without the preload bridge", async () => {
    const { getCurrentWindow } = await loadNativeWindow();
    await expect(getCurrentWindow().startDragging()).resolves.toBeUndefined();
  });

  test("exits through the preload bridge or falls back to window.close", async () => {
    const { exit } = await loadNativeProcess();
    const exitMock = mock(async () => undefined);
    window.orkestrator = { process: { exit: exitMock } } as never;

    await exit(9);
    expect(exitMock).toHaveBeenCalledWith(9);

    delete window.orkestrator;
    const closeMock = mock(() => undefined);
    const originalClose = window.close;
    Object.defineProperty(window, "close", { configurable: true, value: closeMock });
    try {
      await exit();
      expect(closeMock).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "close", { configurable: true, value: originalClose });
    }
  });
});
