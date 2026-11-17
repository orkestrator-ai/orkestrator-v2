/**
 * Writes images to the clipboard from either client: the desktop app through
 * its preload (which also offers a WebP as a raw platform format), a browser
 * through the async Clipboard API. Kept apart from `@/lib/native/clipboard`,
 * which the test setup replaces wholesale.
 */

/**
 * The desktop app's clipboard, when this window has one. A browser gateway
 * client also has `window.orkestrator.clipboard`, but its `writeImage` does
 * nothing, so a browser always writes through `navigator.clipboard`.
 */
function desktopClipboard() {
  if (typeof window === "undefined") return undefined;
  const gateway = window.orkestratorGateway;
  if (gateway?.enabled && !gateway.desktop) return undefined;
  const clipboard = window.orkestrator?.clipboard;
  return typeof clipboard?.writeImage === "function" ? clipboard : undefined;
}

function browserCanWriteImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/** Whether this client can put an image on the clipboard at all. */
export function canWriteImage(): boolean {
  if (typeof window === "undefined") return false;
  return desktopClipboard() !== undefined || browserCanWriteImage();
}

/**
 * Whether a copied image can also carry a WebP. The desktop app writes it as a
 * raw platform format; a browser only when its clipboard accepts `image/webp`
 * (no shipping browser does yet, so there this is normally false).
 */
export function canWriteWebpImage(): boolean {
  if (desktopClipboard()) return true;
  if (!canWriteImage()) return false;
  return typeof ClipboardItem.supports === "function" && ClipboardItem.supports("image/webp");
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Puts an image on the clipboard: always a PNG, plus a WebP of the same image
 * when `webp` is given. Call it straight from the user's click: a browser
 * accepts the write only during the gesture, so the clipboard entry is created
 * before either image has finished preparing.
 */
export function writeImage(images: { png: Promise<Blob>; webp?: Promise<Blob> }): Promise<void> {
  // The PNG's failure is the one reported; never leave the WebP's unobserved.
  images.webp?.catch(() => undefined);
  const desktop = desktopClipboard();
  if (desktop) {
    return (async () => {
      const [png, webp] = await Promise.all([images.png, images.webp]);
      await desktop.writeImage(
        await blobToDataUrl(png),
        webp ? { webpDataUrl: await blobToDataUrl(webp) } : undefined,
      );
    })();
  }
  if (!browserCanWriteImage()) {
    return Promise.reject(new Error("This browser cannot copy images to the clipboard"));
  }
  return navigator.clipboard.write([
    new ClipboardItem({
      "image/png": images.png,
      ...(images.webp ? { "image/webp": images.webp } : {}),
    }),
  ]);
}
