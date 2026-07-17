export interface ClipboardImage {
  rgba(): Promise<Uint8Array>;
  size(): Promise<{ width: number; height: number }>;
}

async function decodeImageData(dataUrl: string): Promise<ImageData> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is not available");

  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Clipboard image could not be read"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Clipboard image could not be read"));
    reader.readAsDataURL(blob);
  });
}

function createClipboardImage(
  dataUrl: string,
  dimensions?: { width: number; height: number },
): ClipboardImage {
  let imageData: ImageData | null = null;
  const getImageData = async () => {
    imageData ??= await decodeImageData(dataUrl);
    return imageData;
  };

  return {
    async rgba() {
      return new Uint8Array((await getImageData()).data);
    },
    async size() {
      if (dimensions) return dimensions;
      const decoded = await getImageData();
      return { width: decoded.width, height: decoded.height };
    },
  };
}

export async function readImage(pastedBlob?: Blob | null): Promise<ClipboardImage> {
  if (pastedBlob) {
    return createClipboardImage(await blobToDataUrl(pastedBlob));
  }

  // A real browser paste event has already exposed all readable data through
  // clipboardData. Avoid a second async clipboard read (and its permission UI)
  // when that event contained no image. Calls without an event still use the
  // async browser API for terminal/context-menu paste commands.
  if (pastedBlob === null && window.orkestratorGateway?.enabled) {
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
