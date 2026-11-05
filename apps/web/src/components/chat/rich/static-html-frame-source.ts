import { staticHtmlFrameBootstrap } from "@orkestrator/protocol/static-html-presentation";
import { emittedFrameDocumentUrl } from "@/components/design/design-frame-source";

/**
 * Where a static document frame's runtime comes from, on the same terms as the
 * design frame: a production build ships a document, because a `srcdoc` frame
 * would inherit the renderer's `script-src 'self'`. A document cannot carry a
 * fresh nonce in its script, so the mount's readiness nonce travels in the URL
 * fragment, which the frame reads itself and no server sees.
 */
export function staticHtmlFrameSource(
  mountNonce: string,
  document = import.meta.env.ORKESTRATOR_STATIC_HTML_FRAME_DOCUMENT,
  pageUrl = window.location.href,
): { src: string } | { srcDoc: string } {
  if (!document) return { srcDoc: staticHtmlFrameBootstrap(mountNonce) };
  return { src: `${emittedFrameDocumentUrl(document, pageUrl)}#${mountNonce}` };
}

/**
 * The hosted client's own policy (`apps/web-public/vercel.json`) refuses a
 * `srcdoc` bootstrap and its build emits no frame document, so a frame there
 * could only time out. That build says so, and its cards stay on saved previews.
 */
export function staticHtmlPresentationSupported(
  declared = import.meta.env.ORKESTRATOR_STATIC_HTML_PRESENTATION,
): boolean {
  return declared !== "unavailable";
}
