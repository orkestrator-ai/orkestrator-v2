import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { runCommand } from "./shell.js";

/**
 * `docker start` for runtimes, rebuild candidates and egress gateways, with
 * two failures of a rootless daemon handled:
 *
 * - An automatic (`127.0.0.1::<port>`) mapping collides with a host process.
 *   Rootless dockerd picks the host port inside RootlessKit's namespace,
 *   which cannot see host listeners, and RootlessKit's own bind on the host
 *   then fails with `address already in use`. Docker draws a fresh port on
 *   the next start, so the start is retried once. A collision on a port the
 *   user fixed is theirs to resolve and is never retried. The failed start
 *   also detaches the container from its network (Docker 29.9, observed
 *   live), and a bare second start would run it with no network and no
 *   published ports, so the network is connected again first and the retry
 *   is refused, stopped, if the container still has none.
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
  /** Host ports (or ranges) the container fixes. */
  fixed: Array<{ from: number; to: number }>;
  /** Whether any mapping leaves the host port to Docker. */
  automatic: boolean;
}

/** Parses `{{json .HostConfig.PortBindings}}`; null when unreadable. */
export function parsePortBindings(json: string): PortBindingSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(json.trim() || "null");
  } catch {
    return null;
  }
  const summary: PortBindingSummary = { fixed: [], automatic: false };
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
  return summary;
}

/**
 * Whether a start that failed on a port collision may be retried: the
 * container leaves at least one host port to Docker, and the colliding port
 * is not one it fixes (when the error does not name the port, only when it
 * fixes none).
 */
export function shouldRetryPortCollision(
  message: string,
  bindings: PortBindingSummary | null,
): boolean {
  if (!ADDRESS_IN_USE.test(message) || !bindings?.automatic) return false;
  const port = collidingHostPort(message);
  if (port === null) return bindings.fixed.length === 0;
  return !bindings.fixed.some((range) => port >= range.from && port <= range.to);
}

/** The typed error for a read-only bind the daemon refused to mount, or null. */
export function bindMountRefusedError(message: string): Error | null {
  if (!REMOUNT_REFUSED.test(message) || !/operation not permitted/i.test(message)) return null;
  const source = /error mounting "([^"]+)"/i.exec(message)?.[1];
  const target = /to rootfs at "([^"]+)"/i.exec(message)?.[1];
  const mount =
    source && target ? `${source} at ${target}` : target ? `at ${target}` : "a read-only bind";
  return new Error(
    formatContainerLifecycleError(
      "unsupported-topology",
      `Docker refused to mount ${mount} read-only (operation not permitted), so nothing was started. Under rootless Docker this happens when the filesystem holding it is mounted nosuid or nodev, flags a user namespace cannot clear: keep Orkestrator's data directory on a filesystem mounted without them, or run Docker rootful.`,
    ),
  );
}

export interface StartInspection {
  bindings: PortBindingSummary | null;
  /** The network the container was created on, or null (`host`, `none`, a joined namespace). */
  network: string | null;
  /** Networks the container is attached to now. */
  attached: string[];
}

/** Parses `PortBindings`, `NetworkMode` and the attached networks, tab-separated. */
export function parseStartInspection(stdout: string): StartInspection {
  const [bindings = "", mode = "", networks = ""] = stdout.trim().split("\t");
  let attached: string[] = [];
  try {
    const value = JSON.parse(networks || "null") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) attached = Object.keys(value);
  } catch {
    attached = [];
  }
  const named =
    !mode || mode === "host" || mode === "none" || mode.startsWith("container:")
      ? null
      : mode === "default"
        ? "bridge"
        : mode;
  return { bindings: parsePortBindings(bindings), network: named, attached };
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
        "{{json .HostConfig.PortBindings}}\t{{.HostConfig.NetworkMode}}\t{{json .NetworkSettings.Networks}}",
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

export async function startDockerContainer(
  containerId: string,
  options: {
    /** `restart` for a running gateway whose firewall failed. */
    verb?: "start" | "restart";
    timeoutMs?: number;
    run?: typeof runCommand;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const attempt = (verb: "start" | "restart") =>
    run("docker", [verb, containerId], { timeoutMs }).then(() => undefined);
  let collision: unknown;
  let network: string | null = null;
  try {
    await attempt(options.verb ?? "start");
    return;
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
    if (!shouldRetryPortCollision(message, inspection.bindings)) throw error;
    collision = error;
    network = inspection.network;
    (options.log ?? ((line) => console.warn(line)))(
      `[container-start] automatic host port collided container=${containerId.slice(0, 12)} port=${collidingHostPort(message) ?? "unknown"}; retrying once with fresh ports`,
    );
  }
  try {
    await attempt("start");
  } catch (error) {
    if (ADDRESS_IN_USE.test(messageOf(error))) {
      const inspection = await inspectForStart(containerId, run);
      if (inspection) {
        await restoreNetwork(containerId, inspection, run).catch(() => {
          throw error;
        });
      }
    }
    throw bindMountRefusedError(messageOf(error)) ?? error;
  }
  // Never leave a container running without the network it was created on.
  const after = await inspectForStart(containerId, run);
  if (network && !after?.attached.includes(network)) {
    await run("docker", ["stop", containerId], { timeoutMs: 60_000 }).catch(() => undefined);
    throw collision;
  }
}
