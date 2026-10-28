import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  CONTAINER_HOST_REACHABILITY_CHANGED_EVENT,
  ROOTLESSKIT_HOST_LOOPBACK_ADDRESS,
  initialContainerHostReachability,
  type ContainerHostProbe,
  type ContainerHostProbeOutcome,
  type ContainerHostProbeScope,
  type ContainerHostReachability,
  type ContainerHostRemediation,
  type HostFirewallKind,
} from "@orkestrator/protocol/container-host-reachability";
import type { DockerTopology } from "@orkestrator/protocol/image-manifest";
import { DOCKER_LABEL_OWNER, DOCKER_LABEL_RESOURCE_ROLE } from "./constants.js";
import { CommandFailedError, runCommand } from "./shell.js";

/**
 * Container → host agent tools reachability.
 *
 * Agents in containers reach Orkestrator's agent tools server through
 * `http://host.docker.internal:<port>/mcp`. The server answers any non-POST
 * request with 405 before authenticating, so a credential-free GET that gets
 * *any* HTTP status proves the path; a timeout, refusal or unresolvable host
 * name proves it broken. A host firewall that drops Docker traffic (ufw's
 * default on many Linux desktops) otherwise only surfaces when a workflow
 * agent silently fails to submit its result many minutes later.
 *
 * Under rootless Docker `host-gateway` names a bridge inside RootlessKit's
 * network namespace, where nothing of the host listens. The only way back to
 * the host is RootlessKit's host loopback address, which the daemon refuses
 * unless it runs with host loopback enabled. On a rootless daemon the check
 * therefore also probes through that address; when it answers, new
 * containers' `host.docker.internal` names it (`hostAddress`), and when it
 * does not, the remediation is the daemon setting, not a host firewall rule.
 *
 * Three checks share one parser:
 * - at startup (Linux), from a throwaway ~1 MB busybox container on the
 *   default bridge and on a temporary per-environment style network;
 * - after a bridge resolves its tools connection, from inside the running
 *   environment container (non-blocking, logged);
 * - before a workflow stage dispatches, from inside the container, failing
 *   the stage immediately with a descriptive error.
 *
 * Nothing here handles a credential: the probe URL carries none.
 */

/** Pinned multi-arch busybox (amd64 + arm64, ~1 MB). Its `wget` is the probe. */
export const CONTAINER_HOST_PROBE_IMAGE =
  "busybox:1.37-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092";
export const HOST_REACHABILITY_PROBE_ROLE = "host-reachability-probe";
export const CONTAINER_AGENT_TOOLS_PROBE_HOST = "host.docker.internal";
const LOG_PREFIX = "[container-host-reachability]";
const PROBE_CONNECT_TIMEOUT_SECONDS = 5;
/** `docker run` start-up, the probe itself, and removal. */
const PROBE_COMMAND_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 120_000;
const MAX_DETAIL_CHARS = 300;
const MAX_NETWORKS_INSPECTED = 64;
const CONTAINER_REACHABLE_TTL_MS = 60_000;
const CONTAINER_FAILURE_TTL_MS = 10_000;
/** Minimum spacing of automatic host rechecks triggered by container probes. */
const AUTO_RECHECK_INTERVAL_MS = 60_000;
/** How long shutdown waits for a running check to remove its own probe network. */
const DISPOSE_WAIT_MS = 3_000;
/** Per-command bound on shutdown's own removal when the check did not finish. */
const DISPOSE_REMOVE_TIMEOUT_MS = 5_000;

/**
 * POSIX-sh probe: `$1` URL, `$2` connect timeout in seconds. Prefers curl
 * (environment images), then wget (busybox or GNU). Always exits 0 and
 * reports through `ORK_PROBE_*` markers so a failed connection is data, not a
 * failed `docker` invocation.
 */
export const CONTAINER_HOST_PROBE_SCRIPT = [
  'url="$1"; t="$2"',
  "if command -v curl >/dev/null 2>&1; then",
  '  out=$(curl -sS -o /dev/null -w \'ORK_PROBE_HTTP=%{http_code}\' --connect-timeout "$t" -m "$((t + 3))" "$url" 2>&1); rc=$?',
  '  printf \'ORK_PROBE_TOOL=curl\\n%s\\nORK_PROBE_RC=%s\\n\' "$out" "$rc"',
  "elif command -v wget >/dev/null 2>&1; then",
  "  if wget --help 2>&1 | grep -qi busybox; then",
  '    out=$(wget -T "$t" -O /dev/null "$url" 2>&1); rc=$?',
  "  else",
  '    out=$(wget -t 1 -T "$t" -O /dev/null "$url" 2>&1); rc=$?',
  "  fi",
  '  printf \'ORK_PROBE_TOOL=wget\\n%s\\nORK_PROBE_RC=%s\\n\' "$out" "$rc"',
  "else",
  "  printf 'ORK_PROBE_TOOL=none\\nORK_PROBE_RC=127\\n'",
  "fi",
  "exit 0",
].join("\n");

export type ProbeClassification = {
  outcome: ContainerHostProbeOutcome;
  httpStatus: number | null;
  detail: string | null;
};

/** Classifies the output of {@link CONTAINER_HOST_PROBE_SCRIPT}. */
export function classifyProbeOutput(output: string): ProbeClassification {
  const text = output.replaceAll("\r", "");
  const tool = /ORK_PROBE_TOOL=(\w+)/.exec(text)?.[1] ?? null;
  const rcText = /ORK_PROBE_RC=(\d+)/.exec(text)?.[1];
  const rc = rcText === undefined ? null : Number.parseInt(rcText, 10);
  const detail = probeDetail(text);
  const status =
    // curl's write-out; `000` means no response at all.
    /ORK_PROBE_HTTP=([1-5]\d\d)/.exec(text)?.[1] ??
    // busybox wget: "server returned error: HTTP/1.1 405 Method Not Allowed".
    /HTTP\/\d(?:\.\d)?\s+([1-5]\d\d)/.exec(text)?.[1] ??
    // GNU wget: "HTTP request sent, awaiting response... 405 Method Not Allowed".
    /awaiting response\.\.\.\s*([1-5]\d\d)/i.exec(text)?.[1] ??
    /ERROR ([1-5]\d\d)/.exec(text)?.[1];
  if (status) {
    return { outcome: "reachable", httpStatus: Number.parseInt(status, 10), detail };
  }
  if (tool === "none") {
    return { outcome: "error", httpStatus: null, detail: "neither curl nor wget is installed" };
  }
  if (tool === null || rc === null) return { outcome: "error", httpStatus: null, detail };
  if (rc === 0) return { outcome: "reachable", httpStatus: null, detail };
  if (/timed out|timeout/i.test(text) || (tool === "curl" && rc === 28)) {
    return { outcome: "timeout", httpStatus: null, detail };
  }
  if (/refused/i.test(text)) return { outcome: "refused", httpStatus: null, detail };
  if (/no route to host|network (?:is )?unreachable|host is unreachable/i.test(text)) {
    return { outcome: "unreachable", httpStatus: null, detail };
  }
  if (
    /bad address|could not resolve|resolve host|name or service not known|temporary failure in name resolution|unable to resolve/i.test(
      text,
    ) ||
    (tool === "curl" && rc === 6)
  ) {
    return { outcome: "dns", httpStatus: null, detail };
  }
  if (tool === "curl" && rc === 7) return { outcome: "refused", httpStatus: null, detail };
  return { outcome: "error", httpStatus: null, detail };
}

