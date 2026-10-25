import { safeArtifactFilename } from "@orkestrator/protocol/transcript-artifacts";

/**
 * Host-owned downloads for rich transcript content. Filenames are derived
 * independently of titles (`safeArtifactFilename`); nothing here opens or
 * executes what it saves, and object URLs are revoked after the click.
 */

export function artifactFilename(title: string, extension: string): string {
  return safeArtifactFilename(title, extension);
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== "function")
    throw new Error("Downloads are not available here");
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a tick to start the download before releasing the bytes.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadText(text: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: mimeType }), filename);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function downloadBase64(base64: string, filename: string, mimeType: string): void {
  const bytes = base64ToBytes(base64);
  downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }), filename);
}

/**
 * Paper of the artifact print profile for this reader: US Letter where it is
 * the norm (United States, Canada, Mexico and a few others), A4 elsewhere.
 * The backend accepts only these two fixed sizes.
 */
export function defaultPrintPaper(
  locale: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language,
): "a4" | "letter" {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale ?? "")?.[1]?.toUpperCase();
  return region && ["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT"].includes(region)
    ? "letter"
    : "a4";
}

/**
 * Print a saved static PNG capture through an application-owned, script-free
 * document. Live authored content is never printed with `window.print()`.
 */
export function printStaticCapture(pngBase64: string, title: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-modals allow-same-origin");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error("Printing is not available here");
  }
  doc.title = title;
  const image = doc.createElement("img");
  image.alt = title;
  image.style.maxWidth = "100%";
  image.src = `data:image/png;base64,${pngBase64}`;
  doc.body.style.margin = "0";
  doc.body.appendChild(image);
  const finish = () => {
    try {
      win.focus();
      win.print();
    } finally {
      setTimeout(() => frame.remove(), 1_000);
    }
  };
  if (image.complete) finish();
  else image.addEventListener("load", finish, { once: true });
}
