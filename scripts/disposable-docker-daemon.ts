import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  NESTED_DIND_IMAGE,
  inspectOuter,
  isNestedRunning,
  nestedDaemonConfig,
  nestedNames,
  nestedRunningState,
  outerDocker,
  outerEnvironment,
  removeNested,
  resolveOuterHost,
  restartNested,
  startNested,
  type NestedState,
} from "./disposable-docker-daemon-nested";

/**
 * A disposable host rootless Docker daemon for the live container suites
 * (to-do 4730), in one of two modes behind the same commands. One command starts a private `dockerd` under RootlessKit with
 * its own data root, exec root, socket and pid file, prints the `DOCKER_HOST`
 * that selects it, and a second command stops it and removes everything it
 * made. See docs/development/container-qualification.md, "Disposable Docker
 * daemon". `--mode rootful` starts a nested rootful daemon instead, a
 * privileged `docker:dind` container on the outer daemon; its own safety notes
 * are in disposable-docker-daemon-nested.ts.
 *
 * Safety, which comes first:
 * - It never talks to the host's Docker daemon except to read an image the
 *   caller names (`docker save`); it never restarts, configures or prunes it.
 * - The daemon runs rootless, inside RootlessKit's own user, mount and network
 *   namespaces, so its bridges and iptables rules never reach the host's
 *   firewall, routes or interfaces. Nothing here runs as root.
 * - Every directory it creates is under the instance root (this worktree's
 *   `output/disposable-docker/` by default) or a runtime directory under the
 *   temporary directory, and removal refuses any path outside those.
 * - A process is signalled only after its identity is confirmed: the start
 *   time recorded at spawn and an instance marker in its environment that
 *   only this launcher sets.
 */

export const ROOTLESS_EXTRAS_VERSION = "29.9.2";
export const SLIRP4NETNS_VERSION = "1.3.3";

type ToolArchive = { url: string; sha256: string };
type ArchitectureTools = { rootlessExtras: ToolArchive; slirp4netns: ToolArchive };

/** Pinned downloads, verified by SHA-256 before anything is unpacked or run. */
export const PINNED_TOOLS: Record<string, ArchitectureTools> = {
  x64: {
    rootlessExtras: {
      url: `https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-${ROOTLESS_EXTRAS_VERSION}.tgz`,
      sha256: "f2663b230a7afc13dea88fc589685331d01f5f3fc458b92ab40e2388db452ed2",
    },
    slirp4netns: {
      url: `https://github.com/rootless-containers/slirp4netns/releases/download/v${SLIRP4NETNS_VERSION}/slirp4netns-x86_64`,
      sha256: "5618887b671a30a2f7548f2bdf7fba98a53981abc80cfd3183cd28b4dc8b2b97",
    },
  },
  arm64: {
    rootlessExtras: {
      url: `https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-${ROOTLESS_EXTRAS_VERSION}.tgz`,
      sha256: "6b7da07c75eee49353657fdc3b9d7e8f4abe44bdd3fd735eaa8e1b0bc3fbc797",
    },
    slirp4netns: {
      url: `https://github.com/rootless-containers/slirp4netns/releases/download/v${SLIRP4NETNS_VERSION}/slirp4netns-aarch64`,
      sha256: "1ca9d2f5f1fb4beb91f354653e5dad35b95c049afb264268d99a96ff2a10d903",
    },
  },
};

/** Set in the daemon's environment; every process it starts inherits it. */
export const INSTANCE_MARKER_ENV = "ORKESTRATOR_DISPOSABLE_DOCKER_INSTANCE";
/** What the launcher tells a suite about RootlessKit's host loopback. */
export const HOST_LOOPBACK_ENV = "ORKESTRATOR_LIVE_ROOTLESS_HOST_LOOPBACK";
/** The instance's mode, printed for suites that need to know which kind of daemon they got. */
export const MODE_ENV = "ORKESTRATOR_DISPOSABLE_DOCKER_MODE";
/** A directory the nested daemon sees at the same path, for suites that bind-mount temporary files. */
export const SHARED_DIR_ENV = "ORKESTRATOR_DISPOSABLE_DOCKER_SHARED_DIR";
export const NETWORK_DRIVERS = ["slirp4netns", "gvisor-tap-vsock", "pasta", "vpnkit"] as const;
export type NetworkDriver = (typeof NETWORK_DRIVERS)[number];
export const DAEMON_MODES = ["rootless", "rootful"] as const;
/** `rootless`: host rootless dockerd under RootlessKit. `rootful`: nested privileged docker:dind. */
export type DaemonMode = (typeof DAEMON_MODES)[number];
const RUNTIME_PREFIX = "ork-ddd-";
const INSTANCE_FILE = "instance.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** Unix socket paths are limited to 108 bytes on Linux. */
const MAX_SOCKET_PATH = 100;

export type InstanceSettings = {
  mode: DaemonMode;
  network: NetworkDriver;
  hostLoopback: boolean;
  liveRestore: boolean;
  addressPool: string;
  poolSize: number;
  /** Rootful only: an IPv6 pool and IPv6 on by default for new bridge networks. */
  ipv6: boolean;
};

export type InstancePaths = {
  /** Instance directory: record, daemon.json, log, private HOME. */
  instanceDir: string;
  dataRoot: string;
  home: string;
  log: string;
  config: string;
  record: string;
  /** Rootful only: mounted into the dind container at the same path. */
  share: string;
  /** Short runtime directory: XDG_RUNTIME_DIR, socket, exec root, pid file. */
  runtimeDir: string;
  socket: string;
  execRoot: string;
  pidFile: string;
  rootlesskitState: string;
};

