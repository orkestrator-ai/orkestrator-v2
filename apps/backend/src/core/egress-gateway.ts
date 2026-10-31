import { DOCKER_LABEL_APP, DOCKER_LABEL_OWNER, DOCKER_LABEL_RESOURCE_ROLE } from "./constants.js";
import {
  formatContainerLifecycleError,
  type ContainerLifecycleErrorCode,
} from "@orkestrator/protocol/container-lifecycle";
import type { NetworkPolicyVersion } from "./container-network.js";
import { runCommand } from "./shell.js";
import { egressGatewayOf, forgetNetworkOwner } from "./container-network-owner.js";
import { startDockerContainer } from "./container-start.js";
import { PROBE_WINDOW_MS, boundedWaitScript, probeIterations } from "./container-readiness.js";
import { copyGithubRangesSeed } from "./github-ranges-cache.js";

export { egressGatewayOf, networkOwnerContainer } from "./container-network-owner.js";

/**
 * External egress enforcement (`egress-gateway=1`).
 *
 * A restricted runtime's firewall runs in a companion container, its egress
 * gateway, which owns the network namespace with `NET_ADMIN`. The workload
 * joins it (`--network container:<gateway>`) with no added capability, so no
 * process in the workload, root terminals included, can change the rules.
 * The gateway is created with the workload and lives exactly as long as it:
 *
 * - creation: the gateway first, holding the environment network, the
 *   published ports, the host alias and the firewall policy; the workload
 *   references it by id, so a workload can only ever start in that namespace;
 * - start: the gateway first, and the workload only once the gateway's
 *   firewall reports `applied` for its current boot (its `/run` is a tmpfs,
 *   so an earlier boot's report cannot be read). A workload that is still
 *   running in the namespace of a gateway that restarted since has only
 *   loopback; it is stopped and started again;
 * - stop: the workload, then the gateway, which frees its published ports;
 * - removal: with its workload, and every gateway of an environment with the
 *   environment. A gateway whose workload no longer exists is an orphan,
 *   removed by {@link sweepOrphanEgressGateways}.
 *
 * Gateways carry neither the app label nor the environment-id label, so no
 * listing of environment containers (cleanup review, usage, recovery copies,
 * operation reconciliation) ever mistakes one for a runtime. They are found
 * through their own owner, role and workload labels.
 *
 * Docker never starts either container by itself: runtimes have no restart
 * policy, so after a daemon restart both stay stopped until the backend's
 * start path brings up the gateway first.
 */

export const EGRESS_GATEWAY_ROLE = "egress-gateway";

// The typed transport form, without importing the lifecycle service (which
// removes runtimes through this module).
function lifecycleError(code: ContainerLifecycleErrorCode, message: string): Error {
  return new Error(formatContainerLifecycleError(code, message));
}
/** On a workload: the name of the gateway whose namespace it joins. */
export const DOCKER_LABEL_EGRESS_GATEWAY = "orkestrator-egress-gateway";
/** On a gateway: the name of the workload it serves. */
export const DOCKER_LABEL_EGRESS_WORKLOAD = "orkestrator-egress-workload";
/** On a gateway: its environment (not `environment-id`, which marks runtimes). */
export const DOCKER_LABEL_EGRESS_ENVIRONMENT = "orkestrator-egress-environment";
export const EGRESS_GATEWAY_ENTRYPOINT = "/usr/local/bin/orkestrator-egress-gateway";
/** Rollout cap: `in-container` keeps the firewall inside the workload. */
export const EGRESS_OVERRIDE_ENV = "ORKESTRATOR_EGRESS";

/** The gateway's own budget; it runs bash, sleep, the refresher and lookups. */
export const EGRESS_GATEWAY_MEMORY_MIB = 128;
export const EGRESS_GATEWAY_PIDS = 128;
/** Firewall initialization waits up to 120 s for its lock, plus resolution. */
export const EGRESS_GATEWAY_READY_TIMEOUT_MS = 180_000;

export type EgressEnforcement = "gateway" | "container" | "none";

/**
 * Where a new runtime's firewall runs. Full mode has none. A gateway needs
 * the environment's own network (policy 2 or later) and an image that ships
 * the gateway entrypoint; `ORKESTRATOR_EGRESS=in-container` keeps the
 * firewall in the workload, with `NET_ADMIN`, as before.
 */
