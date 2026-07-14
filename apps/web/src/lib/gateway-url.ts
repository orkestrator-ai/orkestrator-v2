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
    if (!isLoopbackHost(url.hostname) || !url.port) return baseUrl;

    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${getGatewayBaseUrl()}/__orkestrator/proxy/loopback/${url.port}${basePath}`;
  } catch {
    return baseUrl;
  }
}
