import type { HostImageFile } from "@/lib/backend/files-sessions";
import {
  MAX_PROJECT_ICON_LENGTH,
  PROJECT_ICON_SIZE,
  normalizeProjectIcon,
} from "@orkestrator/protocol/project-icon";

const IMAGE_FILE_NAME = /\.(?:png|jpe?g|webp|gif|svg|ico|bmp|avif)$/i;

/** An image by its type, or by its name when the system reported no type (common for `.ico`). */
export function isProjectIconFile(file: Pick<File, "name" | "type">): boolean {
  return file.type ? file.type.startsWith("image/") : IMAGE_FILE_NAME.test(file.name);
}

/**
 * Scales a chosen image file, a favicon included, to the stored project icon:
 * a square `PROJECT_ICON_SIZE` PNG, centre-cropped so the sidebar never
 * stretches it. Falls back to WebP when a busy image's PNG is over the stored
 * bound. Whatever the source format, only the converted raster is stored.
 */
export async function projectIconFromFile(file: File): Promise<string> {
  if (!isProjectIconFile(file)) throw new Error("Choose an image file");
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = PROJECT_ICON_SIZE;
  canvas.height = PROJECT_ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot resize images");
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (!side) throw new Error("The image is empty");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    PROJECT_ICON_SIZE,
    PROJECT_ICON_SIZE,
  );
  for (const [type, quality] of [
    ["image/png", undefined],
    ["image/webp", 0.85],
  ] as const) {
    const icon = normalizeProjectIcon(canvas.toDataURL(type, quality));
    if (icon && icon.length <= MAX_PROJECT_ICON_LENGTH) return icon;
  }
  throw new Error("The image could not be made small enough");
}

/** Wraps an image read from the backend host as a `File` for `projectIconFromFile`. */
export function fileFromHostImage(image: HostImageFile): File {
  const binary = atob(image.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], image.name, { type: image.mimeType });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be read"));
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}
