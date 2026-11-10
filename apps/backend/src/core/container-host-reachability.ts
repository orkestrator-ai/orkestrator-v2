import { containerHostReachabilityChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { Cause, Effect, Exit, Fiber } from "effect";
import type { BackendEmit } from "./backend-emit.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  ROOTLESSKIT_HOST_LOOPBACK_ADDRESSES,
  initialContainerHostReachability,
  type ContainerHostProbe,
  type ContainerHostProbeOutcome,
  type ContainerHostProbeScope,
  type ContainerHostReachability,
  type ContainerHostRemediation,
  type HostFirewallKind,
} from "@orkestrator/protocol/container-host-reachability";
import type { DockerTopology } from "@orkestrator/protocol/image-manifest";
import {
  DOCKER_LABEL_CREATOR,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RESOURCE_ROLE,
} from "./constants.js";
import type { ProbeCreator } from "./container-host-reachability-creator.js";
import { runCommand } from "./shell.js";
import { reportDockerNetworkChange } from "./docker-network-changes.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  type CommandFailureFields,
  classifyCommandFailure,
} from "@orkestrator/protocol/node/command-failure-reason";

const log = createLogger("docker.reachability");
const probeFailures = new WeakMap<ContainerHostProbe, CommandFailureFields>();

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
/** How long shutdown lets a running check finish on its own before interrupting it. */
const DISPOSE_WAIT_MS = 3_000;
/** Per-command bound on shutdown's own removal when the check did not finish. */
const DISPOSE_REMOVE_TIMEOUT_MS = 5_000;
const PROBE_NETWORK_COMMAND_TIMEOUT_MS = 20_000;
/** Longest network command, plus time for runCommand to reap its timed-out child. */
const DISPOSE_PREPARATION_WAIT_MS = PROBE_NETWORK_COMMAND_TIMEOUT_MS + 1_000;

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

/**
 * One pasteable line that applies `rule` to every source under a single
 * `sudo`. Pasting several `sudo` lines lets the password prompt swallow the
 * next line as the password. `rule` and `then` must not contain single quotes:
 * with more than one source they run inside `sh -c '...'`.
 */
