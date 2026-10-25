/**
 * A counter that changes when the document finishes loading fonts.
 *
 * Highlight cache identity includes it (with theme and highlighter version,
 * see `rich-identity.ts`), so output produced while a font was still loading
 * is never reused as if it were settled under the final font set. It only
 * changes on `loadingdone` events, so it is cheap and stable afterwards.
 */
import { useSyncExternalStore } from "react";

let generation = 0;
const listeners = new Set<() => void>();
let attached = false;

function fontSet(): FontFaceSet | null {
  if (typeof document === "undefined") return null;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  return fonts && typeof fonts.addEventListener === "function" ? fonts : null;
}

function attach(): void {
  if (attached) return;
  attached = true;
  fontSet()?.addEventListener("loadingdone", () => bumpFontGeneration());
}

/** Advance the generation (fonts finished loading; also used by tests). */
export function bumpFontGeneration(): void {
  generation++;
  for (const listener of Array.from(listeners)) listener();
}

export function fontGeneration(): number {
  return generation;
}

function subscribe(listener: () => void): () => void {
  attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => generation;

export function useFontGeneration(): number {
  return useSyncExternalStore(subscribe, read, read);
}