export type ProcessIdentity = { pid: number; startTime: string };

export type InstanceRecord = {
  schema: 1;
  name: string;
  marker: string;
  /** The temporary directory at start; restart and stop may run under another TMPDIR. */
  runtimeBase: string;
  settings: InstanceSettings;
  paths: InstancePaths;
  process: ProcessIdentity | null;
  images: { reference: string; id: string }[];
  /** Rootful only: what this instance made on the outer daemon. */
  nested?: NestedState | null;
  createdAt: string;
};

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);

export function defaultInstanceRoot(): string {
  return (
    process.env.ORKESTRATOR_DISPOSABLE_DOCKER_ROOT?.trim() ||
    path.join(repositoryRoot, "output", "disposable-docker")
  );
}

export const DEFAULT_SETTINGS: InstanceSettings = {
  mode: "rootless",
  network: "slirp4netns",
  hostLoopback: false,
  liveRestore: false,
  addressPool: "172.30.0.0/16",
  poolSize: 24,
  ipv6: false,
};

export function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Instance name ${JSON.stringify(name)} must be 1-24 lowercase letters, digits or dashes, starting with a letter or digit`,
    );
  }
  return name;
}

export function instancePaths(root: string, runtimeBase: string, name: string): InstancePaths {
  validateName(name);
  const instanceDir = path.join(path.resolve(root), name);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runtimeDir = path.join(path.resolve(runtimeBase), `${RUNTIME_PREFIX}${uid}-${name}`);
  const paths: InstancePaths = {
    instanceDir,
    dataRoot: path.join(instanceDir, "data"),
    home: path.join(instanceDir, "home"),
    log: path.join(instanceDir, "dockerd.log"),
    config: path.join(instanceDir, "daemon.json"),
    record: path.join(instanceDir, INSTANCE_FILE),
    share: path.join(instanceDir, "share"),
    runtimeDir,
    socket: path.join(runtimeDir, "docker.sock"),
    execRoot: path.join(runtimeDir, "exec"),
    pidFile: path.join(runtimeDir, "docker.pid"),
    rootlesskitState: path.join(runtimeDir, "rootlesskit"),
  };
  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH) {
    throw new Error(
      `The socket path ${paths.socket} is too long for a Unix socket; set TMPDIR to a shorter directory`,
    );
  }
  return paths;
}

/** The daemon's own configuration: its pools exist only in RootlessKit's namespace. */
export function daemonConfig(settings: InstanceSettings): Record<string, unknown> {
  if (settings.mode === "rootful") return nestedDaemonConfig(settings);
  return {
    "default-address-pools": [{ base: settings.addressPool, size: settings.poolSize }],
    "live-restore": settings.liveRestore,
  };
}

export function dockerdArguments(paths: InstancePaths): string[] {
  return [
    `--data-root=${paths.dataRoot}`,
    `--exec-root=${paths.execRoot}`,
    `--pidfile=${paths.pidFile}`,
    `--host=unix://${paths.socket}`,
    `--config-file=${paths.config}`,
  ];
}

/**
 * The environment for `dockerd-rootless.sh`: a private HOME and runtime
 * directory, so neither the user's rootless daemon nor `~/.config/docker` is
 * read, and no DOCKER_HOST or CONTAINER_HOST leaks in from the caller.
 */
