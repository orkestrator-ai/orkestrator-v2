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
import { tmpdir } from "node:os";
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
  expectDigest,
  fetchArtifact,
  hashArchiveEntry,
  type FetchArtifact,
} from "./verify-toolchain-artifacts";

const repoRoot = path.resolve(import.meta.dir, "..");

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

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 2_000)}`));
    });
  });
}

/** `--version`, purely to prove the file we installed actually runs. */
function probeVersion(executable: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim().split("\n")[0] ?? ""));
  });
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
  const staging = await mkdtemp(path.join(tmpdir(), `ork-download-${agent}-`));
  try {
    const archivePath = path.join(staging, "archive");
    await downloadTo(artifact.archive, archivePath, options.fetchImpl);

    // Verify before installing. The manifest's digests are the whole point of
    // pinning; fetching a URL and trusting the bytes is what this replaces.
    const executableDigest = await hashArchiveEntry(artifact.archive, archivePath);
    expectDigest(`${agent} executable`, executableDigest, artifact.executable);

    const destination = path.join(directory, artifact.executable.fileName);
    if (artifact.archive.bundleRoot) {
      // Cursor and Pi read themes, helpers and grammars from beside the
      // launcher, so the tree is installed intact rather than reduced to one
      // file. `--strip-components=1` drops the archive's own root directory.
      const bundleDirectory = path.join(directory, `${agent}-bundle`);
      await rm(bundleDirectory, { recursive: true, force: true });
      await mkdir(bundleDirectory, { recursive: true });
      await run("tar", [
        "-xzf",
        archivePath,
        "-C",
        bundleDirectory,
        "--strip-components=1",
        "--no-same-owner",
      ]);
      const inside = artifact.archive.entryPath.slice(artifact.archive.bundleRoot.length);
      const launcher = path.join(bundleDirectory, ...inside.split("/"));
      await chmod(launcher, 0o755);
      if (platform === "darwin") await adHocSign(launcher, log);
      log(`${agent} bundle installed at ${bundleDirectory}`);
      log(`${agent} launcher at ${launcher}`);
      const reported = await probeVersion(launcher);
      if (reported) log(reported);
      return launcher;
    }

    switch (artifact.archive.format) {
      case "raw":
        await rename(archivePath, destination);
        break;
      case "zip":
        await run("unzip", ["-o", "-q", archivePath, artifact.archive.entryPath, "-d", staging]);
        await rename(path.join(staging, artifact.archive.entryPath), destination);
        break;
      case "tar.gz":
        await run("tar", ["-xzf", archivePath, "-C", staging, artifact.archive.entryPath]);
        await rename(path.join(staging, artifact.archive.entryPath), destination);
        break;
      default: {
        const unreachable: never = artifact.archive.format;
        throw new Error(`Unsupported archive format: ${String(unreachable)}`);
      }
    }
    await chmod(destination, 0o755);
    if (platform === "darwin") await adHocSign(destination, log);

    // A companion is a helper the primary spawns from its own directory, so it
    // has to land beside it. Codex's code-mode host is the only one today, and
    // omitting it breaks every model that defaults to code mode.
    for (const companion of artifact.companions ?? []) {
      log(`  fetching companion ${companion.fileName}`);
      const companionArchive = path.join(staging, `companion-${companion.fileName}`);
      await downloadTo(companion.archive, companionArchive, options.fetchImpl);
      const companionDigest = await hashArchiveEntry(companion.archive, companionArchive);
      expectDigest(`${agent} ${companion.fileName}`, companionDigest, companion.executable);
      const companionPath = path.join(directory, companion.fileName);
      await run("tar", ["-xzf", companionArchive, "-C", staging, companion.archive.entryPath]);
      await rename(path.join(staging, companion.archive.entryPath), companionPath);
      await chmod(companionPath, 0o755);
      // Companions are helper processes with their own protocols, not CLIs, so
      // they are deliberately never probed with `--version`.
      if (platform === "darwin") await adHocSign(companionPath, log);
      log(`${agent} ${companion.fileName} downloaded to ${companionPath}`);
    }

    log(`${agent} binary downloaded to ${destination}`);
    const reported = await probeVersion(destination);
    if (reported) log(reported);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--dir");
  const directory = dirFlag >= 0 ? argv[dirFlag + 1] : undefined;
  const agent = parseAgent(argv.find((value) => !value.startsWith("--") && value !== directory));
  const { platform, architecture } = hostTarget();
  await downloadAgent({ agent, platform, architecture, directory });
}
