import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadNativeClipboard() {
  return import("../../../apps/web/src/lib/native/clipboard.ts?real") as Promise<typeof import("../../../apps/web/src/lib/native/clipboard")>;
}

afterEach(() => {
  delete window.orkestrator;
});

describe("native clipboard wrapper", () => {
  test("uses the preload clipboard bridge when available", async () => {
    const { readText, writeText } = await loadNativeClipboard();
    const readTextMock = mock(async () => "from-native");
    const writeTextMock = mock(async () => undefined);
    window.orkestrator = {
      clipboard: {
        readText: readTextMock,
        writeText: writeTextMock,
      },
    } as never;

    await expect(readText()).resolves.toBe("from-native");
    await writeText("copied");

    expect(readTextMock).toHaveBeenCalled();
    expect(writeTextMock).toHaveBeenCalledWith("copied");
  });

  test("falls back to navigator.clipboard without the preload bridge", async () => {
    const { readText, writeText } = await loadNativeClipboard();
    const originalClipboard = navigator.clipboard;
    const readTextMock = mock(async () => "from-browser");
    const writeTextMock = mock(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: readTextMock, writeText: writeTextMock },
    });

    try {
      await expect(readText()).resolves.toBe("from-browser");
      await writeText("browser-copy");
      expect(writeTextMock).toHaveBeenCalledWith("browser-copy");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});
