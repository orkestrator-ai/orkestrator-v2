#!/usr/bin/env bun
/**
 * Start one side of a mixed-version pairing from a release tag, on a
 * throwaway root, for live checks the support window promises
 * (docs/architecture/version-compatibility.md, "What must work across the
 * window"):
 *
 * - `backend`: an older release's backend, built from its tag, serving a
 *   renderer URL (normally a `dev:test` profile's Vite renderer, so the
 *   browser runs today's renderer against the older backend). Recorded in
 *   to-do 0048, "Multi-client, restarts and an older backend".
 * - `renderer`: this checkout's backend serving an older release's renderer,
 *   built from its tag, so a browser runs the older renderer against today's
 *   backend ("Open browser tab → upgraded backend").
 * - `prepare`: only build the tag's checkout (both modes reuse it).
 *
 *   bun scripts/older-release-stack.ts backend --tag v2.21.0 --renderer-profile qa
 *   bun scripts/older-release-stack.ts renderer --tag v2.36.1
 *
 * The tag is archived with `git archive` (the repository's own history; npm
 * carries no v2.21.0), installed with `bun install --frozen-lockfile
 * --ignore-scripts`, and only what the mode needs is built: the Claude bridge
 * for `backend`, the web renderer for `renderer`.
 *
 * Isolation (the backend's whole environment is built, not inherited, by the
 * mixed-version harness's `backendEnvironment`):
 *
 * - its own data directory, worktree directory, HOME and TMPDIR under the
 *   root (default `output/older-release/<tag>/`, git-ignored);
 * - loopback only, on a free port that is never 34121, 34122 or 45507, with an
 *   ephemeral control port and `ORKESTRATOR_CONTROL_MCP_PORT=0` (releases
 *   before 2026-11 otherwise bind the production Control MCP port);
 * - `--runtime-flavor agent-test`, so no agent outside a managed toolchain can
 *   start; `--toolchain-bin-dir` hands it a profile's toolchain for a
 *   fake-model turn;
 * - Docker unreachable: `DOCKER_HOST` names a socket that does not exist and
 *   `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. v2.21.0 has no switch for its
 *   boot probe, so an absent socket is the only way to keep it off the
 *   host's Docker;
 * - a gateway token the launcher writes to the data directory's owner-only
 *   `gateway-auth.json` and never prints. Sign in with that file (the CLI's
 *   `--url <url> --credential-file <file>`, or the login form).
 *
 * The launcher stays attached and supervises the backend it spawned; SIGINT or
 * SIGTERM stops that one process through its handle. Nothing else is
 * signalled. A profile restart changes its renderer URL, so restart a
 * `backend` stack after restarting the profile.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { backendEnvironment, FORBIDDEN_PORTS, freePort, ROOT } from "./mixed-version/harness.ts";

export type StackMode = "backend" | "renderer" | "prepare";

export interface StackOptions {
  readonly mode: StackMode;
  readonly tag: string;
  /** Throwaway directory for this tag: its checkout, data, home and logs. */
  readonly root: string;
  readonly port?: number;
  /** `backend` mode: the renderer the older backend serves. */
  readonly rendererUrl?: string;
  /** `backend` mode: read the renderer URL from this `dev:test` profile. */
  readonly rendererProfile?: string;
  /** A managed toolchain directory to hand the backend (a profile's). */
  readonly toolchainBinDir?: string;
  /** Print the ready line as JSON. */
  readonly json: boolean;
}

export class UsageError extends Error {}

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export const USAGE = `Usage: bun scripts/older-release-stack.ts <backend|renderer|prepare> --tag vX.Y.Z
  [--root DIR] [--port N] [--toolchain-bin-dir DIR] [--json]
  backend:  [--renderer-url URL | --renderer-profile NAME]   (one is required)`;

