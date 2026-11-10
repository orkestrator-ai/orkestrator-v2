import { createLogger } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import { DOCKER_LABEL_OWNER } from "./constants.js";
import { subscribeDockerNetworkChanges } from "./docker-network-changes.js";
import { CommandFailedError, runCommand } from "./shell.js";

const log = createLogger("docker.reachability");

/**
 * Who may talk to the agent-tools server.
 *
 * The server listens on every interface, because containers reach it through
 * `host.docker.internal`, whose host-side address differs per daemon and per
 * environment network. A peer is admitted only when its address is loopback
 * (Docker Desktop and RootlessKit's host loopback deliver container traffic
 * from the host's own loopback) or inside a subnet of this backend's own
 * Docker networks on native Linux Engine: the default `bridge` and every
 * network labelled with this data directory's owner (environment networks,
 * the reachability probe's network). Anything else, the LAN and a tailnet included, is closed before
 * the request is routed, so it learns neither a route nor a status code.
 * Non-Linux hosts and Docker Desktop use loopback only: Desktop's VM-internal
 * subnets can overlap host LAN/VPN addresses and do not identify host peers.
 *
 * The subnet list follows network creation and removal: the network code
 * reports each change ({@link subscribeDockerNetworkChanges}), which marks
 * the list stale and reloads it. A non-loopback peer also reloads it once
 * the list is stale or older than {@link MISS_RELOAD_INTERVAL_MS}, so a
 * network this process did not see created is admitted within that interval,
 * and an outside peer can cost at most one `docker network` read per
 * interval.
 */

/** Minimum spacing of peer-triggered reloads while the list is current. */
export const MISS_RELOAD_INTERVAL_MS = 15_000;
/** Bounds on what one reload reads and keeps. */
const MAX_NETWORKS = 256;
const MAX_SUBNETS = 512;
const DOCKER_TIMEOUT_MS = 10_000;
/** Refusals are logged at most once per this interval, with the count since the last entry. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;

type Ipv4Subnet = { base: number; mask: number; text: string };

/** The IPv4 address as a 32-bit number, accepting the `::ffff:` mapped form. */
export function parseIpv4(address: string | undefined | null): number | null {
  if (!address) return null;
  const text = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv4 CIDR (`a.b.c.d/n`); anything else, IPv6 included, is null. */
export function parseIpv4Subnet(text: string): Ipv4Subnet | null {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const address = parseIpv4(match[1]);
  const bits = Number(match[2]);
  if (address === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (address & mask) >>> 0, mask, text: text.trim() };
}

/** `127.0.0.0/8`, `::1`, and their IPv4-mapped forms. */
export function isLoopbackPeer(address: string | undefined | null): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  const value = parseIpv4(address);
  return value !== null && value >>> 24 === 127;
}

function inSubnet(value: number, subnet: Ipv4Subnet): boolean {
  return (value & subnet.mask) >>> 0 === subnet.base;
}

export type PeerVerdict = "admit" | "refuse" | "reload";

export interface AgentToolsPeerFilterOptions {
  /** Reads the subnets peers may come from; null when the source is unavailable. */
  loadSubnets?: () => Promise<readonly string[] | null>;
  now?: () => number;
  missReloadIntervalMs?: number;
}