export function egressEnforcement(options: {
  networkMode: "full" | "restricted";
  networkPolicy: NetworkPolicyVersion;
  imageGatewayVersion: number;
  override: string | undefined;
}): EgressEnforcement {
  if (options.networkMode === "full") return "none";
  if (options.networkPolicy < 2 || options.imageGatewayVersion < 1) return "container";
  if (options.override?.trim() === "in-container") return "container";
  return "gateway";
}

/** Deterministic, so an interrupted create finds its gateway again. */
export function egressGatewayName(workloadName: string): string {
  return `${workloadName.slice(0, 120)}-egress`;
}

export interface EgressGatewaySpec {
  name: string;
  workloadName: string;
  environmentId: string;
  owner: string;
  image: string;
  network: string;
  /** `-p` arguments: the gateway owns the namespace, so it publishes. */
  publishArguments: readonly string[];
  /** Linux Engine's `host.docker.internal` alias; the workload shares /etc/hosts. */
  addHostGateway: boolean;
  /** What the alias names: Docker's `host-gateway` unless rootless needs RootlessKit's host. */
  hostAliasTarget?: string;
  githubSeed: string | null;
  /** `-e NAME=value` policy values the gateway records and enforces. */
  policyEnvironment: Readonly<Record<string, string>>;
  /** Apply the gateway's own memory and PID budget (when the daemon can). */
  limits: { memory: boolean; pids: boolean };
  logArguments: readonly string[];
}

export function egressGatewayCreateArguments(spec: EgressGatewaySpec): string[] {
  return [
    "create",
    "--name",
    spec.name,
    "--label",
    `${DOCKER_LABEL_OWNER}=${spec.owner}`,
    "--label",
    `${DOCKER_LABEL_RESOURCE_ROLE}=${EGRESS_GATEWAY_ROLE}`,
    "--label",
    `${DOCKER_LABEL_EGRESS_WORKLOAD}=${spec.workloadName}`,
    "--label",
    `${DOCKER_LABEL_EGRESS_ENVIRONMENT}=${spec.environmentId}`,
    "--user",
    "root",
    "--entrypoint",
    EGRESS_GATEWAY_ENTRYPOINT,
    "--cap-add",
    "NET_ADMIN",
    // A fresh /run on every start: the firewall report there always describes
    // the current boot, so the start gate can never read a stale `applied`.
    "--tmpfs",
    "/run:rw,nosuid,nodev,mode=0755",
    "--init",
    "--stop-timeout",
    "5",
    ...(spec.limits.memory
      ? [
          "--memory",
          `${EGRESS_GATEWAY_MEMORY_MIB}m`,
          "--memory-swap",
          `${EGRESS_GATEWAY_MEMORY_MIB}m`,
        ]
      : []),
    ...(spec.limits.pids ? ["--pids-limit", String(EGRESS_GATEWAY_PIDS)] : []),
    ...spec.logArguments,
    ...(spec.addHostGateway
      ? ["--add-host", `host.docker.internal:${spec.hostAliasTarget ?? "host-gateway"}`]
      : []),
    "--network",
    spec.network,
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    ...spec.publishArguments,
    ...Object.entries(spec.policyEnvironment).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    spec.image,
  ];
}

interface GatewayInspection {
  id: string;
  running: boolean;
  startedAt: string;
  owner: string;
  role: string;
  workload: string;
  environment: string;
}

const GATEWAY_INSPECT_FORMAT = `{{.Id}}\t{{.State.Running}}\t{{.State.StartedAt}}\t{{ index .Config.Labels "${DOCKER_LABEL_OWNER}" }}\t{{ index .Config.Labels "${DOCKER_LABEL_RESOURCE_ROLE}" }}\t{{ index .Config.Labels "${DOCKER_LABEL_EGRESS_WORKLOAD}" }}\t{{ index .Config.Labels "${DOCKER_LABEL_EGRESS_ENVIRONMENT}" }}`;

function label(value: string | undefined): string {
  return !value || value === "<no value>" ? "" : value;
}

export function parseGatewayInspection(stdout: string): GatewayInspection | null {
  const [id = "", running = "", startedAt = "", owner, role, workload, environment] = stdout
    .trim()
    .split("\n")[0]!
    .split("\t");
  if (!/^[0-9a-f]{12,64}$/.test(id)) return null;
  return {
    id,
    running: running === "true",
    startedAt,
    owner: label(owner),
    role: label(role),
    workload: label(workload),
    environment: label(environment),
  };
}