function sudoForEachSource(
  sources: readonly string[],
  rule: (source: string) => string,
  then?: string,
): string {
  if (sources.length === 1) {
    return [`sudo ${rule(sources[0]!)}`, ...(then ? [`sudo ${then}`] : [])].join(" && ");
  }
  const loop = `for net in ${sources.join(" ")}; do ${rule("$net")} || exit 1; done`;
  return `sudo sh -c '${loop}${then ? ` && ${then}` : ""}'`;
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
        commands: [
          sudoForEachSource(
            cidrs,
            (source) =>
              `ufw allow proto tcp from ${source} to any port ${port} comment "Orkestrator agent tools"`,
          ),
        ],
      };
    case "firewalld":
      return {
        title: "Allow Docker containers through firewalld",
        steps: [intro, scope, after],
        commands: [
          sudoForEachSource(
            cidrs,
            (source) =>
              `firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${source} port port=${port} protocol=tcp accept"`,
            "firewall-cmd --reload",
          ),
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
        commands: [
          sudoForEachSource(
            cidrs,
            (source) => `iptables -I INPUT -p tcp -s ${source} --dport ${port} -j ACCEPT`,
          ),
        ],
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
      "Then press “Check again”. New containers reach Orkestrator through RootlessKit's host loopback address, which the check finds and shows once it answers; rebuild existing environments so their network policy includes it.",
    ],
    commands: [
      [
        "mkdir -p ~/.config/systemd/user/docker.service.d",
        `printf '[Service]\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false"\n' > ${ROOTLESS_HOST_LOOPBACK_DROP_IN}`,
        "systemctl --user daemon-reload",
        "systemctl --user restart docker",
      ].join(" && "),
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
  /**
   * Content-free kind of this backend (`probeCreator`), labelled on every
   * probe network and container so a leaked one can be traced to a test
   * backend, a profile or production. Omitted, the label is left off.
   */
  creator?: ProbeCreator;
  /** Configured environment image, the fallback probe image. */
  fallbackImage: () => string;
  emit?: BackendEmit;
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
};

type ContainerProbeCacheEntry = { at: number; port: number; probe: ContainerHostProbe };

/** `created` is false when the create command failed; the daemon may still have made it. */
type ProbeNetwork = { name: string; subnet: string | null; created: boolean };
type ProbeRun = { output: Awaited<ReturnType<typeof runCommand>> } | { error: unknown };
/** Shared by one check's releases. */
type ProbeCleanup = {
  /** Removals that wait for an interrupted `docker run` to really end. */
  late: Promise<unknown>[];
  /** Containers whose interrupted removal failed, retried if the network removal fails. */
  failedRemovals: string[];
};

/**
 * The host check runs as an Effect fiber ({@link checkProgram}) so shutdown
 * can interrupt it, and its Docker resources live in a scope:
 * `acquireRelease(network create, network rm)` and, per probe,
 * `acquireRelease(start docker run, rm -f)`. An acquire is uninterruptible, so
 * a network is never removed before its create settles, and a release runs on
 * success, failure and interruption alike. An interrupted release removes
 * whatever the create may have made: interrupting a client proves nothing about
 * the daemon, so a probe container is removed again once its `docker run`
 * really ends. {@link dispose} interrupts the fiber and waits, bounded, for the
 * releases.
 */
export class ContainerHostReachabilityService {
  private state: ContainerHostReachability = initialContainerHostReachability();
  private inFlight: Promise<ContainerHostReachability> | null = null;
  private checkFiber: Fiber.Fiber<ContainerHostReachability> | null = null;
  /** Set by {@link dispose}: no check starts, and a running one starts no new Docker work. */
  private closed = false;
  private disposing: Promise<void> | null = null;
  /** The uninterruptible network acquire is running, so an interrupt waits for Docker. */
  private preparingNetwork = false;
  private lastAutoRecheckAt = Number.NEGATIVE_INFINITY;
  private readonly containerCache = new Map<string, ContainerProbeCacheEntry>();
  private readonly containerInFlight = new Map<string, Promise<ContainerHostProbe>>();
  private readonly platform: NodeJS.Platform;
  private readonly run: typeof runCommand;
  private readonly now: () => number;

  constructor(private readonly deps: ContainerHostReachabilityDependencies) {
    this.platform = deps.platform ?? process.platform;
    this.run = deps.run ?? runCommand;
    this.now = deps.now ?? Date.now;
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
    const cleanup: ProbeCleanup = { late: [], failedRemovals: [] };
    const fiber = Effect.runFork(this.checkProgram(trigger, cleanup));
    this.checkFiber = fiber;
    const running = Effect.runPromise(Fiber.await(fiber))
      .then(async (exit) => {
        // The check settles once its interrupted probe containers are removed.
        await Promise.all(cleanup.late);
        if (Exit.isSuccess(exit)) return exit.value;
        // Shutdown cut it short: no verdict.
        if (Cause.hasInterruptsOnly(exit.cause)) return this.snapshot();
        throw Cause.squash(exit.cause);
      })
      .catch((error: unknown) => {
        log.warn("check.crashed", { trigger, error: formatLogError(error) });
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
        this.checkFiber = null;
      });
    this.inFlight = running;
    return running;
  }

  /**
   * For backend shutdown: stops new checks and settles a running one so its
   * probe network does not outlive the process. Gives the check `waitMs` to
   * finish on its own, then interrupts it; its releases remove the probe
   * containers and network, each command bounded. A network create in flight
   * gets one additional network-command deadline to settle; after that the
   * fiber's release still removes the network once it does. Never rejects. A
   * SIGKILL still leaks; {@link reapStaleProbes} recovers that on the owner's
   * next check.
   */
  dispose(waitMs = DISPOSE_WAIT_MS): Promise<void> {
    this.closed = true;
    this.disposing ??= this.settleForShutdown(waitMs);
    return this.disposing;
  }

  private async settleForShutdown(waitMs: number): Promise<void> {
    const fiber = this.checkFiber;
    if (!fiber || (await settlesWithin(Effect.runPromise(Fiber.await(fiber)), waitMs))) return;
    log.info("shutdown.removing-resources");
    const released = Effect.runPromise(Fiber.interrupt(fiber));
    if (!this.preparingNetwork) return released;
    // The network acquire is uninterruptible: the interrupt waits for the
    // create to settle, so an early "not found" never precedes a late create.
    log.info("shutdown.awaiting-network");
    if (!(await settlesWithin(released, DISPOSE_PREPARATION_WAIT_MS))) {
      log.warn("shutdown.cleanup-deferred");
    }
  }

  private async removeShutdownProbeContainer(name: string): Promise<boolean> {
    try {
      await this.run("docker", ["rm", "-f", name], {
        timeoutMs: DISPOSE_REMOVE_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      log.warn("shutdown.container-remove-failed", {
        container: name,
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
      return false;
    }
  }

  private async removeShutdownProbeNetwork(network: string): Promise<boolean> {
    try {
      await this.run("docker", ["network", "rm", network], {
        timeoutMs: DISPOSE_REMOVE_TIMEOUT_MS,
      });
      reportDockerNetworkChange();
      return true;
    } catch (error) {
      log.warn("shutdown.network-remove-failed", {
        network,
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
      return false;
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
      log.warn("probe.skipped", {
        trigger: options.reason,
        container: shortId(containerId),
        cause: "agent-tools-not-listening",
      });
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
    log.warn("preflight.refused", {
      stage,
      environmentId: environment.id,
      container: shortId(environment.containerId),
      outcome: probe.outcome,
      hostStatus: host.status,
    });
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
        log.warn("probe.prepare-failed", {
          container: shortId(containerId),
          ...classifyCommandFailure(error, { tools: ["docker"] }),
          error: formatLogError(error),
        });
      });
    }
    const started = this.now();
    let classification: ProbeClassification;
    let failure: CommandFailureFields | undefined;
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
      failure = classifyCommandFailure(error, { tools: ["docker"] });
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
    if (failure) probeFailures.set(probe, failure);
    this.containerCache.set(containerId, { at: this.now(), port, probe });
    if (this.containerCache.size > 256) {
      const oldest = this.containerCache.keys().next().value;
      if (oldest !== undefined) this.containerCache.delete(oldest);
    }
    log[probe.outcome === "reachable" ? "info" : "warn"]("probe.result", () => ({
      trigger: options.reason,
      container: shortId(containerId),
      url,
      ...probeFields(probe),
    }));
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
    log.info("probe.contradicts-host", { hostStatus: this.state.status, outcome: probe.outcome });
    void this.check("recheck");
  }

  /** An interruption point for an awaited step; `signal` aborts when the check is interrupted. */
  private awaitStep<A>(step: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> {
    return Effect.promise((signal) => step(signal));
  }

  /** Shutdown began while the check ran on (dispose waits before interrupting): start nothing new. */
  private readonly stopIfClosing: Effect.Effect<void> = Effect.suspend(() =>
    this.closed ? Effect.interrupt : Effect.void,
  );

  private checkProgram(
    trigger: "boot" | "manual" | "recheck",
    cleanup: ProbeCleanup,
  ): Effect.Effect<ContainerHostReachability> {
    return Effect.gen({ self: this }, function* () {
      const startedAt = this.now();
      const port = this.deps.servicePort();
      log.info("check.started", { trigger, platform: this.platform, port: port ?? null });
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

      const topology = yield* this.awaitStep(() =>
        this.deps.detectTopology
          ? this.deps.detectTopology()
          : import("./docker-image.js").then((module) => module.detectDockerTopology()),
      );
      const rootless = topology.rootless === true;
      log.info("topology.detected", { kind: topology.kind, rootless });
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

      const [firewall, subnets] = yield* this.awaitStep((signal) =>
        Promise.all([this.detectFirewall(signal), this.dockerSubnets()]),
      );
      log.info("firewall.detected", {
        kind: firewall.kind,
        detail: firewall.detail ?? null,
        dockerSubnets: subnets.join(",") || null,
      });

      const image = yield* this.awaitStep((signal) => this.ensureProbeImage(signal));
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
      yield* this.awaitStep((signal) => this.reapStaleProbes(signal));
      // Shutdown began while the image was pulled: create nothing it must remove.
      yield* this.stopIfClosing;

      const hostGateway = topology.kind !== "desktop" ? "host-gateway" : null;
      // The scope closes, removing the network, before the verdict is published.
      const { probes, loopbackProbes, loopbackAddress } = yield* Effect.scoped(
        this.probeHost(image, port, hostGateway, rootless, subnets, cleanup),
      );
      return this.finishProbes(startedAt, base, {
        firewall,
        subnets,
        image,
        port,
        rootless,
        probes,
        loopbackProbes,
        loopbackAddress,
      });
    });
  }

  /** Probes the default bridge and a temporary network, both held in the caller's scope. */
  private probeHost(
    image: string,
    port: number,
    hostGateway: string | null,
    rootless: boolean,
    subnets: string[],
    cleanup: ProbeCleanup,
  ) {
    return Effect.gen({ self: this }, function* () {
      const prepared = yield* Effect.acquireRelease(
        Effect.promise(() => this.createProbeNetwork()),
        (network, exit) => this.releaseProbeNetwork(network, exit, cleanup),
      );
      yield* this.stopIfClosing;
      const network = prepared?.created ? prepared : null;
      // Both paths at once: a dropped connection costs the full connect timeout.
      const probeBoth = (hostTarget: string | null) =>
        Effect.all(
          [
            this.probeThrowaway(
              image,
              "default-bridge",
              "bridge",
              port,
              hostTarget,
              subnets,
              cleanup,
            ),
            ...(network
              ? [
                  this.probeThrowaway(
                    image,
                    "environment-network",
                    network.name,
                    port,
                    hostTarget,
                    network.subnet ? [network.subnet] : [],
                    cleanup,
                  ),
                ]
              : []),
          ],
          { concurrency: "unbounded" },
        );
      const probes = yield* probeBoth(hostGateway);
      const loopbackProbes: ContainerHostProbe[] = [];
      let loopbackAddress: string | null = null;
      // Rootless: host-gateway is inside RootlessKit's namespace; try its
      // host loopback addresses (slirp4netns's, then gvisor-tap-vsock's)
      // before calling the path blocked, and keep the first that answers.
      if (rootless && !probes.every((probe) => probe.outcome === "reachable")) {
        for (const address of ROOTLESSKIT_HOST_LOOPBACK_ADDRESSES) {
          yield* this.stopIfClosing;
          const attempt = yield* probeBoth(address);
          loopbackProbes.push(...attempt);
          if (attempt.length > 0 && attempt.every((probe) => probe.outcome === "reachable")) {
            loopbackAddress = address;
            break;
          }
        }
      }
      return { probes, loopbackProbes, loopbackAddress };
    });
  }

  /** The verdict from the probes of a check that ran them. */
  private finishProbes(
    startedAt: number,
    base: ContainerHostReachability,
    scan: {
      firewall: ContainerHostReachability["firewall"];
      subnets: string[];
      image: string;
      port: number;
      rootless: boolean;
      probes: ContainerHostProbe[];
      loopbackProbes: ContainerHostProbe[];
      /** The RootlessKit host loopback address every loopback probe reached through. */
      loopbackAddress: string | null;
    },
  ): ContainerHostReachability {
    const { firewall, subnets, image, port, rootless, probes, loopbackProbes, loopbackAddress } =
      scan;
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
        loopbackAddress,
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
    input: ContainerHostReachability & {
      port: number;
      loopbackProbes: ContainerHostProbe[];
      loopbackAddress: string | null;
    },
  ): ContainerHostReachability {
    const { loopbackProbes, loopbackAddress, ...common } = input;
    const { port } = input;
    if (loopbackAddress) {
      return this.finish(startedAt, {
        ...common,
        status: "reachable",
        reason: null,
        hostAddress: loopbackAddress,
        summary: `Docker containers can reach Orkestrator's agent tools server on port ${port} through RootlessKit's host loopback (${loopbackAddress}).`,
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
    const warn = result.status === "blocked" || result.reason === "probe-failed";
    const level = warn ? "warn" : "info";
    log[level]("check.finished", {
      trigger: result.trigger,
      status: result.status,
      outcome: result.reason ?? null,
      port: result.port ?? null,
      firewall: result.firewall.kind,
      elapsedMs,
      probes: result.probes.length,
    });
    // Log the original probes: publication clones the UI snapshot.
    for (const probe of next.probes) {
      log[probe.outcome === "reachable" ? "info" : "warn"]("check.probe", () => probeFields(probe));
    }
    if (result.status !== "reachable") {
      log[level]("check.summary", { status: result.status, reason: result.reason, elapsedMs });
    }
    if (result.status === "blocked" && result.remediation) {
      for (const command of result.remediation.commands) {
        log.warn("check.remediation", { command });
      }
    }
    return result;
  }

  private publish(next: ContainerHostReachability): ContainerHostReachability {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) {
      try {
        this.deps.emit?.(containerHostReachabilityChangedEvent, this.snapshot());
      } catch (error) {
        log.warn("event.emit-failed", { error: formatLogError(error) });
      }
    }
    return this.snapshot();
  }

  private hostAddresses(): string[] {
    try {
      return (this.deps.hostAddresses ?? hostNetworkAddresses)();
    } catch (error) {
      log.warn("host-addresses.list-failed", {
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
      return [];
    }
  }

  private async ensureProbeImage(signal?: AbortSignal): Promise<string | null> {
    if (await this.imagePresent(CONTAINER_HOST_PROBE_IMAGE, signal)) {
      log.info("probe-image.present", { image: CONTAINER_HOST_PROBE_IMAGE });
      return CONTAINER_HOST_PROBE_IMAGE;
    }
    const pullStarted = this.now();
    log.info("probe-image.pulling", { image: CONTAINER_HOST_PROBE_IMAGE });
    try {
      await this.run("docker", ["pull", "--quiet", CONTAINER_HOST_PROBE_IMAGE], {
        timeoutMs: PULL_TIMEOUT_MS,
        signal,
      });
      log.info("probe-image.pulled", { elapsedMs: Math.max(0, this.now() - pullStarted) });
      return CONTAINER_HOST_PROBE_IMAGE;
    } catch (error) {
      // The check was interrupted: nobody reads the result.
      if (signal?.aborted) return null;
      log.warn("probe-image.pull-failed", {
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
    }
    const fallback = this.deps.fallbackImage();
    if (await this.imagePresent(fallback, signal)) {
      log.info("probe-image.fallback", { image: fallback });
      return fallback;
    }
    log.warn("probe-image.missing", { fallback });
    return null;
  }

  private async imagePresent(image: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.run("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
        timeoutMs: 15_000,
        signal,
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
      ...(this.deps.creator ? ["--label", `${DOCKER_LABEL_CREATOR}=${this.deps.creator}`] : []),
    ];
  }

  private probeThrowaway(
    image: string,
    scope: ContainerHostProbeScope,
    network: string,
    port: number,
    /** `--add-host` target for the probe host name: `host-gateway`, an address, or none. */
    hostTarget: string | null,
    subnets: readonly string[],
    cleanup: ProbeCleanup,
  ): Effect.Effect<ContainerHostProbe> {
    return Effect.gen({ self: this }, function* () {
      const url = containerAgentToolsUrl(port);
      const name = `ork-${this.deps.ownerNamespace}-reach-${randomBytes(4).toString("hex")}`;
      const started = this.now();
      const args = [
        "run",
        "--rm",
        "--pull",
        "never",
        "--name",
        name,
        ...this.probeLabels(),
        "--network",
        network,
        ...(hostTarget ? ["--add-host", `${CONTAINER_AGENT_TOOLS_PROBE_HOST}:${hostTarget}`] : []),
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
      ];
      const run = yield* Effect.scoped(
        Effect.flatMap(
          Effect.acquireRelease(
            Effect.sync(() => this.startProbeRun(args)),
            (running, exit) => this.releaseProbeContainer(name, running, exit, cleanup),
          ),
          // No abort signal: the release's late removal waits for this
          // command to really end, which killing the client would not prove.
          (running) => Effect.promise(() => running),
        ),
      );
      let classification: ProbeClassification;
      let failure: CommandFailureFields | undefined;
      if ("error" in run) {
        classification = { outcome: "error", httpStatus: null, detail: boundedError(run.error) };
        failure = classifyCommandFailure(run.error, { tools: ["docker"] });
      } else {
        classification = classifyProbeOutput(`${run.output.stdout}\n${run.output.stderr}`);
      }
      const subnet =
        scope === "default-bridge"
          ? ((yield* this.awaitStep((signal) => this.networkSubnet("bridge", signal))) ??
            subnets[0] ??
            null)
          : (subnets[0] ?? null);
      const probe: ContainerHostProbe = {
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
      if (failure) probeFailures.set(probe, failure);
      return probe;
    });
  }

  /** Starts `docker run`; from here on the daemon may create the container. Never rejects. */
  private startProbeRun(args: string[]): Promise<ProbeRun> {
    // Async, so a runner that throws synchronously still yields a failed run.
    return (async () => this.run("docker", args, { timeoutMs: PROBE_COMMAND_TIMEOUT_MS }))().then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
  }

  private releaseProbeContainer(
    name: string,
    running: Promise<ProbeRun>,
    exit: Exit.Exit<unknown, unknown>,
    cleanup: ProbeCleanup,
  ): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (Exit.hasInterrupts(exit)) {
        // Remove it now, which also ends an attached run, and again once the
        // run settles: an early "not found" can precede the daemon's create.
        if (!(await this.removeShutdownProbeContainer(name))) cleanup.failedRemovals.push(name);
        cleanup.late.push(running.then(() => this.removeShutdownProbeContainer(name)));
        return;
      }
      // A timed-out `docker run` can leave the container behind.
      if ("error" in (await running)) {
        await this.run("docker", ["rm", "-f", name], { timeoutMs: 15_000 }).catch(() => undefined);
      }
    });
  }

  /** Runs uninterruptibly as the network's acquire. */
  private async createProbeNetwork(): Promise<ProbeNetwork | null> {
    const name = `ork-${this.deps.ownerNamespace}-reach-probe-net`;
    this.preparingNetwork = true;
    try {
      // A crash mid-check can leave it behind; start from a clean network.
      await this.run("docker", ["network", "rm", name], {
        timeoutMs: PROBE_NETWORK_COMMAND_TIMEOUT_MS,
      }).catch(() => undefined);
      // Interruption waits for this acquire, so shutdown is read here: create
      // nothing it must remove.
      if (this.closed) return null;
      try {
        await this.run(
          "docker",
          ["network", "create", "--driver", "bridge", ...this.probeLabels(), name],
          { timeoutMs: PROBE_NETWORK_COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        log.warn("probe-network.create-failed", {
          network: name,
          ...classifyCommandFailure(error, { tools: ["docker"] }),
          error: formatLogError(error),
        });
        return { name, subnet: null, created: false };
      }
      if (this.closed) return { name, subnet: null, created: true };
      // The agent-tools server must admit the probe containers' new subnet.
      reportDockerNetworkChange();
      return { name, subnet: await this.networkSubnet(name), created: true };
    } finally {
      this.preparingNetwork = false;
    }
  }

  private releaseProbeNetwork(
    network: ProbeNetwork | null,
    exit: Exit.Exit<unknown, unknown>,
    cleanup: ProbeCleanup,
  ): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (!network) return;
      if (Exit.hasInterrupts(exit)) {
        // Even a failed client command can have created a daemon-side network.
        if (await this.removeShutdownProbeNetwork(network.name)) return;
        // An endpoint may still be attached after a failed container removal.
        // Retry those names and the network once, each with a bounded command.
        for (const name of cleanup.failedRemovals) await this.removeShutdownProbeContainer(name);
        if (!(await this.removeShutdownProbeNetwork(network.name)) && cleanup.late.length > 0) {
          // Do not hold dispose open on a docker run that is still pending.
          // The check joins this final, bounded attempt after all late endpoint
          // removals, when the network can actually be released.
          const endpoints = Promise.all(cleanup.late);
          cleanup.late.push(endpoints.then(() => this.removeShutdownProbeNetwork(network.name)));
        }
        return;
      }
      if (!network.created) return;
      await this.run("docker", ["network", "rm", network.name], {
        timeoutMs: this.closed ? DISPOSE_REMOVE_TIMEOUT_MS : 20_000,
      }).then(
        () => reportDockerNetworkChange(),
        (error: unknown) =>
          log.warn("probe-network.remove-failed", {
            network: network.name,
            ...classifyCommandFailure(error, { tools: ["docker"] }),
            error: formatLogError(error),
          }),
      );
    });
  }

  private async networkSubnet(network: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const { stdout } = await this.run(
        "docker",
        ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", network],
        { timeoutMs: 15_000, signal },
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
      log.warn("network.list-failed", {
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
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
      log.warn("network.inspect-failed", {
        ...classifyCommandFailure(error, { tools: ["docker"] }),
        error: formatLogError(error),
      });
      return [];
    }
  }

  /**
   * Removes probe containers and networks an interrupted check of this owner
   * left behind (a backend killed mid-check). Owner-scoped: other owners'
   * probes on a shared daemon are never touched.
   */
  private async reapStaleProbes(signal?: AbortSignal): Promise<void> {
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
        { timeoutMs: 15_000, signal },
      );
      const ids = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 32);
      if (ids.length > 0) {
        log.info("stale-containers.removing", { count: ids.length });
        for (const id of ids) {
          await this.run("docker", ["rm", "-f", id], { timeoutMs: 30_000, signal }).catch(
            () => undefined,
          );
        }
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
        { timeoutMs: 15_000, signal },
      );
      const names = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.startsWith(prefix))
        .slice(0, 32);
      if (names.length > 0) {
        log.info("stale-networks.removing", { count: names.length });
      }
      // One per call: a refusal (still attached) must not keep the others.
      for (const name of names) {
        await this.run("docker", ["network", "rm", name], { timeoutMs: 20_000, signal }).catch(
          () => undefined,
        );
      }
      if (names.length > 0) reportDockerNetworkChange();
    } catch {
      // Best effort, as above.
    }
  }

  private async detectFirewall(
    signal?: AbortSignal,
  ): Promise<{ kind: HostFirewallKind; detail: string | null }> {
    const readText =
      this.deps.readTextFile ??
      ((path: string) => readFile(path, "utf8").catch(() => null as string | null));
    const ufwConfig = await readText("/etc/ufw/ufw.conf");
    const unitActive = async (unit: string) =>
      this.run("systemctl", ["is-active", unit], { timeoutMs: 5_000, signal }).then(
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

function probeFields(probe: ContainerHostProbe) {
  return {
    scope: probe.scope,
    network: probe.network ?? null,
    subnet: probe.subnet ?? null,
    host: probe.hostAddress ?? "host-gateway",
    outcome: probe.outcome,
    http: probe.httpStatus ?? null,
    elapsedMs: probe.elapsedMs,
    ...probeFailures.get(probe),
  };
}

/** Whether `work` settles within `ms`. Never rejects. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