export class AgentToolsPeerFilter {
  private subnets: Ipv4Subnet[] = [];
  /** True before the first read, and after every reported change. */
  private stale = true;
  private lastLoadCompletedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;
  /** Set when a change is reported during a load: that load may predate it. */
  private changedDuringLoad = false;
  private readonly now: () => number;
  private readonly missReloadIntervalMs: number;
  private refusalsSinceLog = 0;
  private lastRefusalLogAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: AgentToolsPeerFilterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.missReloadIntervalMs = options.missReloadIntervalMs ?? MISS_RELOAD_INTERVAL_MS;
  }

  /** Loopback only: the filter for a server no container calls. */
  static loopbackOnly(): AgentToolsPeerFilter {
    return new AgentToolsPeerFilter();
  }

  /**
   * The decision that needs no I/O: `admit`, `refuse`, or `reload` when the
   * cached list needs refreshing before the peer can be decided.
   */
  verdict(address: string | undefined | null): PeerVerdict {
    if (isLoopbackPeer(address)) return "admit";
    const value = parseIpv4(address);
    if (value === null) return "refuse";
    if (this.reloadDue()) return "reload";
    return this.subnets.some((subnet) => inSubnet(value, subnet)) ? "admit" : "refuse";
  }

  /** {@link verdict}, reloading the subnet list first when one is due. */
  async admits(address: string | undefined | null): Promise<boolean> {
    // A load in flight follows a reported change, which may have removed the
    // peer's network: decide on the list it produces.
    if (isLoopbackPeer(address)) return true;
    if (parseIpv4(address) === null) return false;
    if (this.verdict(address) === "reload") await this.reload();
    // Every invalidation during a read starts a replacement read. Never
    // decide from an intermediate snapshot, even across several changes.
    while (this.loading) await this.loading;
    return this.verdict(address) === "admit";
  }

  /** A network was created or removed: the list is stale; reload it now if it was ever loaded. */
  networksChanged(): void {
    const wasLoaded = this.lastLoadCompletedAt !== Number.NEGATIVE_INFINITY;
    this.stale = true;
    if (this.loading) this.changedDuringLoad = true;
    if (wasLoaded) void this.reload();
  }

  /**
   * Logs a refused peer, at most once per interval: an outside peer must not
   * be able to fill the log. The address is the peer's, never a credential.
   */
  recordRefusal(address: string | undefined | null): void {
    this.refusalsSinceLog += 1;
    const at = this.now();
    if (at - this.lastRefusalLogAt < REFUSAL_LOG_INTERVAL_MS) return;
    log.info("peers.refused", {
      peer: typeof address === "string" ? address.slice(0, 64) : null,
      refused: this.refusalsSinceLog,
      subnets: this.subnets.length,
    });
    this.lastRefusalLogAt = at;
    this.refusalsSinceLog = 0;
  }

  /** Current subnets, for logs and tests. */
  allowedSubnets(): string[] {
    return this.subnets.map((subnet) => subnet.text);
  }

  /** Coalesced reload; never rejects. A failed read revokes cached permissions. */
  reload(): Promise<void> {
    if (!this.options.loadSubnets) {
      this.stale = false;
      return Promise.resolve();
    }
    if (this.loading) return this.loading;
    const load = this.options.loadSubnets;
    this.changedDuringLoad = false;
    const running = (async () => {
      let loaded: readonly string[] | null = null;
      try {
        loaded = await load();
      } catch {
        // Command output may contain private data; log only the outcome below.
      }
      if (loaded === null) log.warn("peers.subnets-load-failed");
      if (loaded && !this.changedDuringLoad) {
        const parsed: Ipv4Subnet[] = [];
        for (const text of loaded) {
          const subnet = parseIpv4Subnet(text);
          if (subnet && !parsed.some((known) => known.text === subnet.text)) parsed.push(subnet);
          if (parsed.length >= MAX_SUBNETS) break;
        }
        this.subnets = parsed;
        log.info("peers.subnets-loaded", { count: parsed.length });
      } else {
        // A failed or superseded read cannot authorize a removed network.
        this.subnets = [];
      }
      // Retry failed reads on the interval, not on every connection. Only
      // a new change bypasses that backoff and starts a replacement read.
      this.stale = this.changedDuringLoad;
      this.lastLoadCompletedAt = this.now();
    })().finally(() => {
      this.loading = null;
      if (this.stale) void this.reload();
    });
    this.loading = running;
    return running;
  }

  private reloadDue(): boolean {
    if (!this.options.loadSubnets) return false;
    if (this.loading || this.stale) return true;
    // An unexplained miss reloads at most once per interval.
    return this.now() - this.lastLoadCompletedAt >= this.missReloadIntervalMs;
  }

  /** Follows the network code's change reports until the returned function is called. */
  followNetworkChanges(): () => void {
    return subscribeDockerNetworkChanges(() => this.networksChanged());
  }
}