export function parseArguments(argv: readonly string[]): StackOptions {
  const [mode, ...rest] = argv;
  if (mode !== "backend" && mode !== "renderer" && mode !== "prepare") {
    throw new UsageError(USAGE);
  }
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (
      ![
        "--tag",
        "--root",
        "--port",
        "--renderer-url",
        "--renderer-profile",
        "--toolchain-bin-dir",
      ].includes(flag)
    ) {
      throw new UsageError(`Unknown option ${flag}\n${USAGE}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    values.set(flag, value);
    index += 1;
  }
  const tag = values.get("--tag");
  if (!tag || !TAG.test(tag)) throw new UsageError(`--tag must name a release tag (vX.Y.Z)`);
  let port: number | undefined;
  if (values.has("--port")) {
    port = Number(values.get("--port"));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new UsageError("--port must be a port number");
    }
    if (FORBIDDEN_PORTS.has(port)) {
      throw new UsageError(`--port ${port} belongs to the production install; pick another`);
    }
  }
  const rendererUrl = values.get("--renderer-url");
  const rendererProfile = values.get("--renderer-profile");
  if (mode === "backend") {
    if ((rendererUrl === undefined) === (rendererProfile === undefined)) {
      throw new UsageError("backend needs exactly one of --renderer-url or --renderer-profile");
    }
  } else if (rendererUrl !== undefined || rendererProfile !== undefined) {
    throw new UsageError(`${mode} takes no renderer option`);
  }
  if (rendererUrl !== undefined && !isLoopbackHttpUrl(rendererUrl)) {
    throw new UsageError("--renderer-url must be an http URL on 127.0.0.1 or localhost");
  }
  if (rendererProfile !== undefined && !PROFILE.test(rendererProfile)) {
    throw new UsageError("--renderer-profile must be a dev:test profile name");
  }
  return {
    mode,
    tag,
    root: path.resolve(values.get("--root") ?? path.join(ROOT, "output", "older-release", tag)),
    ...(port !== undefined ? { port } : {}),
    ...(rendererUrl !== undefined ? { rendererUrl } : {}),
    ...(rendererProfile !== undefined ? { rendererProfile } : {}),
    ...(values.has("--toolchain-bin-dir")
      ? { toolchainBinDir: path.resolve(values.get("--toolchain-bin-dir")!) }
      : {}),
    json,
  };
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Where everything of one stack lives, all under its root. */
export function stackLayout(root: string, mode: Exclude<StackMode, "prepare">) {
  const run = path.join(root, mode);
  return {
    source: path.join(root, "source"),
    archive: path.join(root, "source.tar"),
    marker: path.join(root, "source", ".older-release-prepared.json"),
    run,
    data: path.join(run, "data"),
    home: path.join(run, "home"),
    tmp: path.join(run, "tmp"),
    worktrees: path.join(run, "worktrees"),
    authFile: path.join(run, "data", "gateway-auth.json"),
    log: path.join(run, "backend.log"),
    manifest: path.join(run, "stack.json"),
    absentDockerSocket: path.join(run, "no-docker.sock"),
  };
}

/**
 * The backend's environment: the mixed-version harness's constructed one
 * (nothing `ORKESTRATOR_*` or credential-shaped inherited, a system PATH plus
 * Bun's and Git's), without its environment token (the launcher writes the
 * token file instead, which is what the CLI and the login form read), with the
 * Control MCP on an ephemeral port and Docker pointed at an absent socket.
 */
export function stackEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  layout: Pick<ReturnType<typeof stackLayout>, "home" | "tmp" | "absentDockerSocket">,
  pathDirectories?: readonly string[],
): Record<string, string> {
  const env = backendEnvironment(
    base,
    { home: layout.home, tmp: layout.tmp, token: "unused" },
    ...(pathDirectories ? [pathDirectories] : []),
  );
  delete env.ORKESTRATOR_GATEWAY_TOKEN;
  return {
    ...env,
    ORKESTRATOR_CONTROL_MCP_PORT: "0",
    DOCKER_HOST: `unix://${layout.absentDockerSocket}`,
  };
}

/** The backend's arguments; `rendererUrl` or `rendererRoot` picks what it serves. */
export function stackBackendArguments(input: {
  readonly layout: Pick<ReturnType<typeof stackLayout>, "data" | "worktrees">;
  readonly port: number;
  readonly controlPort: number;
  readonly rendererUrl?: string;
  readonly rendererRoot?: string;
  readonly toolchainBinDir?: string;
}): string[] {
  for (const port of [input.port, input.controlPort]) {
    if (FORBIDDEN_PORTS.has(port)) throw new UsageError(`Refusing production port ${port}`);
  }
  return [
    "--data-dir",
    input.layout.data,
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--port",
    String(input.port),
    "--strict-gateway-port",
    "--control-host",
    "127.0.0.1",
    "--control-port",
    String(input.controlPort),
    "--runtime-flavor",
    "agent-test",
    "--worktree-dir",
    input.layout.worktrees,
    ...(input.rendererUrl ? ["--renderer-dev-server-url", input.rendererUrl] : []),
    ...(input.rendererRoot ? ["--renderer-root", input.rendererRoot] : []),
    ...(input.toolchainBinDir ? ["--toolchain-bin-dir", input.toolchainBinDir] : []),
  ];
}

function run(command: string, args: readonly string[], cwd: string, label: string): void {
  process.stderr.write(`[older-release] ${label}\n`);
  const result = spawnSync(command, [...args], {
    cwd,
    // Build output goes to stderr, so stdout carries only the ready line.
    stdio: ["ignore", 2, 2],
    // Builds run with the developer's PATH (Bun, Git) but never in production
    // mode, which would change what a release's scripts resolve.
    env: { ...process.env, NODE_ENV: "development" },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status ?? result.signal})`);
  }
}

interface PreparedMarker {
  tag: string;
  commit: string;
  built: string[];
}

/**
 * Archive, install and build the tag's checkout. Reuses an earlier checkout of
 * the same commit and builds only what is missing.
 */
export async function prepareRelease(
  options: Pick<StackOptions, "tag" | "root">,
  needs: ReadonlyArray<"claude-bridge" | "renderer">,
): Promise<string> {
  const layout = stackLayout(options.root, "backend");
  const commit = spawnSync("git", ["rev-parse", "--verify", `${options.tag}^{commit}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (commit.status !== 0) {
    throw new UsageError(`${options.tag} is not a tag in this repository (git fetch --tags?)`);
  }
  const sha = commit.stdout.trim();
  let marker: PreparedMarker | null = null;
  try {
    marker = JSON.parse(await readFile(layout.marker, "utf8")) as PreparedMarker;
  } catch {
    marker = null;
  }
  if (!marker || marker.commit !== sha) {
    // Only this launcher's own checkout under the root is ever replaced.
    await rm(layout.source, { recursive: true, force: true });
    await mkdir(layout.source, { recursive: true, mode: 0o700 });
    run(
      "git",
      ["archive", "--format=tar", "-o", layout.archive, sha],
      ROOT,
      `archive ${options.tag}`,
    );
    run("tar", ["-xf", layout.archive, "-C", layout.source], ROOT, "extract the archive");
    await rm(layout.archive, { force: true });
    run(
      "bun",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      layout.source,
      "install the release's dependencies (frozen, no lifecycle scripts)",
    );
    marker = { tag: options.tag, commit: sha, built: [] };
  }
  for (const need of needs) {
    if (marker.built.includes(need)) continue;
    if (need === "claude-bridge") {
      run(
        "bun",
        ["run", "--cwd", "bridges/claude-bridge", "build"],
        layout.source,
        "build the release's Claude bridge",
      );
    } else {
      // `vite build` alone: the package's `build` also typechecks, which a
      // released tag already passed.
      run(
        "bun",
        ["x", "vite", "build"],
        path.join(layout.source, "apps", "web"),
        "build the release's renderer",
      );
    }
    marker.built.push(need);
  }
  await writeFile(layout.marker, `${JSON.stringify(marker, null, 2)}\n`);
  return layout.source;
}

/** The renderer URL a `dev:test` profile reports. */
function profileRendererUrl(profile: string): string {
  const status = spawnSync(
    "bun",
    [
      path.join(ROOT, "apps", "desktop", "scripts", "dev-status.ts"),
      "--profile",
      profile,
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const text = status.stdout ?? "";
  const start = text.indexOf("{");
  if (status.status !== 0 || start < 0) {
    throw new UsageError(`dev:status for profile ${profile} failed; is it running?`);
  }
  const manifest = JSON.parse(text.slice(start)) as { status?: string; rendererUrl?: string };
  if (
    manifest.status !== "ready" ||
    !manifest.rendererUrl ||
    !isLoopbackHttpUrl(manifest.rendererUrl)
  ) {
    throw new UsageError(`Profile ${profile} is not ready or reports no loopback renderer URL`);
  }
  return manifest.rendererUrl;
}

async function writeToken(authFile: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(authFile), { recursive: true, mode: 0o700 });
  await writeFile(authFile, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  await chmod(authFile, 0o600);
  return token;
}

async function readToken(authFile: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(authFile, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

async function waitForVersion(url: string, token: string, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `The backend exited early (${child.exitCode ?? child.signalCode}); see its log`,
      );
    }
    try {
      const response = await fetch(`${url}/__orkestrator/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "get_app_version", args: {} }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { result?: unknown };
        if (typeof body.result === "string") return body.result;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(500);
  }
  throw new Error("The backend did not answer within 180 s; see its log");
}

async function start(options: StackOptions & { mode: "backend" | "renderer" }): Promise<number> {
  const layout = stackLayout(options.root, options.mode);
  const source = await prepareRelease(
    options,
    options.mode === "backend" ? ["claude-bridge"] : ["renderer"],
  );
  const rendererUrl =
    options.mode === "backend"
      ? (options.rendererUrl ?? profileRendererUrl(options.rendererProfile!))
      : undefined;
  const rendererRoot =
    options.mode === "renderer" ? path.join(source, "apps", "web", "dist") : undefined;
  if (rendererRoot && !existsSync(path.join(rendererRoot, "index.html"))) {
    throw new Error(`The release's renderer build has no index.html (${rendererRoot})`);
  }
  for (const directory of [layout.data, layout.home, layout.tmp, layout.worktrees]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const token = (await readToken(layout.authFile)) ?? (await writeToken(layout.authFile));
  const port = options.port ?? (await freePort());
  const controlPort = await freePort();
  const backendRoot = options.mode === "backend" ? source : ROOT;
  const args = stackBackendArguments({
    layout,
    port,
    controlPort,
    ...(rendererUrl ? { rendererUrl } : {}),
    ...(rendererRoot ? { rendererRoot } : {}),
    ...(options.toolchainBinDir ? { toolchainBinDir: options.toolchainBinDir } : {}),
  });
  const log = createWriteStream(layout.log, { flags: "a", mode: 0o600 });
  const child = spawn(
    "bun",
    [path.join(backendRoot, "apps", "backend", "src", "main.ts"), ...args],
    {
      cwd: path.join(backendRoot, "apps", "backend"),
      env: stackEnvironment(process.env, layout),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  let stopping = false;
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  // Handlers first, then the ready line (AGENTS.md invariant 16).
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 15_000);
    timer.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const url = `http://127.0.0.1:${port}`;
  try {
    const backendVersion = await waitForVersion(url, token, child);
    const ready = {
      mode: options.mode,
      tag: options.tag,
      backendVersion,
      url,
      ...(rendererUrl ? { rendererUrl } : {}),
      ...(rendererRoot ? { rendererRoot } : {}),
      dataDir: layout.data,
      authFile: layout.authFile,
      log: layout.log,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    };
    await writeFile(layout.manifest, `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(ready)}\n`
        : `[older-release] ready: ${options.mode} ${options.tag} (backend ${backendVersion}) at ${url}\n` +
            `[older-release] sign in with the token file ${layout.authFile}; log ${layout.log}\n`,
    );
  } catch (error) {
    stop();
    await exited;
    throw error;
  }
  const code = await exited;
  log.end();
  return stopping ? 0 : code;
}

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "prepare") {
    const source = await prepareRelease(options, ["claude-bridge", "renderer"]);
    process.stdout.write(
      `${options.json ? JSON.stringify({ tag: options.tag, source }) : source}\n`,
    );
    return 0;
  }
  return start(options as StackOptions & { mode: "backend" | "renderer" });
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `[older-release] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
