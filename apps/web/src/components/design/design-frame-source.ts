import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { createUuid } from "@/lib/uuid";

/**
 * Where a design frame's runtime comes from. A production build of the app
 * ships it as a document, because a `srcdoc` frame would inherit the renderer's
 * `script-src 'self'` (`vite-plugin-renderer-security.ts`). Both forms load in a
 * sandbox without `allow-same-origin`, so the frame is opaque either way.
 */
export function designFrameSource(): { src: string } | { srcDoc: string } {
  const document = import.meta.env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT;
  return document ? { src: document } : { srcDoc: designBootstrap(createUuid()) };
}
