import { createHash } from "node:crypto";
import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_NETWORK_POLICY,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RESOURCE_ROLE,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";
import { ContainerLifecycleError } from "./container-lifecycle-service.js";
import { requiredAgentNetworkDomains } from "./constants.js";
import { imageCapabilities } from "./docker-image.js";
import type { AppConfig, Environment } from "./models.js";

/**
 * One Docker bridge network per environment (network policy 2).
 *
 * The network holds only the environment's own runtime (and, during a
 * replacement, its candidate — never both running), so the in-container
 * firewall no longer has to guess which /24 is "the host": siblings live on
 * other networks, which Docker isolates from each other. The network is
 * labelled with this registry's owner and the environment, created without
 * IPv6, adopted only when its labels match exactly, and removed after the
 * environment's containers by the deletion ledger.
 */

export const NETWORK_ROLE = "network";

export function environmentNetworkName(owner: string, environmentId: string): string {
  // Environment ids are not bounded to Docker's name alphabet; a digest keeps
  // the name valid, short and stable.
  const key = createHash("sha256").update(environmentId).digest("hex").slice(0, 16);
  return `ork-${owner}-${key}-net`;
}

function expectedLabels(owner: string, environmentId: string): Record<string, string> {
  return {
    [DOCKER_LABEL_APP]: DOCKER_LABEL_APP_VALUE,
    [DOCKER_LABEL_OWNER]: owner,
    [DOCKER_LABEL_ENVIRONMENT_ID]: environmentId,
    [DOCKER_LABEL_RESOURCE_ROLE]: NETWORK_ROLE,
  };
}

type NetworkProbe =
  | { kind: "present"; labels: Record<string, string>; containers: number }
  | { kind: "missing" }
  | { kind: "unreachable" };

export async function inspectNetwork(name: string): Promise<NetworkProbe> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["network", "inspect", "--format", "{{json .Labels}}\t{{len .Containers}}", name],
      { timeoutMs: 15_000 },
    );
    const [labelsJson = "{}", count = "0"] = stdout.trim().split("\t");
    const parsed = JSON.parse(labelsJson || "{}") as Record<string, unknown> | null;
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (typeof value === "string") labels[key] = value;
    }
    return { kind: "present", labels, containers: Number.parseInt(count, 10) || 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|no such network/i.test(message)) return { kind: "missing" };
    return { kind: "unreachable" };
  }
}

function labelsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/**
 * Creates the environment's network, or adopts the one an earlier (possibly
 * interrupted) attempt created. A same-named network with other labels is
 * never used, and a creation failure never falls back to the shared bridge.
 */
export async function ensureEnvironmentNetwork(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
): Promise<string> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const name = environmentNetworkName(owner, environmentId);
  const labels = expectedLabels(owner, environmentId);
  const existing = await inspectNetwork(name);
  if (existing.kind === "present") {
    if (labelsMatch(existing.labels, labels)) return name;
    throw new ContainerLifecycleError(
      "needs-attention",
      "A Docker network with this environment's name exists but is not labelled as its own. It was left untouched.",
    );
  }
  if (existing.kind === "unreachable") {
    throw new ContainerLifecycleError(
      "daemon-unavailable",
      "Docker could not be asked about the environment's network. Retry once Docker is reachable.",
    );
  }
  try {
    await runCommand(
      "docker",
      [
        "network",
        "create",
        "--driver",
        "bridge",
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        name,
      ],
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    // An ambiguous create (timeout, a racing attempt) is resolved by exact
    // identity rather than reported as failure.
    const after = await inspectNetwork(name);
    if (after.kind === "present" && labelsMatch(after.labels, labels)) return name;
    const message = error instanceof Error ? error.message : String(error);
    throw new ContainerLifecycleError(
      /address pools|could not find an available|non-overlapping/i.test(message)
        ? "resource-exhausted"
        : "needs-attention",
      /address pools|could not find an available|non-overlapping/i.test(message)
        ? "Docker has no free address range for another environment network. Remove unused networks or widen Docker's default address pools."
        : "Docker could not create the environment's network. Nothing else was changed.",
    );
  }
  return name;
}

/**
 * Removes the environment's network when it is this registry's, labelled for
 * this environment and nothing is attached. `in-use` and `unreachable` are
 * retried; a same-named network that is not ours is never touched.
 */