async function inspectGateway(nameOrId: string): Promise<GatewayInspection | "missing"> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "--type", "container", "--format", GATEWAY_INSPECT_FORMAT, nameOrId],
      { timeoutMs: 15_000 },
    );
    const parsed = parseGatewayInspection(stdout);
    if (!parsed) throw new Error("Unrecognized docker inspect output");
    return parsed;
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (object|container)|not found/i.test(message);
}

function isGatewayOf(inspection: GatewayInspection, owner: string): boolean {
  return inspection.owner === owner && inspection.role === EGRESS_GATEWAY_ROLE;
}

async function containerExists(nameOrId: string): Promise<boolean | null> {
  try {
    await runCommand(
      "docker",
      ["inspect", "--type", "container", "--format", "{{.Id}}", nameOrId],
      {
        timeoutMs: 15_000,
      },
    );
    return true;
  } catch (error) {
    return isMissing(error) ? false : null;
  }
}

/**
 * Creates the gateway for a workload about to be created. A same-named
 * gateway left by an interrupted attempt is replaced only when it is this
 * registry's, for the same workload, and that workload does not exist; any
 * other same-named container is left alone and reported.
 */
export async function createEgressGateway(spec: EgressGatewaySpec): Promise<string> {
  // The GitHub seed is copied in before the first start, never bound
  // (`copyGithubRangesSeed`).
  const create = async () => {
    const id = (
      await runCommand("docker", egressGatewayCreateArguments(spec), { timeoutMs: 120_000 })
    ).stdout.trim();
    if (spec.githubSeed) await copyGithubRangesSeed(id, spec.githubSeed);
    return id;
  };
  try {
    return await create();
  } catch (error) {
    const existing = await inspectGateway(spec.name).catch(() => null);
    if (!existing || existing === "missing") throw error;
    if (!isGatewayOf(existing, spec.owner) || existing.workload !== spec.workloadName) {
      throw lifecycleError(
        "needs-attention",
        "A Docker container with this environment's egress gateway name exists but is not labelled as its own. It was left untouched.",
      );
    }
    if ((await containerExists(spec.workloadName)) !== false) {
      // An earlier attempt created both, or Docker cannot say: never replace
      // the namespace a workload may already be bound to.
      throw lifecycleError(
        "needs-attention",
        "An egress gateway for this runtime already exists with its container. Nothing was replaced.",
      );
    }
    await runCommand("docker", ["rm", "-f", existing.id], { timeoutMs: 60_000 });
    return create();
  }
}

// ---------------------------------------------------------------------------
// Start, stop and removal
// ---------------------------------------------------------------------------

const FIREWALL_REPORT = "/run/orkestrator-firewall/firewall.json";

/**
 * The current boot's firewall report. `pending` when the exec ran, which
 * proves the gateway is running, but found no final state; `null` when Docker
 * could not exec into it (stopped, missing or unreachable). With `waitMs` the
 * exec first waits inside the gateway, up to that long, for the report to
 * reach `applied` or `failed` (its /run is fresh per boot, so any report is
 * this boot's).
 */
