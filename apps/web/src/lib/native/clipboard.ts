import {
  ClipboardImageValidationError,
  getNormalizedClipboardImageDimensions,
  MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES,
  readClipboardImageBlob,
  readClipboardImageDimensions,
  validateClipboardImageDimensions,
} from "@/lib/clipboard-image";

export interface ClipboardImage {
  rgba(): Promise<Uint8Array>;
  size(): Promise<{ width: number; height: number }>;
}

type ImageDimensions = { width: number; height: number };
const MAX_DATA_URL_FALLBACK_PIXELS = 8 * 1024 * 1024;

function readCanvasImageData(
  source: CanvasImageSource,
  outputDimensions: ImageDimensions,
): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = outputDimensions.width;
  canvas.height = outputDimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is not available");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, outputDimensions.width, outputDimensions.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function decodeDataUrlImage(
  dataUrl: string,
  expectedDimensions?: ImageDimensions,
): Promise<ImageData> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const sourceDimensions = validateClipboardImageDimensions(
    image.naturalWidth,
    image.naturalHeight,
  );
  if (
    expectedDimensions &&
    (sourceDimensions.width !== expectedDimensions.width ||
      sourceDimensions.height !== expectedDimensions.height)
  ) {
    throw new Error("Clipboard image dimensions do not match its encoded metadata");
  }
  const outputDimensions = getNormalizedClipboardImageDimensions(
    sourceDimensions.width,
    sourceDimensions.height,
  );
  return readCanvasImageData(image, outputDimensions);
}

async function decodeBlobImage(
  blob: Blob,
  sourceDimensions: ImageDimensions,
): Promise<ImageData> {
  const outputDimensions = getNormalizedClipboardImageDimensions(
    sourceDimensions.width,
    sourceDimensions.height,
  );

  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob, {
        imageOrientation: "none",
        resizeWidth: outputDimensions.width,
        resizeHeight: outputDimensions.height,
        resizeQuality: "high",
      });
    } catch (error) {
      if (
        blob.size > MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES ||
        sourceDimensions.width * sourceDimensions.height > MAX_DATA_URL_FALLBACK_PIXELS
      ) {
        throw error;
      }
    }
    if (bitmap) {
      try {
        return readCanvasImageData(bitmap, outputDimensions);
      } finally {
        bitmap.close();
      }
    }
  }

  if (
    blob.size > MAX_CLIPBOARD_IMAGE_DATA_URL_BYTES ||
    sourceDimensions.width * sourceDimensions.height > MAX_DATA_URL_FALLBACK_PIXELS
  ) {
    throw new ClipboardImageValidationError(
      "This browser cannot safely resize the clipboard image during decoding",
      "too-large",
    );
  }
  const { dataUrl } = await readClipboardImageBlob(blob);
  return decodeDataUrlImage(dataUrl, sourceDimensions);
}

function createClipboardImage(
  dimensions: ImageDimensions,
  decode: () => Promise<ImageData>,
): ClipboardImage {
  const safeDimensions = validateClipboardImageDimensions(
    dimensions.width,
    dimensions.height,
  );
  const outputDimensions = getNormalizedClipboardImageDimensions(
    safeDimensions.width,
    safeDimensions.height,
  );
  let imageDataPromise: Promise<ImageData> | null = null;
  const getImageData = async () => {
    imageDataPromise ??= decode();
    return imageDataPromise;
  };

  return {
    async rgba() {
      return new Uint8Array((await getImageData()).data);
    },
    async size() {
      return outputDimensions;
    },
  };
}

export async function readImage(pastedBlob?: Blob | null): Promise<ClipboardImage> {
  if (pastedBlob) {
    const dimensions = await readClipboardImageDimensions(pastedBlob);
    return createClipboardImage(
      dimensions,
      () => decodeBlobImage(pastedBlob, dimensions),
    );
  }

  // A real browser paste event has already exposed all readable data through
  // clipboardData. Avoid a second async clipboard read (and its permission UI)
  // when that event contained no image. Calls without an event still use the
  // async browser API for terminal/context-menu paste commands.
  if (
    pastedBlob === null &&
    window.orkestratorGateway?.enabled &&
    !window.orkestratorGateway.desktop
  ) {
    throw new Error("No image in clipboard");
  }

  const image = await window.orkestrator?.clipboard.readImage();
  if (!image) throw new Error("No image in clipboard");

  const reportedDimensions = validateClipboardImageDimensions(image.width, image.height);
  if (image.blob instanceof Blob) {
    const encodedDimensions = await readClipboardImageDimensions(image.blob);
    if (
      encodedDimensions.width !== reportedDimensions.width ||
      encodedDimensions.height !== reportedDimensions.height
    ) {
      throw new Error("Clipboard image dimensions do not match its encoded metadata");
    }
    return createClipboardImage(
      encodedDimensions,
      () => decodeBlobImage(image.blob!, encodedDimensions),
    );
  }
  if (typeof image.dataUrl !== "string") {
    throw new Error("Clipboard image payload is invalid");
  }
  return createClipboardImage(
    reportedDimensions,
    () => decodeDataUrlImage(image.dataUrl!, reportedDimensions),
  );
}

export async function readText(): Promise<string> {
  if (window.orkestrator) return window.orkestrator.clipboard.readText();
  return navigator.clipboard.readText();
}

export async function writeText(text: string): Promise<void> {
  if (window.orkestrator) {
    await window.orkestrator.clipboard.writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
