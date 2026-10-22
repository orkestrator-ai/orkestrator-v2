import type { ConnectionTransportState } from "../../connections.js";
import { validatePort, validateSshDestination } from "../../device-catalogue.js";
import { isConnectionCheckError, transportStateForError } from "./backend-hello.js";

/**
 * Opening one saved route as a base URL for the ordinary backend client.
 *
 * HTTPS routes are their own origin. SSH routes are a loopback forward
 * owned by the native tunnel supervisor. Everything above this boundary —
 * the client, the stores, the renderer — is the same for every route kind.
 */

export type RouteFailure = { code: string; message: string };

/** The fields of a saved route (desktop catalogue or command-node registry) a link needs. */
export type LinkHttpsRoute = { id: string; kind: "https"; origin: string };
export type LinkSshRoute = {
  id: string;
  kind: "ssh";
  destination: string;
  sshPort?: number;
  identityFile?: string;
  remoteGatewayPort: number;
};
export type LinkRoute = LinkHttpsRoute | LinkSshRoute;

export type OpenedRoute = {
  baseUrl: string;
  release(): void;
  /** Fires when an owned transport (a tunnel) goes away underneath the client. */
  onClosed?(listener: (failure: RouteFailure) => void): () => void;
};

/** Minimal surface of the OpenSSH supervisor this module needs. */
export type SshTunnelProvider = {
  acquire(
    spec: {
      routeId: string;
      destination: string;
      sshPort?: number;
      identityFile?: string;
      remoteGatewayPort: number;
    },
    options: { interactive: boolean; signal?: AbortSignal },
  ): Promise<{
    localOrigin: string;
    release(): void;
    onClosed(listener: (failure: RouteFailure) => void): () => void;
  }>;
  probeHostKey?(spec: {
    routeId: string;
    destination: string;
    sshPort?: number;
    remoteGatewayPort: number;
  }): Promise<{
    probeId: string;
    destination: string;
    fingerprints: Array<{ fingerprint: string; keyType: string; bits: number }>;
  }>;
  trustHostKey?(probe: { probeId: string }): Promise<{ added: number }>;
  disposeAll?(): Promise<void>;
};

export async function openRoute(
  route: LinkRoute,
  options: { interactive: boolean; ssh: SshTunnelProvider | null; signal?: AbortSignal },
): Promise<OpenedRoute> {
  if (route.kind === "https") return { baseUrl: route.origin, release: () => undefined };
  if (!options.ssh) {
    throw routeError(
      "ssh-unavailable",
      "This client cannot open SSH routes. Use the machine's HTTPS route instead.",
      false,
    );
  }
  const lease = await options.ssh.acquire(sshSpec(route), {
    interactive: options.interactive,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    baseUrl: lease.localOrigin,
    release: () => lease.release(),
    onClosed: (listener) => lease.onClosed(listener),
  };
}

function sshSpec(route: LinkSshRoute) {
  return {
    routeId: route.id,
    destination: route.destination,
    ...(route.sshPort ? { sshPort: route.sshPort } : {}),
    ...(route.identityFile ? { identityFile: route.identityFile } : {}),
    remoteGatewayPort: route.remoteGatewayPort,
  };
}

export type RouteError = Error & { code: string; retryable: boolean };

export function routeError(code: string, message: string, retryable: boolean): RouteError {
  const error = new Error(message) as RouteError;
  error.code = code;
  error.retryable = retryable;
  return error;
}

/** SSH tunnel failure codes that need the user rather than a retry. */
const SSH_TRUST_CODES = new Set(["host-key-unknown", "host-key-changed"]);
const SSH_AUTH_CODES = new Set(["authentication-required", "authentication-failed"]);
const SSH_UNSUPPORTED_CODES = new Set([
  "ssh-unavailable",
  "config-extra-forwards",
  "forwarding-denied",
  "control-endpoint",
  "legacy-backend",
  "no-route",
  "invalid-route",
]);

export type ClassifiedRouteFailure = {
  state: ConnectionTransportState;
  retryable: boolean;
  /** Quarantine the route: a trust failure is never ordinary failover. */
  quarantine: boolean;
  code: string;
  message: string;
};

export function classifyRouteFailure(error: unknown): ClassifiedRouteFailure {
  const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
  let cause: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && cause && !seen.has(cause); depth++) {
    seen.add(cause);
    const entry = cause as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      (typeof entry.code === "string" &&
        /^(?:ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:VERIFY|GET)_)/.test(
          entry.code,
        )) ||
      (typeof entry.message === "string" &&
        /certificate|cert_has_expired|self.signed|tls.*(?:verify|verification)/i.test(
          entry.message,
        ))
    ) {
      return {
        state: "trust-blocked",
        retryable: false,
        quarantine: true,
        code: "trust-blocked",
        message: "The TLS certificate could not be verified.",
      };
    }
    cause = entry.cause;
  }
  if (isConnectionCheckError(error)) {
    return {
      state: transportStateForError(error),
      retryable: error.retryable,
      quarantine: error.code === "trust-blocked",
      code: error.code,
      message,
    };
  }
  const code = (error as { code?: unknown } | null)?.code;
  const retryable = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof code === "string") {
    if (SSH_TRUST_CODES.has(code) || code === "identity-mismatch") {
      return { state: "trust-blocked", retryable: false, quarantine: true, code, message };
    }
    if (SSH_AUTH_CODES.has(code)) {
      return {
        state: "authentication-required",
        retryable: false,
        quarantine: false,
        code,
        message,
      };
    }
    if (SSH_UNSUPPORTED_CODES.has(code)) {
      return {
        state: "incompatible",
        retryable: false,
        quarantine: code === "control-endpoint",
        code,
        message,
      };
    }
    if (code === "cancelled") {
      return { state: "unreachable", retryable: false, quarantine: false, code, message };
    }
    return {
      state: "unreachable",
      retryable: retryable !== false,
      quarantine: false,
      code,
      message,
    };
  }
  return { state: "unreachable", retryable: true, quarantine: false, code: "unknown", message };
}

/**
 * Bounded, single-line diagnostics. Raw transport errors can carry
 * usernames, home paths and configuration detail; only a short sentence
 * reaches the renderer.
 */
export function sanitizeDiagnostic(value: string): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex -- diagnostics are single-line text
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240)
  );
}

/**
 * First-use host-key review: fetch the server's key without offering any
 * credential, so the user can compare fingerprints before trusting it.
 */
export async function probeSshHostKey(
  ssh: SshTunnelProvider | null,
  input: { destination: string; sshPort?: number },
): Promise<{
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
}> {
  if (!ssh?.probeHostKey) throw new Error("SSH routes are not available in this client.");
  const destination = validateSshDestination(input.destination);
  const sshPort = input.sshPort === undefined ? undefined : validatePort(input.sshPort, "SSH port");
  const result = await ssh.probeHostKey({
    routeId: "host-key-probe",
    destination,
    ...(sshPort ? { sshPort } : {}),
    remoteGatewayPort: 1,
  });
  return {
    probeId: result.probeId,
    destination: result.destination,
    fingerprints: result.fingerprints.map((entry) => ({
      type: entry.keyType,
      fingerprint: entry.fingerprint,
    })),
  };
}
