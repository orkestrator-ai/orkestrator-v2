/**
 * Canvas utilities for image processing.
 */

// Claude SDK uses sharp to resize images >2000px — sharp fails in packaged apps (code signing).
// Pre-resize in the frontend to avoid hitting the SDK's sharp dependency entirely.
export const MAX_IMAGE_DIMENSION = 2000;

export interface EncodedPng {
  canvas: HTMLCanvasElement;
  dataUrl: string;
  base64Data: string;
}

/**
 * Resize a canvas if its RGBA data exceeds the maximum size limit.
 * Maintains aspect ratio while scaling down to fit within the limit.
 *
 * @param canvas - The source canvas to potentially resize
 * @param maxRgbaSize - Maximum allowed RGBA data size in bytes
 * @returns The original canvas if within limits, or a new resized canvas
 * @throws Error if canvas 2D context cannot be obtained for resizing
 */
export function resizeCanvasIfNeeded(
  canvas: HTMLCanvasElement,
  maxRgbaSize: number
): HTMLCanvasElement {
  const { width, height } = canvas;
  const rgbaSize = width * height * 4;

  if (rgbaSize <= maxRgbaSize) return canvas;

  // Calculate scale factor to fit within limit
  const scale = Math.sqrt(maxRgbaSize / rgbaSize);
  const newWidth = Math.max(1, Math.floor(width * scale));
  const newHeight = Math.max(1, Math.floor(height * scale));

  // Create resized canvas
  const resizedCanvas = document.createElement("canvas");
  resizedCanvas.width = newWidth;
  resizedCanvas.height = newHeight;
  const ctx = resizedCanvas.getContext("2d");

  if (!ctx) {
    // Cannot resize - return original canvas unchanged
    console.error("[canvas-utils] Failed to get 2D context for resized canvas");
    releaseCanvas(resizedCanvas);
    return canvas;
  }

  // Use high-quality image smoothing for better downscaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, newWidth, newHeight);

  // Release original canvas memory
  canvas.width = 0;
  canvas.height = 0;

  return resizedCanvas;
}

/**
 * Resize a canvas so neither dimension exceeds maxDimension pixels.
 * Maintains aspect ratio. Returns the original canvas if already within limits.
 *
 * @param canvas - The source canvas to potentially resize
 * @param maxDimension - Maximum allowed width or height in pixels
 * @returns The original canvas if within limits, or a new resized canvas
 */
export function resizeCanvasToMaxDimension(
  canvas: HTMLCanvasElement,
  maxDimension: number
): HTMLCanvasElement {
  const { width, height } = canvas;

  if (width <= maxDimension && height <= maxDimension) return canvas;

  const scale = Math.min(maxDimension / width, maxDimension / height);
  const newWidth = Math.max(1, Math.floor(width * scale));
  const newHeight = Math.max(1, Math.floor(height * scale));

  const resizedCanvas = document.createElement("canvas");
  resizedCanvas.width = newWidth;
  resizedCanvas.height = newHeight;
  const ctx = resizedCanvas.getContext("2d");

  if (!ctx) {
    console.error("[canvas-utils] Failed to get 2D context for dimension-resized canvas");
    releaseCanvas(resizedCanvas);
    return canvas;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, newWidth, newHeight);

  // Release original canvas memory
  canvas.width = 0;
  canvas.height = 0;

  return resizedCanvas;
}

/**
 * Encode a canvas as PNG, progressively reducing its dimensions when the
 * encoded payload is larger than the attachment limit. The first resize is
 * calculated from the payload-size ratio, with a small margin to avoid
 * repeatedly landing just above the limit.
 */
export function encodeCanvasAsPngWithinSize(
  canvas: HTMLCanvasElement,
  maxEncodedSize: number,
): EncodedPng | null {
  const maxAttempts = 6;
  let currentCanvas = canvas;
  let previousEncodedSize = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const dataUrl = currentCanvas.toDataURL("image/png");
    const separatorIndex = dataUrl.indexOf(",");
    if (separatorIndex < 0) {
      releaseCanvas(currentCanvas);
      return null;
    }

    const base64Start = separatorIndex + 1;
    const encodedSize = getBase64DecodedSize(dataUrl, base64Start);
    if (encodedSize !== null && encodedSize <= maxEncodedSize) {
      return {
        canvas: currentCanvas,
        dataUrl,
        // Only copy the payload after it has passed the size check. Oversized
        // PNG data URLs can be many megabytes and are retried several times.
        base64Data: dataUrl.slice(base64Start),
      };
    }

    if (
      encodedSize === null ||
      (currentCanvas.width <= 1 && currentCanvas.height <= 1) ||
      attempt === maxAttempts - 1
    ) {
      releaseCanvas(currentCanvas);
      return null;
    }

    // PNG compression is not monotonic as dimensions change. If one resize
    // does not reduce the encoded payload, make a larger step and keep trying
    // rather than rejecting an image that may fit at a smaller dimension.
    const didNotShrink = encodedSize >= previousEncodedSize;
    previousEncodedSize = encodedSize;

    const scale = Math.min(
      didNotShrink ? 0.75 : 0.9,
      Math.sqrt(maxEncodedSize / Math.max(encodedSize, 1)) * 0.9,
    );
    const longestDimension = Math.max(currentCanvas.width, currentCanvas.height);
    const nextMaxDimension = Math.max(1, Math.floor(longestDimension * scale));
    const resizedCanvas = resizeCanvasToMaxDimension(
      currentCanvas,
      nextMaxDimension,
    );
    if (resizedCanvas === currentCanvas) {
      releaseCanvas(currentCanvas);
      return null;
    }
    currentCanvas = resizedCanvas;
  }

  releaseCanvas(currentCanvas);
  return null;
}

function getBase64DecodedSize(dataUrl: string, base64Start: number): number | null {
  const base64Length = dataUrl.length - base64Start;
  if (base64Length === 0 || base64Length % 4 !== 0) return null;

  const padding = dataUrl.endsWith("==")
    ? 2
    : dataUrl.endsWith("=")
      ? 1
      : 0;

  // Padding is only valid at the end of a base64 payload.
  const firstPaddingIndex = dataUrl.indexOf("=", base64Start);
  if (
    firstPaddingIndex >= 0 &&
    firstPaddingIndex < dataUrl.length - padding
  ) {
    return null;
  }

  return Math.floor((base64Length * 3) / 4) - padding;
}

/**
 * Release canvas memory by setting dimensions to zero.
 * Call this when done with a canvas to help garbage collection.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}
