/**
 * Return the image file exposed by a native paste event, if there is one.
 *
 * Browsers usually expose pasted screenshots through DataTransfer.items, but
 * WebKit can expose the same payload only through DataTransfer.files. Check
 * both so the web client and the iOS WKWebView follow the same code path.
 */
export function getPastedImageBlob(event: ClipboardEvent): Blob | null {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return null;

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }

  return null;
}