function probeDetail(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !line.startsWith("ORK_PROBE_TOOL=") && !line.startsWith("ORK_PROBE_RC="),
    )
    .map((line) => line.replace(/ORK_PROBE_HTTP=\d+/, "").trim())
    .filter(Boolean);
  const joined = lines.join(" | ");
  if (!joined) return null;
  return joined.length > MAX_DETAIL_CHARS ? `${joined.slice(0, MAX_DETAIL_CHARS)}…` : joined;
}

export function isBlockingOutcome(outcome: ContainerHostProbeOutcome): boolean {
  return (
    outcome === "timeout" || outcome === "refused" || outcome === "unreachable" || outcome === "dns"
  );
}

function outcomeExplanation(outcome: ContainerHostProbeOutcome): string {
  switch (outcome) {
    case "timeout":
      return "the connection timed out, which means a firewall on this computer is silently dropping traffic from Docker containers";
    case "refused":
      return "the connection was refused, which means a firewall rule is rejecting traffic from Docker containers (or nothing is listening on that port)";
    case "unreachable":
      return "there was no route to the host, which means a firewall rule is rejecting traffic from Docker containers";
    case "dns":
      return `${CONTAINER_AGENT_TOOLS_PROBE_HOST} does not resolve inside the container`;
    case "error":
      return "the probe could not run";
    case "reachable":
      return "the server answered";
  }
}

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

type Ipv4Cidr = { address: number; prefix: number };

function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  const prefix = Number.parseInt(match[5]!, 10);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return { address, prefix };
}

function cidrContains(outer: Ipv4Cidr, inner: Ipv4Cidr): boolean {
  if (inner.prefix < outer.prefix) return false;
  const mask = outer.prefix === 0 ? 0 : (0xffffffff << (32 - outer.prefix)) >>> 0;
  return (outer.address & mask) === (inner.address & mask);
}

/**
 * Docker's primary default address pool (172.17.0.0/16 … 172.31.0.0/16).
 * Home and office networks rarely use it, unlike 192.168.0.0/16 and
 * 10.0.0.0/8, which are never widened to: a rule for those would also admit
 * every machine on such a network.
 */
export const DOCKER_DEFAULT_POOL = "172.16.0.0/12";
/** Docker's default bridge subnet, used when nothing better is known. */
const DOCKER_DEFAULT_BRIDGE_SUBNET = "172.17.0.0/16";

/**
 * The source ranges a firewall rule should allow. Subnets inside Docker's
 * primary pool are widened to it, so a rule keeps working for environment
 * networks Docker has not created yet, unless one of this computer's own
 * (non-Docker) addresses is in that pool: then the local network uses it and
 * the exact subnets are kept. Every other subnet is kept as is. With no
 * subnets known, the pool (or the default bridge subnet) is assumed.
 */
export function coveringCidrs(
  subnets: readonly string[],
  hostAddresses: readonly string[] = [],
): string[] {
  const pool = parseIpv4Cidr(DOCKER_DEFAULT_POOL)!;
  const poolUsedLocally = hostAddresses.some((address) => {
    const parsed = parseIpv4Cidr(`${address.trim()}/32`);
    return parsed !== null && cidrContains(pool, parsed);
  });
  const covers = new Set<string>();
  for (const subnet of subnets) {
    const parsed = parseIpv4Cidr(subnet);
    if (!parsed) continue;
    covers.add(
      !poolUsedLocally && cidrContains(pool, parsed) ? DOCKER_DEFAULT_POOL : subnet.trim(),
    );
  }
  if (covers.size === 0) {
    covers.add(poolUsedLocally ? DOCKER_DEFAULT_BRIDGE_SUBNET : DOCKER_DEFAULT_POOL);
  }
  return [...covers];
}

/**
 * This computer's IPv4 addresses outside Docker (not loopback, `docker0`,
 * `br-*` or `veth*`): the local networks a firewall rule must not open to.
 */
export function hostNetworkAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(?:docker\d*|br-|veth)/.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export function firewallDisplayName(kind: HostFirewallKind): string {
  switch (kind) {
    case "ufw":
      return "ufw";
    case "firewalld":
      return "firewalld";
    case "nftables":
      return "nftables";
    case "iptables":
      return "iptables";
    case "unknown":
      return "your firewall";
  }
}

