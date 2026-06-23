function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function resolveGatewayLoopbackBaseUrl(baseUrl: string): string {
  if (typeof window === "undefined" || !window.orkestratorGateway?.enabled) return baseUrl;

  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname) || !url.port) return baseUrl;

    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${window.location.origin}/__orkestrator/proxy/loopback/${url.port}${basePath}`;
  } catch {
    return baseUrl;
  }
}
