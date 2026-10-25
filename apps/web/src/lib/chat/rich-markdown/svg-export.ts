/**
 * Export helpers for sanitized, self-contained SVG (diagram previews).
 *
 * Only already-sanitized markup is accepted. PNG export rasterizes that SVG
 * through an <img> + canvas, bounded to the preview pixel limits, and every
 * object URL it creates is revoked once decoded.
 */
import { PREVIEW_CAPTURE_POLICY } from "@orkestrator/protocol/rich-content-policy";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A standalone SVG document: namespace present, explicit pixel size from the viewBox. */
export function standaloneSvg(svg: string, width: number | null, height: number | null): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, rawAttributes: string) => {
    let attributes = rawAttributes.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    attributes = attributes.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i, "");
    if (!/\sxmlns\s*=/.test(attributes)) attributes = ` xmlns="${SVG_NAMESPACE}"${attributes}`;
    const size =
      width && height ? ` width="${Math.round(width)}" height="${Math.round(height)}"` : "";
    return `<svg${attributes}${size}>`;
  });
}

export class SvgRasterizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgRasterizeError";
  }
}

/** PNG pixel size for an SVG of natural size `width`×`height`, within the capture limits. */
export function pngExportSize(
  width: number,
  height: number,
  scale = 2,
): { width: number; height: number } {
  const maxDimension = PREVIEW_CAPTURE_POLICY.maxDimension;
  let factor = scale;
  factor = Math.min(factor, maxDimension / width, maxDimension / height);
  factor = Math.min(factor, Math.sqrt(PREVIEW_CAPTURE_POLICY.maxPixels / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}

export async function rasterizeSvgToPng(svg: string, width: number, height: number): Promise<Blob> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new SvgRasterizeError("PNG export is not available here");
  }
  const size = pngExportSize(width, height);
  const url = URL.createObjectURL(
    new Blob([standaloneSvg(svg, width, height)], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new SvgRasterizeError("This browser cannot draw the diagram to an image");
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new SvgRasterizeError("This browser could not encode the diagram as PNG");
    return blob;
  } catch (error) {
    if (error instanceof SvgRasterizeError) throw error;
    throw new SvgRasterizeError("This browser could not rasterize the diagram");
  } finally {
    URL.revokeObjectURL(url);
  }
}