async function gatewayFirewallState(
  gatewayId: string,
  waitMs = 0,
): Promise<"applied" | "failed" | "pending" | null> {
  const window = Math.max(0, Math.min(waitMs, PROBE_WINDOW_MS));
  const settled = `case "$(head -c 4096 ${FIREWALL_REPORT} 2>/dev/null)" in *'"state":"applied"'*|*'"state":"failed"'*) true ;; *) false ;; esac`;
  const wait = window > 0 ? boundedWaitScript(probeIterations(window), settled) : "";
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      ["exec", gatewayId, "sh", "-c", `${wait}head -c 4096 ${FIREWALL_REPORT} 2>/dev/null || true`],
      { timeoutMs: 10_000 + window },
    ));
  } catch {
    return null;
  }
  try {
    const state = (JSON.parse(stdout.trim() || "{}") as { state?: unknown }).state;
    return state === "applied" || state === "failed" ? state : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Waits for the gateway's current boot to apply its firewall. A failed or
 * missing report, or a gateway that stopped, refuses the workload's start.
 * Each read waits inside the gateway for up to a window (`windowMs`), so the
 * report is seen as soon as it is written and an unfinished firewall costs
 * one Docker call per window. The gateway is inspected only when the exec
 * itself failed. `pollMs` is the floor between reads that came back early
 * without a final state.
 */
export async function waitForEgressGatewayFirewall(
  gatewayId: string,
  options: { timeoutMs?: number; pollMs?: number; windowMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? EGRESS_GATEWAY_READY_TIMEOUT_MS);
  const pollMs = options.pollMs ?? 250;
  const windowMs = options.windowMs ?? PROBE_WINDOW_MS;
  while (true) {
    const readAt = Date.now();
    const state = await gatewayFirewallState(
      gatewayId,
      Math.min(windowMs, Math.max(0, deadline - readAt)),
    );
    if (state === "applied") return;
    if (state === "failed") {
      throw lifecycleError(
        "not-ready",
        "The environment's egress gateway could not apply its network policy, so the container was not started. Check the gateway's logs, then retry.",
      );
    }
    // An inspection failure is a daemon/protocol error, not evidence of a
    // pending policy. Surface it so the caller can retry without a policy timeout.
    const inspection = state === null ? await inspectGateway(gatewayId) : null;
    if (inspection === "missing" || (inspection && !inspection.running)) {
      throw lifecycleError(
        "not-ready",
        "The environment's egress gateway stopped before applying its network policy, so the container was not started. Retry the start.",
      );
    }
    if (Date.now() >= deadline) {
      throw lifecycleError(
        "not-ready",
        "The environment's egress gateway did not apply its network policy in time, so the container was not started. Retry the start.",
      );
    }
    const pause = pollMs - (Date.now() - readAt);
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

function startError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (/port is already allocated|address already in use|bind for .* failed/i.test(message)) {
    return lifecycleError(
      "port-conflict",
      "A host port this environment publishes is in use by another program. Free the port or change the environment's port mappings, then start it again.",
    );
  }
  return error;
}

/**
 * Brings up a workload's egress gateway before the workload starts: starts
 * it when stopped and waits until its firewall is applied. Returns
 * `restarted-gateway` when a running workload's namespace belonged to an
 * earlier boot of the gateway; that workload has been stopped and the caller
 * starts it like a stopped one. `none` for a workload without a gateway.
 */
export async function prepareEgressGatewayForStart(
  workloadId: string,
  options: { timeoutMs?: number; pollMs?: number; windowMs?: number } = {},
): Promise<"none" | "ready" | "restarted-gateway"> {
  const gatewayId = await egressGatewayOf(workloadId);
  if (!gatewayId) return "none";
  const gateway = await inspectGateway(gatewayId);
  if (gateway === "missing") {
    throw lifecycleError(
      "needs-attention",
      "This environment's egress gateway is missing, so its container cannot start with its network policy. Rebuild the environment to create a new one.",
    );
  }
  const firewall = gateway.running ? await gatewayFirewallState(gatewayId) : null;
  const retryFailed = firewall === "failed";
  if (!gateway.running || retryFailed) {
    await startDockerContainer(gatewayId, { verb: retryFailed ? "restart" : "start" }).catch(
      (error: unknown) => {
        throw startError(error);
      },
    );
  }
  // A running gateway that already reported `applied` for its current boot
  // (its /run is fresh per boot) needs no second read.
  if (firewall !== "applied") {
    await waitForEgressGatewayFirewall(gatewayId, options);
  }
  const { stdout } = await runCommand(
    "docker",
    [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.State.Running}}\t{{.State.StartedAt}}",
      workloadId,
    ],
    { timeoutMs: 10_000 },
  );
  const [running = "", workloadStartedAt = ""] = stdout.trim().split("\t");
  if (running !== "true") return "ready";
  const current = await inspectGateway(gatewayId);
  if (current === "missing") return "ready";
  if (Date.parse(current.startedAt) > Date.parse(workloadStartedAt)) {
    // The workload kept the namespace of the gateway's earlier boot, which
    // lost its interface when the gateway stopped: it has only loopback and
    // must rejoin. Nothing in it can reach the network meanwhile.
    await runCommand("docker", ["stop", workloadId], { timeoutMs: 60_000 });
    return "restarted-gateway";
  }
  return "ready";
}

