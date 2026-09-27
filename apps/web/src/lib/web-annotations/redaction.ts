/**
 * In-memory manual redaction for a pending capture image. The trusted UI
 * paints opaque rectangles over the working copy and hands the result to the
 * desktop spool (`replacePendingCaptureImage`) BEFORE any upload, so the
 * unredacted pixels never reach the backend.
 */
import { WEB_ANNOTATION_LIMITS } from "@orkestrator/protocol/web-annotations";

/** Rectangle in stored-image pixels. */
export interface RedactionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_REDACTION_REGIONS = WEB_ANNOTATION_LIMITS.redactionRegions;

export function clampRedaction(
  rect: RedactionRect,
  image: { width: number; height: number },
): RedactionRect | null {
  const x = Math.max(0, Math.min(image.width, Math.round(Math.min(rect.x, rect.x + rect.width))));
  const y = Math.max(0, Math.min(image.height, Math.round(Math.min(rect.y, rect.y + rect.height))));
  const right = Math.max(
    0,
    Math.min(image.width, Math.round(Math.max(rect.x, rect.x + rect.width))),
  );
  const bottom = Math.max(
    0,
    Math.min(image.height, Math.round(Math.max(rect.y, rect.y + rect.height))),
  );
  if (right - x < 2 || bottom - y < 2) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The capture image could not be decoded"));
    image.src = dataUrl;
  });
}

async function canvasRedactor(dataUrl: string, regions: readonly RedactionRect[]): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Redaction is unavailable in this client");
  context.drawImage(image, 0, 0);
  context.fillStyle = "#000";
  for (const region of regions) context.fillRect(region.x, region.y, region.width, region.height);
  const result = canvas.toDataURL("image/png");
  if (!result.startsWith("data:image/png;base64,")) {
    throw new Error("Redaction did not produce a PNG image");
  }
  return result;
}

/** Replaceable for tests: happy-dom has no raster canvas. */
export const imageRedactor = {
  redact: canvasRedactor as (dataUrl: string, regions: readonly RedactionRect[]) => Promise<string>,
};

export function redactPngDataUrl(
  dataUrl: string,
  regions: readonly RedactionRect[],
): Promise<string> {
  if (regions.length === 0) return Promise.resolve(dataUrl);
  if (regions.length > MAX_REDACTION_REGIONS) {
    return Promise.reject(new Error(`At most ${MAX_REDACTION_REGIONS} redaction regions`));
  }
  return imageRedactor.redact(dataUrl, regions);
}
