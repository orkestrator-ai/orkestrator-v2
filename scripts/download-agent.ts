/**
 * Download one pinned agent binary for the current host into `binaries/`.
 *
 * This replaces the three hand-written `download-<agent>.sh` scripts, which
 * each re-implemented the manifest's URL construction, version literal and
 * platform mapping in bash. That duplication needed its own drift tests to
 * prove the copy still agreed with the manifest, and it still only covered
 * three of the six agents — Cursor, Grok and Pi had no downloader at all, so
 * getting one of those binaries in front of you meant hand-`curl`ing a URL you
 * reconstructed by eye.
 *
 * Here the manifest is the only input. A version bump changes nothing in this
 * file, and every agent is reachable the same way:
 *
 *   bun run download:claude          # or codex | opencode | cursor | grok | pi
 *   bun scripts/download-agent.ts claude --dir /tmp/probe
 *
 * Unlike the shell scripts it replaces, this verifies what it downloaded
 * against the manifest's pinned digests before installing it. The old scripts
 * fetched a URL and trusted whatever came back.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  PINNED_TOOLCHAIN_VERSIONS,
  pinnedToolchainArtifacts,
  type ToolchainArchitecture,
  type ToolchainArtifact,
  type ToolchainName,
  type ToolchainPlatform,
} from "../apps/desktop/electron/toolchain-manifest";
import {
  fetchArtifact,
  verifyDownloadedArchive,
  type FetchArtifact,
} from "./verify-toolchain-artifacts";

const repoRoot = path.resolve(import.meta.dir, "..");
const VERSION_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_BYTES = 2_000;

export interface DownloadOptions {
  agent: ToolchainName;
  platform: ToolchainPlatform;
  architecture: ToolchainArchitecture;
  /** Where the executables land. Defaults to `binaries/`. */
  directory?: string;
  log?: (message: string) => void;
  /** Injected so the install logic is testable without downloads. */
  artifacts?: readonly ToolchainArtifact[];
  fetchImpl?: FetchArtifact;
  /** Shortened by tests that exercise a hung executable. */
  versionProbeTimeoutMs?: number;
}

/** Maps `uname`-style values onto the manifest's vocabulary. */
export function hostTarget(
  nodePlatform: string = process.platform,
  nodeArch: string = process.arch,
): { platform: ToolchainPlatform; architecture: ToolchainArchitecture } {
  const platform =
    nodePlatform === "darwin" ? "darwin" : nodePlatform === "linux" ? "linux" : undefined;
  const architecture = nodeArch === "arm64" ? "arm64" : nodeArch === "x64" ? "x64" : undefined;
  if (!platform) throw new Error(`Unsupported platform: ${nodePlatform}`);
  if (!architecture) throw new Error(`Unsupported architecture: ${nodeArch}`);
  return { platform, architecture };
}

export function parseAgent(value: string | undefined): ToolchainName {
  const names = Object.keys(PINNED_TOOLCHAIN_VERSIONS) as ToolchainName[];
  if (!value || !names.includes(value as ToolchainName)) {
    throw new Error(`Expected one of: ${names.join(", ")}${value ? ` (received "${value}")` : ""}`);
  }
  return value as ToolchainName;
}

export interface CliArguments {
  agent: ToolchainName;
  directory?: string;
}

/**
 * Both `--dir <path>` and `--dir=<path>`, and nothing else.
 *
 * Rejecting the unknown rather than skipping it is the load-bearing part. The
 * first version of this matched only the space-separated form and dropped
 * anything else beginning with `--`, so `--dir=/tmp/probe` parsed as "no
 * directory given" and wrote a few hundred megabytes into the repository's
 * `binaries/` while reporting success.
 */
export function parseCliArguments(argv: readonly string[]): CliArguments {
  let directory: string | undefined;
  let agent: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--dir requires a directory path");
      }
      directory = value;
      index += 1;
    } else if (argument.startsWith("--dir=")) {
      directory = argument.slice("--dir=".length);
      if (!directory) throw new Error("--dir requires a directory path");
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}. Use --dir <path>.`);
    } else if (agent !== undefined) {
      throw new Error(`Unexpected extra argument: ${argument}`);
    } else {
      agent = argument;
    }
  }
  return { agent: parseAgent(agent), directory };
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_PROCESS_OUTPUT_BYTES);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

/** `--version`, purely to prove the staged file actually runs. */
function probeVersion(executable: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, reported = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(reported);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(executable)} --version timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-MAX_PROCESS_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_PROCESS_OUTPUT_BYTES);
    });
    child.on("error", (error) => {
      finish(new Error(`Could not run ${path.basename(executable)} --version: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const detail = stderr.trim() || `signal ${signal ?? "unknown"}`;
        finish(new Error(`${path.basename(executable)} --version exited ${code}: ${detail}`));
        return;
      }
      finish(undefined, (stdout.trim() || stderr.trim()).split("\n")[0] ?? "");
    });
  });
}

