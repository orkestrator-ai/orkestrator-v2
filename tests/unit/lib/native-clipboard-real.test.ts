import { afterEach, describe, expect, mock, test } from "bun:test";

function pngBlob(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: "image/png" });
}

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
      const image = await readImage(pngBlob(2, 1));
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

  test("preserves the native screenshot fallback in Electron remote mode", async () => {
    const { readImage } = await loadNativeClipboard();
    const nativeReadImage = mock(async () => ({
      width: 32,
      height: 18,
      dataUrl: "data:image/png;base64,AA==",
    }));
    window.orkestratorGateway = { enabled: true, desktop: true };
    window.orkestrator = { clipboard: { readImage: nativeReadImage } } as never;

    const image = await readImage(null);

    await expect(image.size()).resolves.toEqual({ width: 32, height: 18 });
    expect(nativeReadImage).toHaveBeenCalledTimes(1);
  });

  test("uses native image dimensions and reports an empty native clipboard", async () => {
    const { readImage } = await loadNativeClipboard();
    const nativeReadImage = mock(async () => ({
      width: 4,
      height: 3,
      dataUrl: "data:image/png;base64,AA==",
    }) as { width: number; height: number; dataUrl: string } | null);
    window.orkestrator = { clipboard: { readImage: nativeReadImage } } as never;

    await expect((await readImage()).size()).resolves.toEqual({ width: 4, height: 3 });
    nativeReadImage.mockImplementation(async () => null);
    await expect(readImage()).rejects.toThrow("No image in clipboard");
  });

  test("rejects decode failures, mismatched metadata, and missing canvas contexts", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    try {
      class DecodeFailureImage {
        naturalWidth = 2;
        naturalHeight = 1;
        src = "";
        async decode() { throw new Error("decode failed"); }
      }
      globalThis.Image = DecodeFailureImage as unknown as typeof Image;
      await expect((await readImage(pngBlob(2, 1))).rgba()).rejects.toThrow("decode failed");

      class WrongSizeImage {
        naturalWidth = 3;
        naturalHeight = 1;
        src = "";
        async decode() {}
      }
      globalThis.Image = WrongSizeImage as unknown as typeof Image;
      await expect((await readImage(pngBlob(2, 1))).rgba()).rejects.toThrow("do not match");

      class MatchingImage {
        naturalWidth = 2;
        naturalHeight = 1;
        src = "";
        async decode() {}
      }
      globalThis.Image = MatchingImage as unknown as typeof Image;
      HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
      await expect((await readImage(pngBlob(2, 1))).rgba()).rejects.toThrow("Canvas 2D context");
    } finally {
      globalThis.Image = originalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
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
