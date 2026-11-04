import { isIP } from "node:net";
import { hostname as machineHostname } from "node:os";
import { createLogger } from "@orkestrator/protocol/logger";
import { originMatchesRule } from "./gateway-internals.js";

const log = createLogger("gateway");

/** Distinct refused names logged per process: the header is the caller's to choose. */
const MAX_LOGGED_REFUSED_HOSTS = 32;

export const REFUSED_HOST_MESSAGE =
  "This gateway does not answer to that host name. To reach it through a name of your own, add that origin with --allowed-origins or ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS.";

/** The lower-case name in a `Host` header, or null when it is more than a host and port. */
function hostnameOf(host: string): string | null {
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * DNS rebinding points a name the attacker controls at this machine, so the
 * browser sends that name as `Host` while its page counts as same-origin. This
 * refuses such names. It is no boundary against a client that writes its own
 * headers, which still needs a credential.
 *
 * The rules name what a rebinding attacker cannot control rather than listing
 * this machine's addresses, because a name missing from the list locks a remote
 * user out of the machine:
 * - An IP literal: no lookup happens, so nothing can be rebound.
 * - A single-label name (`localhost`, MagicDNS's short `machine`): public DNS
 *   does not serve one.
 * - `*.localhost`, which browsers resolve to loopback themselves.
 * - `*.ts.net`, where Tailscale's control plane owns the names. The backend has
 *   no in-process source for this machine's own one, and the CLI that could
 *   report it may be absent.
 * - This machine's host name, and any origin the operator allowed.
 */
export class GatewayHostPolicy {
  private readonly machineNames: ReadonlySet<string>;
  private readonly loggedRefusals = new Set<string>();

  constructor(
    private readonly allowedOrigins: readonly string[],
    machineName = machineHostname(),
  ) {
    const name = machineName.toLowerCase().replace(/\.$/, "");
    this.machineNames = new Set([name, `${name.split(".")[0]}.local`]);
  }

  /** A browser always sends `Host`, so a request without one is not a rebound page. */
  allows(host: string | undefined): boolean {
    if (host === undefined) return true;
    if (this.hostAllowed(host)) return true;
    if (this.loggedRefusals.size < MAX_LOGGED_REFUSED_HOSTS && !this.loggedRefusals.has(host)) {
      this.loggedRefusals.add(host);
      log.warn("host.refused", { host: host.slice(0, 255) });
    }
    return false;
  }

  private hostAllowed(host: string): boolean {
    const name = hostnameOf(host);
    if (name === null) return false;
    if (isIP(name) !== 0 || !name.includes(".")) return true;
    if (name.endsWith(".localhost") || name.endsWith(".ts.net")) return true;
    if (this.machineNames.has(name)) return true;
    return ["http", "https"].some((protocol) => {
      const origin = new URL(`${protocol}://${host}`);
      return this.allowedOrigins.some((rule) => originMatchesRule(origin, rule));
    });
  }
}