export type Promotion = { source: string; destination: string };

/**
 * Promote a complete staged install, restoring the previous files on failure.
 *
 * Exported for its own tests: this is the one routine whose failure branch
 * cannot be reached through `downloadAgent`, because every check that rejects
 * an install — digests, bundle integrity, the `--version` probe — deliberately
 * runs before promotion begins. Reaching the rollback path through the public
 * entry point would mean breaking a rename mid-flight, so it is driven here.
 */
export async function promotePaths(
  promotions: readonly Promotion[],
  staging: string,
): Promise<void> {
  const backups: Array<Promotion & { backup: string; existed: boolean }> = [];
  const promoted: Promotion[] = [];
  try {
    for (const [index, promotion] of promotions.entries()) {
      const backup = path.join(staging, `.previous-${index}`);
      let existed = true;
      try {
        await rename(promotion.destination, backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      backups.push({ ...promotion, backup, existed });
    }
    for (const promotion of promotions) {
      await rename(promotion.source, promotion.destination);
      promoted.push(promotion);
    }
  } catch (error) {
    for (const promotion of promoted.reverse()) {
      await rename(promotion.destination, promotion.source).catch(() => undefined);
    }
    for (const previous of backups.reverse()) {
      if (previous.existed) {
        await rename(previous.backup, previous.destination).catch(() => undefined);
      }
    }
    throw error;
  }
  for (const previous of backups) {
    if (previous.existed) await rm(previous.backup, { recursive: true, force: true });
  }
}

async function downloadTo(
  archive: ToolchainArtifact["archive"],
  destination: string,
  fetchImpl?: FetchArtifact,
): Promise<void> {
  const response = await fetchArtifact({ archive } as ToolchainArtifact, fetchImpl);
  if (!response.body) throw new Error(`Artifact response omitted a body: ${archive.url}`);
  // Streamed the same way `verify-toolchain-artifacts.ts` does. `Bun.write`
  // with the Response directly reads as the obvious shorthand and hangs
  // indefinitely on these bodies instead of finishing the write.
  await pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination),
  );
}

/**
 * macOS refuses to exec a binary whose signature does not match its bytes, and
 * several of these arrive signed for a different distribution path. An ad-hoc
 * signature is what the old scripts did too, and it is applied *after*
 * verification so the digests still describe the upstream bytes.
 */
async function adHocSign(executable: string, log: (message: string) => void): Promise<void> {
  log(`  re-signing ${path.basename(executable)} (ad-hoc, for macOS)`);
  await run("codesign", ["--remove-signature", executable]).catch(() => undefined);
  await run("codesign", ["--sign", "-", "--force", executable]);
}

