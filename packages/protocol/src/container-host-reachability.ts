/**
 * Can agents inside Docker containers reach the backend's agent tools server?
 *
 * Container agents submit workflow results, read mail and update tickets
 * through `http://host.docker.internal:<port>/mcp`. A host firewall that drops
 * Docker-network traffic (ufw's default on many Linux desktops) makes every
 * one of those calls hang, so the backend probes the path at startup and
 * before workflow stages, and the renderer shows the result.
 */

/** Emitted with a {@link ContainerHostReachability} whenever the snapshot changes. */
export const CONTAINER_HOST_REACHABILITY_CHANGED_EVENT = "container-host-reachability-changed";

/**
 * - `reachable`: the probe got an HTTP response (any status).
 * - `timeout`: the connection was never answered; a firewall is dropping it.
 * - `refused`: the host actively rejected it (a REJECT rule, or nothing listening).
 * - `unreachable`: no route to the host (an ICMP-rejecting rule or routing).
 * - `dns`: `host.docker.internal` does not resolve inside the container.
 * - `error`: the probe itself could not run; says nothing about the path.
 */
export type ContainerHostProbeOutcome =
  | "reachable"
  | "timeout"
  | "refused"
  | "unreachable"
  | "dns"
  | "error";

export type ContainerHostProbeScope =
  /** A throwaway container on Docker's default `bridge` network (`docker0`). */
  | "default-bridge"
  /** A throwaway container on a temporary per-environment style network. */
  | "environment-network"
  /** A running environment container. */
  | "environment-container";

export type ContainerHostProbe = {
  scope: ContainerHostProbeScope;
  network: string | null;
  subnet: string | null;
  /** The environment container probed, for `environment-container`. */
  containerId: string | null;
  outcome: ContainerHostProbeOutcome;
  httpStatus: number | null;
  elapsedMs: number;
  /** Bounded, credential-free probe output (wget/curl error text). */
  detail: string | null;
};

export type HostFirewallKind = "ufw" | "firewalld" | "nftables" | "iptables" | "unknown";

export type ContainerHostReachabilityStatus =
  | "checking"
  | "reachable"
  | "blocked"
  /** The check could not run; `reason` says why. Not proof either way. */
  | "unverified"
  /** Not relevant on this host (not Linux, or a remote Docker daemon). */
  | "not-applicable";

export type ContainerHostUnverifiedReason =
  | "not-linux"
  | "docker-remote"
  | "docker-unavailable"
  | "agent-tools-not-listening"
  | "probe-image-unavailable"
  | "probe-failed"
  | "not-checked";

export type ContainerHostRemediation = {
  title: string;
  /** Plain-language steps, in order. */
  steps: string[];
  /** Shell commands to copy. Contain no secrets. */
  commands: string[];
};

export type ContainerHostReachability = {
  status: ContainerHostReachabilityStatus;
  /** Why the result is `unverified` or `not-applicable`; null otherwise. */
  reason: ContainerHostUnverifiedReason | null;
  /** One sentence for banners and logs. */
  summary: string;
  checkedAt: string | null;
  /** What triggered the most recent check. */
  trigger: "boot" | "manual" | "recheck" | null;
  port: number | null;
  /** The URL containers use; never carries a credential. */
  url: string | null;
  probeImage: string | null;
  probes: ContainerHostProbe[];
  firewall: { kind: HostFirewallKind; detail: string | null };
  /** Docker network subnets containers use on this host. */
  subnets: string[];
  remediation: ContainerHostRemediation | null;
};

export function initialContainerHostReachability(): ContainerHostReachability {
  return {
    status: "unverified",
    reason: "not-checked",
    summary: "Container connectivity to Orkestrator has not been checked yet.",
    checkedAt: null,
    trigger: null,
    port: null,
    url: null,
    probeImage: null,
    probes: [],
    firewall: { kind: "unknown", detail: null },
    subnets: [],
    remediation: null,
  };
}

/** True when the renderer should warn the user. */
export function containerHostReachabilityNeedsAttention(
  value: Pick<ContainerHostReachability, "status" | "reason">,
): boolean {
  return (
    value.status === "blocked" ||
    (value.status === "unverified" &&
      (value.reason === "probe-failed" ||
        value.reason === "probe-image-unavailable" ||
        value.reason === "agent-tools-not-listening"))
  );
}

export function isContainerHostReachability(value: unknown): value is ContainerHostReachability {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "string" &&
    typeof record.summary === "string" &&
    Array.isArray(record.probes) &&
    Array.isArray(record.subnets) &&
    !!record.firewall &&
    typeof record.firewall === "object"
  );
}
