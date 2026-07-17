import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadNativeClipboard() {
  return import("../../../apps/web/src/lib/native/clipboard.ts?real") as Promise<typeof import("../../../apps/web/src/lib/native/clipboard")>;
}

afterEach(() => {
  delete window.orkestrator;
  delete window.orkestratorGateway;
});

describe("native clipboard wrapper", () => {
  test("decodes an image blob supplied by a browser paste event", async () => {
    const { readImage } = await loadNativeClipboard();
    const nativeReadImage = mock(async () => null);
    window.orkestrator = {
      clipboard: {
        readImage: nativeReadImage,
      },
    } as never;

    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    class TestImage {
      naturalWidth = 2;
      naturalHeight = 1;
      src = "";
      async decode() {}
    }
    globalThis.Image = TestImage as unknown as typeof Image;
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: mock(() => undefined),
      getImageData: () => ({
        data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
        width: 2,
        height: 1,
      }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const image = await readImage(new Blob(["image"], { type: "image/png" }));
      await expect(image.size()).resolves.toEqual({ width: 2, height: 1 });
      await expect(image.rgba()).resolves.toEqual(
        new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      );
      expect(nativeReadImage).not.toHaveBeenCalled();
    } finally {
      globalThis.Image = originalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

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

  test("does not request browser clipboard permission for a text paste event", async () => {
    const { readImage } = await loadNativeClipboard();
    const browserReadImage = mock(async () => null);
    window.orkestratorGateway = { enabled: true };
    window.orkestrator = {
      clipboard: {
        readImage: browserReadImage,
      },
    } as never;

    await expect(readImage(null)).rejects.toThrow("No image in clipboard");
    expect(browserReadImage).not.toHaveBeenCalled();
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
