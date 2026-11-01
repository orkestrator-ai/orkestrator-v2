/**
 * Main-process clipboard access, written against Electron 44's W3C-shaped
 * `clipboard` module: every read and write is asynchronous, and images travel
 * as MIME-typed `ClipboardItem` payloads rather than `NativeImage`s.
 */

/** Structural subset of Electron's `ClipboardItem`. */
export type ClipboardItemLike = {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
};

/** Structural subset of Electron's `clipboard` module. */
export type ClipboardLike = {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  read(): Promise<ClipboardItemLike[]>;
  write(items: ClipboardItemLike[]): Promise<void>;
};

export type CreateClipboardItem = (items: Record<string, Blob>) => ClipboardItemLike;

export type ClipboardNativeImageLike = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width?: number;
    height?: number;
    quality?: "good" | "better" | "best";
  }): ClipboardNativeImageLike;
  toDataURL(): string;
  toPNG(): Buffer;
};

export type ClipboardNativeImageApi = {
  createFromBuffer(buffer: Buffer): ClipboardNativeImageLike;
  createFromDataURL(dataUrl: string): ClipboardNativeImageLike;
};

export type ClipboardImageTransfer = { width: number; height: number; dataUrl: string };

export const MAX_CLIPBOARD_TRANSFER_DIMENSION = 2000;

/**
 * Upper bound on the encoded clipboard image the main process will copy into
 * its heap before decoding. A full-resolution 6K screenshot is well under this.
 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 128 * 1024 * 1024;

/**
 * The encodings nativeImage decodes, in preference order. Electron's native
 * clipboard reader exposes a PNG conversion for TIFF-only macOS pasteboards;
 * electron-main.spec.ts exercises that OS conversion with a real public.tiff.
 */
const CLIPBOARD_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

type BlobLike = { readonly size: number; arrayBuffer(): Promise<ArrayBuffer> };

function isBlobLike(value: unknown): value is BlobLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BlobLike).size === "number" &&
    typeof (value as BlobLike).arrayBuffer === "function"
  );
}

function findClipboardImage(
  items: readonly ClipboardItemLike[],
): { item: ClipboardItemLike; type: string } | null {
  for (const type of CLIPBOARD_IMAGE_TYPES) {
    const item = items.find((candidate) => candidate.types.includes(type));
    if (item) return { item, type };
  }
  return null;
}

/** Read the clipboard image, bounded to the renderer transfer dimension. */
export async function readClipboardImage(
  clipboardApi: Pick<ClipboardLike, "read">,
  nativeImageApi: Pick<ClipboardNativeImageApi, "createFromBuffer">,
): Promise<ClipboardImageTransfer | null> {
  const match = findClipboardImage(await clipboardApi.read());
  if (!match) return null;
  const payload = await match.item.getType(match.type);
  if (!isBlobLike(payload)) return null;
  if (payload.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("Clipboard image is too large to transfer");
  }
  const clipboardImage = nativeImageApi.createFromBuffer(Buffer.from(await payload.arrayBuffer()));
  if (clipboardImage.isEmpty()) return null;
  const sourceSize = clipboardImage.getSize();
  const image =
    sourceSize.width > MAX_CLIPBOARD_TRANSFER_DIMENSION ||
    sourceSize.height > MAX_CLIPBOARD_TRANSFER_DIMENSION
      ? clipboardImage.resize({
          ...(sourceSize.width >= sourceSize.height
            ? { width: MAX_CLIPBOARD_TRANSFER_DIMENSION }
            : { height: MAX_CLIPBOARD_TRANSFER_DIMENSION }),
          quality: "best",
        })
      : clipboardImage;
  const size = image.getSize();
  return { width: size.width, height: size.height, dataUrl: image.toDataURL() };
}

/** Write an image data URL to the clipboard as PNG. */
export async function writeClipboardImage(
  clipboardApi: Pick<ClipboardLike, "write">,
  nativeImageApi: Pick<ClipboardNativeImageApi, "createFromDataURL">,
  createClipboardItem: CreateClipboardItem,
  dataUrl: string,
): Promise<void> {
  const image = nativeImageApi.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error("Expected an image data URL");
  const png = new Uint8Array(image.toPNG());
  await clipboardApi.write([
    createClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
  ]);
}

/**
 * Fire-and-forget text writer for synchronous callers such as menu items.
 * `clipboard.writeText` returns a Promise in Electron 44; an unobserved
 * rejection would terminate the main process, so every failure is logged here.
 */
export function createClipboardTextWriter(
  clipboardApi: Pick<ClipboardLike, "writeText">,
  logError: (error: unknown) => void,
): (text: string) => void {
  return (text) => {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(clipboardApi.writeText(text));
    } catch (error) {
      logError(error);
      return;
    }
    pending.catch((error: unknown) => logError(error));
  };
}