export function buildContainerHostRemediation(input: {
  firewall: HostFirewallKind;
  port: number;
  subnets: readonly string[];
  outcomes: readonly ContainerHostProbeOutcome[];
  /** This computer's non-Docker IPv4 addresses; see {@link coveringCidrs}. */
  hostAddresses?: readonly string[];
}): ContainerHostRemediation {
  const { firewall, port } = input;
  const blocking = input.outcomes.filter(isBlockingOutcome);
  if (blocking.length > 0 && blocking.every((outcome) => outcome === "dns")) {
    return {
      title: `Make ${CONTAINER_AGENT_TOOLS_PROBE_HOST} resolve inside containers`,
      steps: [
        `Containers could not resolve ${CONTAINER_AGENT_TOOLS_PROBE_HOST}. Orkestrator adds it with Docker's "host-gateway" alias, which needs Docker Engine 20.10 or newer.`,
        "Update Docker, restart it, then check again.",
      ],
      commands: ["docker version --format '{{.Server.Version}}'"],
    };
  }
  const cidrs = coveringCidrs(input.subnets, input.hostAddresses);
  const name = firewallDisplayName(firewall);
  const intro = `${firewall === "unknown" ? "A firewall on this computer" : `The host firewall (${name})`} is blocking Docker containers from connecting to port ${port}, where Orkestrator's agent tools server listens. Container agents use it to submit review results, send mail and update tickets.`;
  const scope = [
    `Allow connections to port ${port} only from Docker's networks (${cidrs.join(", ")}), none of which this computer's local network uses, so other machines on it still can't connect.`,
    ...(cidrs.includes(DOCKER_DEFAULT_POOL)
      ? [
          `${DOCKER_DEFAULT_POOL} also covers networks Docker creates for new environments. If this computer later joins a network with ${DOCKER_DEFAULT_POOL} addresses, replace that rule with Docker's exact subnets.`,
        ]
      : []),
    ...(cidrs.some((cidr) => cidr !== DOCKER_DEFAULT_POOL)
      ? [
          "A Docker network created later outside these subnets needs its own rule; this check warns you when one is blocked.",
        ]
      : []),
  ].join(" ");
  const after =
    "Then press “Check again”. Orkestrator reuses the same port across restarts; if it ever has to change port, this check will warn you again.";
  switch (firewall) {
    case "ufw":
      return {
        title: "Allow Docker containers through ufw",
        steps: [intro, scope, after],
        commands: cidrs.map(
          (cidr) =>
            `sudo ufw allow proto tcp from ${cidr} to any port ${port} comment 'Orkestrator agent tools'`,
        ),
      };
    case "firewalld":
      return {
        title: "Allow Docker containers through firewalld",
        steps: [intro, scope, after],
        commands: [
          ...cidrs.map(
            (cidr) =>
              `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${cidr}" port port="${port}" protocol="tcp" accept'`,
          ),
          "sudo firewall-cmd --reload",
        ],
      };
    default:
      return {
        title: "Allow Docker containers through the host firewall",
        steps: [
          intro,
          scope,
          "These iptables rules take effect immediately but are lost on reboot. Add the same rule to your firewall's saved configuration to keep it.",
          after,
        ],
        commands: cidrs.map(
          (cidr) => `sudo iptables -I INPUT -p tcp -s ${cidr} --dport ${port} -j ACCEPT`,
        ),
      };
  }
}

/** The systemd drop-in that enables RootlessKit's host loopback for the user's daemon. */
export const ROOTLESS_HOST_LOOPBACK_DROP_IN =
  "~/.config/systemd/user/docker.service.d/orkestrator-host-loopback.conf";

/**
 * Remediation for a rootless daemon whose containers cannot reach the agent
 * tools server: traffic from its containers never reaches a host firewall,
 * so the fix is RootlessKit's host loopback, with its cost stated.
 */
