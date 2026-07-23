import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  ClipboardImageValidationError,
  getNormalizedClipboardImageDimensions,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES,
  MAX_CLIPBOARD_IMAGE_DIMENSION,
  MAX_CLIPBOARD_IMAGE_PIXELS,
  MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION,
  readClipboardImageBlob,
  readClipboardImageDimensions,
  validateClipboardImageDimensions,
} from "../../../apps/web/src/lib/clipboard-image";

const RealFileReader = globalThis.FileReader;

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gifBytes(width: number, height: number, version: "87a" | "89a" = "89a"): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set(
    version === "87a"
      ? [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
      : [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function bmpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([0x42, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x07, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ]);
  return bytes;
}

function jpegWithMarkerPrefix(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0x00,
    0xff, 0xff, 0x01,
    0xff, 0xd0,
    0xff, 0xc2, 0x00, 0x07, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ]);
}

function webpExtendedBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const write24 = (offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  };
  write24(24, width - 1);
  write24(27, height - 1);
  return bytes;
}

function webpLosslessBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
  bytes[20] = 0x2f;
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[21] = encodedWidth & 0xff;
  bytes[22] = ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x03) << 6);
  bytes[23] = (encodedHeight >> 2) & 0xff;
  bytes[24] = (encodedHeight >> 10) & 0x0f;
  return bytes;
}

function webpLossyBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

afterEach(() => {
  globalThis.FileReader = RealFileReader;
});

