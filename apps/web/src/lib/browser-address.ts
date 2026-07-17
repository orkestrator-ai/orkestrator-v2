import { isGatewayBrowserPreviewSupported, resolveGatewayBrowserPreviewUrl } from "@/lib/gateway-url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface BrowserAddress {
  /** Canonical address displayed to the user and persisted with the tab. */
  displayUrl: string;
  /** Address loaded by the iframe, routed through the backend gateway when remote. */
  iframeUrl: string;
}

/**
 * Direct previews keep their real origin (the iframe grants allow-same-origin),
 * so previewing the renderer's own origin would let previewed code lift its
 * sandbox and reach the app. Electron's main process already blocks subframe
 * navigation onto the renderer; this keeps the invariant in browser contexts
 * that have no main process. A server bound to a loopback port answers on
 * every loopback alias, so any loopback address sharing the renderer's port
 * is the renderer.
 */
function isRendererServedAddress(previewUrl: URL): boolean {
  if (typeof window === "undefined") return false;
  const renderer = window.location;
  if (renderer.protocol !== "http:" || !LOOPBACK_HOSTS.has(renderer.hostname)) return false;
  return (renderer.port || "80") === (previewUrl.port || "80");
}

export function resolveBrowserAddress(value: string): BrowserAddress {
  if (!isGatewayBrowserPreviewSupported()) {
    throw new Error("Browser previews are only available in the desktop app when connected remotely.");
  }

  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a backend-local address.");

  const shorthand = /^:?([0-9]{1,5})(\/.*)?$/.exec(trimmed);
  const candidate = shorthand
    ? `http://localhost:${shorthand[1]}${shorthand[2] ?? "/"}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter an address such as localhost:3000.");
  }

  if (url.protocol !== "http:") {
    throw new Error("Browser previews currently support backend-local HTTP addresses.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Use localhost or 127.0.0.1 to preview a service on the backend machine.");
  }
  if (url.username || url.password) {
    throw new Error("Addresses with embedded credentials are not supported.");
  }
  const port = url.port ? Number.parseInt(url.port, 10) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Enter a port between 1 and 65535.");
  }

  const displayUrl = url.toString();
  const iframeUrl = resolveGatewayBrowserPreviewUrl(displayUrl);
  if (iframeUrl === displayUrl && isRendererServedAddress(url)) {
    throw new Error("This address serves the Orkestrator app itself. Enter the address of a service you want to preview.");
  }
  return { displayUrl, iframeUrl };
}
