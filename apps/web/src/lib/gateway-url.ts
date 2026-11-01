function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * The configured gateway origin. A desktop window on a tunnelled route asks
 * the native layer each time, because a reconnect can move the tunnel to
 * another local port; a forwarded-port URL is never kept in durable state.
 */
function configuredGatewayBaseUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const gateway = window.orkestratorGateway;
  if (!gateway) return undefined;
  let resolved: string | undefined;
  try {
    resolved = gateway.resolveBaseUrl?.();
  } catch {
    resolved = undefined;
  }
  return (resolved || gateway.baseUrl)?.replace(/\/$/, "");
}

export function getGatewayBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return configuredGatewayBaseUrl() ?? window.location.origin;
}

export function resolveGatewayApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const configuredBaseUrl = configuredGatewayBaseUrl();
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

/** Whether renderer commands are routed through a non-local Orkestrator gateway. */
export function isRemoteGatewayConnection(): boolean {
  if (typeof window === "undefined") return false;
  const gateway = window.orkestratorGateway;
  if (!gateway?.enabled) return false;

  // The Electron preload only publishes this flag for configured remote
  // connections. Browser clients do not have the flag, so classify those from
  // the gateway origin instead.
  if (gateway.desktop === true) return true;

  try {
    const url = new URL(gateway.baseUrl ?? window.location.origin);
    return !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether backend commands run on a different computer from this client, so
 * anything they launch (an editor window) would open out of the user's sight.
 * A gateway alone does not mean that: it can lead back to this computer.
 */
export function isBackendOnAnotherDevice(): boolean {
  return isRemoteGatewayConnection() && window.orkestratorGateway?.backendOnThisDevice !== true;
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