export async function removeEnvironmentNetwork(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
): Promise<"removed" | "absent" | "foreign" | "in-use" | "unreachable"> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const name = environmentNetworkName(owner, environmentId);
  const probe = await inspectNetwork(name);
  if (probe.kind === "missing") return "absent";
  if (probe.kind === "unreachable") return "unreachable";
  if (!labelsMatch(probe.labels, expectedLabels(owner, environmentId))) return "foreign";
  if (probe.containers > 0) return "in-use";
  try {
    await runCommand("docker", ["network", "rm", name], { timeoutMs: 30_000 });
    return "removed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|no such network/i.test(message)) return "absent";
    return /active endpoints|in use/i.test(message) ? "in-use" : "unreachable";
  }
}

/** Container ports Docker publishes for a runtime, for the ingress rule. */
export function ingressPorts(publishArguments: readonly string[]): number[] {
  const ports = new Set<number>();
  for (let index = 0; index < publishArguments.length; index += 1) {
    if (publishArguments[index] !== "-p") continue;
    const spec = publishArguments[index + 1] ?? "";
    const match = /:(\d+)\/tcp$/.exec(spec);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 ? value : null;
}

/**
 * The allowlist a restricted container receives: the environment's own list
 * or the global one, plus the hosts the enabled agent platforms require. The
 * same list goes into `ALLOWED_DOMAINS` at creation and into a live update,
 * so its revision identifies it on both sides.
 */
export function configuredAllowedDomains(
  environment: Pick<Environment, "allowedDomains">,
  config: Pick<AppConfig, "global">,
): string[] {
  return [
    ...new Set([
      ...(environment.allowedDomains ?? config.global.allowedDomains ?? []),
      ...requiredAgentNetworkDomains(config.global.enabledAgentPlatforms),
    ]),
  ];
}

/** Same digest as `ork_domains_revision` in docker/firewall-domains.sh. */
export function allowedDomainsRevision(domains: readonly string[]): string {
  return createHash("sha256").update(domains.join(",")).digest("hex").slice(0, 16);
}

/** Parses the firewall's status report; anything unexpected reads as absent. */
export function parseFirewallStatus(text: string): EnvironmentNetworkPolicy["effective"] {
  if (!text.trim() || text.length > 4096) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.mode !== "full" && value.mode !== "restricted") return null;
  return {
    mode: value.mode,
    state: value.state === "applied" || value.state === "failed" ? value.state : null,
    appliedAt: boundedTimestamp(value.appliedAt),
    resolvedDomains: boundedNumber(value.resolvedDomains),
    unresolvedDomains: boundedNumber(value.unresolvedDomains),
    allowedEntries: boundedNumber(value.allowedEntries),
    hostServicePorts:
      typeof value.hostServicePorts === "string" && /^[0-9,]*$/.test(value.hostServicePorts)
        ? value.hostServicePorts
        : null,
    ipv6: value.ipv6 === "blocked" || value.ipv6 === "disabled" ? value.ipv6 : null,
    githubRanges:
      value.githubRanges === "seed" ||
      value.githubRanges === "live" ||
      value.githubRanges === "seed-stale" ||
      value.githubRanges === "cached"
        ? value.githubRanges
        : null,
    domainsRevision:
      typeof value.domainsRevision === "string" && /^[0-9a-f]{16}$/.test(value.domainsRevision)
        ? value.domainsRevision
        : null,
    refreshedAt: boundedTimestamp(value.refreshedAt),
    nextRefreshAt: boundedTimestamp(value.nextRefreshAt),
    carriedDomains: boundedNumber(value.carriedDomains),
    carriedUntil: boundedTimestamp(value.carriedUntil),
    refreshFailures: boundedNumber(value.refreshFailures),
    revokedEntries: boundedNumber(value.revokedEntries),
    revocation:
      value.revocation === "conntrack" || value.revocation === "unavailable"
        ? value.revocation
        : null,
  };
}

// Refreshing images keep the report in a root-only directory; earlier images
// wrote it where node could replace it.
const FIREWALL_STATUS_READ =
  "head -c 4096 /run/orkestrator-firewall/firewall.json 2>/dev/null || head -c 4096 /run/orkestrator/firewall.json";

interface ContainerNetworkFacts {
  policyVersion: 1 | 2;
  liveUpdates: boolean;
  running: boolean;
}

