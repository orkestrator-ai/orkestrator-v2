/**
 * Native image handling for captures: bounded PNG encoding, opaque masks
 * painted into the pixels, and region crops. Coordinates are CSS pixels of
 * the viewport unless stated otherwise.
 */
import type { BrowserPreviewCaptureMask } from "@orkestrator/protocol/browser-preview";
import type { WebAnnotationRect } from "@orkestrator/protocol/web-annotations";
import {
  CaptureFailure,
  type CaptureImageLike,
  type CaptureNativeImageApi,
} from "./browser-preview-capture-page.js";

const MAX_SCREENSHOT_DIMENSION = 2_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

function pngDataUrlByteLength(dataUrl: string): number {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("The browser frame did not return a PNG image");
  const base64 = dataUrl.slice(prefix.length);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("The browser frame returned an invalid PNG image");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Longest side ≤ 2000 px and ≤ 8 MiB; shrinks further only when the PNG is too large. */
export function boundedScreenshotDataUrl(image: CaptureImageLike): string {
  const originalSize = image.getSize();
  const longestSide = Math.max(originalSize.width, originalSize.height);
  const initialScale = Math.min(1, MAX_SCREENSHOT_DIMENSION / longestSide);
  let width = Math.max(1, Math.round(originalSize.width * initialScale));
  let height = Math.max(1, Math.round(originalSize.height * initialScale));
  let candidate = initialScale < 1 ? image.resize({ width, height, quality: "best" }) : image;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const dataUrl = candidate.toDataURL();
    const byteLength = pngDataUrlByteLength(dataUrl);
    if (byteLength <= MAX_SCREENSHOT_BYTES) return dataUrl;
    if (width === 1 && height === 1) break;
    const byteScale = Math.sqrt(MAX_SCREENSHOT_BYTES / byteLength) * 0.92;
    const scale = Math.min(0.85, Math.max(0.1, byteScale));
    const nextWidth = Math.max(1, Math.floor(width * scale));
    const nextHeight = Math.max(1, Math.floor(height * scale));
    width = nextWidth === width && width > 1 ? width - 1 : nextWidth;
    height = nextHeight === height && height > 1 ? height - 1 : nextHeight;
    candidate = image.resize({ width, height, quality: "best" });
  }
  throw new CaptureFailure("too-large");
}

const MASK_PIXEL = Buffer.from([0x28, 0x23, 0x1f, 0xff]);

/** Paint opaque boxes over sensitive rectangles in the native pixels (alpha is last in BGRA and RGBA). */
export function maskCaptureImage(
  image: CaptureImageLike,
  rects: WebAnnotationRect[],
  viewport: { width: number; height: number },
  api: CaptureNativeImageApi | undefined,
): { image: CaptureImageLike; masked: boolean } {
  if (rects.length === 0 || !api || typeof image.toBitmap !== "function")
    return { image, masked: false };
  const { width, height } = image.getSize();
  try {
    const bitmap = Buffer.from(image.toBitmap());
    if (bitmap.length !== width * height * 4 || viewport.width <= 0 || viewport.height <= 0) {
      return { image, masked: false };
    }
    const scaleX = width / viewport.width;
    const scaleY = height / viewport.height;
    for (const rect of rects) {
      const x0 = Math.max(0, Math.floor(rect.x * scaleX));
      const y0 = Math.max(0, Math.floor(rect.y * scaleY));
      const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * scaleX));
      const y1 = Math.min(height, Math.ceil((rect.y + rect.height) * scaleY));
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y += 1) {
        bitmap.fill(MASK_PIXEL, (y * width + x0) * 4, (y * width + x1) * 4);
      }
    }
    return { image: api.createFromBitmap(bitmap, { width, height }), masked: true };
  } catch {
    return { image, masked: false };
  }
}

export function clampRect(
  rect: WebAnnotationRect,
  width: number,
  height: number,
): WebAnnotationRect {
  const x = Math.min(Math.max(0, rect.x), width);
  const y = Math.min(Math.max(0, rect.y), height);
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, rect.width)),
    height: Math.max(0, Math.min(height - y, rect.height)),
  };
}

/** Viewport rectangle → document coordinates (CSS pixels) for a stored mask. */
export function documentMask(
  rect: WebAnnotationRect,
  scroll: { x: number; y: number },
  source: BrowserPreviewCaptureMask["source"],
): BrowserPreviewCaptureMask {
  return {
    source,
    rect: { x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height },
  };
}

/**
 * Document-space masks → viewport rectangles at the current scroll, keeping
 * only those that intersect the viewport (bounded).
 */
export function masksInViewport(
  masks: readonly BrowserPreviewCaptureMask[],
  scroll: { x: number; y: number },
  viewport: { width: number; height: number },
  limit = 64,
): Array<{ mask: BrowserPreviewCaptureMask; rect: WebAnnotationRect }> {
  const visible: Array<{ mask: BrowserPreviewCaptureMask; rect: WebAnnotationRect }> = [];
  for (const mask of masks.slice(0, limit)) {
    const rect = {
      x: mask.rect.x - scroll.x,
      y: mask.rect.y - scroll.y,
      width: mask.rect.width,
      height: mask.rect.height,
    };
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width <= 0 ||
      rect.y + rect.height <= 0 ||
      rect.x >= viewport.width ||
      rect.y >= viewport.height
    ) {
      continue;
    }
    visible.push({ mask, rect });
  }
  return visible;
}

/**
 * Crop a spooled PNG to `rect` (pixels of that image). Null when the native
 * image API cannot decode or crop, or the rectangle is empty.
 */
export function cropPng(
  png: Buffer,
  rect: WebAnnotationRect,
  api: CaptureNativeImageApi | undefined,
): { dataUrl: string; width: number; height: number } | null {
  if (!api?.createFromBuffer) return null;
  try {
    const source = api.createFromBuffer(png);
    if (typeof source.crop !== "function") return null;
    const size = source.getSize();
    const bounded = clampRect(
      {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      size.width,
      size.height,
    );
    if (bounded.width < 1 || bounded.height < 1) return null;
    const cropped = source.crop(bounded);
    const croppedSize = cropped.getSize();
    const dataUrl = cropped.toDataURL();
    if (!dataUrl.startsWith("data:image/png;base64,")) return null;
    return { dataUrl, width: croppedSize.width, height: croppedSize.height };
  } catch {
    return null;
  }
}