/** What the agent-tools server needs from a filter; tests substitute their own. */
export type AgentToolsPeerGate = Pick<
  AgentToolsPeerFilter,
  "verdict" | "admits" | "recordRefusal" | "followNetworkChanges"
>;

/**
 * IPv4 subnets of the daemon's default `bridge` network and of every network
 * labelled with `owner`. Null when Docker cannot be asked.
 */
export async function loadOwnedDockerSubnets(
  owner: string,
  run: typeof runCommand = runCommand,
): Promise<string[] | null> {
  let names: string[];
  try {
    const { stdout } = await run(
      "docker",
      ["network", "ls", "--filter", `label=${DOCKER_LABEL_OWNER}=${owner}`, "--format", "{{.ID}}"],
      { timeoutMs: DOCKER_TIMEOUT_MS },
    );
    names = [
      "bridge",
      ...stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f]{6,64}$/i.test(line))
        .slice(0, MAX_NETWORKS),
    ];
  } catch (error) {
    log.warn("network.list-failed", { ...classifyCommandFailure(error, { tools: ["docker"] }) });
    return null;
  }
  // A network removed between listing and inspection is harmless. Every
  // other failure makes the snapshot incomplete and must revoke permissions.
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const { stdout } = await run(
          "docker",
          ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", name],
          { timeoutMs: DOCKER_TIMEOUT_MS },
        );
        return stdout.split(/\s+/).filter((value) => parseIpv4Subnet(value) !== null);
      } catch (error) {
        // A timeout/abort is never evidence of removal, even if partial stderr
        // happens to mention a missing network.
        if (
          error instanceof CommandFailedError &&
          error.exitCode === 1 &&
          !error.timedOut &&
          !error.aborted &&
          !error.outputLimitExceeded &&
          /^(?:Error(?: response from daemon)?: )?(?:No such network:|network \S+ not found)\s*/im.test(
            error.stderr,
          )
        )
          return [];
        log.warn("network.inspect-failed", {
          network: name,
          ...classifyCommandFailure(error, { tools: ["docker"] }),
        });
        return null;
      }
    }),
  );
  return results.some((result) => result === null)
    ? null
    : results.flatMap((result) => result ?? []);
}

/** A `docker info` security option naming a rootless daemon. */
export const ROOTLESS_SECURITY_OPTION = /^(?:name=)?rootless(?:,|$)/i;

/**
 * The production filter: loopback plus, on native Linux Engine, Docker
 * networks of one owner namespace (`dockerOwnerNamespace` of the data directory whose environments
 * call the server).
 */
export function dockerPeerFilter(
  ownerNamespace: () => string,
  options: { platform?: NodeJS.Platform; run?: typeof runCommand } = {},
): AgentToolsPeerFilter {
  if ((options.platform ?? process.platform) !== "linux")
    return AgentToolsPeerFilter.loopbackOnly();
  const run = options.run ?? runCommand;
  return new AgentToolsPeerFilter({
    loadSubnets: async () => {
      // Recheck on every refresh, including after daemon/context changes. An
      // unavailable or malformed topology must never retain subnet permission.
      const { stdout } = await run(
        "docker",
        [
          "info",
          "--format",
          '{"os":{{json .OSType}},"name":{{json .OperatingSystem}},"securityOptions":{{json .SecurityOptions}}}',
        ],
        { timeoutMs: DOCKER_TIMEOUT_MS },
      );
      const info: unknown = JSON.parse(stdout);
      if (
        !info ||
        typeof info !== "object" ||
        !("os" in info) ||
        info.os !== "linux" ||
        !("name" in info) ||
        typeof info.name !== "string" ||
        !info.name.trim()
      )
        return null;
      if (/docker desktop/i.test(info.name)) return [];
      if (
        !("securityOptions" in info) ||
        !Array.isArray(info.securityOptions) ||
        !info.securityOptions.every((option) => typeof option === "string")
      )
        return null;
      // Rootless networks live in another namespace just like Desktop's VM
      // networks. Their CIDRs cannot identify container peers on the host.
      if (info.securityOptions.some((option) => ROOTLESS_SECURITY_OPTION.test(option))) return [];
      return loadOwnedDockerSubnets(ownerNamespace(), run);
    },
  });
}
