import {
  BACKEND_HELLO_PATH,
  isClientApiCompatible,
  parseBackendHello,
  type BackendHello,
} from "../../backend-profile.js";
import type { ConnectionTransportState } from "../../connections.js";

/**
 * The authenticated handshake with one route.
 *
 * Forward establishment or a TCP connect is not application health: a route
 * is usable only after the gateway accepted the token and answered a hello
 * (or, for an older backend without one, the authenticated status check).
 * Outcomes are typed so the route manager can tell a retryable network
 * failure from one that needs the user (credentials, trust, compatibility).
 */

export type ConnectionCheckCode =
  | "unreachable"
  | "timeout"
  | "authentication-required"
  | "incompatible"
  | "trust-blocked"
  | "protocol";

export type ConnectionCheckError = Error & {
  code: ConnectionCheckCode;
  retryable: boolean;
};

export function connectionCheckError(
  code: ConnectionCheckCode,
  message: string,
  cause?: unknown,
): ConnectionCheckError {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as ConnectionCheckError;
  error.code = code;
  error.retryable = code === "unreachable" || code === "timeout";
  return error;
}

const CONNECTION_CHECK_CODES = new Set<string>([
  "unreachable",
  "timeout",
  "authentication-required",
  "incompatible",
  "trust-blocked",
  "protocol",
]);

export function isConnectionCheckError(error: unknown): error is ConnectionCheckError {
  return (
    error instanceof Error &&
    CONNECTION_CHECK_CODES.has((error as Partial<ConnectionCheckError>).code as string) &&
    typeof (error as Partial<ConnectionCheckError>).retryable === "boolean"
  );
}

export function transportStateForError(error: unknown): ConnectionTransportState {
  if (!isConnectionCheckError(error)) return "unreachable";
  switch (error.code) {
    case "authentication-required":
      return "authentication-required";
    case "trust-blocked":
      return "trust-blocked";
    case "incompatible":
    case "protocol":
      return "incompatible";
    default:
      return "unreachable";
  }
}

export type HelloOutcome =
  /** The backend proved its installation identity and capabilities. */
  | { kind: "hello"; hello: BackendHello; latencyMs?: number }
  /** An older backend without the handshake: identity stays provisional. */
  | { kind: "legacy"; latencyMs?: number };

const MAX_HELLO_BYTES = 64 * 1024;

export type HelloOptions = {
  timeoutMs: number;
  /** Message used when the route is a network path the user can check. */
  unreachableMessage?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Authenticate and identify one route. Redirects are refused: application
 * authorization never follows a redirect to another origin.
 */
export async function checkBackendRoute(
  baseUrl: string,
  token: string,
  options: HelloOptions,
): Promise<HelloOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = performance.now();
  try {
    const hello = await requestJson(
      fetchImpl,
      new URL(BACKEND_HELLO_PATH, baseUrl),
      token,
      controller.signal,
    );
    if (hello.status === 401)
      throw connectionCheckError("authentication-required", "The gateway token was rejected.");
    if (hello.status === 200 && hello.json !== undefined) {
      try {
        const parsed = parseBackendHello(hello.json);
        if (!isClientApiCompatible(parsed)) {
          throw connectionCheckError(
            "incompatible",
            `This backend (${parsed.appVersion}) does not support this client's API version. Update one of them.`,
          );
        }
        return { kind: "hello", hello: parsed, latencyMs: performance.now() - started };
      } catch (error) {
        if (isConnectionCheckError(error)) throw error;
        // A 200 that is not a hello is an older backend serving its renderer
        // for an unknown path: fall through to the authenticated status check.
      }
    }
    const status = await requestJson(
      fetchImpl,
      new URL("/__orkestrator/status", baseUrl),
      token,
      controller.signal,
    );
    const payload = (status.json ?? {}) as { ok?: boolean; error?: string };
    if (status.status === 401) {
      throw connectionCheckError("authentication-required", "The gateway token was rejected.");
    }
    if (status.status < 200 || status.status >= 300 || payload.ok !== true) {
      throw connectionCheckError(
        "protocol",
        typeof payload.error === "string"
          ? payload.error.slice(0, 200)
          : `Backend check failed with HTTP ${status.status}.`,
      );
    }
    return { kind: "legacy", latencyMs: performance.now() - started };
  } catch (error) {
    if (controller.signal.aborted) {
      const seconds = options.timeoutMs / 1_000;
      throw connectionCheckError(
        "timeout",
        `The backend did not respond within ${seconds} second${seconds === 1 ? "" : "s"}.`,
        error,
      );
    }
    if (isConnectionCheckError(error)) throw error;
    if (error instanceof TypeError) {
      throw connectionCheckError(
        "unreachable",
        options.unreachableMessage ??
          "Could not reach the backend. Check its HTTPS address and Tailscale connection.",
        error,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: URL,
  token: string,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw connectionCheckError(
      "protocol",
      "The backend answered with a redirect. Use its final HTTPS origin.",
    );
  }
  const text = await response.text().catch(() => "");
  if (text.length > MAX_HELLO_BYTES) return { status: response.status, json: undefined };
  try {
    return { status: response.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, json: undefined };
  }
}
