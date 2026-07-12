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

export async function readImage(): Promise<ClipboardImage> {
  const image = await window.orkestrator?.clipboard.readImage();
  if (!image) throw new Error("No image in clipboard");

  let imageData: ImageData | null = null;
  const getImageData = async () => {
    imageData ??= await decodeImageData(image.dataUrl);
    return imageData;
  };

  return {
    async rgba() {
      return new Uint8Array((await getImageData()).data);
    },
    async size() {
      return { width: image.width, height: image.height };
    },
  };
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
