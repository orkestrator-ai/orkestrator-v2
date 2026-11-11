import { ContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { runCommand } from "./shell.js";
import { createLogger } from "@orkestrator/protocol/logger";
import { DOCKER_LABEL_BACKEND_HOST_PORTS } from "./constants.js";
import { parseBackendHostPortsLabel } from "./container-host-ports.js";

const log = createLogger("docker");

/**
 * `docker start` for runtimes, rebuild candidates and egress gateways, with
 * two failures of a rootless daemon handled:
 *
 * - An automatic (`127.0.0.1::<port>`) mapping collides with a host process.
 *   Rootless dockerd picks the host port inside RootlessKit's namespace,
 *   which cannot see host listeners, and RootlessKit's own bind on the host
 *   then fails with `address already in use`. Docker draws a fresh port on
 *   the next start, so the start is retried, up to
 *   {@link PORT_COLLISION_RETRIES} times. Containers created on a rootless
 *   daemon now get host ports the backend chose instead
 *   (`container-host-ports.ts`); a collision on one of those keeps its port,
 *   so it is retried after a pause ({@link PORT_HOLD_RETRY_DELAYS_MS}) for the
 *   short-lived holder to go. A collision on a port the
 *   user fixed is theirs to resolve and is never retried. The failed start
 *   also detaches the container from its network (Docker 29.9, observed
 *   live), and a bare second start would run it with no network and no
 *   published ports, so the network is connected again before every retry
 *   and the started container is stopped if it still has none.
 * - A read-only bind Docker cannot mount (`remount-ro … operation not
 *   permitted`): a user namespace cannot clear the locked `nosuid`/`nodev`
 *   flags of the source filesystem. It becomes a typed error naming the mount.
 *
 * Every other failure is returned unchanged.
 */

/** Docker's errors for a host port another socket holds (rootful and RootlessKit). */
const ADDRESS_IN_USE = /address already in use|port is already allocated/i;
const COLLIDING_PORT = [
  /:(\d{1,5})(?:\/[a-z]+)?: bind: address already in use/i,
  /Bind for [^\s]*?:(\d{1,5}) failed: port is already allocated/i,
  /failed to bind host port [^\s]*?:(\d{1,5})/i,
];
const REMOUNT_REFUSED = /remount|locked flags|mount.*operation not permitted/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host port named by a port-collision error, or null. */
export function collidingHostPort(message: string): number | null {
  for (const pattern of COLLIDING_PORT) {
    const match = pattern.exec(message);
    const port = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  }
  return null;
}

export interface PortBindingSummary {
  /** Host ports (or ranges) the container fixes, backend-chosen ones included. */
  fixed: Array<{ from: number; to: number }>;
  /** Whether any mapping leaves the host port to Docker. */
  automatic: boolean;
  /** Fixed host ports the backend chose rather than the user (the label). */
  backendChosen: number[];
}

/**
 * Parses `{{json .HostConfig.PortBindings}}` and the backend-chosen port
 * label; null when the bindings are unreadable. A labelled port the bindings
 * do not fix is ignored.
 */
export function parsePortBindings(json: string, backendLabel?: string): PortBindingSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(json.trim() || "null");
  } catch {
    return null;
  }
  const summary: PortBindingSummary = { fixed: [], automatic: false, backendChosen: [] };
  if (value === null) return summary;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  for (const bindings of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      const hostPort = String((binding as { HostPort?: unknown })?.HostPort ?? "").trim();
      if (!hostPort || hostPort === "0") {
        summary.automatic = true;
        continue;
      }
      const range = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(hostPort);
      if (!range) return null;
      const from = Number.parseInt(range[1]!, 10);
      summary.fixed.push({ from, to: range[2] ? Number.parseInt(range[2], 10) : from });
    }
  }
  summary.backendChosen = parseBackendHostPortsLabel(backendLabel).filter((port) =>
    summary.fixed.some((range) => range.from === port && range.to === port),
  );
  return summary;
}

/**
 * How a start that failed on a port collision may be retried:
 *
 * - `same-port` when the colliding port is one the backend chose, which the
 *   next start binds again (when the error names no port: the container fixes
 *   only backend-chosen ports and leaves none to Docker);
 * - `fresh-port` when the container leaves a host port to Docker and the
 *   colliding port is not one it fixes (when the error names no port: it
 *   fixes only backend-chosen ports, or none);
 * - `none` otherwise, above all for a port the user fixed.
 */
export function portCollisionRetry(
  message: string,
  bindings: PortBindingSummary | null,
): "same-port" | "fresh-port" | "none" {
  if (!ADDRESS_IN_USE.test(message) || !bindings) return "none";
  const userFixed = bindings.fixed.filter(
    (range) => !(range.from === range.to && bindings.backendChosen.includes(range.from)),
  );
  const port = collidingHostPort(message);
  if (port === null) {
    if (userFixed.length > 0) return "none";
    if (bindings.automatic) return "fresh-port";
    return bindings.backendChosen.length > 0 ? "same-port" : "none";
  }
  if (bindings.backendChosen.includes(port)) return "same-port";
  if (!bindings.automatic) return "none";
  return userFixed.some((range) => port >= range.from && port <= range.to) ? "none" : "fresh-port";
}

/** Whether a start that failed on a port collision may be retried at all. */
export function shouldRetryPortCollision(
  message: string,
  bindings: PortBindingSummary | null,
): boolean {
  return portCollisionRetry(message, bindings) !== "none";
}

