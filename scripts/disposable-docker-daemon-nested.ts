import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { InstanceRecord, InstanceSettings } from "./disposable-docker-daemon";

/**
 * The nested rootful mode of the disposable Docker daemon (to-do 4730 task 1):
 * a privileged `docker:dind` container on an outer daemon (normally the host's
 * own), with its own data volume, a socket in the instance's private runtime
 * directory and a supervisor loop that starts `dockerd` again whenever it
 * exits, so stopping the inner `dockerd` is a real rootful daemon restart.
 *
 * Safety, which comes first:
 * - The outer daemon is only asked to pull the pinned dind image when it is
 *   missing, to read an image the caller names, and to create, inspect and
 *   remove the one container and one volume this instance names. It is never
 *   restarted, configured or pruned, and no network is created on it: the
 *   container joins the outer default bridge, so no address pool is needed.
 * - The inner daemon's bridges, iptables rules and pools live in the
 *   container's own network namespace, never the host's.
 * - Everything on the outer daemon carries the instance's random marker as a
 *   label, and nothing is removed until that label is read back and matches.
 */

/** Docker's dind image at Engine 29.9.3, pinned by its multi-architecture index digest. */
export const NESTED_DIND_IMAGE =
  "docker:29.9.3-dind@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121";
/** The inner default bridge, away from the outer default bridge's 172.17.0.0/16. */
export const NESTED_BRIDGE_IP = "10.213.0.1/24";
/** The IPv6 pool `--ipv6` adds, as on the 2026-10-31 rootful run. */
export const NESTED_IPV6_POOL = { base: "2001:db8:100::/56", size: 64 };
export const NESTED_MARKER_LABEL = "orkestrator-disposable-docker";
export const NESTED_NAME_LABEL = "orkestrator-disposable-docker-instance";
/** Where the instance's runtime directory (socket, generation file) appears in the container. */
export const NESTED_RUNTIME_MOUNT = "/run/ork-ddd";
const NESTED_PIDFILE = "/var/run/docker.pid";
const PULL_TIMEOUT_MS = 15 * 60_000;

export type NestedState = {
  /** The outer daemon, recorded at start: a later restart may run with DOCKER_HOST on the inner one. */
  outerHost: string;
  /** True when the outer daemon is rootless, so "root" in the container is the user's own uid. */
  outerRootless: boolean;
  image: string;
  /** True only when this instance pulled the dind image; stop then removes it if nothing uses it. */
  pulledImage: boolean;
  container: string;
  containerId: string | null;
  volume: string;
  /** Mounted into the container at the same path, so inner bind mounts of it resolve. */
  shareDir: string;
  socketGid: number;
};

export type NestedDependencies = {
  persist: (record: InstanceRecord) => void;
  ready: (record: InstanceRecord) => Promise<boolean>;
  readyTimeoutMs: number;
  stopTimeoutMs: number;
  restartGenerationTimeoutMs?: number;
  log: (line: string) => void;
};

/**
 * Runs as the container's entrypoint. Each pass writes `<generation> <pid>` to
 * the runtime directory, so a restart can tell the new `dockerd` from the old.
 * `dind` (from the image) sets up cgroup v2 nesting and execs `dockerd`.
 */
export const SUPERVISOR_SCRIPT = `set -u
run=${NESTED_RUNTIME_MOUNT}
mkdir -p /etc/ork-ddd
printf '%s\\n' "$ORK_DDD_CONFIG" > /etc/ork-ddd/daemon.json
child=
trap 'touch "$run/stop"; [ -n "$child" ] && kill -TERM "$child"' TERM INT
generation=0
while [ ! -e "$run/stop" ]; do
  generation=$((generation + 1))
  rm -f "$run/docker.sock"
  dind dockerd --host="unix://$run/docker.sock" --group="$ORK_DDD_GID" --pidfile=${NESTED_PIDFILE} --config-file=/etc/ork-ddd/daemon.json &
  child=$!
  printf '%s %s\\n' "$generation" "$child" > "$run/generation.tmp" && mv "$run/generation.tmp" "$run/generation"
  status=0
  wait "$child" || status=$?
  echo "ork-ddd: dockerd generation $generation exited with status $status" >&2
  rm -f "$run/docker.sock"
  [ -e "$run/stop" ] || sleep 1
done
`;

export function nestedNames(name: string, marker: string, uid: number) {
  const base = `ork-ddd-${uid}-${name}-${marker.slice(0, 12)}`;
  return { container: base, volume: `${base}-data` };
}

/** The inner daemon's own configuration. */
/** The daemon.json keys that select the image store; none for Engine 29's default. */
export function storageConfig(storage: InstanceSettings["storage"]): Record<string, unknown> {
  if (storage !== "overlay2") return {};
  return { features: { "containerd-snapshotter": false }, "storage-driver": "overlay2" };
}

