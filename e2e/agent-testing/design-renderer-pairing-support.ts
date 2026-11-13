/**
 * Backends and a CDP-only desktop app for the 0036 renderer pairing
 * (design-canvas-renderer-pairing-electron.spec.ts): this checkout's backend or
 * a published `orkestrator` npm release, and a published desktop build whose
 * Node inspect fuse is off, so Playwright reaches it only over CDP.
 *
 * Node, not Bun: Playwright runs the specs under Node. The backend's process
 * shape follows `scripts/mixed-version/harness.ts` (which needs Bun): its own
 * data directory, worktree directory, HOME and TMPDIR under the run's root, a
 * constructed environment with nothing `ORKESTRATOR_*` or credential-shaped
 * inherited, `--runtime-flavor agent-test` (no agent outside a managed
 * toolchain can start, and there is none, so no provider turn is possible),
 * loopback only, never on a production port, and a private random gateway
 * token that is never printed.
 *
 * Its toolchain directory (`--toolchain-bin-dir`) holds one stub, `pi`, a
 * shell script that only exits 1. Both versions look agents up there in an
 * agent-test profile, so the backend reports an agent platform as any real
 * install does; with none, every renderer opens its blocking "AI CLI
 * Required" dialog over the workspace. The stub cannot run a turn, and the
 * isolated HOME has no Pi login or model catalogue.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/** The production gateway and Control MCP ports, and the host session's MCP port. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([34121, 34122, 45507]);

/** The published release the pairing runs by default: the oldest Stable on npm in the window. */
export const DEFAULT_PAIRING_RELEASE = "2.22.3";

/** Set to a published desktop build's executable to run the old-renderer half. */
export const PAIRING_OLD_APP_ENV = "ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE";

/** Overrides {@link DEFAULT_PAIRING_RELEASE} for the old-backend half. */
export const PAIRING_RELEASE_ENV = "ORKESTRATOR_PAIRING_RELEASE";

/**
 * The executable {@link PAIRING_OLD_APP_ENV} names, resolved against the
 * repository root as `packagedAppExecutable` resolves its override, so a
 * repository-relative value means the same path when it is checked and when
 * the app is spawned from the run's temporary root. Undefined when unset.
 */
export function pairingOldAppExecutable(
  repositoryRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[PAIRING_OLD_APP_ENV]?.trim();
  return value ? path.resolve(repositoryRoot, value) : undefined;
}

/**
 * Where {@link pairingPorts} finds its candidates: a port number to try, and
 * a loopback bind of exactly that port that resolves to its release, or to
 * null when the port is taken.
 */
export interface PairingPortProbe {
  candidate(): number;
  bind(port: number): Promise<(() => Promise<void>) | null>;
}

/**
 * Candidates are drawn from 20000–32767, below both Linux's (32768–60999) and
 * macOS's (49152–65535) ephemeral ranges, so an outgoing connection is not
 * handed one of them between the reservation and the backend's bind.
 */
const PAIRING_PORT_RANGE = { first: 20_000, last: 32_767 } as const;

export const loopbackPairingPortProbe: PairingPortProbe = {
  candidate: () =>
    PAIRING_PORT_RANGE.first +
    Math.floor(Math.random() * (PAIRING_PORT_RANGE.last - PAIRING_PORT_RANGE.first + 1)),
  bind: (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(null);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () =>
        resolve(() => new Promise<void>((done) => server.close(() => done()))),
      );
    }),
};

/**
 * `count` distinct free loopback ports, none of them {@link FORBIDDEN_PORTS}.
 * A forbidden candidate is refused before anything binds it: the production
 * ports are never bound, not even for the moment a probe socket would hold
 * one. Each chosen port stays bound until all are chosen, then is released.
 */
export async function pairingPorts(
  count: number,
  probe: PairingPortProbe = loopbackPairingPortProbe,
  attempts = 200,
): Promise<number[]> {
  const chosen: number[] = [];
  const releases: Array<() => Promise<void>> = [];
  try {
    for (let attempt = 0; attempt < attempts && chosen.length < count; attempt++) {
      const port = probe.candidate();
      if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
      if (FORBIDDEN_PORTS.has(port) || chosen.includes(port)) continue;
      const release = await probe.bind(port);
      if (!release) continue;
      chosen.push(port);
      releases.push(release);
    }
  } finally {
    await Promise.all(releases.map((release) => release()));
  }
  if (chosen.length < count) {
    throw new Error("No free loopback ports outside the production ports");
  }
  return chosen;
}

/** Inherited variables a backend may see; everything else is dropped. */
const INHERITED = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TZ"];

function directoryOf(executable: string): string | null {
  const found = spawnSync("/usr/bin/which", [executable], { encoding: "utf8" });
  const resolved = found.status === 0 ? found.stdout.trim() : "";
  return resolved ? path.dirname(resolved) : null;
}