/** The typed error for a read-only bind the daemon refused to mount, or null. */
export function bindMountRefusedError(message: string): Error | null {
  if (!REMOUNT_REFUSED.test(message) || !/operation not permitted/i.test(message)) return null;
  const source = /error mounting "([^"]+)"/i.exec(message)?.[1];
  const target = /to rootfs at "([^"]+)"/i.exec(message)?.[1];
  const mount =
    source && target ? `${source} at ${target}` : target ? `at ${target}` : "a read-only bind";
  return new ContainerLifecycleError(
    "unsupported-topology",
    `Docker refused to mount ${mount} read-only (operation not permitted), so nothing was started. Under rootless Docker this happens when the filesystem holding it is mounted nosuid or nodev, flags a user namespace cannot clear: keep Orkestrator's data directory on a filesystem mounted without them, or run Docker rootful.`,
  );
}

export interface StartInspection {
  bindings: PortBindingSummary | null;
  /** The network the container was created on, or null (`host`, `none`, a joined namespace). */
  network: string | null;
  /** Names and IDs of networks the container is attached to now. */
  attached: string[];
}

/**
 * Parses `PortBindings`, `NetworkMode`, the attached networks and the
 * backend-chosen port label, tab-separated.
 */
export function parseStartInspection(stdout: string): StartInspection {
  const [bindings = "", mode = "", networks = "", backendLabel = ""] = stdout.trim().split("\t");
  let attached: string[] = [];
  try {
    const value = JSON.parse(networks || "null") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      attached = Object.entries(value).flatMap(([name, endpoint]) => {
        // NetworkMode may name the network by ID, while Networks is keyed by
        // name. Recognize both so recovery neither reconnects an attached
        // endpoint nor stops a successfully reconnected runtime.
        const id = (endpoint as { NetworkID?: unknown } | null)?.NetworkID;
        return typeof id === "string" && id ? [name, id] : [name];
      });
    }
  } catch {
    attached = [];
  }
  const named =
    !mode || mode === "host" || mode === "none" || mode.startsWith("container:")
      ? null
      : mode === "default"
        ? "bridge"
        : mode;
  return { bindings: parsePortBindings(bindings, backendLabel), network: named, attached };
}

async function inspectForStart(
  containerId: string,
  run: typeof runCommand,
): Promise<StartInspection | null> {
  try {
    const { stdout } = await run(
      "docker",
      [
        "inspect",
        "--type",
        "container",
        "--format",
        `{{json .HostConfig.PortBindings}}\t{{.HostConfig.NetworkMode}}\t{{json .NetworkSettings.Networks}}\t{{ index .Config.Labels "${DOCKER_LABEL_BACKEND_HOST_PORTS}" }}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    return parseStartInspection(stdout);
  } catch {
    return null;
  }
}

/** Reconnect stopped containers after Docker drops their endpoint on a failed bind. */
async function restoreNetwork(
  containerId: string,
  inspection: StartInspection,
  run: typeof runCommand,
): Promise<void> {
  if (inspection.network && !inspection.attached.includes(inspection.network)) {
    await run("docker", ["network", "connect", inspection.network, containerId], {
      timeoutMs: 30_000,
    });
  }
}

/**
 * How many times a start that collided on an automatic port is retried.
 * Rootless dockerd hands out automatic ports in sequence, so a retry draws
 * the next port in the same busy neighbourhood; short-lived outbound sockets
 * held two consecutive ports in a 2026-11-09 run (to-do 7549 task 3).
 */
export const PORT_COLLISION_RETRIES = 3;

/**
 * Pauses before retrying a collision on a backend-chosen port, one per retry.
 * That port is bound again on the next start, so the retry waits for its
 * holder (short-lived loopback connections, observed 2026-11-11) to go.
 */
export const PORT_HOLD_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

export async function startDockerContainer(
  containerId: string,
  options: {
    /** `restart` for a running gateway whose firewall failed. */
    verb?: "start" | "restart";
    timeoutMs?: number;
    run?: typeof runCommand;
    log?: (message: string) => void;
    /** Waits before a same-port retry; tests pass a recorder. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const run = options.run ?? runCommand;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const attempt = (verb: "start" | "restart") =>
    run("docker", [verb, containerId], { timeoutMs }).then(() => undefined);
  let collision: unknown = null;
  let network: string | null = null;
  for (let retry = 0; ; retry += 1) {
    try {
      await attempt(retry === 0 ? (options.verb ?? "start") : "start");
      break;
    } catch (error) {
      const message = messageOf(error);
      const refused = bindMountRefusedError(message);
      if (refused) throw refused;
      if (!ADDRESS_IN_USE.test(message)) throw error;
      const inspection = await inspectForStart(containerId, run);
      if (!inspection) throw error;
      // Restore the endpoint even when a fixed-port failure cannot be retried.
      // Otherwise a later start can succeed without networking or published ports.
      await restoreNetwork(containerId, inspection, run).catch(() => {
        throw error;
      });
      if (retry >= PORT_COLLISION_RETRIES) throw error;
      const retryKind = portCollisionRetry(message, inspection.bindings);
      if (retryKind === "none") throw error;
      collision = error;
      network = inspection.network;
      log.warn("start.port-collision-retrying", {
        container: containerId.slice(0, 12),
        port: collidingHostPort(message) ?? null,
        retry: retry + 1,
        backendChosen: retryKind === "same-port",
      });
      if (retryKind === "same-port") {
        await sleep(PORT_HOLD_RETRY_DELAYS_MS[retry] ?? PORT_HOLD_RETRY_DELAYS_MS.at(-1)!);
      }
    }
  }
  if (collision === null) return;
  // Never leave a container running without the network it was created on.
  const after = await inspectForStart(containerId, run);
  if (network && !after?.attached.includes(network)) {
    await run("docker", ["stop", containerId], { timeoutMs: 60_000 }).catch(() => undefined);
    throw collision;
  }
}
