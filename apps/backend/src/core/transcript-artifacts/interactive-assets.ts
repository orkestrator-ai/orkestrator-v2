/**
 * Validation of assets embedded into an interactive HTML package.
 *
 * Assets arrive as already-copied bytes (never URLs or paths). Each is bounded,
 * its declared MIME type must be on a short allowlist, and binary formats are
 * confirmed by their magic bytes; raster image dimensions are read from the
 * header before anything decodes them.
 */
import type { ArtifactDiagnostic } from "@orkestrator/protocol/transcript-artifacts";
import { ARTIFACT_ASSET_NAME_PATTERN } from "@orkestrator/protocol/transcript-artifacts";
import {
  FRONTEND_RENDER_POLICY,
  INTERACTIVE_HTML_POLICY,
} from "@orkestrator/protocol/rich-content-policy";

import type { InteractiveAssetInput } from "./contracts.js";
import { sha256Hex } from "./dependency-manifest.js";

const MAX_IMAGE_DIMENSION = 16_384;

type Sniffer = (bytes: Uint8Array) => boolean;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

function validUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const SNIFFERS: Record<string, Sniffer> = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  "image/svg+xml": (b) => {
    const text = validUtf8(b);
    return text !== null && /<svg[\s>]/i.test(text.slice(0, 4096));
  },
  "font/woff": (b) => startsWith(b, ascii("wOFF")),
  "font/woff2": (b) => startsWith(b, ascii("wOF2")),
  "font/ttf": (b) => startsWith(b, [0x00, 0x01, 0x00, 0x00]) || startsWith(b, ascii("true")),
  "font/otf": (b) => startsWith(b, ascii("OTTO")),
  "application/json": (b) => validUtf8(b) !== null,
  "text/csv": (b) => validUtf8(b) !== null,
  "text/plain": (b) => validUtf8(b) !== null,
};

export const ALLOWED_ASSET_MIME_TYPES: readonly string[] = Object.freeze(Object.keys(SNIFFERS));

/** Width/height from the image header, or null when the format has none we read. */
export function imageDimensions(
  mimeType: string,
  b: Uint8Array,
): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (mimeType === "image/png" && b.length >= 24)
      return { width: view.getUint32(16), height: view.getUint32(20) };
    if (mimeType === "image/gif" && b.length >= 10)
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (mimeType === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
      if (chunk === "VP8X") {
        const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
        const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
        return { width: w, height: h };
      }
      if (chunk === "VP8 ")
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      if (chunk === "VP8L" && b.length >= 25) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) return null;
        const marker = b[offset + 1]!;
        const length = view.getUint16(offset + 2);
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface ValidatedAsset {
  name: string;
  mimeType: string;
  dataUrl: string;
  byteLength: number;
}

export function validateInteractiveAssets(
  assets: readonly InteractiveAssetInput[],
  diagnostics: ArtifactDiagnostic[],
): Map<string, ValidatedAsset> | null {
  const result = new Map<string, ValidatedAsset>();
  let total = 0;
  let failed = false;
  const fail = (code: string, message: string, location: string) => {
    failed = true;
    diagnostics.push({ severity: "error", code, message, location });
  };
  if (assets.length > INTERACTIVE_HTML_POLICY.maxAssets) {
    fail(
      "too_many_assets",
      `The package has ${assets.length} assets; at most ${INTERACTIVE_HTML_POLICY.maxAssets} are allowed`,
      "assets",
    );
    return null;
  }
  assets.forEach((asset, index) => {
    const location = `assets[${index}]`;
    if (typeof asset.name !== "string" || !ARTIFACT_ASSET_NAME_PATTERN.test(asset.name)) {
      fail(
        "invalid_asset_name",
        "Asset names use letters, digits, '.', '_' and '-' only",
        location,
      );
      return;
    }
    if (result.has(asset.name)) {
      fail("duplicate_asset", `Asset "${asset.name}" is listed twice`, location);
      return;
    }
    total += asset.bytes.byteLength;
    const sniff = SNIFFERS[asset.mimeType];
    if (!sniff) {
      fail(
        "unsupported_asset_type",
        `Asset "${asset.name}" has unsupported type ${String(asset.mimeType).slice(0, 80)}; allowed: ${ALLOWED_ASSET_MIME_TYPES.join(", ")}`,
        location,
      );
      return;
    }
    if (sha256Hex(asset.bytes) !== asset.sha256) {
      fail(
        "asset_integrity",
        `Asset "${asset.name}" bytes do not match their recorded SHA-256`,
        location,
      );
      return;
    }
    if (!sniff(asset.bytes)) {
      fail(
        "asset_type_mismatch",
        `Asset "${asset.name}" content is not ${asset.mimeType}`,
        location,
      );
      return;
    }
    const dimensions = imageDimensions(asset.mimeType, asset.bytes);
    if (
      dimensions &&
      (dimensions.width > MAX_IMAGE_DIMENSION ||
        dimensions.height > MAX_IMAGE_DIMENSION ||
        dimensions.width * dimensions.height > FRONTEND_RENDER_POLICY.imageDecodeMaxPixels)
    ) {
      fail(
        "asset_image_too_large",
        `Asset "${asset.name}" is ${dimensions.width}×${dimensions.height}; images are limited to ${MAX_IMAGE_DIMENSION} px per side and ${FRONTEND_RENDER_POLICY.imageDecodeMaxPixels} pixels`,
        location,
      );
      return;
    }
    result.set(asset.name, {
      name: asset.name,
      mimeType: asset.mimeType,
      byteLength: asset.bytes.byteLength,
      dataUrl: `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`,
    });
  });
  if (total > INTERACTIVE_HTML_POLICY.maxAssetBytesTotal) {
    fail(
      "assets_too_large",
      `Assets total ${total} bytes decoded; at most ${INTERACTIVE_HTML_POLICY.maxAssetBytesTotal} are allowed`,
      "assets",
    );
  }
  return failed ? null : result;
}