async function containerNetworkFacts(
  containerId: string,
  context: Pick<CommandContext, "storage">,
): Promise<ContainerNetworkFacts | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "-f",
        `{{ index .Config.Labels "${DOCKER_LABEL_NETWORK_POLICY}" }}\t{{ .Image }}\t{{ .State.Running }}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    const [policy = "", imageId = "", running = ""] = stdout.trim().split("\t");
    const capabilities = await imageCapabilities(imageId || undefined, context).catch(() => null);
    return {
      policyVersion: policy === "2" ? 2 : 1,
      liveUpdates: (capabilities?.["network-refresh"] ?? 0) >= 1,
      running: running === "true",
    };
  } catch {
    return null;
  }
}

function domainsState(
  configured: EnvironmentNetworkPolicy["configured"],
  effective: EnvironmentNetworkPolicy["effective"],
  liveUpdates: boolean,
): EnvironmentNetworkPolicy["domains"] {
  if (!effective || effective.state !== "applied") return null;
  if (effective.mode !== configured.mode) return "rebuild-required";
  if (configured.mode === "full") return "applied";
  if (effective.domainsRevision === configured.domainsRevision) return "applied";
  return liveUpdates ? "pending" : "rebuild-required";
}

export async function environmentNetworkPolicy(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<EnvironmentNetworkPolicy> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const config = await context.storage.loadConfig();
  const domains = environment.allowedDomains ?? config.global.allowedDomains ?? [];
  const result: EnvironmentNetworkPolicy = {
    environmentId,
    configured: {
      mode: environment.networkAccessMode === "full" ? "full" : "restricted",
      domains: domains.length,
      domainsRevision: allowedDomainsRevision(configuredAllowedDomains(environment, config)),
    },
    policyVersion: null,
    domains: null,
    effective: null,
  };
  if (!environment.containerId || environment.environmentType !== "containerized") return result;
  const facts = await containerNetworkFacts(environment.containerId, context);
  if (!facts) return result;
  result.policyVersion = facts.policyVersion;
  try {
    const { stdout } = await runCommand(
      "docker",
      ["exec", environment.containerId, "sh", "-c", FIREWALL_STATUS_READ],
      { timeoutMs: 10_000 },
    );
    result.effective = parseFirewallStatus(stdout);
  } catch {
    result.effective = null;
  }
  result.domains = domainsState(result.configured, result.effective, facts.liveUpdates);
  return result;
}

export type AllowedDomainsApplyResult =
  | { kind: "applied"; policy: EnvironmentNetworkPolicy }
  | {
      kind: "not-applicable" | "rebuild-required" | "not-running" | "failed";
      policy: EnvironmentNetworkPolicy;
    };

/**
 * Applies the saved allowlist to the environment's running container in
 * place, when its image supports it and the modes agree. The container
 * rebuilds its set beside the live one, swaps it in, revokes removed
 * addresses and stores the list so a restart keeps it. Anything else leaves
 * the container as it is and says why; nothing here recreates a container.
 */
export function applyEnvironmentAllowedDomains(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<AllowedDomainsApplyResult> {
  // One apply per environment at a time, each reading the list saved when it
  // starts: two quick edits cannot land in the container in the wrong order.
  const previous = applyQueue.get(environmentId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => applyAllowedDomainsNow(environmentId, context));
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  applyQueue.set(environmentId, settled);
  void settled.then(() => {
    if (applyQueue.get(environmentId) === settled) applyQueue.delete(environmentId);
  });
  return next;
}

const applyQueue = new Map<string, Promise<void>>();

async function applyAllowedDomainsNow(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<AllowedDomainsApplyResult> {
  const before = await environmentNetworkPolicy(environmentId, context);
  if (before.domains === "applied") return { kind: "applied", policy: before };
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment?.containerId || environment.environmentType !== "containerized") {
    return { kind: "not-applicable", policy: before };
  }
  if (before.domains === "rebuild-required") return { kind: "rebuild-required", policy: before };
  const facts = await containerNetworkFacts(environment.containerId, context);
  if (!facts?.running) return { kind: "not-running", policy: before };
  if (!facts.liveUpdates) return { kind: "rebuild-required", policy: before };
  if (before.configured.mode !== "restricted") return { kind: "rebuild-required", policy: before };
  const config = await context.storage.loadConfig();
  const domains = configuredAllowedDomains(environment, config);
  try {
    await runCommand(
      "docker",
      [
        "exec",
        "--user",
        "root",
        environment.containerId,
        "/usr/local/bin/update-firewall.sh",
        "--set-domains",
        domains.join(","),
      ],
      { timeoutMs: 180_000 },
    );
  } catch {
    // The script leaves the previous allowlist active on failure; the report
    // below states which revision is enforced.
    return {
      kind: "failed",
      policy: await environmentNetworkPolicy(environmentId, context),
    };
  }
  const after = await environmentNetworkPolicy(environmentId, context);
  return { kind: after.domains === "applied" ? "applied" : "failed", policy: after };
}
