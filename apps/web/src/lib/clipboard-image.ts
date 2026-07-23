/**
 * Source-image limits protect the renderer from pathological clipboard
 * payloads. They are intentionally higher than the final 8MB attachment
 * limit: normal large screenshots and photos are resized before attachment.
 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CLIPBOARD_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_CLIPBOARD_IMAGE_DIMENSION = 32768;
export const MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

/** Maximum dimensions exposed to paste consumers after decoding. */
export const MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION = 2000;
const MAX_CLIPBOARD_IMAGE_HEADER_BYTES = 512 * 1024;

export type ClipboardImageValidationCode = "too-large" | "unsupported" | "invalid";

export class ClipboardImageValidationError extends Error {
  constructor(
    message: string,
    readonly code: ClipboardImageValidationCode,
  ) {
    super(message);
    this.name = "ClipboardImageValidationError";
  }
}

export function validateClipboardImageDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ClipboardImageValidationError("Clipboard image dimensions are invalid", "invalid");
  }
  if (
    width > MAX_CLIPBOARD_IMAGE_DIMENSION ||
    height > MAX_CLIPBOARD_IMAGE_DIMENSION ||
    width * height > MAX_CLIPBOARD_IMAGE_PIXELS
  ) {
    throw new ClipboardImageValidationError(
      `Clipboard image is too large (${width}×${height}); maximum source size is 64 megapixels`,
      "too-large",
    );
  }
  return { width, height };
}

export function getNormalizedClipboardImageDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const dimensions = validateClipboardImageDimensions(width, height);
  if (
    dimensions.width <= MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION &&
    dimensions.height <= MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION
  ) {
    return dimensions;
  }

  const scale = Math.min(
    MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION / dimensions.width,
    MAX_NORMALIZED_CLIPBOARD_IMAGE_DIMENSION / dimensions.height,
  );
  return {
    width: Math.max(1, Math.floor(dimensions.width * scale)),
    height: Math.max(1, Math.floor(dimensions.height * scale)),
  };
}

function isBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readPngDimensions(bytes: Uint8Array, view: DataView) {
  if (
    bytes.length < 24 ||
    !isBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    !isBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])
  ) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGifDimensions(bytes: Uint8Array, view: DataView) {
  if (
    bytes.length < 10 ||
    (!isBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) &&
      !isBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
  ) return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readBmpDimensions(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 26 || !isBytes(bytes, 0, [0x42, 0x4d])) return null;
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

function readJpegDimensions(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 4 || !isBytes(bytes, 0, [0xff, 0xd8])) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array, view: DataView) {
  if (
    bytes.length < 30 ||
    !isBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) ||
    !isBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) return null;
  if (isBytes(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    const width = 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16);
    const height = 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16);
    return { width, height };
  }
  if (isBytes(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && view.getUint8(20) === 0x2f) {
    const byte21 = view.getUint8(21);
    const byte22 = view.getUint8(22);
    const byte23 = view.getUint8(23);
    const byte24 = view.getUint8(24);
    return {
      width: 1 + byte21 + ((byte22 & 0x3f) << 8),
      height: 1 + ((byte22 & 0xc0) >> 6) + (byte23 << 2) + ((byte24 & 0x0f) << 10),
    };
  }
  if (
    isBytes(bytes, 12, [0x56, 0x50, 0x38, 0x20]) &&
    isBytes(bytes, 23, [0x9d, 0x01, 0x2a])
  ) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return null;
}

export async function readClipboardImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  if (blob.size === 0) {
    throw new ClipboardImageValidationError("Clipboard image is empty", "invalid");
  }
  if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageValidationError(
      `Clipboard image source is too large (${(blob.size / 1024 / 1024).toFixed(1)}MB); maximum source size is 64MB`,
      "too-large",
    );
  }

  // Raster dimensions live in format headers. Keep validation memory bounded
  // even when a large (but otherwise accepted) source is pasted.
  const buffer = await blob.slice(0, MAX_CLIPBOARD_IMAGE_HEADER_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const dimensions =
    readPngDimensions(bytes, view) ??
    readJpegDimensions(bytes, view) ??
    readGifDimensions(bytes, view) ??
    readWebpDimensions(bytes, view) ??
    readBmpDimensions(bytes, view);
  if (!dimensions) {
    throw new ClipboardImageValidationError(
      "Clipboard image format is unsupported or malformed",
      "unsupported",
    );
  }
  return validateClipboardImageDimensions(dimensions.width, dimensions.height);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Clipboard image could not be read"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Clipboard image could not be read"));
    reader.readAsDataURL(blob);
  });
}

export async function readClipboardImageBlob(blob: Blob): Promise<{
  width: number;
  height: number;
  dataUrl: string;
}> {
  if (blob.size > MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES) {
    throw new ClipboardImageValidationError(
      "Clipboard image is too large for safe data-URL decoding",
      "too-large",
    );
  }
  const dimensions = await readClipboardImageDimensions(blob);
  return { ...dimensions, dataUrl: await blobToDataUrl(blob) };
}
