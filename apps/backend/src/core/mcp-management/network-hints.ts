/**
 * Where a server's URL is reached from, and whether a restricted container
 * can reach it. Advisory only: saving never changes an allowlist, and nothing
 * here logs a URL, its query string or a header.
 */

import {
  DEFAULT_ALLOWLIST_PORT,
  parseAllowlistEntry,
} from "@orkestrator/protocol/network-allowlist";

/** A container's network policy as far as a URL warning needs it. */
export type ContainerNetworkView =
  | { mode: "full" }
  | {
      mode: "restricted";
      /** Allowlist entries exactly as the container's firewall received them. */
      allowedDomains: readonly string[];
      /** Policy 3 matches `host:port`; earlier policies open every port of a domain. */
      policyVersion: number;
    };

export const CONTAINER_SIGN_IN_REASON =
  "In-app sign-in needs its callback to reach this container from your browser, which Orkestrator has not proven. Use a header or an environment variable reference instead.";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function urlParts(value: string): { host: string; port: number } | null {
  try {
    const url = new URL(value);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "http:"
        ? 80
        : url.protocol === "https:"
          ? DEFAULT_ALLOWLIST_PORT
          : NaN;
    if (!Number.isFinite(port)) return null;
    return { host: url.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

function allows(
  view: Extract<ContainerNetworkView, { mode: "restricted" }>,
  host: string,
  port: number,
) {
  return view.allowedDomains.some((entry) => {
    const parsed = parseAllowlistEntry(entry);
    if (!parsed || parsed.domain.toLowerCase() !== host) return false;
    return view.policyVersion < 3 || (parsed.protocol === "tcp" && parsed.port === port);
  });
}

/**
 * The warning a container save shows for `url`, or undefined. `localhost`
 * is the container itself; a restricted container reaches only its
 * allowlist, which only the user may widen.
 */
export function urlReachabilityWarning(
  url: string,
  network: ContainerNetworkView | null,
): string | undefined {
  const parts = urlParts(url);
  if (!parts) return undefined;
  if (LOOPBACK.has(parts.host) || parts.host.endsWith(".localhost"))
    return `"${parts.host}" in this URL is the container itself, not the backend's computer or your browser's. A server running elsewhere needs an address the container can reach.`;
  if (!network || network.mode !== "restricted") return undefined;
  if (allows(network, parts.host, parts.port)) return undefined;
  const entry = parts.port === DEFAULT_ALLOWLIST_PORT ? parts.host : `${parts.host}:${parts.port}`;
  return `This container's network is restricted and "${entry}" is not on its allowlist, so this server may be unreachable from the container. Saving does not change the allowlist; add "${entry}" to the environment's allowed domains if it needs it.`;
}