export function nestedDaemonConfig(settings: InstanceSettings): Record<string, unknown> {
  const pools: { base: string; size: number }[] = [
    { base: settings.addressPool, size: settings.poolSize },
  ];
  const config: Record<string, unknown> = {
    bip: NESTED_BRIDGE_IP,
    "default-address-pools": pools,
    "live-restore": settings.liveRestore,
  };
  if (settings.ipv6) {
    pools.push(NESTED_IPV6_POOL);
    config["default-network-opts"] = { bridge: { "com.docker.network.enable_ipv6": "true" } };
  }
  return { ...config, ...storageConfig(settings.storage) };
}

/** Environment for a CLI call that names its daemon with --host: nothing else may select one. */
export function outerEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    delete env[key];
  }
  return env;
}

export function outerDocker(outerHost: string, args: string[], timeout = 60_000) {
  return spawnSync("docker", ["--host", outerHost, ...args], {
    encoding: "utf8",
    env: outerEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, timeout),
    killSignal: "SIGKILL",
  });
}

/**
 * The outer daemon: `--outer-host`, else the caller's DOCKER_HOST, else the
 * current context's endpoint. It must be a local Unix socket, because the
 * container bind-mounts paths of this machine.
 */
export function resolveOuterHost(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  contextHost: () => string = currentContextHost,
): string {
  const host = explicit?.trim() || env.DOCKER_HOST?.trim() || contextHost();
  if (!host.startsWith("unix://") || host.length <= "unix://".length) {
    throw new Error(
      `The nested rootful mode needs a local outer daemon reached through a unix:// socket, not ${JSON.stringify(host)}`,
    );
  }
  return host;
}

function currentContextHost(): string {
  const result = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  if (result.status !== 0) throw new Error("Could not read the current Docker context's endpoint");
  return result.stdout.trim();
}