export async function downloadAgent(options: DownloadOptions): Promise<string> {
  const { agent, platform, architecture } = options;
  const log = options.log ?? console.log;
  const directory = options.directory ?? path.join(repoRoot, "binaries");
  const versionProbeTimeoutMs = options.versionProbeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const artifacts = options.artifacts ?? pinnedToolchainArtifacts(platform, architecture);
  const artifact = artifacts.find(
    (entry) =>
      entry.name === agent && entry.platform === platform && entry.architecture === architecture,
  );
  if (!artifact) {
    throw new Error(`No pinned ${agent} artifact for ${platform}/${architecture}`);
  }

  log(`Downloading ${agent} v${artifact.version} for ${platform}-${architecture}...`);
  await mkdir(directory, { recursive: true });
  // Keep staging beside the destination so every final rename stays on one
  // filesystem, including when the workspace or --dir is a mounted volume.
  const staging = await mkdtemp(path.join(directory, `.ork-download-${agent}-`));
  try {
    const archivePath = path.join(staging, "archive");
    await downloadTo(artifact.archive, archivePath, options.fetchImpl);
    await verifyDownloadedArchive(agent, artifact.archive, artifact.executable, archivePath);

    const destination = path.join(directory, artifact.executable.fileName);
    if (artifact.archive.bundleRoot) {
      // Cursor and Pi read themes, helpers and grammars from beside the
      // launcher, so the tree is installed intact rather than reduced to one
      // file. `--strip-components=1` drops the archive's own root directory.
      const stagedBundle = path.join(staging, `${agent}-bundle`);
      const bundleDirectory = path.join(directory, `${agent}-bundle`);
      await mkdir(stagedBundle, { recursive: true });
      await run("tar", [
        "-xzf",
        archivePath,
        "-C",
        stagedBundle,
        "--strip-components=1",
        "--no-same-owner",
      ]);
      const inside = artifact.archive.entryPath.slice(artifact.archive.bundleRoot.length);
      const stagedLauncher = path.join(stagedBundle, ...inside.split("/"));
      await chmod(stagedLauncher, 0o755);
      if (platform === "darwin") await adHocSign(stagedLauncher, log);
      const reported = await probeVersion(stagedLauncher, versionProbeTimeoutMs);
      await promotePaths([{ source: stagedBundle, destination: bundleDirectory }], staging);
      const launcher = path.join(bundleDirectory, ...inside.split("/"));
      log(`${agent} bundle installed at ${bundleDirectory}`);
      log(`${agent} launcher at ${launcher}`);
      if (reported) log(reported);
      return launcher;
    }

    const stagedInstall = path.join(staging, "install");
    await mkdir(stagedInstall, { recursive: true });
    const stagedDestination = path.join(stagedInstall, artifact.executable.fileName);
    switch (artifact.archive.format) {
      case "raw":
        await rename(archivePath, stagedDestination);
        break;
      case "zip":
        await run("unzip", ["-o", "-q", archivePath, artifact.archive.entryPath, "-d", staging]);
        await rename(path.join(staging, artifact.archive.entryPath), stagedDestination);
        break;
      case "tar.gz":
        await run("tar", ["-xzf", archivePath, "-C", staging, artifact.archive.entryPath]);
        await rename(path.join(staging, artifact.archive.entryPath), stagedDestination);
        break;
      default: {
        const unreachable: never = artifact.archive.format;
        throw new Error(`Unsupported archive format: ${String(unreachable)}`);
      }
    }
    await chmod(stagedDestination, 0o755);
    if (platform === "darwin") await adHocSign(stagedDestination, log);

    // A companion is a helper the primary spawns from its own directory, so it
    // has to land beside it. Codex's code-mode host is the only one today, and
    // omitting it breaks every model that defaults to code mode.
    const promotions: Promotion[] = [{ source: stagedDestination, destination }];
    for (const companion of artifact.companions ?? []) {
      log(`  fetching companion ${companion.fileName}`);
      const companionArchive = path.join(staging, `companion-${companion.fileName}`);
      await downloadTo(companion.archive, companionArchive, options.fetchImpl);
      await verifyDownloadedArchive(
        `${agent} ${companion.fileName}`,
        companion.archive,
        companion.executable,
        companionArchive,
      );
      const companionPath = path.join(directory, companion.fileName);
      const stagedCompanion = path.join(stagedInstall, companion.fileName);
      await run("tar", ["-xzf", companionArchive, "-C", staging, companion.archive.entryPath]);
      await rename(path.join(staging, companion.archive.entryPath), stagedCompanion);
      await chmod(stagedCompanion, 0o755);
      // Companions are helper processes with their own protocols, not CLIs, so
      // they are deliberately never probed with `--version`.
      if (platform === "darwin") await adHocSign(stagedCompanion, log);
      promotions.push({ source: stagedCompanion, destination: companionPath });
    }

    const reported = await probeVersion(stagedDestination, versionProbeTimeoutMs);
    await promotePaths(promotions, staging);
    log(`${agent} binary downloaded to ${destination}`);
    for (const companion of artifact.companions ?? []) {
      log(
        `${agent} ${companion.fileName} downloaded to ${path.join(directory, companion.fileName)}`,
      );
    }
    if (reported) log(reported);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { agent, directory } = parseCliArguments(process.argv.slice(2));
  const { platform, architecture } = hostTarget();
  await downloadAgent({ agent, platform, architecture, directory });
}