export function daemonEnvironment(
  record: Pick<InstanceRecord, "marker" | "settings" | "paths">,
  toolsDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const { paths, settings } = record;
  const keep = ["PATH", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "SHELL", "TERM"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = [toolsDir, env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
  // The systemd cgroup driver creates each container's transient scope in the
  // user's own systemd manager, reached over the session bus; the private
  // XDG_RUNTIME_DIR below would otherwise hide it.
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  env.DBUS_SESSION_BUS_ADDRESS = base.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`;
  env.HOME = paths.home;
  env.XDG_RUNTIME_DIR = paths.runtimeDir;
  env.XDG_CONFIG_HOME = path.join(paths.home, ".config");
  env.XDG_DATA_HOME = path.join(paths.home, ".local", "share");
  env.DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR = paths.rootlesskitState;
  env.DOCKERD_ROOTLESS_ROOTLESSKIT_NET = settings.network;
  env.DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER =
    settings.network === "pasta" ? "implicit" : "builtin";
  env.DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK = settings.hostLoopback ? "false" : "true";
  env[INSTANCE_MARKER_ENV] = record.marker;
  return env;
}

/** What a suite needs to target this daemon, as `KEY=value` lines a shell can `export`. */
export function suiteEnvironment(
  record: InstanceRecord,
  bun = process.execPath,
): Record<string, string> {
  const rootful = record.settings.mode === "rootful";
  return {
    DOCKER_HOST: `unix://${record.paths.socket}`,
    DOCKER_CONTEXT: "",
    DOCKER_TLS: "",
    DOCKER_TLS_VERIFY: "",
    DOCKER_CERT_PATH: "",
    [MODE_ENV]: record.settings.mode,
    // Empty for a rootful daemon, so a value left from a rootless instance cannot leak through.
    [HOST_LOOPBACK_ENV]: rootful ? "" : record.settings.hostLoopback ? "enabled" : "disabled",
    [SHARED_DIR_ENV]: rootful ? (record.nested?.shareDir ?? record.paths.share) : "",
    ORKESTRATOR_LIVE_DAEMON_RESTART_COMMAND: restartCommand(record, bun),
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function rootArgument(record: InstanceRecord): string {
  return `--root ${shellQuote(path.dirname(record.paths.instanceDir))}`;
}

export function restartCommand(record: InstanceRecord, bun = process.execPath): string {
  return `${shellQuote(bun)} ${shellQuote(scriptPath)} restart --name ${record.name} ${rootArgument(record)}`;
}

export function stopCommand(record: InstanceRecord, bun = process.execPath): string {
  return `${shellQuote(bun)} ${shellQuote(scriptPath)} stop --name ${record.name} ${rootArgument(record)}`;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/** Field 22 of /proc/<pid>/stat, in clock ticks since boot; null when gone. */
export function readStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may itself contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function readEnvironment(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return null;
  }
}

/** True only when `pid` is still the process recorded at spawn and carries this instance's marker. */
export function isOwnedProcess(identity: ProcessIdentity, marker: string): boolean {
  if (readStartTime(identity.pid) !== identity.startTime) return false;
  return readEnvironment(identity.pid)?.includes(`${INSTANCE_MARKER_ENV}=${marker}`) ?? false;
}

/** Every live process of this user whose environment carries the marker. */
export function markedProcesses(marker: string): ProcessIdentity[] {
  const found: ProcessIdentity[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const startTime = readStartTime(pid);
    if (startTime === null) continue;
    if (readEnvironment(pid)?.includes(`${INSTANCE_MARKER_ENV}=${marker}`)) {
      found.push({ pid, startTime });
    }
  }
  return found;
}

function signalOwned(identity: ProcessIdentity, marker: string, signal: NodeJS.Signals): boolean {
  if (!isOwnedProcess(identity, marker)) return false;
  try {
    process.kill(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return condition();
}

// ---------------------------------------------------------------------------
// Paths and removal
// ---------------------------------------------------------------------------

/** Throws unless `candidate` is strictly inside `parent` and not a symlink. */
export function assertInside(parent: string, candidate: string): void {
  const resolvedParent = path.resolve(parent);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedParent, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove ${resolved}: it is not inside ${resolvedParent}`);
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Refusing to remove ${resolved}: it is a symbolic link`);
  }
}

/** The directories this record may remove, each checked against its own parent. */
export function removableDirectories(record: InstanceRecord, root: string): string[] {
  const runtimeBase = record.runtimeBase;
  const expected = instancePaths(root, runtimeBase, record.name);
  if (
    record.paths.instanceDir !== expected.instanceDir ||
    record.paths.runtimeDir !== expected.runtimeDir
  ) {
    throw new Error(`The record for ${record.name} names directories this launcher did not create`);
  }
  assertInside(root, record.paths.instanceDir);
  assertInside(runtimeBase, record.paths.runtimeDir);
  return [record.paths.runtimeDir, record.paths.instanceDir];
}

/**
 * Removes a directory that may hold files owned by subordinate ids (the data
 * root): the user cannot unlink those directly, so the removal runs inside a
 * RootlessKit user namespace, as `dockerd-rootless-setuptool.sh` does.
 */
function removeTree(directory: string, toolsDir: string | null, scratch: string): void {
  if (!existsSync(directory)) return;
  try {
    rmSync(directory, { recursive: true, force: true });
    return;
  } catch {
    // Fall through to the namespace removal.
  }
  const rootlesskit = toolsDir ? path.join(toolsDir, "rootlesskit") : null;
  if (!rootlesskit || !existsSync(rootlesskit)) {
    throw new Error(`Could not remove ${directory}, and RootlessKit is not available to remove it`);
  }
  const state = path.join(scratch, `rm-${randomBytes(4).toString("hex")}`);
  const result = spawnSync(
    rootlesskit,
    [`--state-dir=${state}`, "--net=host", "rm", "-rf", "--", directory],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() } },
  );
  rmSync(state, { recursive: true, force: true });
  if (result.status !== 0 || existsSync(directory)) {
    throw new Error(`Could not remove ${directory}: ${result.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function readRecord(root: string, name: string): InstanceRecord | null {
  const file = path.join(path.resolve(root), validateName(name), INSTANCE_FILE);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as InstanceRecord;
  // Records from before the rootful mode carry no mode or ipv6 setting.
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.settings &&
    typeof parsed.settings === "object"
  ) {
    parsed.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
  }
  if (
    parsed.schema !== 1 ||
    parsed.name !== name ||
    typeof parsed.marker !== "string" ||
    typeof parsed.runtimeBase !== "string"
  ) {
    throw new Error(`${file} is not a disposable daemon record`);
  }
  return parsed;
}

function writeRecord(record: InstanceRecord): void {
  const temporary = `${record.paths.record}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, record.paths.record);
}

export function listRecords(root: string): InstanceRecord[] {
  if (!existsSync(root)) return [];
  const records: InstanceRecord[] = [];
  for (const entry of readdirSync(root)) {
    if (!NAME_PATTERN.test(entry)) continue;
    try {
      const record = readRecord(root, entry);
      if (record) records.push(record);
    } catch {
      // Not one of ours; leave it alone.
    }
  }
  return records;
}

export function isRunning(record: InstanceRecord): boolean {
  if (record.settings.mode === "rootful") return isNestedRunning(record);
  return record.process !== null && isOwnedProcess(record.process, record.marker);
}

// ---------------------------------------------------------------------------
// Tools and prerequisites
// ---------------------------------------------------------------------------

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export async function download(archive: ToolArchive, destination: string): Promise<void> {
  const response = await fetch(archive.url);
  if (!response.ok) throw new Error(`Download of ${archive.url} failed: HTTP ${response.status}`);
  writeFileSync(destination, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
  const actual = sha256(destination);
  if (actual !== archive.sha256) {
    rmSync(destination, { force: true });
    throw new Error(`${archive.url} has SHA-256 ${actual}, expected ${archive.sha256}`);
  }
}

/**
 * RootlessKit, `dockerd-rootless.sh` and slirp4netns at pinned versions in
 * `<root>/tools/`, downloaded once and verified before use. `dockerd`,
 * `containerd` and `runc` come from the host's Docker installation.
 */
export async function ensureTools(root: string, arch: string = process.arch): Promise<string> {
  return withLock(root, "tools", () => ensureToolsUnlocked(root, arch));
}

async function ensureToolsUnlocked(root: string, arch: string): Promise<string> {
  const pinned = PINNED_TOOLS[arch];
  if (!pinned) throw new Error(`No pinned rootless tools for architecture ${arch}`);
  const toolsDir = path.join(
    path.resolve(root),
    "tools",
    `extras-${ROOTLESS_EXTRAS_VERSION}-slirp-${SLIRP4NETNS_VERSION}-${arch}`,
  );
  const ready = path.join(toolsDir, ".verified");
  if (existsSync(ready)) return toolsDir;
  // Downloads land in their own empty directory and are verified before use.
  const staging = `${toolsDir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const tarball = path.join(staging, "rootless-extras.tgz");
    await download(pinned.rootlessExtras, tarball);
    const unpacked = path.join(staging, "unpacked");
    mkdirSync(unpacked);
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", unpacked, "--no-same-owner"], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(`Could not unpack the rootless extras: ${tar.stderr}`);
    const bin = path.join(staging, "bin");
    mkdirSync(bin);
    for (const tool of ["rootlesskit", "dockerd-rootless.sh"]) {
      const source = path.join(unpacked, "docker-rootless-extras", tool);
      if (!existsSync(source)) throw new Error(`The rootless extras have no ${tool}`);
      renameSync(source, path.join(bin, tool));
      chmodSync(path.join(bin, tool), 0o755);
    }
    await download(pinned.slirp4netns, path.join(bin, "slirp4netns"));
    chmodSync(path.join(bin, "slirp4netns"), 0o755);
    writeFileSync(path.join(bin, ".verified"), `${JSON.stringify(pinned)}\n`);
    rmSync(toolsDir, { recursive: true, force: true });
    mkdirSync(path.dirname(toolsDir), { recursive: true });
    renameSync(bin, toolsDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return toolsDir;
}

function onPath(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/** Host prerequisites for the nested rootful mode: the outer daemon is checked at start. */
export function missingNestedPrerequisites(has: (command: string) => boolean = onPath): string[] {
  const missing: string[] = [];
  if (process.platform !== "linux") missing.push("the nested rootful mode runs on Linux only");
  for (const command of ["docker", "flock"]) {
    if (!has(command)) missing.push(`${command} is not on PATH`);
  }
  return missing;
}

/** Host prerequisites for a rootless daemon; each failure names what is missing. */
export function missingPrerequisites(
  user = os.userInfo().username,
  read: (file: string) => string | null = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  has: (command: string) => boolean = onPath,
): string[] {
  const missing: string[] = [];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    missing.push("run this as an unprivileged user, not root");
  }
  for (const command of [
    "dockerd",
    "containerd",
    "runc",
    "newuidmap",
    "newgidmap",
    "docker",
    "flock",
  ]) {
    if (!has(command)) missing.push(`${command} is not on PATH`);
  }
  for (const file of ["/etc/subuid", "/etc/subgid"]) {
    const entries = read(file) ?? "";
    if (!entries.split("\n").some((line) => line.split(":")[0] === user)) {
      missing.push(`${file} has no range for ${user}`);
    }
  }
  if (read("/proc/sys/kernel/unprivileged_userns_clone")?.trim() === "0") {
    missing.push("unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)");
  }
  if (!existsSync("/dev/net/tun")) missing.push("/dev/net/tun is missing");
  return missing;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type LauncherOptions = {
  root: string;
  runtimeBase: string;
  /** The program RootlessKit wraps; tests replace it with a stand-in. */
  rootlessScript?: (toolsDir: string) => string;
  tools?: (root: string) => Promise<string>;
  ready?: (record: InstanceRecord) => Promise<boolean>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (line: string) => void;
  /** Rootful only: the outer daemon (`--outer-host`); defaults to the caller's daemon. */
  outerHost?: string;
};

function launcherDefaults(options: LauncherOptions) {
  return {
    rootlessScript:
      options.rootlessScript ?? ((tools: string) => path.join(tools, "dockerd-rootless.sh")),
    tools: options.tools ?? ensureTools,
    ready: options.ready ?? dockerAnswers,
    readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
    stopTimeoutMs: options.stopTimeoutMs ?? 90_000,
    log: options.log ?? ((line: string) => console.error(line)),
  };
}

export function destinationEnvironment(record: InstanceRecord): NodeJS.ProcessEnv {
  return { ...process.env, ...suiteEnvironment(record) };
}

function docker(record: InstanceRecord | null, args: string[], timeout = 30_000) {
  return spawnSync("docker", record ? ["--host", `unix://${record.paths.socket}`, ...args] : args, {
    encoding: "utf8",
    env: record ? destinationEnvironment(record) : process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, timeout),
    killSignal: "SIGKILL",
  });
}