describe("clipboard image validation", () => {
  test("reads dimensions for supported raster clipboard formats", async () => {
    const cases = [
      [pngBytes(32, 18), "image/png", 32, 18],
      [jpegBytes(40, 20), "image/jpeg", 40, 20],
      [jpegWithMarkerPrefix(42, 21), "image/jpeg", 42, 21],
      [gifBytes(22, 11, "87a"), "image/gif", 22, 11],
      [gifBytes(24, 12), "image/gif", 24, 12],
      [bmpBytes(16, 8), "image/bmp", 16, 8],
      [webpExtendedBytes(48, 24), "image/webp", 48, 24],
      [webpLosslessBytes(50, 25), "image/webp", 50, 25],
      [webpLossyBytes(60, 30), "image/webp", 60, 30],
    ] as const;

    for (const [bytes, type, width, height] of cases) {
      const result = await readClipboardImageBlob(new Blob([bytes], { type }));
      expect(result).toMatchObject({ width, height });
      expect(result.dataUrl).toStartWith(`data:${type};base64,`);
    }
  });

  test("returns exact dimensions for each WebP encoding", async () => {
    await expect(readClipboardImageBlob(new Blob([webpExtendedBytes(48, 24)]))).resolves.toMatchObject({ width: 48, height: 24 });
    await expect(readClipboardImageBlob(new Blob([webpLosslessBytes(50, 25)]))).resolves.toMatchObject({ width: 50, height: 25 });
    await expect(readClipboardImageBlob(new Blob([webpLossyBytes(60, 30)]))).resolves.toMatchObject({ width: 60, height: 30 });
  });

  test("rejects empty, malformed, invalid-dimension, and unsupported images", async () => {
    await expect(readClipboardImageBlob(new Blob([]))).rejects.toMatchObject({ code: "invalid" });
    await expect(readClipboardImageBlob(new Blob(["not-an-image"]))).rejects.toMatchObject({ code: "unsupported" });
    await expect(readClipboardImageBlob(new Blob([pngBytes(0, 10)]))).rejects.toMatchObject({ code: "invalid" });
    await expect(readClipboardImageBlob(new Blob([jpegBytes(10, 0)]))).rejects.toMatchObject({ code: "invalid" });
  });

  test("rejects recognizable but truncated or malformed image headers", async () => {
    const malformedImages = [
      // PNG signature with a truncated IHDR, and a complete header without IHDR.
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      (() => {
        const bytes = pngBytes(2, 1);
        bytes.set([0x49, 0x44, 0x41, 0x54], 12);
        return bytes;
      })(),
      // JPEG SOI with no complete segment, and terminal markers before a frame.
      new Uint8Array([0xff, 0xd8, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xda]),
      // RIFF/WEBP signature that is truncated or has no recognized VP8 chunk.
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
        0x57, 0x45, 0x42, 0x50,
      ]),
      (() => {
        const bytes = webpExtendedBytes(2, 1);
        bytes.set([0x42, 0x41, 0x44, 0x21], 12);
        return bytes;
      })(),
      (() => {
        const bytes = webpLosslessBytes(2, 1);
        bytes[20] = 0;
        return bytes;
      })(),
      (() => {
        const bytes = webpLossyBytes(2, 1);
        bytes[23] = 0;
        return bytes;
      })(),
    ];

    for (const bytes of malformedImages) {
      await expect(readClipboardImageBlob(new Blob([bytes]))).rejects.toMatchObject({
        code: "unsupported",
      });
    }
  });

  test("rejects malformed JPEG marker and segment structures", async () => {
    const malformedJpegs = [
      // A marker without both segment-length bytes.
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      // Segment lengths include their own two bytes, so zero and one are invalid.
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
      // The declared segment extends beyond the available bytes.
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00]),
      // A start-of-frame segment shorter than seven bytes has no dimensions.
      new Uint8Array([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x06, 0x08, 0x00, 0x01, 0x00,
      ]),
      // Standalone markers are legal to skip, but do not make an image complete.
      new Uint8Array([
        0xff, 0xd8,
        0xff, 0x01,
        0xff, 0xd7,
        0xff, 0xd9,
      ]),
    ];

    for (const bytes of malformedJpegs) {
      await expect(readClipboardImageBlob(new Blob([bytes], { type: "image/jpeg" }))).rejects
        .toMatchObject({ code: "unsupported" });
    }
  });

  test("allows sources above the attachment limit so they can be resized", async () => {
    const sourceBytes = new Uint8Array(9 * 1024 * 1024);
    sourceBytes.set(pngBytes(9000, 1000));

    await expect(
      readClipboardImageDimensions(new Blob([sourceBytes], { type: "image/png" })),
    ).resolves.toMatchObject({ width: 9000, height: 1000 });
    await expect(
      readClipboardImageBlob(new Blob([sourceBytes], { type: "image/png" })),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  test("rejects extreme source bytes and dimensions before decoding", async () => {
    const arrayBuffer = mock(async () => pngBytes(1, 1).buffer);
    const oversizedBlob = {
      size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
      type: "image/png",
      arrayBuffer,
    } as unknown as Blob;
    await expect(readClipboardImageBlob(oversizedBlob)).rejects.toMatchObject({ code: "too-large" });
    expect(arrayBuffer).not.toHaveBeenCalled();

    await expect(readClipboardImageBlob(new Blob([pngBytes(32769, 1)]))).rejects.toMatchObject({ code: "too-large" });
    await expect(readClipboardImageBlob(new Blob([pngBytes(9000, 9000)]))).rejects.toMatchObject({ code: "too-large" });
  });

  test("accepts the exact byte limit and rejects the first byte over it", async () => {
    const atLimitArrayBuffer = mock(async () => pngBytes(1, 1).buffer);
    const atLimitSlice = mock(() => ({ arrayBuffer: atLimitArrayBuffer }));
    const atLimitBlob = {
      size: MAX_CLIPBOARD_IMAGE_BYTES,
      type: "image/png",
      slice: atLimitSlice,
    } as unknown as Blob;
    await expect(readClipboardImageDimensions(atLimitBlob)).resolves.toMatchObject({
      width: 1,
      height: 1,
    });
    expect(atLimitSlice).toHaveBeenCalledWith(0, 512 * 1024);
    expect(atLimitArrayBuffer).toHaveBeenCalledTimes(1);

    const overLimitArrayBuffer = mock(async () => pngBytes(1, 1).buffer);
    const overLimitBlob = {
      size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
      type: "image/png",
      arrayBuffer: overLimitArrayBuffer,
    } as unknown as Blob;
    await expect(readClipboardImageDimensions(overLimitBlob)).rejects.toMatchObject({
      code: "too-large",
    });
    expect(overLimitArrayBuffer).not.toHaveBeenCalled();
  });

  test("allows data URLs only through their exact conservative byte limit", async () => {
    class SuccessfulReader {
      result: string | ArrayBuffer | null = "data:image/png;base64,";
      error: DOMException | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = SuccessfulReader as unknown as typeof FileReader;
    const atLimit = {
      size: MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES,
      slice: () => new Blob([pngBytes(1, 1)]),
    } as unknown as Blob;
    await expect(readClipboardImageBlob(atLimit)).resolves.toMatchObject({
      width: 1,
      height: 1,
    });

    const overLimit = {
      size: MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES + 1,
    } as Blob;
    await expect(readClipboardImageBlob(overLimit)).rejects.toMatchObject({
      code: "too-large",
    });
  });

  test("validates direct native dimensions", () => {
    expect(validateClipboardImageDimensions(2, 3)).toEqual({ width: 2, height: 3 });
    for (const dimensions of [
      [NaN, 1],
      [1, NaN],
      [Infinity, 1],
      [1, Number.NEGATIVE_INFINITY],
      [1.5, 2],
      [2, 1.5],
      [-1, 2],
      [1, 0],
    ] as const) {
      expect(() => validateClipboardImageDimensions(...dimensions)).toThrow(ClipboardImageValidationError);
    }
  });

  test("enforces exact dimension and total-pixel boundaries", () => {
    expect(validateClipboardImageDimensions(MAX_CLIPBOARD_IMAGE_DIMENSION, 1)).toEqual({
      width: MAX_CLIPBOARD_IMAGE_DIMENSION,
      height: 1,
    });
    expect(() => validateClipboardImageDimensions(MAX_CLIPBOARD_IMAGE_DIMENSION + 1, 1))
      .toThrow(ClipboardImageValidationError);
    expect(() => validateClipboardImageDimensions(1, MAX_CLIPBOARD_IMAGE_DIMENSION + 1))
      .toThrow(ClipboardImageValidationError);

    const squareAtPixelLimit = Math.sqrt(MAX_CLIPBOARD_IMAGE_PIXELS);
    expect(Number.isInteger(squareAtPixelLimit)).toBe(true);
    expect(validateClipboardImageDimensions(squareAtPixelLimit, squareAtPixelLimit)).toEqual({
      width: squareAtPixelLimit,
      height: squareAtPixelLimit,
    });
    expect(() => validateClipboardImageDimensions(
      squareAtPixelLimit,
      squareAtPixelLimit + 1,
    )).toThrow(ClipboardImageValidationError);
  });

  test("calculates bounded output dimensions while preserving aspect ratio", () => {
    expect(getNormalizedClipboardImageDimensions(1200, 800)).toEqual({
      width: 1200,
      height: 800,
    });
    expect(getNormalizedClipboardImageDimensions(9000, 1000)).toEqual({
      width: 2000,
      height: 222,
    });
    expect(getNormalizedClipboardImageDimensions(1000, 9000)).toEqual({
      width: 222,
      height: 2000,
    });
    expect(getNormalizedClipboardImageDimensions(MAX_CLIPBOARD_IMAGE_DIMENSION, 1)).toEqual({
      width: MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION,
      height: 1,
    });
    expect(getNormalizedClipboardImageDimensions(1, MAX_CLIPBOARD_IMAGE_DIMENSION)).toEqual({
      width: 1,
      height: MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION,
    });
  });

  test("surfaces FileReader errors and non-string results", async () => {
    class ErrorReader {
      result: string | ArrayBuffer | null = null;
      error = new DOMException("read failed");
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = ErrorReader as unknown as typeof FileReader;
    await expect(readClipboardImageBlob(new Blob([pngBytes(2, 1)]))).rejects.toThrow("read failed");

    class NonStringReader extends ErrorReader {
      override result: string | ArrayBuffer | null = new ArrayBuffer(0);
      override readAsDataURL() {
        this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = NonStringReader as unknown as typeof FileReader;
    await expect(readClipboardImageBlob(new Blob([pngBytes(2, 1)]))).rejects.toThrow("could not be read");
  });

  test("uses a stable fallback when FileReader reports an error without details", async () => {
    class EmptyErrorReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
      }
    }
    globalThis.FileReader = EmptyErrorReader as unknown as typeof FileReader;

    await expect(readClipboardImageBlob(new Blob([pngBytes(2, 1)]))).rejects
      .toThrow("Clipboard image could not be read");
  });
});
