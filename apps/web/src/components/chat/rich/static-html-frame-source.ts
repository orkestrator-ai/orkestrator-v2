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
 * A build whose host policy cannot run the frame (no emitted frame document and
 * a `script-src 'self'` that refuses the `srcdoc` bootstrap) declares
 * `ORKESTRATOR_STATIC_HTML_PRESENTATION=unavailable`, and its cards stay on saved
 * previews. No build does now: the hosted client (`apps/web-public`) emits the
 * frame document and serves it under its own `vercel.json` rule.
 */
export function staticHtmlPresentationSupported(
  declared = import.meta.env.ORKESTRATOR_STATIC_HTML_PRESENTATION,
): boolean {
  return declared !== "unavailable";
}