/** Throws when a path cannot be written into a `--mount` value unambiguously. */
function mountSource(directory: string): string {
  if (!path.isAbsolute(directory) || /[,:"\n]/.test(directory)) {
    throw new Error(
      `${directory} cannot be bind-mounted: use a path without commas, colons or quotes`,
    );
  }
  return directory;
}

/** Validate the recorded share before any bind mount or recursive deletion. */
function validateShare(paths: InstanceRecord["paths"], state: NestedState): void {
  const expected = path.join(paths.instanceDir, "share");
  if (paths.share !== expected || state.shareDir !== expected) {
    throw new Error("Refusing shared directory outside the derived instance share path");
  }
  for (const directory of [paths.instanceDir, expected]) {
    try {
      if (!lstatSync(directory).isDirectory()) {
        throw new Error("Refusing shared directory: symbolic link or non-directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function nestedRunArguments(
  record: Pick<InstanceRecord, "name" | "marker" | "settings" | "paths">,
  state: NestedState,
): string[] {
  validateShare(record.paths, state);
  return [
    "run",
    "--detach",
    "--privileged",
    "--pull",
    "never",
    "--network",
    "bridge",
    "--name",
    state.container,
    "--label",
    `${NESTED_MARKER_LABEL}=${record.marker}`,
    "--label",
    `${NESTED_NAME_LABEL}=${record.name}`,
    "--env",
    "DOCKER_TLS_CERTDIR=",
    "--env",
    `ORK_DDD_CONFIG=${JSON.stringify(nestedDaemonConfig(record.settings))}`,
    "--env",
    `ORK_DDD_GID=${state.socketGid}`,
    "--mount",
    `type=volume,source=${state.volume},target=/var/lib/docker`,
    "--mount",
    `type=bind,source=${mountSource(record.paths.runtimeDir)},target=${NESTED_RUNTIME_MOUNT}`,
    "--mount",
    `type=bind,source=${mountSource(state.shareDir)},target=${state.shareDir}`,
    "--entrypoint",
    "sh",
    state.image,
    "-c",
    SUPERVISOR_SCRIPT,
  ];
}

export type OuterInfo = { rootless: boolean };

/** Refuses an outer daemon that is unreachable, not Linux, or Docker Desktop (no bind-mounted sockets). */
export function inspectOuter(outerHost: string): OuterInfo {
  const result = outerDocker(
    outerHost,
    ["info", "--format", "{{.OSType}}|{{.OperatingSystem}}|{{json .SecurityOptions}}"],
    15_000,
  );
  if (result.status !== 0) {
    throw new Error(`The outer daemon at ${outerHost} does not answer: ${result.stderr.trim()}`);
  }
  const [osType, operatingSystem, options] = result.stdout.trim().split("|");
  if (osType !== "linux" || /docker desktop/i.test(operatingSystem ?? "")) {
    throw new Error(
      `The outer daemon at ${outerHost} is ${operatingSystem} (${osType}); the nested mode needs Linux Engine`,
    );
  }
  return { rootless: (options ?? "").includes("name=rootless") };
}

type Owned = { id: string; running: boolean } | null;

/**
 * Reads a container or volume this instance named. Absent is null; one that
 * exists without this instance's marker label is refused, never touched.
 */
export function inspectOwned(
  outerHost: string,
  kind: "container" | "volume",
  reference: string,
  marker: string,
): Owned {
  const format =
    kind === "container"
      ? `{{.Id}}|{{.State.Running}}|{{index .Config.Labels "${NESTED_MARKER_LABEL}"}}`
      : `{{.Name}}|false|{{index .Labels "${NESTED_MARKER_LABEL}"}}`;
  const result = outerDocker(outerHost, [kind, "inspect", "--format", format, reference], 15_000);
  if (result.status !== 0) {
    if (/no such/i.test(result.stderr)) return null;
    throw new Error(
      `Could not inspect ${kind} ${reference} on ${outerHost}: ${result.stderr.trim()}`,
    );
  }
  const [id, running, label] = result.stdout.trim().split("|");
  if (label !== marker) {
    throw new Error(
      `Refusing to touch ${kind} ${reference}: it does not carry this instance's marker`,
    );
  }
  return { id: id!, running: running === "true" };
}

export function nestedRunningState(record: InstanceRecord): boolean | null {
  const state = record.nested;
  if (!state) return false;
  try {
    const owned = inspectOwned(
      state.outerHost,
      "container",
      state.containerId ?? state.container,
      record.marker,
    );
    return owned?.running ?? false;
  } catch {
    return null;
  }
}

export function isNestedRunning(record: InstanceRecord): boolean {
  return nestedRunningState(record) === true;
}

function imagePresent(outerHost: string, image: string): boolean {
  return (
    outerDocker(outerHost, ["image", "inspect", "--format", "{{.Id}}", image], 15_000).status === 0
  );
}

function containerLogTail(state: NestedState): string {
  const logs = outerDocker(state.outerHost, [
    "logs",
    "--tail",
    "20",
    state.containerId ?? state.container,
  ]);
  return `${logs.stdout}${logs.stderr}`.trim();
}

export function readGeneration(runtimeDir: string): number {
  try {
    const value = Number(readFileSync(path.join(runtimeDir, "generation"), "utf8").split(" ")[0]);
    return Number.isInteger(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return condition();
}

async function waitUntilAnswering(record: InstanceRecord, deps: NestedDependencies): Promise<void> {
  const state = record.nested!;
  const ready = await waitFor(
    async () => {
      const owned = inspectOwned(state.outerHost, "container", state.containerId!, record.marker);
      if (!owned?.running) {
        throw new Error(
          `The dind container of ${record.name} exited during start:\n${containerLogTail(state)}`,
        );
      }
      return deps.ready(record);
    },
    deps.readyTimeoutMs,
    500,
  );
  if (!ready) {
    throw new Error(
      `The nested daemon of ${record.name} did not answer within ${deps.readyTimeoutMs} ms:\n${containerLogTail(state)}`,
    );
  }
}

/** Pulls the pinned image when missing, creates the volume, runs the container and waits for it. */
export async function startNested(record: InstanceRecord, deps: NestedDependencies): Promise<void> {
  const state = record.nested!;
  if (!imagePresent(state.outerHost, state.image)) {
    deps.log(`Pulling ${state.image} into the outer daemon`);
    // Recorded before the pull, so a pull that dies part-way is still cleaned up.
    state.pulledImage = true;
    deps.persist(record);
    const pull = outerDocker(state.outerHost, ["pull", "--quiet", state.image], PULL_TIMEOUT_MS);
    if (pull.status !== 0) throw new Error(`Could not pull ${state.image}: ${pull.stderr.trim()}`);
  }
  const volume = outerDocker(state.outerHost, [
    "volume",
    "create",
    "--label",
    `${NESTED_MARKER_LABEL}=${record.marker}`,
    "--label",
    `${NESTED_NAME_LABEL}=${record.name}`,
    state.volume,
  ]);
  if (volume.status !== 0)
    throw new Error(`Could not create ${state.volume}: ${volume.stderr.trim()}`);
  const run = outerDocker(state.outerHost, nestedRunArguments(record, state));
  if (run.status !== 0) throw new Error(`Could not start ${state.container}: ${run.stderr.trim()}`);
  state.containerId = run.stdout.trim().split("\n").at(-1)!.trim();
  if (!/^[a-f0-9]{12,64}$/.test(state.containerId)) {
    throw new Error(`docker run printed an unexpected container id for ${state.container}`);
  }
  deps.persist(record);
  await waitUntilAnswering(record, deps);
}

/**
 * A real rootful daemon restart: SIGTERM to the inner `dockerd` (its pid is in
 * the container's own pid namespace), then wait for the supervisor's next
 * generation to answer. With live-restore off its containers stop, as they do
 * when a host daemon restarts.
 */
export async function restartNested(
  record: InstanceRecord,
  deps: NestedDependencies,
): Promise<void> {
  const state = record.nested!;
  const owned = inspectOwned(
    state.outerHost,
    "container",
    state.containerId ?? state.container,
    record.marker,
  );
  if (!owned?.running) throw new Error(`The dind container of ${record.name} is not running`);
  const before = readGeneration(record.paths.runtimeDir);
  const signal = outerDocker(state.outerHost, [
    "exec",
    owned.id,
    "sh",
    "-c",
    `kill -TERM "$(cat ${NESTED_PIDFILE})"`,
  ]);
  if (signal.status !== 0) {
    throw new Error(
      `Could not signal the nested dockerd of ${record.name}: ${signal.stderr.trim()}`,
    );
  }
  const timeoutMs = deps.restartGenerationTimeoutMs ?? deps.stopTimeoutMs + 30_000;
  const replaced = await waitFor(() => readGeneration(record.paths.runtimeDir) > before, timeoutMs);
  if (!replaced) {
    throw new Error(`The nested dockerd of ${record.name} did not restart within ${timeoutMs} ms`);
  }
  await waitUntilAnswering(record, deps);
}

/** Removes every entry of `directory` the user can; false when some stayed (owned by root). */
function clearAsUser(directory: string): boolean {
  if (!existsSync(directory)) return true;
  let cleared = true;
  for (const entry of readdirSync(directory)) {
    try {
      rmSync(path.join(directory, entry), { recursive: true, force: true });
    } catch {
      cleared = false;
    }
  }
  return cleared;
}

/**
 * Removes what this instance made on the outer daemon: the container, root-owned
 * files it left in the bind-mounted directories, the volume and, when this
 * instance pulled it and nothing else uses it, the dind image. Throws, leaving
 * the record for a later stop, when the outer daemon cannot confirm removal.
 */
export function removeNested(
  record: InstanceRecord,
  deps: Pick<NestedDependencies, "log">,
  staleOnly = false,
): void {
  const state = record.nested;
  if (!state) return;
  validateShare(record.paths, state);
  inspectOuter(state.outerHost);
  const container = inspectOwned(
    state.outerHost,
    "container",
    state.containerId ?? state.container,
    record.marker,
  );
  if (container) {
    if (staleOnly && container.running) {
      throw new Error("Refusing to reap a running nested daemon");
    }
    const removed = outerDocker(
      state.outerHost,
      ["rm", ...(staleOnly ? [] : ["--force"]), "--volumes", container.id],
      120_000,
    );
    if (removed.status !== 0) {
      throw new Error(`Could not remove ${state.container}: ${removed.stderr.trim()}`);
    }
  }
  validateShare(record.paths, state);
  const directories = [record.paths.runtimeDir, state.shareDir];
  const leftovers = directories.filter((directory) => !clearAsUser(directory));
  if (leftovers.length > 0) {
    if (!imagePresent(state.outerHost, state.image)) {
      throw new Error(
        `Root-owned files remain in ${leftovers.join(", ")} and ${state.image} is gone`,
      );
    }
    validateShare(record.paths, state);
    // A throwaway container of the same image removes them as the root that made them.
    const cleanup = outerDocker(
      state.outerHost,
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--label",
        `${NESTED_MARKER_LABEL}=${record.marker}`,
        ...leftovers.flatMap((directory, index) => [
          "--mount",
          `type=bind,source=${mountSource(directory)},target=/clean/${index}`,
        ]),
        "--entrypoint",
        "find",
        state.image,
        ...leftovers.map((_, index) => `/clean/${index}`),
        "-mindepth",
        "1",
        "-delete",
      ],
      120_000,
    );
    if (cleanup.status !== 0) {
      throw new Error(
        `Could not remove root-owned files of ${record.name}: ${cleanup.stderr.trim()}`,
      );
    }
  }
  const volume = inspectOwned(state.outerHost, "volume", state.volume, record.marker);
  if (volume) {
    const removed = outerDocker(state.outerHost, ["volume", "rm", state.volume], 120_000);
    if (removed.status !== 0)
      throw new Error(`Could not remove ${state.volume}: ${removed.stderr.trim()}`);
  }
  if (state.pulledImage && imagePresent(state.outerHost, state.image)) {
    // Without --force Docker refuses while any container still uses the image.
    const removed = outerDocker(state.outerHost, ["image", "rm", state.image], 120_000);
    if (removed.status !== 0) {
      deps.log(`Left ${state.image} on the outer daemon: ${removed.stderr.trim()}`);
    }
  }
}