export function buildRootlessHostRemediation(port: number): ContainerHostRemediation {
  return {
    title: "Let rootless Docker containers reach Orkestrator",
    steps: [
      `Docker runs rootless, so containers reach this computer only through RootlessKit, which by default refuses connections to its loopback addresses, where Orkestrator's agent tools server answers on port ${port}. A host firewall rule cannot help: this traffic never reaches it. Container agents use that server to submit review results, send mail and update tickets.`,
      "Allow host loopback for your Docker user service with the commands below, which restart it. Restarting Docker stops every running container, Orkestrator's included; start the environments again afterwards. If you start dockerd-rootless.sh yourself, set DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false in its environment instead.",
      `This lets every container on this Docker daemon connect to services that listen on this computer's loopback addresses. Orkestrator's restricted containers still reach only port ${port} through their firewall; full-access containers and containers Orkestrator does not manage can reach all of them.`,
      `Then press “Check again”. New containers reach Orkestrator through RootlessKit's host address (${ROOTLESSKIT_HOST_LOOPBACK_ADDRESS}); rebuild existing environments so their network policy includes it.`,
    ],
    commands: [
      "mkdir -p ~/.config/systemd/user/docker.service.d",
      `printf '[Service]\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false"\n' > ${ROOTLESS_HOST_LOOPBACK_DROP_IN}`,
      "systemctl --user daemon-reload",
      "systemctl --user restart docker",
    ],
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A workflow stage refused to start because its container cannot reach the tools server. */
export class ContainerAgentToolsUnreachableError extends Error {
  readonly outcome: ContainerHostProbeOutcome;
  readonly containerId: string;

  constructor(message: string, outcome: ContainerHostProbeOutcome, containerId: string) {
    super(message);
    this.name = "ContainerAgentToolsUnreachableError";
    this.outcome = outcome;
    this.containerId = containerId;
  }
}

export function describeUnreachableContainer(input: {
  stage: string;
  environmentName: string | null;
  url: string;
  probe: Pick<ContainerHostProbe, "outcome" | "elapsedMs" | "detail">;
  host: ContainerHostReachability;
}): string {
  const where = input.environmentName
    ? `environment “${input.environmentName}”`
    : "this environment's container";
  const parts = [
    `Orkestrator did not start the ${input.stage}: ${where} can't reach Orkestrator's agent tools server at ${input.url} (${outcomeExplanation(input.probe.outcome)}).`,
    "Agents in containers submit their results through that server, so this stage could never finish.",
  ];
  if (input.host.status === "reachable") {
    parts.push(
      "A fresh test container on this host can reach the server, so the block is inside this environment's container (its network policy or /etc/hosts). Restart the environment, then retry this stage.",
    );
  } else if (input.host.remediation && input.host.remediation.commands.length > 0) {
    parts.push(
      `Fix: run ${input.host.remediation.commands.map((command) => `\`${command}\``).join(" and ")}, then retry this stage.`,
    );
  } else {
    parts.push(
      `Allow Docker containers to connect to TCP port ${portFromUrl(input.url) ?? "the agent tools port"} on this computer, then retry this stage.`,
    );
  }
  if (input.probe.detail) parts.push(`Probe output: ${input.probe.detail}`);
  return parts.join(" ");
}

function portFromUrl(url: string): number | null {
  try {
    const port = Number.parseInt(new URL(url).port, 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ReachabilityEnvironment = {
  id: string;
  name?: string | null;
  environmentType?: string | null;
  containerId?: string | null;
};

export type ContainerHostReachabilityDependencies = {
  /** Port the agent tools server listens on; null before it starts. */
  servicePort: () => number | null;
  /** Docker owner namespace of this data directory, for probe labels. */
  ownerNamespace: string;
  /** Configured environment image, the fallback probe image. */
  fallbackImage: () => string;
  emit?: (event: string, payload: unknown) => void;
  platform?: NodeJS.Platform;
  run?: typeof runCommand;
  detectTopology?: () => Promise<
    Pick<DockerTopology, "kind"> & Partial<Pick<DockerTopology, "rootless">>
  >;
  readTextFile?: (path: string) => Promise<string | null>;
  /** This computer's non-Docker IPv4 addresses; defaults to its interfaces. */
  hostAddresses?: () => string[];
  /** Repairs host alias and in-container firewall before an environment probe. */
  prepareContainer?: (containerId: string) => Promise<void>;
  loadEnvironment?: (environmentId: string) => Promise<ReachabilityEnvironment | null>;
  now?: () => number;
  log?: { info(message: string): void; warn(message: string): void };
};

type ContainerProbeCacheEntry = { at: number; port: number; probe: ContainerHostProbe };

export class ContainerHostReachabilityService {
  private state: ContainerHostReachability = initialContainerHostReachability();
  private inFlight: Promise<ContainerHostReachability> | null = null;
  /** Set by {@link dispose}: no check starts, and a running one adds no probe network. */
  private closed = false;
  private disposing: Promise<void> | null = null;
  /** This owner's probe network while it may exist; cleared once removed. */
  private probeNetwork: string | null = null;
  /** Names of probe containers whose `docker run` has not returned. */
  private readonly probeContainers = new Set<string>();
  private lastAutoRecheckAt = Number.NEGATIVE_INFINITY;
  private readonly containerCache = new Map<string, ContainerProbeCacheEntry>();
  private readonly containerInFlight = new Map<string, Promise<ContainerHostProbe>>();
  private readonly platform: NodeJS.Platform;
  private readonly run: typeof runCommand;
  private readonly now: () => number;
  private readonly log: { info(message: string): void; warn(message: string): void };

  constructor(private readonly deps: ContainerHostReachabilityDependencies) {
    this.platform = deps.platform ?? process.platform;
    this.run = deps.run ?? runCommand;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? {
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
    };
  }

  snapshot(): ContainerHostReachability {
    return structuredClone(this.state);
  }

  /**
   * The address containers' `host.docker.internal` should name when it is
   * not Docker's `host-gateway` (RootlessKit's host loopback), from the last
   * check. Null means `host-gateway`.
   */
  containerHostAddress(): string | null {
    return this.state.hostAddress ?? null;
  }

  /**
   * {@link containerHostAddress} for a container about to be created on a
   * rootless daemon: waits for the first check (started now when none ran),
   * bounded, so the new container's alias and firewall name the address that
   * works. A check that does not finish in time leaves `host-gateway`.
   */
  async resolveContainerHostAddress(timeoutMs = 45_000): Promise<string | null> {
    if (this.platform === "linux" && (this.inFlight || this.state.checkedAt === null)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (this.inFlight ?? this.check("boot")).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    return this.containerHostAddress();
  }

  /** Coalesced host check. A call during a running check shares its result. */
  check(trigger: "boot" | "manual" | "recheck"): Promise<ContainerHostReachability> {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return Promise.resolve(this.snapshot());
    const running = this.runCheck(trigger)
      .catch((error: unknown) => {
        this.log.warn(
          `${LOG_PREFIX} check crashed trigger=${trigger} error=${boundedError(error)}`,
        );
        return this.publish({
          ...this.state,
          status: "unverified",
          reason: "probe-failed",
          summary: `Couldn't check whether Docker containers can reach Orkestrator: ${boundedError(error)}`,
          checkedAt: new Date(this.now()).toISOString(),
          trigger,
          remediation: null,
        });
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = running;
    return running;
  }

  /**
   * For backend shutdown: stops new checks and settles a running one so its
   * probe network does not outlive the process. Waits up to `waitMs` for the
   * check to remove the network itself, then removes this owner's probe
   * containers and network by name. Bounded (a hung Docker cannot hold the
   * exit past the removal timeouts) and never rejects. A SIGKILL still
   * leaks; {@link reapStaleProbes} recovers that on the owner's next check.
   */
  dispose(waitMs = DISPOSE_WAIT_MS): Promise<void> {
    this.closed = true;
    this.disposing ??= this.settleForShutdown(waitMs);
    return this.disposing;
  }

  private async settleForShutdown(waitMs: number): Promise<void> {
    const running = this.inFlight;
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const network = this.probeNetwork;
    const containers = [...this.probeContainers];
    if (!network && containers.length === 0) return;
    this.log.info(
      `${LOG_PREFIX} shutdown removing probe resources network=${network ?? "-"} containers=${containers.length}`,
    );
    // Containers first: Docker refuses to remove a network they are attached to.
    if (containers.length > 0) {
      await this.run("docker", ["rm", "-f", ...containers], {
        timeoutMs: DISPOSE_REMOVE_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    if (network) {
      await this.run("docker", ["network", "rm", network], {
        timeoutMs: DISPOSE_REMOVE_TIMEOUT_MS,
      }).then(
        () => {
          if (this.probeNetwork === network) this.probeNetwork = null;
        },
        (error: unknown) =>
          this.log.warn(
            `${LOG_PREFIX} shutdown probe network removal failed network=${network} error=${boundedError(error)}`,
          ),
      );
    }
  }

  /**
   * Probes from inside a running environment container. Results are cached
   * briefly (successes longer than failures, so a retry after a fix is
   * fresh) and concurrent calls for one container share one probe.
   */
  async checkEnvironmentContainer(
    containerId: string,
    options: { prepare?: boolean; reason: string; environmentName?: string | null },
  ): Promise<ContainerHostProbe | null> {
    const port = this.deps.servicePort();
    if (!port) {
      this.log.warn(
        `${LOG_PREFIX} container probe skipped reason=${options.reason} container=${shortId(containerId)} cause=agent-tools-not-listening`,
      );
      return null;
    }
    const cached = this.containerCache.get(containerId);
    if (cached && cached.port === port) {
      const ttl =
        cached.probe.outcome === "reachable"
          ? CONTAINER_REACHABLE_TTL_MS
          : CONTAINER_FAILURE_TTL_MS;
      if (this.now() - cached.at < ttl) return cached.probe;
    }
    const existing = this.containerInFlight.get(containerId);
    if (existing) return existing;
    const probing = this.probeEnvironmentContainer(containerId, port, options).finally(() => {
      this.containerInFlight.delete(containerId);
    });
    this.containerInFlight.set(containerId, probing);
    return probing;
  }

  /**
   * Preflight for a workflow stage. Local environments, environments without
   * a container, and inconclusive probes pass; a probe that proves the path
   * broken throws a {@link ContainerAgentToolsUnreachableError} whose message
   * tells the user what is wrong and how to fix it.
   */
  async assertEnvironmentReachable(environmentId: string, stage: string): Promise<void> {
    const environment = await this.deps.loadEnvironment?.(environmentId).catch(() => null);
    if (!environment || environment.environmentType === "local" || !environment.containerId) {
      return;
    }
    const probe = await this.checkEnvironmentContainer(environment.containerId, {
      prepare: true,
      reason: `preflight:${stage}`,
      environmentName: environment.name ?? null,
    });
    if (!probe || !isBlockingOutcome(probe.outcome)) return;
    // Refresh the host verdict so the message names the right cause and fix.
    const host =
      this.state.status === "blocked" || this.state.status === "reachable"
        ? this.state
        : await this.check("recheck");
    const url = containerAgentToolsUrl(this.deps.servicePort() ?? 0);
    const message = describeUnreachableContainer({
      stage,
      environmentName: environment.name ?? null,
      url,
      probe,
      host,
    });
    this.log.warn(
      `${LOG_PREFIX} preflight refused stage=${JSON.stringify(stage)} environment=${environment.id} container=${shortId(environment.containerId)} outcome=${probe.outcome} hostStatus=${host.status}`,
    );
    throw new ContainerAgentToolsUnreachableError(message, probe.outcome, environment.containerId);
  }

  // -------------------------------------------------------------------------

  private async probeEnvironmentContainer(
    containerId: string,
    port: number,
    options: { prepare?: boolean; reason: string; environmentName?: string | null },
  ): Promise<ContainerHostProbe> {
    const url = containerAgentToolsUrl(port);
    if (options.prepare && this.deps.prepareContainer) {
      await this.deps.prepareContainer(containerId).catch((error: unknown) => {
        this.log.warn(
          `${LOG_PREFIX} container prepare failed container=${shortId(containerId)} error=${boundedError(error)}`,
        );
      });
    }
    const started = this.now();
    let classification: ProbeClassification;
    try {
      const { stdout, stderr } = await this.run(
        "docker",
        [
          "exec",
          containerId,
          "sh",
          "-c",
          CONTAINER_HOST_PROBE_SCRIPT,
          "orkestrator-probe",
          url,
          String(PROBE_CONNECT_TIMEOUT_SECONDS),
        ],
        { timeoutMs: PROBE_COMMAND_TIMEOUT_MS },
      );
      classification = classifyProbeOutput(`${stdout}\n${stderr}`);
    } catch (error) {
      classification = { outcome: "error", httpStatus: null, detail: boundedError(error) };
    }
    const probe: ContainerHostProbe = {
      scope: "environment-container",
      network: null,
      subnet: null,
      containerId,
      outcome: classification.outcome,
      httpStatus: classification.httpStatus,
      elapsedMs: Math.max(0, this.now() - started),
      detail: classification.detail,
    };
    this.containerCache.set(containerId, { at: this.now(), port, probe });
    if (this.containerCache.size > 256) {
      const oldest = this.containerCache.keys().next().value;
      if (oldest !== undefined) this.containerCache.delete(oldest);
    }
    const line = `${LOG_PREFIX} container probe reason=${options.reason} container=${shortId(containerId)} url=${url} ${probeFields(probe)}`;
    if (probe.outcome === "reachable") this.log.info(line);
    else this.log.warn(line);
    this.maybeAutoRecheck(probe);
    return probe;
  }

  /**
   * A container result that contradicts the host verdict re-runs the host
   * check (rate limited): a failure may be the first evidence of a block the
   * startup check could not see, and a success may mean the user fixed it.
   */
  private maybeAutoRecheck(probe: ContainerHostProbe): void {
    if (this.platform !== "linux") return;
    const contradicts =
      (isBlockingOutcome(probe.outcome) && this.state.status !== "blocked") ||
      (probe.outcome === "reachable" && this.state.status === "blocked");
    if (!contradicts) return;
    if (this.now() - this.lastAutoRecheckAt < AUTO_RECHECK_INTERVAL_MS) return;
    this.lastAutoRecheckAt = this.now();
    this.log.info(
      `${LOG_PREFIX} container probe contradicts host status=${this.state.status} outcome=${probe.outcome}; rechecking host`,
    );
    void this.check("recheck");
  }

  private async runCheck(
    trigger: "boot" | "manual" | "recheck",
  ): Promise<ContainerHostReachability> {
    const startedAt = this.now();
    const port = this.deps.servicePort();
    this.log.info(
      `${LOG_PREFIX} check started trigger=${trigger} platform=${this.platform} port=${port ?? "none"}`,
    );
    const base = {
      ...initialContainerHostReachability(),
      trigger,
      port,
      url: port ? containerAgentToolsUrl(port) : null,
    };
    if (this.platform !== "linux") {
      return this.finish(startedAt, {
        ...base,
        status: "not-applicable",
        reason: "not-linux",
        summary: "The container connectivity check runs on Linux hosts only.",
      });
    }
    if (!port) {
      return this.finish(startedAt, {
        ...base,
        status: "unverified",
        reason: "agent-tools-not-listening",
        summary:
          "Orkestrator's agent tools server is not running, so agents in containers can't submit results. Restart Orkestrator; if this persists, check the backend log.",
      });
    }
    this.publish({ ...this.state, status: "checking", trigger, port, url: base.url });

    const topology = await (this.deps.detectTopology
      ? this.deps.detectTopology()
      : import("./docker-image.js").then((module) => module.detectDockerTopology()));
    const rootless = topology.rootless === true;
    this.log.info(`${LOG_PREFIX} docker topology kind=${topology.kind} rootless=${rootless}`);
    if (topology.kind === "unavailable") {
      return this.finish(startedAt, {
        ...base,
        status: "unverified",
        reason: "docker-unavailable",
        summary:
          "Couldn't check whether Docker containers can reach Orkestrator because Docker isn't available.",
      });
    }
    if (topology.kind === "remote") {
      return this.finish(startedAt, {
        ...base,
        status: "not-applicable",
        reason: "docker-remote",
        summary:
          "Docker runs on another machine, so containers reach that machine rather than this backend.",
      });
    }

    const [firewall, subnets] = await Promise.all([this.detectFirewall(), this.dockerSubnets()]);
    this.log.info(
      `${LOG_PREFIX} host firewall kind=${firewall.kind} detail=${JSON.stringify(firewall.detail ?? "")} dockerSubnets=${subnets.join(",") || "none"}`,
    );

    const image = await this.ensureProbeImage();
    if (!image) {
      return this.finish(startedAt, {
        ...base,
        firewall,
        subnets,
        status: "unverified",
        reason: "probe-image-unavailable",
        summary: `Couldn't check whether Docker containers can reach Orkestrator: the 1 MB busybox probe image could not be pulled and the Orkestrator environment image is not built.`,
        remediation: {
          title: "Make the probe image available",
          steps: [
            "Pull the probe image (about 1 MB), or build the Orkestrator environment image, then check again.",
          ],
          commands: [`docker pull ${CONTAINER_HOST_PROBE_IMAGE}`],
        },
      });
    }
    await this.reapStaleProbes();
    // Shutdown began while the image was pulled: create nothing it must remove.
    if (this.closed) return this.snapshot();

    const hostGateway = topology.kind !== "desktop" ? "host-gateway" : null;
    // Both paths at once: a dropped connection costs the full connect timeout.
    const network = await this.createProbeNetwork();
    let probes: ContainerHostProbe[];
    let loopbackProbes: ContainerHostProbe[] = [];
    try {
      const probeBoth = (hostTarget: string | null) =>
        Promise.all([
          this.probeThrowaway(image, "default-bridge", "bridge", port, hostTarget, subnets),
          ...(network
            ? [
                this.probeThrowaway(
                  image,
                  "environment-network",
                  network.name,
                  port,
                  hostTarget,
                  network.subnet ? [network.subnet] : [],
                ),
              ]
            : []),
        ]);
      probes = await probeBoth(hostGateway);
      // Rootless: host-gateway is inside RootlessKit's namespace; try its
      // host loopback address before calling the path blocked.
      if (rootless && !this.closed && !probes.every((probe) => probe.outcome === "reachable")) {
        loopbackProbes = await probeBoth(ROOTLESSKIT_HOST_LOOPBACK_ADDRESS);
      }
    } finally {
      if (network) {
        await this.run("docker", ["network", "rm", network.name], { timeoutMs: 20_000 }).then(
          () => {
            if (this.probeNetwork === network.name) this.probeNetwork = null;
          },
          (error: unknown) =>
            this.log.warn(
              `${LOG_PREFIX} probe network removal failed network=${network.name} error=${boundedError(error)}`,
            ),
        );
      }
    }
    const allSubnets = [
      ...new Set([...subnets, ...probes.map((probe) => probe.subnet).filter(isString)]),
    ];
    if (rootless && !probes.every((probe) => probe.outcome === "reachable")) {
      return this.finishRootless(startedAt, {
        ...base,
        firewall,
        subnets: allSubnets,
        probes: [...probes, ...loopbackProbes],
        probeImage: image,
        dockerRootless: true,
        port,
        loopbackProbes,
      });
    }

    const blocking = probes.filter((probe) => isBlockingOutcome(probe.outcome));
    const reachable = probes.filter((probe) => probe.outcome === "reachable");
    const common = {
      ...base,
      firewall,
      subnets: allSubnets,
      probes,
      probeImage: image,
      dockerRootless: rootless,
    };
    if (blocking.length > 0) {
      const remediation = buildContainerHostRemediation({
        firewall: firewall.kind,
        port,
        subnets: allSubnets,
        outcomes: blocking.map((probe) => probe.outcome),
        hostAddresses: this.hostAddresses(),
      });
      const first = blocking[0]!;
      const partial =
        reachable.length > 0
          ? ` Containers on ${reachable.map((probe) => probe.network).join(", ")} can connect, but those on ${blocking.map((probe) => probe.network).join(", ")} cannot.`
          : "";
      return this.finish(startedAt, {
        ...common,
        status: "blocked",
        reason: null,
        summary: `Agents in Docker containers can't reach Orkestrator's agent tools server on port ${port}: ${outcomeExplanation(first.outcome)}.${partial} Container agents won't be able to submit review results, send mail or update tickets until this is fixed.`,
        remediation,
      });
    }
    if (reachable.length > 0) {
      return this.finish(startedAt, {
        ...common,
        status: "reachable",
        reason: null,
        summary: `Docker containers can reach Orkestrator's agent tools server on port ${port}.`,
      });
    }
    return this.finish(startedAt, {
      ...common,
      status: "unverified",
      reason: "probe-failed",
      summary: `Couldn't check whether Docker containers can reach Orkestrator: the probe container failed to run${probes[0]?.detail ? ` (${probes[0].detail})` : ""}.`,
    });
  }

  /** The verdict on a rootless daemon whose `host-gateway` probes did not all answer. */
  private finishRootless(
    startedAt: number,
    input: ContainerHostReachability & { port: number; loopbackProbes: ContainerHostProbe[] },
  ): ContainerHostReachability {
    const { loopbackProbes, ...common } = input;
    const { port } = input;
    if (
      loopbackProbes.length > 0 &&
      loopbackProbes.every((probe) => probe.outcome === "reachable")
    ) {
      return this.finish(startedAt, {
        ...common,
        status: "reachable",
        reason: null,
        hostAddress: ROOTLESSKIT_HOST_LOOPBACK_ADDRESS,
        summary: `Docker containers can reach Orkestrator's agent tools server on port ${port} through RootlessKit's host loopback (${ROOTLESSKIT_HOST_LOOPBACK_ADDRESS}).`,
      });
    }
    if (!loopbackProbes.some((probe) => isBlockingOutcome(probe.outcome))) {
      return this.finish(startedAt, {
        ...common,
        status: "unverified",
        reason: "probe-failed",
        summary: `Couldn't check whether Docker containers can reach Orkestrator: the probe container failed to run${loopbackProbes[0]?.detail ? ` (${loopbackProbes[0].detail})` : ""}.`,
      });
    }
    return this.finish(startedAt, {
      ...common,
      status: "blocked",
      reason: null,
      summary: `Agents in Docker containers can't reach Orkestrator's agent tools server on port ${port}: Docker runs rootless, and RootlessKit refuses connections from containers to this computer's loopback addresses. Container agents won't be able to submit review results, send mail or update tickets until host loopback is enabled.`,
      remediation: buildRootlessHostRemediation(port),
    });
  }

  private finish(startedAt: number, next: ContainerHostReachability): ContainerHostReachability {
    const result = this.publish({ ...next, checkedAt: new Date(this.now()).toISOString() });
    const elapsedMs = Math.max(0, this.now() - startedAt);
    const line = `${LOG_PREFIX} check finished trigger=${result.trigger} status=${result.status} reason=${result.reason ?? "none"} port=${result.port ?? "none"} firewall=${result.firewall.kind} elapsedMs=${elapsedMs} probes=${result.probes.length}`;
    const warn = result.status === "blocked" || result.reason === "probe-failed";
    if (warn) this.log.warn(line);
    else this.log.info(line);
    for (const probe of result.probes) {
      const probeLine = `${LOG_PREFIX}   probe ${probeFields(probe)}`;
      if (probe.outcome === "reachable") this.log.info(probeLine);
      else this.log.warn(probeLine);
    }
    if (result.status !== "reachable")
      this.log[warn ? "warn" : "info"](`${LOG_PREFIX}   ${result.summary}`);
    if (result.status === "blocked" && result.remediation) {
      for (const command of result.remediation.commands) {
        this.log.warn(`${LOG_PREFIX}   fix: ${command}`);
      }
    }
    return result;
  }

  private publish(next: ContainerHostReachability): ContainerHostReachability {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) {
      try {
        this.deps.emit?.(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT, this.snapshot());
      } catch (error) {
        this.log.warn(`${LOG_PREFIX} event emit failed error=${boundedError(error)}`);
      }
    }
    return this.snapshot();
  }

  private hostAddresses(): string[] {
    try {
      return (this.deps.hostAddresses ?? hostNetworkAddresses)();
    } catch (error) {
      this.log.warn(`${LOG_PREFIX} host address listing failed error=${boundedError(error)}`);
      return [];
    }
  }

  private async ensureProbeImage(): Promise<string | null> {
    if (await this.imagePresent(CONTAINER_HOST_PROBE_IMAGE)) {
      this.log.info(`${LOG_PREFIX} probe image present image=${CONTAINER_HOST_PROBE_IMAGE}`);
      return CONTAINER_HOST_PROBE_IMAGE;
    }
    const pullStarted = this.now();
    this.log.info(`${LOG_PREFIX} pulling probe image image=${CONTAINER_HOST_PROBE_IMAGE}`);
    try {
      await this.run("docker", ["pull", "--quiet", CONTAINER_HOST_PROBE_IMAGE], {
        timeoutMs: PULL_TIMEOUT_MS,
      });
      this.log.info(
        `${LOG_PREFIX} probe image pulled elapsedMs=${Math.max(0, this.now() - pullStarted)}`,
      );
      return CONTAINER_HOST_PROBE_IMAGE;
    } catch (error) {
      this.log.warn(
        `${LOG_PREFIX} probe image pull failed ${commandFailureFields(error)} error=${boundedError(error)}`,
      );
    }
    const fallback = this.deps.fallbackImage();
    if (await this.imagePresent(fallback)) {
      this.log.info(`${LOG_PREFIX} using environment image as probe image=${fallback}`);
      return fallback;
    }
    this.log.warn(`${LOG_PREFIX} no probe image available fallback=${fallback} present=false`);
    return null;
  }

  private async imagePresent(image: string): Promise<boolean> {
    try {
      await this.run("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
        timeoutMs: 15_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private probeLabels(): string[] {
    return [
      "--label",
      `${DOCKER_LABEL_OWNER}=${this.deps.ownerNamespace}`,
      "--label",
      `${DOCKER_LABEL_RESOURCE_ROLE}=${HOST_REACHABILITY_PROBE_ROLE}`,
    ];
  }

  private async probeThrowaway(
    image: string,
    scope: ContainerHostProbeScope,
    network: string,
    port: number,
    /** `--add-host` target for the probe host name: `host-gateway`, an address, or none. */
    hostTarget: string | null,
    subnets: readonly string[],
  ): Promise<ContainerHostProbe> {
    const url = containerAgentToolsUrl(port);
    const name = `ork-${this.deps.ownerNamespace}-reach-${randomBytes(4).toString("hex")}`;
    const started = this.now();
    let classification: ProbeClassification;
    this.probeContainers.add(name);
    try {
      const { stdout, stderr } = await this.run(
        "docker",
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--name",
          name,
          ...this.probeLabels(),
          "--network",
          network,
          ...(hostTarget
            ? ["--add-host", `${CONTAINER_AGENT_TOOLS_PROBE_HOST}:${hostTarget}`]
            : []),
          "--memory",
          "64m",
          "--entrypoint",
          "sh",
          image,
          "-c",
          CONTAINER_HOST_PROBE_SCRIPT,
          "orkestrator-probe",
          url,
          String(PROBE_CONNECT_TIMEOUT_SECONDS),
        ],
        { timeoutMs: PROBE_COMMAND_TIMEOUT_MS },
      );
      classification = classifyProbeOutput(`${stdout}\n${stderr}`);
    } catch (error) {
      classification = { outcome: "error", httpStatus: null, detail: boundedError(error) };
      // A timed-out `docker run` can leave the container behind.
      await this.run("docker", ["rm", "-f", name], { timeoutMs: 15_000 }).catch(() => undefined);
    } finally {
      this.probeContainers.delete(name);
    }
    const subnet =
      scope === "default-bridge"
        ? ((await this.networkSubnet("bridge")) ?? subnets[0] ?? null)
        : (subnets[0] ?? null);
    return {
      scope,
      network,
      subnet,
      containerId: null,
      outcome: classification.outcome,
      httpStatus: classification.httpStatus,
      elapsedMs: Math.max(0, this.now() - started),
      detail: classification.detail,
      ...(hostTarget && hostTarget !== "host-gateway" ? { hostAddress: hostTarget } : {}),
    };
  }

  private async createProbeNetwork(): Promise<{ name: string; subnet: string | null } | null> {
    const name = `ork-${this.deps.ownerNamespace}-reach-probe-net`;
    // A crash mid-check can leave it behind; start from a clean network.
    await this.run("docker", ["network", "rm", name], { timeoutMs: 20_000 }).catch(() => undefined);
    if (this.closed) return null;
    // Tracked before it exists: a shutdown during the create still removes it.
    this.probeNetwork = name;
    try {
      await this.run(
        "docker",
        ["network", "create", "--driver", "bridge", ...this.probeLabels(), name],
        { timeoutMs: 20_000 },
      );
    } catch (error) {
      this.log.warn(
        `${LOG_PREFIX} probe network create failed network=${name} error=${boundedError(error)}; checking the default bridge only`,
      );
      this.probeNetwork = null;
      return null;
    }
    return { name, subnet: await this.networkSubnet(name) };
  }

  private async networkSubnet(network: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(
        "docker",
        ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", network],
        { timeoutMs: 15_000 },
      );
      return stdout.split(/\s+/).find((entry) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(entry)) ?? null;
    } catch {
      return null;
    }
  }

  /** IPv4 subnets of every local bridge network (default and user-defined). */
  private async dockerSubnets(): Promise<string[]> {
    let names: string[];
    try {
      const { stdout } = await this.run(
        "docker",
        ["network", "ls", "--filter", "driver=bridge", "--format", "{{.Name}}"],
        { timeoutMs: 15_000 },
      );
      names = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_NETWORKS_INSPECTED);
    } catch (error) {
      this.log.warn(`${LOG_PREFIX} docker network listing failed error=${boundedError(error)}`);
      return [];
    }
    if (names.length === 0) return [];
    try {
      const { stdout } = await this.run(
        "docker",
        ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", ...names],
        { timeoutMs: 20_000 },
      );
      return [
        ...new Set(stdout.split(/\s+/).filter((entry) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(entry))),
      ];
    } catch (error) {
      this.log.warn(`${LOG_PREFIX} docker network inspect failed error=${boundedError(error)}`);
      return [];
    }
  }

  /**
   * Removes probe containers and networks an interrupted check of this owner
   * left behind (a backend killed mid-check). Owner-scoped: other owners'
   * probes on a shared daemon are never touched.
   */
  private async reapStaleProbes(): Promise<void> {
    const filters = [
      "--filter",
      `label=${DOCKER_LABEL_OWNER}=${this.deps.ownerNamespace}`,
      "--filter",
      `label=${DOCKER_LABEL_RESOURCE_ROLE}=${HOST_REACHABILITY_PROBE_ROLE}`,
    ];
    try {
      const { stdout } = await this.run(
        "docker",
        ["ps", "-a", "--no-trunc", ...filters, "--format", "{{.ID}}"],
        { timeoutMs: 15_000 },
      );
      const ids = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 32);
      if (ids.length > 0) {
        this.log.info(`${LOG_PREFIX} removing ${ids.length} stale probe container(s)`);
        await this.run("docker", ["rm", "-f", ...ids], { timeoutMs: 30_000 }).catch(
          () => undefined,
        );
      }
    } catch {
      // Best effort: a leftover probe is harmless and reaped next time.
    }
    // Then networks, after their containers. Docker refuses to remove a
    // network that still has a container attached, so only unattached ones go.
    const prefix = `ork-${this.deps.ownerNamespace}-reach-`;
    try {
      const { stdout } = await this.run(
        "docker",
        ["network", "ls", ...filters, "--format", "{{.Name}}"],
        { timeoutMs: 15_000 },
      );
      const names = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.startsWith(prefix))
        .slice(0, 32);
      if (names.length > 0) {
        this.log.info(`${LOG_PREFIX} removing ${names.length} stale probe network(s)`);
      }
      // One per call: a refusal (still attached) must not keep the others.
      for (const name of names) {
        await this.run("docker", ["network", "rm", name], { timeoutMs: 20_000 }).catch(
          () => undefined,
        );
      }
    } catch {
      // Best effort, as above.
    }
  }

  private async detectFirewall(): Promise<{ kind: HostFirewallKind; detail: string | null }> {
    const readText =
      this.deps.readTextFile ??
      ((path: string) => readFile(path, "utf8").catch(() => null as string | null));
    const ufwConfig = await readText("/etc/ufw/ufw.conf");
    const unitActive = async (unit: string) =>
      this.run("systemctl", ["is-active", unit], { timeoutMs: 5_000 }).then(
        ({ stdout }) => stdout.trim() === "active",
        () => false,
      );
    const ufwEnabled =
      ufwConfig !== null ? /^\s*ENABLED\s*=\s*yes\s*$/im.test(ufwConfig) : await unitActive("ufw");
    if (ufwEnabled) {
      const defaults = await readText("/etc/default/ufw");
      const policy = defaults
        ? /^\s*DEFAULT_INPUT_POLICY\s*=\s*"?(\w+)"?/im.exec(defaults)?.[1]
        : undefined;
      return {
        kind: "ufw",
        detail: `ufw is enabled${policy ? `; default incoming policy ${policy}` : ""}`,
      };
    }
    if (await unitActive("firewalld")) return { kind: "firewalld", detail: "firewalld is active" };
    if (await unitActive("nftables")) {
      return { kind: "nftables", detail: "nftables.service is active" };
    }
    if (await unitActive("iptables")) {
      return { kind: "iptables", detail: "iptables.service is active" };
    }
    return { kind: "unknown", detail: null };
  }
}

export function containerAgentToolsUrl(port: number): string {
  return `http://${CONTAINER_AGENT_TOOLS_PROBE_HOST}:${port}/mcp`;
}

function probeFields(probe: ContainerHostProbe): string {
  return [
    `scope=${probe.scope}`,
    `network=${probe.network ?? "-"}`,
    `subnet=${probe.subnet ?? "-"}`,
    `host=${probe.hostAddress ?? "host-gateway"}`,
    `outcome=${probe.outcome}`,
    `http=${probe.httpStatus ?? "-"}`,
    `elapsedMs=${probe.elapsedMs}`,
    `detail=${JSON.stringify(probe.detail ?? "")}`,
  ].join(" ");
}

function commandFailureFields(error: unknown): string {
  if (!(error instanceof CommandFailedError)) return "errorType=other";
  return `timedOut=${error.timedOut} exitCode=${error.exitCode ?? "unknown"}`;
}

function boundedError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

function shortId(containerId: string): string {
  return containerId.slice(0, 12);
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}