export async function dockerAnswers(record: InstanceRecord, timeout = 5_000): Promise<boolean> {
  if (!existsSync(record.paths.socket)) return false;
  return docker(record, ["info", "--format", "{{.ID}}"], timeout).status === 0;
}

/** flock releases automatically on process/pipe death; never unlink the lock inode. */
async function withLock<T>(root: string, name: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const holder = spawn(
    "flock",
    [
      "--exclusive",
      "--timeout",
      "180",
      path.join(root, `.${name}.lock`),
      "sh",
      "-c",
      "printf ready; cat >/dev/null",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  holder.stdin!.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  // A missing flock or early exit rejects admission before any mutation.
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("close", () => reject(new Error(`Could not acquire ${name} lock`)));
      holder.stdout!.once("data", () => resolve());
    });
    return await action();
  } finally {
    holder.stdin!.end();
    await closed;
  }
}

async function spawnDaemon(
  record: InstanceRecord,
  toolsDir: string,
  script: string,
): Promise<ProcessIdentity> {
  mkdirSync(record.paths.runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(record.paths.runtimeDir, 0o700);
  const log = openSync(record.paths.log, "a", 0o600);
  try {
    const child = spawn(script, dockerdArguments(record.paths), {
      cwd: record.paths.home,
      env: daemonEnvironment(record, toolsDir),
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new Error(`Could not start ${script}`);
    child.unref();
    const startTime = readStartTime(child.pid);
    if (startTime === null) throw new Error(`${script} exited at once; see ${record.paths.log}`);
    const identity = { pid: child.pid, startTime };
    // The spawned child may still be between fork and exec when /proc is first read.
    if (!(await waitFor(() => isOwnedProcess(identity, record.marker), 1_000, 10))) {
      child.kill("SIGKILL");
      throw new Error(`${script} did not acquire its instance identity`);
    }
    return identity;
  } finally {
    closeSync(log);
  }
}

/**
 * Stops the daemon process tree of `record`: SIGTERM to the recorded
 * RootlessKit parent (which stops dockerd, and with it the containers when
 * live-restore is off), then SIGKILL to anything still carrying the marker.
 */
async function stopProcesses(
  record: InstanceRecord,
  timeoutMs: number,
  log: (line: string) => void,
) {
  if (record.process && signalOwned(record.process, record.marker, "SIGTERM")) {
    const stopped = await waitFor(() => !isOwnedProcess(record.process!, record.marker), timeoutMs);
    if (!stopped)
      log(`The daemon of ${record.name} did not stop within ${timeoutMs} ms; killing it`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = markedProcesses(record.marker);
    if (left.length === 0) return;
    for (const identity of left) signalOwned(identity, record.marker, "SIGKILL");
    await waitFor(() => markedProcesses(record.marker).length === 0, 5_000);
  }
  const left = markedProcesses(record.marker);
  if (left.length > 0) {
    throw new Error(
      `Processes of ${record.name} survived SIGKILL: ${left.map((p) => p.pid).join(", ")}`,
    );
  }
}

function nestedDependencies(options: LauncherOptions) {
  const settings = launcherDefaults(options);
  return {
    persist: writeRecord,
    ready: settings.ready,
    readyTimeoutMs: settings.readyTimeoutMs,
    stopTimeoutMs: settings.stopTimeoutMs,
    log: settings.log,
  };
}

async function launch(record: InstanceRecord, options: LauncherOptions): Promise<InstanceRecord> {
  const settings = launcherDefaults(options);
  if (record.settings.mode === "rootful") {
    mkdirSync(record.paths.runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(record.paths.runtimeDir, 0o700);
    await startNested(record, nestedDependencies(options));
    return record;
  }
  const toolsDir = await settings.tools(options.root);
  record.process = await spawnDaemon(record, toolsDir, settings.rootlessScript(toolsDir));
  writeRecord(record);
  const deadline = Date.now() + settings.readyTimeoutMs;
  const ready = await waitFor(
    async () => {
      if (!isOwnedProcess(record.process!, record.marker)) {
        throw new Error(
          `The daemon of ${record.name} exited during start; see ${record.paths.log}`,
        );
      }
      return options.ready
        ? options.ready(record)
        : dockerAnswers(record, Math.min(5_000, Math.max(1, deadline - Date.now())));
    },
    settings.readyTimeoutMs,
    500,
  );
  if (!ready) {
    throw new Error(
      `The daemon of ${record.name} did not answer within ${settings.readyTimeoutMs} ms`,
    );
  }
  return record;
}

/** Removes instances whose daemon is no longer running: their own leftovers, nothing else. */
async function reapStaleUnlocked(options: LauncherOptions): Promise<string[]> {
  const reaped: string[] = [];
  for (const record of listRecords(options.root)) {
    if (record.settings.mode === "rootful") {
      const running = nestedRunningState(record);
      if (running !== false) {
        if (running === null)
          launcherDefaults(options).log(
            `Left stale instance ${record.name}: nested daemon state is unknown`,
          );
        continue;
      }
    } else if (isRunning(record)) continue;
    if (record.settings.mode === "rootful") {
      // An unreachable outer daemon cannot confirm removal: keep the record for a later stop.
      try {
        await remove(record, options, true);
      } catch (error) {
        launcherDefaults(options).log(
          `Left stale instance ${record.name}: ${error instanceof Error ? error.message : error}`,
        );
        continue;
      }
    } else {
      await remove(record, options);
    }
    reaped.push(record.name);
  }
  return reaped;
}

export function validateSettings(
  settings: InstanceSettings,
  overrides: Partial<InstanceSettings> = settings,
): void {
  if (!DAEMON_MODES.includes(settings.mode)) {
    throw new Error(`--mode must be one of ${DAEMON_MODES.join(", ")}`);
  }
  if (!NETWORK_DRIVERS.includes(settings.network)) {
    throw new Error(`--net must be one of ${NETWORK_DRIVERS.join(", ")}`);
  }
  if (settings.mode === "rootless") {
    if (settings.liveRestore) {
      throw new Error("--live-restore is unsupported by the rootless mode; use --mode rootful");
    }
    if (settings.ipv6) throw new Error("--ipv6 needs --mode rootful");
  } else if (overrides.network !== undefined || overrides.hostLoopback !== undefined) {
    throw new Error("--net and --host-loopback apply to the rootless mode only");
  }
}

/** Resolves and checks the outer daemon, and names what the instance will make on it. */
function planNested(
  name: string,
  marker: string,
  paths: InstancePaths,
  options: LauncherOptions,
): NestedState {
  const outerHost = resolveOuterHost(options.outerHost);
  if (outerHost === `unix://${paths.socket}`) {
    throw new Error("The outer daemon cannot be the instance's own socket");
  }
  const outer = inspectOuter(outerHost);
  if (outer.rootless) {
    launcherDefaults(options).log(
      `The outer daemon at ${outerHost} is rootless: the nested daemon is root only inside its user namespace`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    outerHost,
    outerRootless: outer.rootless,
    image: NESTED_DIND_IMAGE,
    pulledImage: false,
    ...nestedNames(name, marker, uid),
    containerId: null,
    shareDir: paths.share,
    socketGid: typeof process.getgid === "function" ? process.getgid() : 0,
  };
}

async function startInstanceUnlocked(
  name: string,
  overrides: Partial<InstanceSettings>,
  options: LauncherOptions,
): Promise<InstanceRecord> {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  validateSettings(settings, overrides);
  const existing = readRecord(options.root, name);
  if (existing && isRunning(existing)) {
    throw new Error(`${name} is already running; stop it first (${stopCommand(existing)})`);
  }
  for (const reaped of await reapStaleUnlocked(options))
    launcherDefaults(options).log(`Removed stale instance ${reaped}`);
  const paths = instancePaths(options.root, options.runtimeBase, name);
  if (existsSync(paths.instanceDir) || existsSync(paths.runtimeDir)) {
    throw new Error(
      `${paths.instanceDir} or ${paths.runtimeDir} already exists and is not a stale instance`,
    );
  }
  const marker = randomBytes(16).toString("hex");
  // The outer daemon is checked before anything is created.
  const nested = settings.mode === "rootful" ? planNested(name, marker, paths, options) : null;
  if (nested) {
    mkdirSync(paths.share, { recursive: true, mode: 0o700 });
  } else {
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  }
  writeFileSync(paths.config, `${JSON.stringify(daemonConfig(settings), null, 2)}\n`, {
    mode: 0o600,
  });
  const record: InstanceRecord = {
    schema: 1,
    name,
    marker,
    runtimeBase: path.resolve(options.runtimeBase),
    settings,
    paths,
    process: null,
    images: [],
    nested,
    createdAt: new Date().toISOString(),
  };
  writeRecord(record);
  try {
    return await launch(record, options);
  } catch (error) {
    await remove(record, options).catch(() => undefined);
    throw error;
  }
}

/** A real daemon restart: the whole RootlessKit tree stops, then starts on the same data root. */
async function restartInstanceUnlocked(
  name: string,
  options: LauncherOptions,
): Promise<InstanceRecord> {
  const record = readRecord(options.root, name);
  if (!record) throw new Error(`No disposable daemon named ${name}`);
  if (record.settings.mode === "rootful") {
    // Only the inner dockerd restarts; a failure leaves the instance for stop to remove.
    await restartNested(record, nestedDependencies(options));
    return record;
  }
  if (record.settings.liveRestore)
    throw new Error("Cannot restart a legacy live-restore instance; stop it first");
  const settings = launcherDefaults(options);
  await stopProcesses(record, settings.stopTimeoutMs, settings.log);
  // The runtime directory is rebuilt from nothing, as after a reboot.
  removableDirectories(record, options.root);
  removeTree(record.paths.runtimeDir, await settings.tools(options.root), record.runtimeBase);
  record.process = null;
  writeRecord(record);
  try {
    return await launch(record, options);
  } catch (error) {
    await remove(record, options);
    throw error;
  }
}

async function remove(
  record: InstanceRecord,
  options: LauncherOptions,
  staleOnly = false,
): Promise<void> {
  const settings = launcherDefaults(options);
  const directories = removableDirectories(record, options.root);
  if (record.settings.mode === "rootful") {
    removeNested(record, { log: settings.log }, staleOnly);
    for (const directory of directories) removeTree(directory, null, record.runtimeBase);
    return;
  }
  if (record.settings.liveRestore) {
    const containers = docker(record, ["ps", "-aq"]);
    if (containers.status !== 0)
      throw new Error("Cannot remove live-restore state without confirming container cleanup");
    const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]+$/.test(id) || docker(record, ["rm", "-f", id]).status !== 0)
        throw new Error("Could not remove a live-restore container; retaining daemon state");
    }
  }
  await stopProcesses(record, settings.stopTimeoutMs, settings.log);
  const toolsDir = await settings.tools(options.root).catch(() => null);
  for (const directory of directories) removeTree(directory, toolsDir, record.runtimeBase);
}

async function stopInstanceUnlocked(name: string, options: LauncherOptions): Promise<boolean> {
  const record = readRecord(options.root, name);
  if (!record) return false;
  await remove(record, options);
  return true;
}

/**
 * Copies an image from the caller's daemon into the instance by `docker save`
 * and `docker load`, keeping its reference and checking the id. The caller's
 * daemon only reads; its tags are never changed.
 */
export async function transferImage(
  record: InstanceRecord,
  reference: string,
): Promise<{ reference: string; id: string }> {
  const leaf = reference.split("/").at(-1)!;
  if (/^orkestrator-v2(?::latest)?(?:@.*)?$/.test(leaf)) {
    throw new Error("Never use orkestrator-v2:latest as a qualification image");
  }
  // A rootful instance copies from its recorded outer daemon, whatever DOCKER_HOST says now.
  const outer = record.settings.mode === "rootful" ? (record.nested?.outerHost ?? null) : null;
  if (!outer && process.env.DOCKER_HOST === `unix://${record.paths.socket}`) {
    throw new Error(
      "DOCKER_HOST already selects the disposable daemon; unset it to copy from the host",
    );
  }
  const inspect = ["image", "inspect", "--format", "{{.Id}}", reference];
  const source = outer ? outerDocker(outer, inspect) : docker(null, inspect);
  if (source.status !== 0) throw new Error(`The host daemon has no image ${reference}`);
  const id = source.stdout.trim();
  const save = spawn("docker", [...(outer ? ["--host", outer] : []), "save", reference], {
    env: outer ? outerEnvironment() : process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const load = spawn("docker", ["--host", `unix://${record.paths.socket}`, "load", "--quiet"], {
    env: destinationEnvironment(record),
    stdio: ["pipe", "ignore", "inherit"],
  });
  const finished = (child: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Docker transfer child exited ${code}`)),
      );
    });
  const saved = finished(save);
  const loaded = finished(load);
  const savedClosed = new Promise<void>((resolve) => save.once("close", () => resolve()));
  const loadedClosed = new Promise<void>((resolve) => load.once("close", () => resolve()));
  try {
    await Promise.all([pipeline(save.stdout!, load.stdin!), saved, loaded]);
  } catch (error) {
    // These child handles belong to this transfer, never a host daemon.
    save.kill("SIGKILL");
    load.kill("SIGKILL");
    await Promise.all([savedClosed, loadedClosed]);
    throw new Error(`Copying ${reference} failed`, { cause: error });
  }
  const copied = docker(record, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    reference,
  ]).stdout.trim();
  if (copied !== id) throw new Error(`${reference} arrived as ${copied}, expected ${id}`);
  const entry = { reference, id };
  record.images = [...record.images.filter((image) => image.reference !== reference), entry];
  writeRecord(record);
  return entry;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export type ParsedArguments = {
  command: string;
  name: string;
  root: string;
  images: string[];
  json: boolean;
  settings: Partial<InstanceSettings>;
  outerHost?: string;
};

export function parseArguments(argv: string[], root = defaultInstanceRoot()): ParsedArguments {
  const args = argv.filter((argument) => argument !== "--");
  const command = args.shift() ?? "help";
  const parsed: ParsedArguments = {
    command,
    name: "default",
    root,
    images: [],
    json: false,
    settings: {},
  };
  const value = (flag: string) => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  while (args.length > 0) {
    const flag = args.shift()!;
    switch (flag) {
      case "--name":
        parsed.name = validateName(value(flag));
        break;
      case "--root":
        parsed.root = path.resolve(value(flag));
        break;
      case "--image":
        parsed.images.push(value(flag));
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--net": {
        const network = value(flag) as NetworkDriver;
        if (!NETWORK_DRIVERS.includes(network)) {
          throw new Error(`--net must be one of ${NETWORK_DRIVERS.join(", ")}`);
        }
        parsed.settings.network = network;
        break;
      }
      case "--host-loopback":
        parsed.settings.hostLoopback = true;
        break;
      case "--mode": {
        const mode = value(flag) as DaemonMode;
        if (!DAEMON_MODES.includes(mode)) {
          throw new Error(`--mode must be one of ${DAEMON_MODES.join(", ")}`);
        }
        parsed.settings.mode = mode;
        break;
      }
      case "--live-restore":
        parsed.settings.liveRestore = true;
        break;
      case "--ipv6":
        parsed.settings.ipv6 = true;
        break;
      case "--outer-host":
        parsed.outerHost = value(flag);
        break;
      case "--address-pool": {
        const pool = value(flag);
        const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pool);
        if (!match || Number(match[2]) > 24)
          throw new Error("--address-pool takes an IPv4 CIDR of /24 or wider");
        parsed.settings.addressPool = pool;
        break;
      }
      default:
        if (command === "load-image" && !flag.startsWith("--")) {
          parsed.images.push(flag);
          break;
        }
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (command !== "start" && (Object.keys(parsed.settings).length || parsed.outerHost)) {
    throw new Error("Daemon settings flags are only accepted by start");
  }
  if (parsed.settings.mode !== "rootful" && parsed.outerHost !== undefined) {
    throw new Error("--outer-host needs --mode rootful");
  }
  validateSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }, parsed.settings);
  return parsed;
}

const USAGE = `Usage: mise run docker:disposable -- <command> [options]

Commands:
  start       Start a disposable daemon and print the variables that select it
  restart     Restart it on the same data (a real daemon restart): the whole RootlessKit
              tree when rootless, the inner dockerd when rootful
  stop        Stop it and remove everything it made: data, runtime directory, record and,
              when rootful, its container, volume and (if it pulled it) the dind image
  load-image  Copy an image from the host daemon into it: load-image --name <n> <reference>
  env         Print the variables for a running instance
  status      List instances and whether each is running

Options:
  --name <n>            Instance name (default: default)
  --root <dir>          Instance root (default: output/disposable-docker in this checkout)
  --image <reference>   With start: copy this image in (repeatable); never orkestrator-v2:latest
  --mode <mode>         rootless (default): host dockerd under RootlessKit
                        rootful: nested privileged docker:dind on the outer daemon
  --address-pool <cidr> Bridge pool inside the daemon's namespace (default 172.30.0.0/16, as /24s)

Rootless only:
  --net <driver>        slirp4netns (default), gvisor-tap-vsock, pasta or vpnkit
  --host-loopback       Let containers reach the host's loopback (RootlessKit default: refused)

Rootful only:
  --outer-host <url>    The outer daemon, a unix:// socket (default: DOCKER_HOST or the context)
  --ipv6                IPv6 on by default for new bridge networks, pool 2001:db8:100::/56
  --live-restore        Keep inner containers running across restart
  --json                Machine-readable output
`;

function printEnvironment(record: InstanceRecord, json: boolean): void {
  const env = suiteEnvironment(record);
  if (json) {
    console.log(
      JSON.stringify(
        {
          name: record.name,
          mode: record.settings.mode,
          env,
          images: record.images,
          stopCommand: stopCommand(record),
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const [key, value] of Object.entries(env)) console.log(`export ${key}=${shellQuote(value)}`);
  console.log(`# Stop and remove: ${stopCommand(record)}`);
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArguments(argv);
  const options: LauncherOptions = {
    root: parsed.root,
    runtimeBase: os.tmpdir(),
    outerHost: parsed.outerHost,
  };
  switch (parsed.command) {
    case "start": {
      const mode = parsed.settings.mode ?? DEFAULT_SETTINGS.mode;
      const missing = mode === "rootful" ? missingNestedPrerequisites() : missingPrerequisites();
      if (missing.length > 0)
        throw new Error(`Cannot start a ${mode} daemon:\n- ${missing.join("\n- ")}`);
      mkdirSync(parsed.root, { recursive: true });
      const record = await startWithImages(parsed.name, parsed.settings, parsed.images, options);
      printEnvironment(record, parsed.json);
      return;
    }
    case "restart": {
      await restartInstance(parsed.name, options);
      return;
    }
    case "stop": {
      const stopped = await stopInstance(parsed.name, options);
      console.error(
        stopped
          ? `Stopped and removed ${parsed.name}`
          : `No disposable daemon named ${parsed.name}`,
      );
      return;
    }
    case "load-image": {
      const record = readRecord(parsed.root, parsed.name);
      if (!record || !isRunning(record)) throw new Error(`${parsed.name} is not running`);
      for (const image of parsed.images) await transferImage(record, image);
      return;
    }
    case "env": {
      const record = readRecord(parsed.root, parsed.name);
      if (!record || !isRunning(record)) throw new Error(`${parsed.name} is not running`);
      printEnvironment(record, parsed.json);
      return;
    }
    case "status": {
      const rows = listRecords(parsed.root).map((record) => ({
        name: record.name,
        mode: record.settings.mode,
        running: isRunning(record),
        dockerHost: `unix://${record.paths.socket}`,
        settings: record.settings,
        images: record.images,
      }));
      console.log(
        parsed.json
          ? JSON.stringify(rows, null, 2)
          : rows
              .map(
                (row) =>
                  `${row.name}\t${row.mode}\t${row.running ? "running" : "stopped"}\t${row.dockerHost}`,
              )
              .join("\n") || "No disposable daemons",
      );
      return;
    }
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      throw new Error(`Unknown command ${parsed.command}\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export async function reapStale(options: LauncherOptions): Promise<string[]> {
  return withLock(options.root, "lifecycle", () => reapStaleUnlocked(options));
}

export async function startInstance(
  name: string,
  overrides: Partial<InstanceSettings>,
  options: LauncherOptions,
): Promise<InstanceRecord> {
  return withLock(options.root, "lifecycle", () => startInstanceUnlocked(name, overrides, options));
}

export async function restartInstance(
  name: string,
  options: LauncherOptions,
): Promise<InstanceRecord> {
  return withLock(options.root, "lifecycle", () => restartInstanceUnlocked(name, options));
}

export async function stopInstance(name: string, options: LauncherOptions): Promise<boolean> {
  return withLock(options.root, "lifecycle", () => stopInstanceUnlocked(name, options));
}

/** Same cleanup boundary used by start --image, exposed for subprocess regressions. */
export async function startWithImages(
  name: string,
  settings: Partial<InstanceSettings>,
  images: string[],
  options: LauncherOptions,
): Promise<InstanceRecord> {
  return withLock(options.root, "lifecycle", async () => {
    const record = await startInstanceUnlocked(name, settings, options);
    try {
      for (const image of images) await transferImage(record, image);
      return record;
    } catch (error) {
      await remove(record, options);
      throw error;
    }
  });
}
