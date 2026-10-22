/**
 * Typed SSH tunnel outcomes. Only these codes, the fixed actionable messages
 * below and a short redacted detail ever leave the adapter; raw OpenSSH stderr
 * (which can contain usernames, paths and configuration) stays inside it.
 */
export const SSH_TUNNEL_FAILURE_CODES = [
  "invalid-route",
  "ssh-unavailable",
  "config-extra-forwards",
  "host-key-unknown",
  "host-key-changed",
  "authentication-required",
  "authentication-failed",
  "forwarding-denied",
  "port-collision-exhausted",
  "connect-failed",
  "tunnel-exited",
  "cancelled",
] as const;

export type SshTunnelFailureCode = (typeof SSH_TUNNEL_FAILURE_CODES)[number];

export type SshTunnelFailure = {
  code: SshTunnelFailureCode;
  /** Whether a route manager may retry automatically (transport, not trust/auth). */
  retryable: boolean;
  /** Fixed, actionable, user-facing text for the code. */
  message: string;
  /** Short redacted OpenSSH diagnostic, when one was recognised. */
  detail?: string;
  /** For `tunnel-exited`: the classified reason the child stopped, when known. */
  cause?: SshTunnelFailureCode;
};

const RETRYABLE = new Set<SshTunnelFailureCode>([
  "connect-failed",
  "tunnel-exited",
  "port-collision-exhausted",
]);

/**
 * Transport failures are retryable. Trust (host keys), authentication,
 * forwarding policy, configuration and cancellation require user attention and
 * must never be retried in a background loop or hidden behind a fallback.
 */
export function isRetryableTunnelFailure(code: SshTunnelFailureCode): boolean {
  return RETRYABLE.has(code);
}

const MESSAGES: Record<SshTunnelFailureCode, string> = {
  "invalid-route": "The SSH route settings are not valid.",
  "ssh-unavailable": "OpenSSH (ssh) was not found on this computer.",
  "config-extra-forwards":
    "The SSH configuration for this destination opens extra port forwards (LocalForward, RemoteForward or DynamicForward). Use a dedicated Host alias without forwards for Orkestrator.",
  "host-key-unknown":
    "The SSH host key for this destination is not trusted yet. Review its fingerprint and approve it to continue.",
  "host-key-changed":
    "The SSH host key for this destination has changed. The connection is blocked until you verify the machine and update its known host key deliberately.",
  "authentication-required":
    "SSH authentication needs your input. Connect again to enter a passphrase or password, or load the key into ssh-agent.",
  "authentication-failed": "The SSH server rejected the authentication.",
  "forwarding-denied":
    "The SSH server refused port forwarding. Enable TCP forwarding (AllowTcpForwarding) for this account to use an SSH route.",
  "port-collision-exhausted":
    "Could not reserve a free local port for the SSH tunnel after several attempts.",
  "connect-failed": "Could not reach the SSH server.",
  "tunnel-exited": "The SSH tunnel stopped unexpectedly.",
  cancelled: "The SSH connection was cancelled.",
};

export function tunnelFailure(
  code: SshTunnelFailureCode,
  extras: { detail?: string; cause?: SshTunnelFailureCode; message?: string } = {},
): SshTunnelFailure {
  // A tunnel that exited because of a trust or auth problem is not retryable.
  const retryable =
    isRetryableTunnelFailure(code) &&
    (extras.cause === undefined || isRetryableTunnelFailure(extras.cause));
  const failure: SshTunnelFailure = {
    code,
    retryable,
    message: extras.message ?? MESSAGES[code],
  };
  if (extras.detail) failure.detail = extras.detail;
  if (extras.cause) failure.cause = extras.cause;
  return failure;
}

export class SshTunnelError extends Error {
  readonly code: SshTunnelFailureCode;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly failure: SshTunnelFailure;

  constructor(failure: SshTunnelFailure) {
    super(failure.message);
    this.name = "SshTunnelError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.detail = failure.detail;
    this.failure = failure;
  }

  static of(
    code: SshTunnelFailureCode,
    extras?: { detail?: string; cause?: SshTunnelFailureCode; message?: string },
  ): SshTunnelError {
    return new SshTunnelError(tunnelFailure(code, extras));
  }
}

export function isSshTunnelError(value: unknown): value is SshTunnelError {
  return value instanceof SshTunnelError;
}
