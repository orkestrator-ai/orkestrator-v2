import {
  readClipboardImageBlob,
  validateClipboardImageDimensions,
} from "@/lib/clipboard-image";

export interface ClipboardImage {
  rgba(): Promise<Uint8Array>;
  size(): Promise<{ width: number; height: number }>;
}

async function decodeImageData(
  dataUrl: string,
  expectedDimensions?: { width: number; height: number },
): Promise<ImageData> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const decodedDimensions = validateClipboardImageDimensions(image.naturalWidth, image.naturalHeight);
  if (
    expectedDimensions &&
    (decodedDimensions.width !== expectedDimensions.width ||
      decodedDimensions.height !== expectedDimensions.height)
  ) {
    throw new Error("Clipboard image dimensions do not match its encoded metadata");
  }

  const canvas = document.createElement("canvas");
  canvas.width = decodedDimensions.width;
  canvas.height = decodedDimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is not available");

  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function createClipboardImage(
  dataUrl: string,
  dimensions?: { width: number; height: number },
): ClipboardImage {
  const safeDimensions = dimensions
    ? validateClipboardImageDimensions(dimensions.width, dimensions.height)
    : undefined;
  let imageData: ImageData | null = null;
  const getImageData = async () => {
    imageData ??= await decodeImageData(dataUrl, safeDimensions);
    return imageData;
  };

  return {
    async rgba() {
      return new Uint8Array((await getImageData()).data);
    },
    async size() {
      if (safeDimensions) return safeDimensions;
      const decoded = await getImageData();
      return { width: decoded.width, height: decoded.height };
    },
  };
}

export async function readImage(pastedBlob?: Blob | null): Promise<ClipboardImage> {
  if (pastedBlob) {
    const { dataUrl, width, height } = await readClipboardImageBlob(pastedBlob);
    return createClipboardImage(dataUrl, { width, height });
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

  return createClipboardImage(image.dataUrl, { width: image.width, height: image.height });
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
