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
 *
 * One thing is let in, and it is text rather than a request: a stylesheet linked
 * from the file's own folder or below is read by the app and inlined as a
 * `<style>`, so the frame still loads nothing. See `resolveSiblingFilePath`.
 * Links to sibling pages are not followed inside the frame (it cannot report a
 * click without scripts); the tab lists them instead.
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

/** Stylesheets inlined per page, and the largest one the app will read for it. */
export const MAX_SIBLING_STYLESHEETS = 16;
export const MAX_SIBLING_STYLESHEET_BYTES = 512 * 1024;
const MAX_SIBLING_PAGE_LINKS = 200;

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Resolve a reference found in an HTML file to a workspace-relative path, only
 * when it names a file in that file's own folder or below. URLs, absolute and
 * network-path references, backslashes and any `..` that would climb out of the
 * folder yield null. The path is decoded first, so `%2e%2e` cannot hide a climb.
 * This is the page's own boundary; the backend's file reads add the workspace
 * and symlink checks.
 */
export function resolveSiblingFilePath(htmlFilePath: string, href: string): string | null {
  const reference = href.trim();
  if (!reference || reference.startsWith("#") || reference.startsWith("/")) return null;
  if (URL_SCHEME.test(reference)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
  if (!decoded || decoded.endsWith("/") || /[\\\0\r\n]/.test(decoded)) return null;
  const inside: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (inside.length === 0) return null;
      inside.pop();
    } else inside.push(segment);
  }
  if (inside.length === 0) return null;
  return [...htmlFilePath.split("/").slice(0, -1), ...inside].join("/");
}

function isStylesheetLink(element: Element): boolean {
  const rel = element.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
  return rel.includes("stylesheet") && !rel.includes("alternate") && element.hasAttribute("href");
}

/** Workspace paths of the page's stylesheets that live in its folder or below. */
export function findSiblingStylesheetPaths(html: string, htmlFilePath: string): string[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const paths = new Set<string>();
  for (const link of Array.from(parsed.querySelectorAll("link"))) {
    if (!isStylesheetLink(link)) continue;
    const path = resolveSiblingFilePath(htmlFilePath, link.getAttribute("href") ?? "");
    if (path) paths.add(path);
    if (paths.size >= MAX_SIBLING_STYLESHEETS) break;
  }
  return Array.from(paths);
}

export interface SiblingPageLink {
  /** Workspace-relative path of the linked HTML file. */
  path: string;
  label: string;
}

/** The page's links to other HTML files in its folder or below, in document order. */
export function findSiblingPageLinks(html: string, htmlFilePath: string): SiblingPageLink[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const links = new Map<string, SiblingPageLink>();
  for (const anchor of Array.from(parsed.querySelectorAll("a[href], area[href]"))) {
    const path = resolveSiblingFilePath(htmlFilePath, anchor.getAttribute("href") ?? "");
    if (!path || path === htmlFilePath || !/\.html?$/i.test(path) || links.has(path)) continue;
    const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    links.set(path, { path, label: text.slice(0, 80) || path.split("/").pop() || path });
    if (links.size >= MAX_SIBLING_PAGE_LINKS) break;
  }
  return Array.from(links.values());
}

export interface HtmlPreviewOptions {
  /** Workspace path of the file being previewed, which its relative references resolve against. */
  filePath: string;
  /** Text of stylesheets already read, keyed by the workspace path they resolve to. */
  stylesheets: ReadonlyMap<string, string>;
}

/**
 * Raw-text elements end at the first `</style`, and the serializer does not
 * escape their text, so a stylesheet containing one would close its own element
 * and have the rest parsed as markup.
 */
function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/** Replace each readable sibling stylesheet link with the file's text as an inline style. */
function inlineSiblingStylesheets(parsed: Document, options: HtmlPreviewOptions): void {
  for (const link of Array.from(parsed.querySelectorAll("link"))) {
    if (!isStylesheetLink(link)) continue;
    const path = resolveSiblingFilePath(options.filePath, link.getAttribute("href") ?? "");
    const css = path ? options.stylesheets.get(path) : undefined;
    if (css === undefined) continue;
    const style = parsed.createElement("style");
    const media = link.getAttribute("media");
    if (media) style.setAttribute("media", media);
    style.textContent = escapeStyleText(css);
    link.replaceWith(style);
  }
}

function isFragmentLink(element: Element): boolean {
  const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
  return href?.trim().startsWith("#") ?? false;
}

export function buildHtmlPreviewDocument(
  html: string,
  options?: HtmlPreviewOptions,
): HtmlPreviewDocument {
  // A DOMParser document is inert: nothing in it runs or loads here.
  let candidate = html;
  let refused = false;
  // Require a fixed point under the browser's HTML parser. Namespace mutation
  // can expose nodes only on a subsequent parse, so rewrite every pass and never
  // publish a document that still changes when reparsed.
  for (let pass = 0; pass < 5; pass++) {
    const parsed = new DOMParser().parseFromString(candidate, "text/html");
    // Inline first, so the inlined text is checked like any other style: its own
    // @import and url() references are still refused.
    if (options) inlineSiblingStylesheets(parsed, options);
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
  // `options` is deliberately not passed: the fallback is plain text.
  return { ...safe, hasRefusedContent: refused };
}