/**
 * A backend's whole environment, built rather than inherited: the
 * allowlisted locale and identity variables of `base`, a PATH of Bun, Git
 * and the system directories, HOME and the XDG roots under `home`, the
 * gateway token, no fixed Control MCP port and no boot-time reachability
 * probe.
 *
 * Git's fsmonitor is forced off through Git's environment config, which
 * overrides a worktree's own config. Releases before #1386 (2.22.3 among them)
 * write `core.fsmonitor=true` into every environment worktree, and on macOS
 * each such worktree started a `git fsmonitor--daemon` that hung its git
 * clients and outlived the backend, its own session leader, after the
 * backend was stopped (seen 2026-11-13). This checkout's backend never
 * enables it, so the setting changes nothing there.
 */
export function pairingBackendEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  node: { home: string; tmp: string; token: string },
  pathDirectories: readonly string[] = [directoryOf("bun"), directoryOf("git")].filter(
    (entry): entry is string => entry !== null,
  ),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  const system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return {
    ...env,
    PATH: [...new Set([...pathDirectories, ...system])].join(path.delimiter),
    HOME: node.home,
    XDG_CONFIG_HOME: path.join(node.home, ".config"),
    XDG_DATA_HOME: path.join(node.home, ".local", "share"),
    XDG_CACHE_HOME: path.join(node.home, ".cache"),
    TMPDIR: node.tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    ORKESTRATOR_GATEWAY_TOKEN: node.token,
    ORKESTRATOR_CONTROL_MCP_PORT: "0",
    ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  };
}

/**
 * Install `orkestrator@<version>` from npm into `directory` (its own
 * `package.json`, so nothing outside it changes), without lifecycle scripts.
 * Returns the package root.
 */
export async function installPublishedBackend(version: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "package.json"),
    '{"name":"design-renderer-pairing","private":true}\n',
  );
  const result = spawnSync(
    "bun",
    ["add", "--ignore-scripts", "--exact", `orkestrator@${version}`],
    { cwd: directory, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`bun add orkestrator@${version}: ${(result.stderr ?? "").trim()}`);
  }
  const packageRoot = path.join(directory, "node_modules", "orkestrator");
  const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  if (installed.version !== version) {
    throw new Error(`npm installed orkestrator ${installed.version}, expected ${version}`);
  }
  return packageRoot;
}

export type PairingBuild = { kind: "current" } | { kind: "published"; packageRoot: string };

export interface PairingBackend {
  readonly origin: string;
  /** What the backend's own `get_app_version` answered. */
  readonly version: string;
  /** The gateway token, for `connections.connect` only; never print it. */
  readonly token: string;
  stop(): Promise<void>;
}

/** Start a headless backend of `build` under `dir` and wait until it answers. */
export async function startPairingBackend(
  build: PairingBuild,
  dir: string,
): Promise<PairingBackend> {
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  for (const directory of [home, tmp, path.join(dir, "data")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const toolchain = path.join(dir, "toolchain");
  await mkdir(toolchain, { recursive: true, mode: 0o700 });
  await writeFile(path.join(toolchain, "pi"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(toolchain, "pi"), 0o700);
  const [port, controlPort] = (await pairingPorts(2)) as [number, number];
  const token = randomBytes(24).toString("base64url");
  const service = [
    "--data-dir",
    path.join(dir, "data"),
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--port",
    String(port),
    "--strict-gateway-port",
    "--control-port",
    String(controlPort),
    "--runtime-flavor",
    "agent-test",
    "--worktree-dir",
    path.join(dir, "worktrees"),
    "--toolchain-bin-dir",
    toolchain,
  ];
  const [entry, args, cwd] =
    build.kind === "current"
      ? [path.join(repositoryRoot, "apps", "backend", "src", "main.ts"), service, repositoryRoot]
      : [path.join(build.packageRoot, "bin", "orkestrator.js"), ["serve", ...service], tmp];
  const child: ChildProcess = ownProcessGroup(
    spawn("bun", [entry, ...args], {
      cwd,
      detached: true,
      env: pairingBackendEnvironment(process.env, { home, tmp, token }),
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16 * 1024);
  });
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => stopProcessGroup(child, 15_000);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      const line = stderr.match(/\w*Error: [^\n]*/u)?.[0] ?? "no error line";
      throw new Error(`the ${build.kind} backend exited early: ${line}`);
    }
    try {
      const response = await fetch(`${origin}/__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "get_app_version", args: {} }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const { result } = (await response.json()) as { result?: unknown };
        if (typeof result === "string") return { origin, version: result, token, stop };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
  throw new Error(`the ${build.kind} backend did not answer within 120 s`);
}
