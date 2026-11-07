/**
 * The Content Security Policy of the application's own renderer document.
 *
 * The renderer shows attacker-influenced Markdown, Mermaid, SVG and transcripts,
 * and script running in it reaches the host through `window.orkestrator`. These
 * policies are the second layer behind the sanitisers: `script-src 'self'` is
 * the part that matters, so no source here may ever allow inline script or eval.
 *
 * Two delivery paths carry the same text. A production build writes it into
 * `index.html` as a `<meta>` tag for Electron's `file://` load, and the gateway
 * sends it as a response header with `frame-ancestors`, which a `<meta>` tag
 * ignores. A document with both obeys both, so the header must not need
 * anything the `<meta>` text refuses. A renderer dev server gets neither: Vite's
 * React preamble is an inline script.
 */

export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Monaco, xterm, Mermaid's SVG output and React `style` props all set inline styles.
  "style-src 'self' 'unsafe-inline'",
  // Markdown images keep working: a remote image is handed to the browser as is.
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: http: https:",
  // The user picks backends at run time. Remote ones must use HTTPS, but a CSP
  // source cannot name an IPv6 host, so plain `[::1]` needs the whole scheme.
  // `https:` already lets a script that runs send data anywhere.
  "connect-src 'self' data: blob: http: https: ws: wss:",
  // Previews and artifact content are framed from run-time origins (the design
  // and static HTML frame documents from 'self'). A gateway on a plain-HTTP
  // tailnet address publishes its previews beside it.
  "frame-src 'self' http: https: orkestrator-artifact-shell:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * `frame-ancestors 'self'` dates from the browser client's workspace realms,
 * same-origin iframes of this document (deleted in plan item 6002). Nothing
 * frames the renderer document now; `'self'` still admits only the gateway's
 * own origin. Tightening it to `'none'` is a separate policy change.
 */
export const GATEWAY_RENDERER_CONTENT_SECURITY_POLICY = `${RENDERER_CONTENT_SECURITY_POLICY}; frame-ancestors 'self'`;

/** The login page is one inline `<style>` and a form that posts back to the gateway. */
export const GATEWAY_LOGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

/**
 * A `srcdoc` frame inherits its parent's policy, whose `script-src 'self'`
 * refuses the design runtime's inline bootstrap. A production build therefore
 * emits the bootstrap as this document (`designFrameDocument`), whose own policy
 * applies instead. Its URL is under the renderer root.
 */
export const DESIGN_FRAME_DOCUMENT = "design-frame.html";

/**
 * The transcript's static HTML presentation runtime
 * (`static-html-presentation.ts`), emitted for the same reason as the design
 * frame document and served under the same frame policy.
 */
export const STATIC_HTML_FRAME_DOCUMENT = "static-html-frame.html";

/**
 * Keeps the design and static HTML frame documents opaque on the gateway's origin even when it
 * is opened without the sandbox attribute the renderer's iframe always sets.
 */
export const GATEWAY_DESIGN_FRAME_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts; frame-ancestors 'self'";
