import type { SshTunnelFailureCode } from "./tunnel-failures.js";

/** Internal-only outcome: a local bind race the supervisor retries on. */
export type SshStderrCode = SshTunnelFailureCode | "port-collision";

export type SshStderrClassification = { code: SshStderrCode; line: string };

export type ClassificationContext = {
  /** True when ssh ran with BatchMode=no and an askpass broker. */
  interactive: boolean;
  /** True when the user dismissed an askpass prompt during this attempt. */
  promptCancelled?: boolean;
};

type Rule = { code: SshStderrCode | "auth"; pattern: RegExp };

// Ordered by priority: trust beats auth beats forwarding beats transport, so a
// changed host key is never reported as a mere connection failure.
const RULES: readonly Rule[] = [
  { code: "host-key-changed", pattern: /REMOTE HOST IDENTIFICATION HAS CHANGED/i },
  { code: "host-key-changed", pattern: /host key for .* has changed/i },
  { code: "host-key-unknown", pattern: /No \S+ host key is known for/i },
  { code: "host-key-unknown", pattern: /Host key verification failed/i },
  { code: "forwarding-denied", pattern: /administratively prohibited/i },
  { code: "port-collision", pattern: /^bind \S+: Address already in use/i },
  { code: "port-collision", pattern: /cannot listen to port/i },
  { code: "port-collision", pattern: /Could not request local forwarding/i },
  { code: "auth", pattern: /Permission denied/i },
  { code: "auth", pattern: /Too many authentication failures/i },
  { code: "auth", pattern: /No more authentication methods/i },
  { code: "connect-failed", pattern: /Could not resolve hostname/i },
  { code: "connect-failed", pattern: /Connection refused/i },
  { code: "connect-failed", pattern: /(Connection|Operation) timed out|timed out/i },
  { code: "connect-failed", pattern: /No route to host|Network is unreachable/i },
  { code: "connect-failed", pattern: /Connection (closed|reset) by/i },
  { code: "connect-failed", pattern: /closed by remote host|server \S+ not responding/i },
  { code: "connect-failed", pattern: /Broken pipe/i },
  { code: "connect-failed", pattern: /kex_exchange_identification/i },
];

const PRIORITY: readonly (SshStderrCode | "auth")[] = [
  "host-key-changed",
  "host-key-unknown",
  "forwarding-denied",
  "port-collision",
  "auth",
  "connect-failed",
];

/**
 * A per-connection failure on the remote side of the forward (SH-06: the
 * gateway port is closed) is not a tunnel failure; the caller's authenticated
 * hello reports it. Only "administratively prohibited" is a tunnel verdict.
 */
const CHANNEL_CONNECT_FAILURE = /^channel \d+: open failed: (?!administratively prohibited)/i;

export function classifySshStderr(
  stderr: string,
  context: ClassificationContext,
): SshStderrClassification | null {
  let best: { rank: number; code: SshStderrCode | "auth"; line: string } | null = null;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || CHANNEL_CONNECT_FAILURE.test(line)) continue;
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      const rank = PRIORITY.indexOf(rule.code);
      if (!best || rank < best.rank) best = { rank, code: rule.code, line };
      break;
    }
  }
  if (!best) return null;
  if (best.code === "auth") {
    const code =
      !context.interactive || context.promptCancelled
        ? "authentication-required"
        : "authentication-failed";
    return { code, line: best.line };
  }
  return { code: best.code, line: best.line };
}

/** Lines that mean the remote side refused a forwarded channel by policy. */
export function isForwardingDeniedLine(line: string): boolean {
  return /administratively prohibited/i.test(line);
}

const MAX_DETAIL_LENGTH = 240;

/**
 * Redact a single OpenSSH diagnostic line before it can be exposed: usernames,
 * local paths and quoted values are removed, control characters stripped and
 * the result bounded.
 */
export function redactSshDiagnostic(
  line: string,
  sensitive: readonly (string | undefined)[] = [],
): string {
  let text = line.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const value of sensitive) {
    if (value && value.length >= 2) text = text.split(value).join("<redacted>");
  }
  text = text
    .replace(/[^\s'"@]+@/g, "<user>@")
    .replace(/(['"])[^'"]*\1/g, "<value>")
    .replace(/(^|[\s(=:])~?\/[^\s'",)]*/g, "$1<path>")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}
