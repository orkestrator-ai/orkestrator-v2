function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function getGatewayBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return window.orkestratorGateway?.baseUrl?.replace(/\/$/, "")
    ?? window.location.origin;
}

export function resolveGatewayApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const configuredBaseUrl = typeof window !== "undefined"
    ? window.orkestratorGateway?.baseUrl?.replace(/\/$/, "")
    : undefined;
  return configuredBaseUrl ? `${configuredBaseUrl}${normalizedPath}` : normalizedPath;
}

export function resolveGatewayLoopbackBaseUrl(baseUrl: string): string {
  if (typeof window === "undefined" || !window.orkestratorGateway?.enabled) return baseUrl;

  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname)) return baseUrl;

    const port = url.port || (url.protocol === "http:" ? "80" : "");
    if (!port) return baseUrl;

    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${getGatewayBaseUrl()}/__orkestrator/proxy/loopback/${port}${basePath}${url.search}${url.hash}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Browser previews load in a sandboxed (opaque-origin) iframe, so the gateway
 * auth cookie is never sent and a bearer token cannot be attached to document
 * loads. Only the Electron desktop app injects gateway credentials at the
 * network layer, so previews through a remote gateway are desktop-only.
 */
export function isGatewayBrowserPreviewSupported(): boolean {
  if (typeof window === "undefined") return true;
  const gateway = window.orkestratorGateway;
  return !gateway?.enabled || gateway.desktop === true;
}

/** Resolve a loopback page through the gateway's browser-preview namespace. */
export function resolveGatewayBrowserPreviewUrl(baseUrl: string): string {
  if (typeof window === "undefined" || !window.orkestratorGateway?.enabled) return baseUrl;

  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname) || url.protocol !== "http:") return baseUrl;
    const port = url.port || "80";
    const targetPath = `${url.pathname}${url.search}${url.hash}`;
    return `${getGatewayBaseUrl()}/__orkestrator/browser/loopback/${port}${targetPath}`;
  } catch {
    return baseUrl;
  }
}