/** Stops a workload's gateway after the workload stopped; best effort. */
export async function stopEgressGatewayOf(workloadId: string): Promise<void> {
  const gatewayId = await egressGatewayOf(workloadId);
  if (!gatewayId) return;
  await runCommand("docker", ["stop", gatewayId], { timeoutMs: 60_000 }).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

/** `docker stop` a runtime, then its gateway, which frees its published ports. */
export async function stopRuntimeContainer(containerId: string): Promise<void> {
  await runCommand("docker", ["stop", containerId], { timeoutMs: 60_000 });
  await stopEgressGatewayOf(containerId);
}

/**
 * Removes a runtime container and then its gateway. The gateway is found
 * before the runtime goes (its network mode names it) and removed only when
 * it carries this registry's owner and gateway role. Errors from removing
 * the runtime propagate unchanged except confirmed absence. A failed gateway
 * removal retains the cached ownership link so an admitted retry can finish.
 */
export async function removeRuntimeContainer(
  containerId: string,
  owner: string,
  run: CommandRunner = runCommand,
  options: { force?: boolean } = {},
): Promise<void> {
  const gatewayId = await egressGatewayOf(containerId);
  const gateway = gatewayId ? await inspectGateway(gatewayId) : null;
  // Without `force`, Docker refuses a runtime that is running, which callers
  // rely on to lose a race against a start.
  await run("docker", ["rm", ...(options.force === false ? [] : ["-f"]), containerId], {
    timeoutMs: 60_000,
  }).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  if (gatewayId && gateway && gateway !== "missing" && isGatewayOf(gateway, owner)) {
    await run("docker", ["rm", "-f", gatewayId], { timeoutMs: 60_000 }).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
  forgetNetworkOwner(containerId);
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

interface ListedGateway {
  id: string;
  workload: string;
  environment: string;
  createdAt: string;
}

async function listEgressGateways(
  owner: string,
  filters: string[],
  run: CommandRunner,
): Promise<ListedGateway[]> {
  const { stdout } = await run(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${DOCKER_LABEL_OWNER}=${owner}`,
      "--filter",
      `label=${DOCKER_LABEL_RESOURCE_ROLE}=${EGRESS_GATEWAY_ROLE}`,
      ...filters.flatMap((filter) => ["--filter", filter]),
      "--format",
      `{{.ID}}\t{{.Label "${DOCKER_LABEL_EGRESS_WORKLOAD}"}}\t{{.Label "${DOCKER_LABEL_EGRESS_ENVIRONMENT}"}}\t{{.CreatedAt}}\t{{.Label "${DOCKER_LABEL_APP}"}}`,
    ],
    { timeoutMs: 30_000 },
  );
  const gateways: ListedGateway[] = [];
  for (const line of stdout.split("\n")) {
    const [id = "", workload = "", environment = "", createdAt = "", app = ""] = line
      .trim()
      .split("\t");
    // A runtime never carries the gateway role; refuse one that claims both.
    if (!/^[0-9a-f]{12,64}$/.test(id) || app) continue;
    gateways.push({ id, workload, environment, createdAt });
  }
  return gateways;
}

/**
 * Removes every gateway of an environment that is being deleted. Its
 * runtimes are already gone by then (the ledger's container step).
 */
export async function removeEnvironmentEgressGateways(
  environmentId: string,
  owner: string,
  run: CommandRunner = runCommand,
): Promise<number> {
  const gateways = await listEgressGateways(
    owner,
    [`label=${DOCKER_LABEL_EGRESS_ENVIRONMENT}=${environmentId}`],
    run,
  );
  for (const gateway of gateways) {
    try {
      await run("docker", ["rm", "-f", gateway.id], { timeoutMs: 60_000 });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return gateways.length;
}

/** `docker ps` CreatedAt (`2026-10-25 10:11:12 +0000 UTC`) → epoch ms, or NaN. */
export function parseDockerCreatedAt(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})\b/.exec(value.trim());
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
}

/** A gateway younger than this may belong to a workload still being created. */
export const ORPHAN_GATEWAY_GRACE_MS = 10 * 60_000;

/**
 * Removes this registry's gateways whose workload no longer exists, for
 * example after a runtime was removed by a path that predates gateways or by
 * hand. A young gateway is kept: its workload may be mid-creation.
 */
export async function sweepOrphanEgressGateways(
  owner: string,
  options: { now?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  let removed = 0;
  for (const gateway of await listEgressGateways(owner, [], runCommand)) {
    const created = parseDockerCreatedAt(gateway.createdAt);
    if (!Number.isFinite(created) || now - created < ORPHAN_GATEWAY_GRACE_MS) continue;
    if (!gateway.workload || (await containerExists(gateway.workload)) !== false) continue;
    await runCommand("docker", ["rm", "-f", gateway.id], { timeoutMs: 60_000 }).then(
      () => {
        removed += 1;
      },
      () => undefined,
    );
  }
  return removed;
}
