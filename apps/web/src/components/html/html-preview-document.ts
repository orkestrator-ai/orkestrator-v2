/**
 * Prepares a workspace HTML file for the Rendered view of its file tab.
 *
 * The file comes from a repository and may be hostile, so viewing it must not
 * run it or reach the network. The boundary is three layers, each checked
 * against Chromium:
 *
 * - The iframe's empty `sandbox` gives the document an opaque origin and stops
 *   scripts, forms, popups, meta refresh and top-level navigation. A script
 *   would also share this renderer's process, so a busy loop could freeze the
 *   whole application.
 * - The CSP injected here, ahead of everything the file declares, refuses every
 *   external resource. Merely opening a file must not fetch a remote URL, and a
 *   relative URL must not reach the application's own origin.
 * - Links are rewritten, because the sandbox does not stop a frame navigating
 *   itself. A fragment link stays, resolved against `about:srcdoc` so it scrolls
 *   rather than loading the embedder's URL. Any other link targets a popup, which
 *   the sandbox refuses; left alone, a click would replace the file with the
 *   destination (or `about:blank#blocked`, for a relative URL).
 */

/** Sandbox flags of the preview iframe: none, deliberately. */
export const HTML_PREVIEW_SANDBOX = "";

export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** Elements whose content the preview refuses, for telling the user why a page looks incomplete. */
const REFUSED_CONTENT_SELECTOR = [
  "script",
  "iframe",
  "object",
  "embed",
  "link[rel~='stylesheet'][href]",
  "img[src]:not([src^='data:'])",
  "video[src]:not([src^='data:'])",
  "audio[src]:not([src^='data:'])",
  "source[src]:not([src^='data:'])",
].join(", ");

export interface HtmlPreviewDocument {
  srcDoc: string;
  /** True when the file uses scripts or external files that the preview refuses to load. */
  hasRefusedContent: boolean;
}

function isFragmentLink(element: Element): boolean {
  const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
  return href?.trim().startsWith("#") ?? false;
}

export function buildHtmlPreviewDocument(html: string): HtmlPreviewDocument {
  // A DOMParser document is inert: nothing in it runs or loads here.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const hasRefusedContent = parsed.querySelector(REFUSED_CONTENT_SELECTOR) !== null;

  for (const base of Array.from(parsed.querySelectorAll("base"))) base.remove();

  const csp = parsed.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", HTML_PREVIEW_CSP);
  const base = parsed.createElement("base");
  base.setAttribute("href", "about:srcdoc");
  parsed.head.prepend(csp, base);

  for (const link of Array.from(parsed.querySelectorAll("a, area"))) {
    if (isFragmentLink(link)) link.removeAttribute("target");
    else link.setAttribute("target", "_blank");
  }

  // Keep the doctype: dropping it would switch the page into quirks mode.
  const doctype = parsed.doctype ? new XMLSerializer().serializeToString(parsed.doctype) : "";
  return { srcDoc: `${doctype}${parsed.documentElement.outerHTML}`, hasRefusedContent };
}
