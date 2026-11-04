import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { createUuid } from "@/lib/uuid";

/**
 * Where a design frame's runtime comes from. A production build of the app
 * ships it as a document, because a `srcdoc` frame would inherit the renderer's
 * `script-src 'self'` (`vite-plugin-renderer-security.ts`). Both forms load in a
 * sandbox without `allow-same-origin`, so the frame is opaque either way.
 */
export function designFrameSource(
  document = import.meta.env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT,
  pageUrl = window.location.href,
): { src: string } | { srcDoc: string } {
  // Gateway SPA routes can be nested; packaged documents are siblings of index.html.
  const base = pageUrl.startsWith("file:") ? pageUrl : new URL("/", pageUrl).href;
  return document
    ? { src: new URL(document, base).href }
    : { srcDoc: designBootstrap(createUuid()) };
}
