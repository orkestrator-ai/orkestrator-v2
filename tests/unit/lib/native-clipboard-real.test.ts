import { afterEach, describe, expect, mock, test } from "bun:test";

const originalCreateImageBitmap = globalThis.createImageBitmap;

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
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
});

describe("native clipboard wrapper", () => {
  test("decodes a browser Blob once with bounded bitmap options and releases it", async () => {
    const { readImage } = await loadNativeClipboard();
    const nativeReadImage = mock(async () => null);
    window.orkestrator = {
      clipboard: {
        readImage: nativeReadImage,
      },
    } as never;

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const bitmap = {
      width: 2,
      height: 1,
      close: mock(() => undefined),
    } as unknown as ImageBitmap;
    const createBitmap = mock(async () => bitmap);
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: createBitmap,
    });
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: mock(() => undefined),
      getImageData: mock(() => ({
        data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
        width: 2,
        height: 1,
      })),
    };
    HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const blob = pngBlob(2, 1);
      const image = await readImage(blob);
      await expect(image.size()).resolves.toEqual({ width: 2, height: 1 });
      const [first, second] = await Promise.all([image.rgba(), image.rgba()]);
      expect(first).toEqual(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
      expect(second).toEqual(first);
      expect(nativeReadImage).not.toHaveBeenCalled();
      expect(createBitmap).toHaveBeenCalledTimes(1);
      expect(createBitmap).toHaveBeenCalledWith(blob, {
        imageOrientation: "none",
        resizeWidth: 2,
        resizeHeight: 1,
        resizeQuality: "high",
      });
      expect(context.imageSmoothingEnabled).toBe(true);
      expect(context.imageSmoothingQuality).toBe("high");
      expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2, 1);
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  test("requests portrait browser images directly at bounded dimensions", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const drawImage = mock(() => undefined);
    const getImageData = mock((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }));
    const bitmap = {
      width: 222,
      height: 2000,
      close: mock(() => undefined),
    } as unknown as ImageBitmap;
    const createBitmap = mock(async () => bitmap);
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: createBitmap,
    });
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage,
      getImageData,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      const blob = pngBlob(1000, 9000);
      const image = await readImage(blob);
      await expect(image.size()).resolves.toEqual({ width: 222, height: 2000 });
      await image.rgba();

      expect(createBitmap).toHaveBeenCalledWith(blob, {
        imageOrientation: "none",
        resizeWidth: 222,
        resizeHeight: 2000,
        resizeQuality: "high",
      });
      expect(drawImage).toHaveBeenCalledWith(
        bitmap,
        0,
        0,
        222,
        2000,
      );
      expect(getImageData).toHaveBeenCalledWith(0, 0, 222, 2000);
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  test("uses the bounded data-URL fallback only for conservative source sizes", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: undefined,
    });
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
        data: new Uint8ClampedArray(8),
        width: 2,
        height: 1,
      }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      await expect((await readImage(pngBlob(2, 1))).rgba()).resolves.toBeInstanceOf(Uint8Array);
      await expect((await readImage(pngBlob(9000, 1000))).rgba()).rejects.toMatchObject({
        code: "too-large",
      });
      const oversizedBytesBlob = {
        size: 8 * 1024 * 1024 + 1,
        slice: () => pngBlob(2, 1),
      } as unknown as Blob;
      await expect((await readImage(oversizedBytesBlob)).rgba()).rejects.toMatchObject({
        code: "too-large",
      });
    } finally {
      globalThis.Image = originalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  test("falls back after a small bitmap decode failure but not for a large source", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: mock(async () => { throw new Error("bitmap decode failed"); }),
    });
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
        data: new Uint8ClampedArray(8),
        width: 2,
        height: 1,
      }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      await expect((await readImage(pngBlob(2, 1))).rgba()).resolves.toBeInstanceOf(Uint8Array);
      await expect((await readImage(pngBlob(9000, 1000))).rgba()).rejects.toThrow(
        "bitmap decode failed",
      );
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

  test("uses a browser-gateway Blob without converting it to a data URL", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const blob = pngBlob(2, 1);
    const bitmap = {
      width: 2,
      height: 1,
      close: mock(() => undefined),
    } as unknown as ImageBitmap;
    const createBitmap = mock(async () => bitmap);
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: createBitmap,
    });
    window.orkestratorGateway = { enabled: true };
    window.orkestrator = {
      clipboard: {
        readImage: mock(async () => ({ width: 2, height: 1, blob })),
      },
    } as never;
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: mock(() => undefined),
      getImageData: () => ({
        data: new Uint8ClampedArray(8),
        width: 2,
        height: 1,
      }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    try {
      await expect((await readImage()).rgba()).resolves.toBeInstanceOf(Uint8Array);
      expect(createBitmap).toHaveBeenCalledWith(blob, expect.objectContaining({
        resizeWidth: 2,
        resizeHeight: 1,
      }));
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
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

  test("rejects invalid native metadata and malformed image payloads", async () => {
    const { readImage } = await loadNativeClipboard();
    const nativeReadImage = mock(async () => ({
      width: 0,
      height: 1,
      dataUrl: "data:image/png;base64,AA==",
    }) as never);
    window.orkestrator = { clipboard: { readImage: nativeReadImage } } as never;

    await expect(readImage()).rejects.toMatchObject({ code: "invalid" });
    nativeReadImage.mockImplementation(async () => ({
      width: 40_000,
      height: 1,
      dataUrl: "data:image/png;base64,AA==",
    }) as never);
    await expect(readImage()).rejects.toMatchObject({ code: "too-large" });
    nativeReadImage.mockImplementation(async () => ({
      width: 2,
      height: 1,
    }) as never);
    await expect(readImage()).rejects.toThrow("payload is invalid");
    nativeReadImage.mockImplementation(async () => ({
      width: 3,
      height: 1,
      blob: pngBlob(2, 1),
    }) as never);
    await expect(readImage()).rejects.toThrow("do not match");
  });

  test("rejects data-URL decode failures, mismatched metadata, and missing canvas contexts", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const nativeReadImage = mock(async () => ({
      width: 2,
      height: 1,
      dataUrl: "data:image/png;base64,AA==",
    }));
    window.orkestrator = { clipboard: { readImage: nativeReadImage } } as never;

    try {
      class DecodeFailureImage {
        naturalWidth = 2;
        naturalHeight = 1;
        src = "";
        async decode() { throw new Error("decode failed"); }
      }
      globalThis.Image = DecodeFailureImage as unknown as typeof Image;
      await expect((await readImage()).rgba()).rejects.toThrow("decode failed");

      class WrongSizeImage {
        naturalWidth = 3;
        naturalHeight = 1;
        src = "";
        async decode() {}
      }
      globalThis.Image = WrongSizeImage as unknown as typeof Image;
      await expect((await readImage()).rgba()).rejects.toThrow("do not match");

      class MatchingImage {
        naturalWidth = 2;
        naturalHeight = 1;
        src = "";
        async decode() {}
      }
      globalThis.Image = MatchingImage as unknown as typeof Image;
      HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
      await expect((await readImage()).rgba()).rejects.toThrow("Canvas 2D context");
    } finally {
      globalThis.Image = originalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  test("releases a decoded bitmap when canvas extraction fails", async () => {
    const { readImage } = await loadNativeClipboard();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const bitmap = {
      width: 2,
      height: 1,
      close: mock(() => undefined),
    } as unknown as ImageBitmap;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: mock(async () => bitmap),
    });
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

    try {
      await expect((await readImage(pngBlob(2, 1))).rgba()).rejects.toThrow(
        "Canvas 2D context",
      );
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
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

  test("propagates native and browser clipboard text failures", async () => {
    const { readText, writeText } = await loadNativeClipboard();
    window.orkestrator = {
      clipboard: {
        readText: mock(async () => { throw new Error("native read failed"); }),
        writeText: mock(async () => { throw new Error("native write failed"); }),
      },
    } as never;
    await expect(readText()).rejects.toThrow("native read failed");
    await expect(writeText("copy")).rejects.toThrow("native write failed");

    delete window.orkestrator;
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: mock(async () => { throw new Error("browser read failed"); }),
        writeText: mock(async () => { throw new Error("browser write failed"); }),
      },
    });
    try {
      await expect(readText()).rejects.toThrow("browser read failed");
      await expect(writeText("copy")).rejects.toThrow("browser write failed");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});
