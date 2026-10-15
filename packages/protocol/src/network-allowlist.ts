/**
 * Restricted-mode allowlist entries.
 *
 * Under network policy 3 an entry is an address, protocol and port tuple: a
 * bare domain allows HTTPS (TCP 443) to its addresses, and a domain with a
 * port allows exactly that port, `db.example.com:5432` over TCP or
 * `example.com:443/udp` over UDP. GitHub's published ranges allow TCP 443 and
 * 22 without an entry. `docker/firewall-domains.sh` parses the same syntax
 * inside the container.
 *
 * Earlier policies allow every port of an allowed address and do not accept a
 * port, so a container on one receives each entry's domain alone.
 */

export const DEFAULT_ALLOWLIST_PORT = 443;

/** Settings help for the allowlist editors. */
export const ALLOWLIST_ENTRY_HINT =
  "One per line. A domain allows HTTPS (port 443); name a port for anything else, such as db.example.com:5432, or example.com:443/udp for UDP. GitHub also allows SSH.";

export interface AllowlistEntry {
  domain: string;
  protocol: "tcp" | "udp";
  port: number;
}

const DOMAIN = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const ENTRY = /^([^:/]+)(?::([1-9][0-9]{0,4})(?:\/(tcp|udp))?)?$/;

/** An entry's domain, protocol and port; null when it is not a valid entry. */
export function parseAllowlistEntry(value: string): AllowlistEntry | null {
  const match = ENTRY.exec(value.trim());
  if (!match || !DOMAIN.test(match[1]!)) return null;
  const port = match[2] === undefined ? DEFAULT_ALLOWLIST_PORT : Number(match[2]);
  if (port > 65535) return null;
  return { domain: match[1]!, protocol: match[3] === "udp" ? "udp" : "tcp", port };
}

/** The domain an entry names, without its port. */
export function allowlistEntryDomain(value: string): string {
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(0, separator);
}

/**
 * The list a container on `policyVersion` receives: every entry for policy 3,
 * and each domain once for earlier policies, which open every port anyway.
 */
export function allowlistForNetworkPolicy(
  entries: readonly string[],
  policyVersion: number,
): string[] {
  if (policyVersion >= 3) return [...entries];
  return [...new Set(entries.map(allowlistEntryDomain))];
}
