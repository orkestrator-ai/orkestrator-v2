/**
 * Downloads frames as PNG, WEBP or PDF: one file for one frame, a ZIP of
 * images or a multi-page PDF for several; copies one frame to the clipboard. Every image is the backend
 * renderer's capture (`design_capture`) of the committed frame, so the file
 * shows exactly what the canvas saved, independent of zoom or of whether the
 * frame is on screen. Encoders live in `design-frame-files.ts`.
 */
import { base64ToBytes } from "@/lib/chat/artifact-download";
import {
  PX_TO_PT,
  buildPdf,
  buildZip,
  frameFileNames,
  rgbaToRgb,
  safeFileStem,
  type DesignImageFormat,
  type DesignPdfPage,
} from "./design-frame-files";

export type { DesignImageFormat } from "./design-frame-files";

/** The formats one frame can be copied to the clipboard as. */
export type DesignCopyFormat = "png" | "webp";

/** Which frames a download covers. */
export type DesignDownloadScope = "frame" | "selected" | "all";

export interface DesignDownloadFrame {
  id: string;
  name: string;
}

export interface DesignImageCodec {
  /** Re-encodes a PNG as WEBP; rejects when the browser cannot encode WEBP. */
  toWebp(png: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  /** Decodes a PNG to RGB samples composited onto white. */
  toRgb(
    png: Uint8Array<ArrayBuffer>,
  ): Promise<{ width: number; height: number; rgb: Uint8Array<ArrayBuffer> }>;
  /** zlib-compresses bytes (RFC 1950), as PDF FlateDecode expects. */
  deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

export interface DesignDownloadDeps {
  /** Captures one committed frame as a base64 PNG. */
  capture(frameId: string): Promise<{ data: string; mimeType: string }>;
  save(file: Blob, fileName: string): void;
  codec?: DesignImageCodec;
}

const WEBP_QUALITY = 0.95;

async function decode(png: Uint8Array<ArrayBuffer>) {
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw images");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas, context };
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The browser's own codecs: canvas for pixels, `CompressionStream` for zlib. */
export const browserImageCodec: DesignImageCodec = {
  async toWebp(png) {
    const { canvas } = await decode(png);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", WEBP_QUALITY),
    );
    // A browser without a WEBP encoder silently returns PNG instead.
    if (!blob || blob.type !== "image/webp")
      throw new Error("This browser cannot save WEBP images");
    return new Uint8Array(await blob.arrayBuffer());
  },
  async toRgb(png) {
    const { canvas, context } = await decode(png);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, rgb: rgbaToRgb(pixels) };
  },
  deflate(bytes) {
    return bytesOf(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate")));
  },
};

const MIME: Record<DesignImageFormat, string> = {
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** The file name a download will be saved as. */
export function downloadFileName(
  scope: DesignDownloadScope,
  format: DesignImageFormat,
  canvasName: string,
  frames: readonly DesignDownloadFrame[],
): string {
  if (frames.length === 1 && scope === "frame") return `${safeFileStem(frames[0]!.name)}.${format}`;
  const stem = safeFileStem(canvasName, "design");
  const suffix = scope === "selected" ? "-selected" : "";
  return `${stem}${suffix}.${format === "pdf" ? "pdf" : "zip"}`;
}

/**
 * Captures `frames` (in canvas order) and saves them in `format`. Returns the
 * saved file's name. Captures run one at a time: the renderer queue is shared
 * with the agent's tools and every other canvas.
 */
export async function downloadFrames({
  scope,
  frames,
  format,
  canvasName,
  deps,
  onProgress,
}: {
  scope: DesignDownloadScope;
  frames: readonly DesignDownloadFrame[];
  format: DesignImageFormat;
  canvasName: string;
  deps: DesignDownloadDeps;
  onProgress?: (done: number, total: number) => void;
}): Promise<string> {
  if (frames.length === 0) throw new Error("There are no frames to download");
  const codec = deps.codec ?? browserImageCodec;
  const fileName = downloadFileName(scope, format, canvasName, frames);
  const encoded: Uint8Array<ArrayBuffer>[] = [];
  const pages: DesignPdfPage[] = [];
  for (const [index, frame] of frames.entries()) {
    onProgress?.(index, frames.length);
    const capture = await deps.capture(frame.id);
    if (capture.mimeType !== "image/png") throw new Error(`Unexpected capture of ${frame.name}`);
    const png = base64ToBytes(capture.data);
    if (format === "png") encoded.push(png);
    else if (format === "webp") encoded.push(await codec.toWebp(png));
    else {
      const { width, height, rgb } = await codec.toRgb(png);
      pages.push({
        width: width * PX_TO_PT,
        height: height * PX_TO_PT,
        pixelWidth: width,
        pixelHeight: height,
        rgbDeflated: await codec.deflate(rgb),
      });
    }
  }
  onProgress?.(frames.length, frames.length);
  let file: Blob;
  if (format === "pdf") {
    file = new Blob([buildPdf(pages, frames.length === 1 ? frames[0]!.name : canvasName)], {
      type: MIME.pdf,
    });
  } else if (frames.length === 1 && scope === "frame") {
    file = new Blob([encoded[0]!], { type: MIME[format] });
  } else {
    const names = frameFileNames(
      frames.map((frame) => frame.name),
      format,
    );
    file = new Blob([buildZip(names.map((name, index) => ({ name, data: encoded[index]! })))], {
      type: "application/zip",
    });
  }
  deps.save(file, fileName);
  return fileName;
}

/**
 * Copies one frame to the clipboard: always as PNG, and for `webp` with a WEBP
 * of the same capture alongside, so an app that cannot read WEBP still pastes
 * the image. Hands `writeClipboard` the images before capturing, so a browser
 * still counts the write as part of the click that asked for it.
 */
export function copyFrame({
  frame,
  format,
  capture,
  writeClipboard,
  codec = browserImageCodec,
}: {
  frame: DesignDownloadFrame;
  format: DesignCopyFormat;
  capture: DesignDownloadDeps["capture"];
  writeClipboard(images: { png: Promise<Blob>; webp?: Promise<Blob> }): Promise<void>;
  codec?: Pick<DesignImageCodec, "toWebp">;
}): Promise<void> {
  const png = capture(frame.id).then((result) => {
    if (result.mimeType !== "image/png") throw new Error(`Unexpected capture of ${frame.name}`);
    return base64ToBytes(result.data);
  });
  const webp =
    format === "webp"
      ? png.then(async (bytes) => new Blob([await codec.toWebp(bytes)], { type: MIME.webp }))
      : undefined;
  return writeClipboard({
    png: png.then((bytes) => new Blob([bytes], { type: MIME.png })),
    ...(webp ? { webp } : {}),
  });
}
