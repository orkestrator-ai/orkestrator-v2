import { isBackendId, isProvisionalBackendId } from "@orkestrator/protocol/federation";

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
  return resolveNodeLoopbackBaseUrl(getGatewayBaseUrl(), baseUrl);
}

/**
 * The URL of a gateway path on one node, from that node's base: a node
 * origin, or a relay base (`<command origin>/__orkestrator/nodes/<id>`). The
 * command node's own paths use `resolveGatewayApiUrl`.
 */
export function resolveNodeGatewayUrl(nodeBaseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${nodeBaseUrl.replace(/\/+$/, "")}${normalizedPath}`;
}

/** `resolveGatewayLoopbackBaseUrl` for one node: a loopback URL through that node's proxy. */
export function resolveNodeLoopbackBaseUrl(nodeBaseUrl: string, baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname)) return baseUrl;

    const port = url.port || (url.protocol === "http:" ? "80" : "");
    if (!port) return baseUrl;

    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return resolveNodeGatewayUrl(
      nodeBaseUrl,
      `/__orkestrator/proxy/loopback/${port}${basePath}${url.search}${url.hash}`,
    );
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

/**
 * The node a device check is for: a node scope (its role says whether it is
 * the command node), a node id, or nothing for the window's command node.
 * Callers pass the scope they render in; code with no scope yet passes
 * nothing until its store is scoped.
 */
export type DeviceCheckNode =
  { readonly nodeId: string; readonly role: "command" | "leaf" } | string | null | undefined;

/**
 * Whether `node` is the window's command node. A string id is the command
 * node when it is the command scope's provisional id or the window's proved
 * machine (`orkestratorDesktopIdentity.backendId`).
 */
function isCommandNode(node: DeviceCheckNode): boolean {
  if (node === null || node === undefined) return true;
  if (typeof node !== "string") return node.role === "command";
  if (isBackendId(node) && isProvisionalBackendId(node)) return true;
  const backendId =
    typeof window === "undefined" ? null : window.orkestratorDesktopIdentity?.backendId;
  return Boolean(backendId) && node === backendId;
}

/** This computer's own backend installation id (desktop only), or null when unknown. */
export function localInstallationId(): string | null {
  if (typeof window === "undefined") return null;
  return window.orkestratorDesktopIdentity?.localInstallationId || null;
}

/** Whether renderer commands are routed through a non-local Orkestrator gateway. */
export function isRemoteGatewayConnection(node?: DeviceCheckNode): boolean {
  // A leaf is always reached through a route: its own, an SSH loopback or the
  // command node's relay.
  if (!isCommandNode(node)) return true;
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
 * Whether `node`'s backend is this computer's own. On desktop that is exactly
 * `nodeId === localInstallationId` for a proved id. The command node falls
 * back to the gateway's word when either id is unknown: no gateway or a
 * loopback one is this computer, a desktop gateway is unless main said it
 * leads back here. Any other node is on another device unless proved here.
 */
export function backendOnThisDevice(node?: DeviceCheckNode): boolean {
  const local = localInstallationId();
  if (isCommandNode(node)) {
    const commandId =
      typeof window === "undefined" ? null : window.orkestratorDesktopIdentity?.backendId;
    if (local && commandId) return commandId === local;
    return (
      !isRemoteGatewayConnection() ||
      (typeof window !== "undefined" && window.orkestratorGateway?.backendOnThisDevice === true)
    );
  }
  const nodeId = typeof node === "string" ? node : node!.nodeId;
  return local !== null && nodeId === local;
}

/**
 * Whether backend commands run on a different computer from this client, so
 * anything they launch (an editor window) would open out of the user's sight.
 * A gateway alone does not mean that: it can lead back to this computer.
 */
export function isBackendOnAnotherDevice(node?: DeviceCheckNode): boolean {
  return !backendOnThisDevice(node);
}

/** Resolve a loopback page through the gateway's browser-preview namespace. */
export function resolveGatewayBrowserPreviewUrl(baseUrl: string): string {
  if (typeof window === "undefined" || !window.orkestratorGateway?.enabled) return baseUrl;
  return resolveNodeBrowserPreviewUrl(getGatewayBaseUrl(), baseUrl);
}

/** `resolveGatewayBrowserPreviewUrl` for one node: a loopback page through that node's preview namespace. */
export function resolveNodeBrowserPreviewUrl(nodeBaseUrl: string, baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!isLoopbackHost(url.hostname) || url.protocol !== "http:") return baseUrl;
    const port = url.port || "80";
    const targetPath = `${url.pathname}${url.search}${url.hash}`;
    return resolveNodeGatewayUrl(
      nodeBaseUrl,
      `/__orkestrator/browser/loopback/${port}${targetPath}`,
    );
  } catch {
    return baseUrl;
  }
}
