import { getGatewayTokenValidationError, normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";

const ADDRESS_KEY = "orkestrator.public.backend-address";
const SESSION_TOKEN_KEY = "orkestrator.public.gateway-token";
const REMEMBERED_TOKEN_KEY = "orkestrator.public.remembered-gateway-token";
export const SKIP_AUTO_CONNECT_KEY = "orkestrator.public.skip-auto-connect";
export const DEFAULT_BACKEND_CONNECTION_TIMEOUT_MS = 10_000;

export interface SavedConnection {
  address: string;
  token: string;
  rememberToken: boolean;
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
  const rememberedToken = localStorage.getItem(REMEMBERED_TOKEN_KEY) ?? "";
  return {
    address: localStorage.getItem(ADDRESS_KEY) ?? "",
    token: sessionStorage.getItem(SESSION_TOKEN_KEY) ?? rememberedToken,
    rememberToken: rememberedToken.length > 0,
  };
}

export function saveConnection(connection: SavedConnection): void {
  localStorage.setItem(ADDRESS_KEY, connection.address);
  sessionStorage.setItem(SESSION_TOKEN_KEY, connection.token);
  if (connection.rememberToken) {
    localStorage.setItem(REMEMBERED_TOKEN_KEY, connection.token);
  } else {
    localStorage.removeItem(REMEMBERED_TOKEN_KEY);
  }
}

export function forgetConnection(): void {
  localStorage.removeItem(ADDRESS_KEY);
  localStorage.removeItem(REMEMBERED_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export function updateSavedToken(token: string, rememberToken: boolean): void {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  if (rememberToken) localStorage.setItem(REMEMBERED_TOKEN_KEY, token);
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
