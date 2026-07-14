import { getGatewayTokenValidationError, normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";

const ADDRESS_KEY = "orkestrator.public.backend-address";
const SESSION_TOKENS_KEY = "orkestrator.public.gateway-tokens";
const CONNECTIONS_KEY = "orkestrator.public.connections";
const LEGACY_SESSION_TOKEN_KEY = "orkestrator.public.gateway-token";
const LEGACY_REMEMBERED_TOKEN_KEY = "orkestrator.public.remembered-gateway-token";
export const DEFAULT_BACKEND_CONNECTION_TIMEOUT_MS = 10_000;

export interface SavedConnection {
  address: string;
  token: string;
}

interface RecentConnection {
  id: string;
  name: string;
  address: string;
  lastConnectedAt: string;
}

function connectionId(address: string): string {
  return `remote:${address}`;
}

function loadSessionTokens(): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_TOKENS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

function loadRecentConnections(): RecentConnection[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONNECTIONS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentConnection => (
      !!entry && typeof entry === "object"
      && typeof (entry as RecentConnection).id === "string"
      && typeof (entry as RecentConnection).name === "string"
      && typeof (entry as RecentConnection).address === "string"
      && typeof (entry as RecentConnection).lastConnectedAt === "string"
    ));
  } catch {
    return [];
  }
}

function saveSessionTokens(tokens: Record<string, string>): void {
  sessionStorage.setItem(SESSION_TOKENS_KEY, JSON.stringify(tokens));
}

export function normalizeBackendAddress(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("Enter the backend address.");

  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    throw new Error("Enter a valid backend URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The backend address must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Put the gateway token in the token field, not in the URL.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use the backend origin only, without a path, query, or fragment.");
  }

  return url.origin;
}

export function insecureBackendWarning(
  address: string,
  pageProtocol = window.location.protocol,
): string | null {
  if (pageProtocol !== "https:") return null;
  try {
    if (new URL(normalizeBackendAddress(address)).protocol === "http:") {
      return "This hosted page is HTTPS. Most browsers will block a direct HTTP backend; use tailnet HTTPS.";
    }
  } catch {
    return null;
  }
  return null;
}

export function loadSavedConnection(): SavedConnection {
  const address = localStorage.getItem(ADDRESS_KEY) ?? "";
  const tokens = loadSessionTokens();
  const legacySessionToken = sessionStorage.getItem(LEGACY_SESSION_TOKEN_KEY) ?? "";
  if (address && legacySessionToken && !tokens[connectionId(address)]) {
    tokens[connectionId(address)] = legacySessionToken;
    saveSessionTokens(tokens);
  }
  sessionStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REMEMBERED_TOKEN_KEY);
  return {
    address,
    token: tokens[connectionId(address)] ?? "",
  };
}

export function saveConnection(connection: SavedConnection): void {
  const address = normalizeBackendAddress(connection.address);
  const id = connectionId(address);
  const now = new Date().toISOString();
  const recent: RecentConnection = { id, name: new URL(address).hostname, address, lastConnectedAt: now };
  localStorage.setItem(ADDRESS_KEY, address);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify([
    recent,
    ...loadRecentConnections().filter((entry) => entry.id !== id),
  ]));
  saveSessionTokens({ ...loadSessionTokens(), [id]: connection.token });
}

export function forgetConnection(): void {
  const address = localStorage.getItem(ADDRESS_KEY) ?? "";
  const id = connectionId(address);
  localStorage.removeItem(ADDRESS_KEY);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(loadRecentConnections().filter((entry) => entry.id !== id)));
  const tokens = loadSessionTokens();
  delete tokens[id];
  saveSessionTokens(tokens);
}

export function updateSavedToken(token: string): void {
  const address = localStorage.getItem(ADDRESS_KEY) ?? "";
  saveSessionTokens({ ...loadSessionTokens(), [connectionId(address)]: token });
}

export function listBrowserConnections(): ConnectionList {
  const activeAddress = localStorage.getItem(ADDRESS_KEY) ?? "";
  const activeConnectionId = activeAddress ? connectionId(activeAddress) : "";
  const tokens = loadSessionTokens();
  return {
    activeConnectionId,
    credentialStorage: "session-only",
    connections: loadRecentConnections().map<ConnectionSummary>((connection) => ({
      ...connection,
      kind: "remote",
      active: connection.id === activeConnectionId,
      requiresToken: !tokens[connection.id],
    })),
  };
}

export function selectBrowserConnection(id: string): ConnectionList {
  const connection = loadRecentConnections().find((entry) => entry.id === id);
  if (!connection) throw new Error("That saved connection no longer exists.");
  if (!loadSessionTokens()[id]) throw new Error("Enter the gateway token to reconnect to this server.");
  localStorage.setItem(ADDRESS_KEY, connection.address);
  return listBrowserConnections();
}

export function forgetBrowserConnection(id: string): ConnectionList {
  const connections = loadRecentConnections().filter((entry) => entry.id !== id);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
  const tokens = loadSessionTokens();
  delete tokens[id];
  saveSessionTokens(tokens);
  if (localStorage.getItem(ADDRESS_KEY) && connectionId(localStorage.getItem(ADDRESS_KEY) ?? "") === id) {
    localStorage.removeItem(ADDRESS_KEY);
  }
  return listBrowserConnections();
}

export async function checkBackendConnection(
  address: string,
  token: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const normalizedAddress = normalizeBackendAddress(address);
  const tokenError = getGatewayTokenValidationError(token);
  if (tokenError) throw new Error(tokenError);
  const normalizedToken = normalizeGatewayToken(token);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_BACKEND_CONNECTION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Connection timeout must be a positive number of milliseconds.");
  }
  const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  let response: Response;
  let payload: { ok?: boolean; error?: string };
  try {
    response = await fetch(`${normalizedAddress}/__orkestrator/status`, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: { authorization: `Bearer ${normalizedToken}` },
      signal: controller.signal,
    });
    try {
      payload = await response.json() as { ok?: boolean; error?: string };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      payload = {};
    }
  } catch {
    if (options.signal?.aborted) throw new Error("Connection check cancelled.");
    if (controller.signal.aborted) {
      const seconds = timeoutMs / 1_000;
      throw new Error(`The backend did not respond within ${seconds} second${seconds === 1 ? "" : "s"}.`);
    }
    throw new Error(
      "Could not reach the backend. Check its HTTPS address, Tailscale connection, and allowed origin setting.",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (response.status === 401) throw new Error("The gateway token was rejected.");
  if (response.status === 403) {
    throw new Error(payload.error === "Origin not allowed"
      ? "This site is not in the backend's allowed origins."
      : payload.error ?? "The backend refused this connection.");
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error ?? `Backend check failed with HTTP ${response.status}.`);
  }
  return normalizedAddress;
}
