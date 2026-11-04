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

/** Detect resource forms even when CSS or responsive media selects them later. */
function hasRefusedContent(document: Document): boolean {
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const tag = element.localName.toLowerCase();
    if (["iframe", "object", "embed"].includes(tag)) return true;
    if (tag === "script") {
      const type = element.getAttribute("type")?.trim().toLowerCase() ?? "";
      if (!type || type === "module" || /(?:java|ecma)script/.test(type)) return true;
    }
    if (
      tag === "link" &&
      element.getAttribute("rel")?.split(/\s+/).includes("stylesheet") &&
      element.hasAttribute("href")
    )
      return true;
    for (const attr of [
      "src",
      "poster",
      ...(tag === "image" || tag === "use" ? ["href", "xlink:href"] : []),
    ]) {
      const value = element.getAttribute(attr)?.trim();
      if (value && !/^(data:|#)/i.test(value) && tag !== "script") return true;
    }
    // A srcset can contain data URLs with commas: conservatively explain it.
    if (element.hasAttribute("srcset")) return true;
    const css =
      (tag === "style" ? (element.textContent ?? "") : "") + (element.getAttribute("style") ?? "");
    if (/@import\b/i.test(css)) return true;
    for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (!/^(data:|#)/i.test(match[2]!.trim())) return true;
    }
  }
  return false;
}

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
  let candidate = html;
  let refused = false;
  // Require a fixed point under the browser's HTML parser. Namespace mutation
  // can expose nodes only on a subsequent parse, so rewrite every pass and never
  // publish a document that still changes when reparsed.
  for (let pass = 0; pass < 5; pass++) {
    const parsed = new DOMParser().parseFromString(candidate, "text/html");
    refused ||= hasRefusedContent(parsed);
    for (const animation of Array.from(
      parsed.querySelectorAll("animate, set, animateMotion, animateTransform, discard"),
    ))
      animation.remove();

    for (const base of Array.from(parsed.querySelectorAll("base"))) base.remove();
    for (const meta of Array.from(parsed.querySelectorAll("meta[http-equiv]"))) {
      if (meta.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy")
        meta.remove();
    }

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
    const serialized = `${doctype}${parsed.documentElement.outerHTML}`;
    if (serialized === candidate) return { srcDoc: serialized, hasRefusedContent: refused };
    candidate = serialized;
  }
  // Malformed markup that never stabilizes is displayed as text, not interpreted.
  const fallback = new DOMParser().parseFromString("<pre></pre>", "text/html");
  fallback.querySelector("pre")!.textContent = html;
  const safe = buildHtmlPreviewDocument(fallback.documentElement.outerHTML);
  return { ...safe, hasRefusedContent: refused };
}
