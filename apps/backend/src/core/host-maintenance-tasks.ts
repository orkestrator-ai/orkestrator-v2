import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePinnedToolchains, type ToolchainProgress } from "@orkestrator/toolchain/manager";
import { installPinnedToolchains, planToolchainInstall } from "@orkestrator/toolchain/install";
import { isHostVersion, type HostReleasePins } from "@orkestrator/protocol/host-maintenance";
import type { CommandContext } from "./commands-context.js";
import { APP_VERSION, DOCKER_IMAGE } from "./constants.js";
import {
  configuredImageRef,
  getImageStatus,
  resetImageManifestCache,
  resolveDockerImage,
} from "./docker-image.js";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import { HostMaintenanceError, type HostMaintenanceService } from "./host-maintenance.js";
import { readImageStatus, releaseImageReference } from "./host-maintenance-readers.js";
import { runCommand } from "./shell.js";

/**
 * The dependency tasks behind `host.toolchain.repair`, `host.image.update` and
 * `host.gh.update`. Each records itself as a task in `HostMaintenanceService`
 * and runs in the background; callers return as soon as the task is recorded.
 */

const RELEASES = "https://github.com/orkestrator-ai/orkestrator-v2/releases/download";
const DOWNLOAD_LIMIT_BYTES = 200 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceOf(context: CommandContext): HostMaintenanceService {
  if (!context.hostMaintenance) {
    throw new HostMaintenanceError("unsupported", "Host maintenance is not available");
  }
  return context.hostMaintenance;
}

/**
 * Runs `work` as task `kind` in the background; returns the recorded task and
 * its outcome. The outcome already has handlers, so awaiting it is optional.
 */
function runInBackground(
  service: HostMaintenanceService,
  kind: Parameters<HostMaintenanceService["startTask"]>[0],
  stage: string,
  work: (setStage: (stage: string) => void) => Promise<Record<string, unknown>>,
) {
  const task = service.startTask(kind, stage);
  const outcome = work((next) => service.updateTask(task.id, { stage: next }));
  void outcome.then(
    (result) => service.updateTask(task.id, { state: "succeeded", result }),
    (error: unknown) => service.updateTask(task.id, { state: "failed", error: message(error) }),
  );
  return { task, outcome };
}

/** Runs `work` as task `kind` in the background; returns the recorded task. */
function background(...args: Parameters<typeof runInBackground>) {
  return runInBackground(...args).task;
}

/** Bounded HTTPS download from GitHub's release hosts. */
async function download(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to download from ${parsed.hostname}`);
  }
  const response = await fetchImpl(url, {
    headers: { "user-agent": `orkestrator/${APP_VERSION}` },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const finalHost = new URL(response.url || url).hostname;
  if (!ALLOWED_DOWNLOAD_HOSTS.has(finalHost)) throw new Error(`Redirected to ${finalHost}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DOWNLOAD_LIMIT_BYTES) throw new Error("Download is too large");
  return bytes;
}

// ---------------------------------------------------------------------------
// Toolchain repair

function describeProgress(progress: ToolchainProgress): string {
  return progress.message.slice(0, 120);
}

/**
 * Reinstalls whatever of the pinned toolchain is missing or fails its digest.
 *
 * The set of pins is fixed by this release, so a repair normally lands in the
 * same activation directory the backend already uses and takes effect at once.
 * A desktop-hosted backend leaves `bin/current` alone (the app passes its own
 * directory); a standalone one moves it, as `orkestrator toolchain install`
 * does.
 */
export function startToolchainRepair(
  context: CommandContext,
  dependencies = {
    plan: planToolchainInstall,
    ensure: ensurePinnedToolchains,
    install: installPinnedToolchains,
  },
) {
  const service = serviceOf(context);
  const dataDir = context.storage.getDataDir();
  return background(service, "toolchain-repair", "Checking the pinned toolchain", async (stage) => {
    const onProgress = (progress: ToolchainProgress) => stage(describeProgress(progress));
    let binDir: string;
    let versions: Record<string, string>;
    if (service.updaterKind === "desktop") {
      const plan = await dependencies.plan({ dataDir });
      const installed = await dependencies.ensure({
        dataDir,
        artifacts: plan.artifacts,
        onProgress,
      });
      binDir = installed.binDir;
      versions = Object.fromEntries(
        plan.artifacts.map((artifact) => [artifact.name, artifact.version]),
      );
    } else {
      const installed = await dependencies.install({ dataDir, onProgress });
      binDir = installed.binDir;
      versions = installed.versions as Record<string, string>;
    }
    const inUse = context.toolchainBinDir ? path.resolve(context.toolchainBinDir) : null;
    return {
      versions,
      // A different directory means a different set (the enabled platforms
      // changed); only a restart picks it up.
      restartRequired: inUse !== null && path.resolve(binDir) !== inUse,
    };
  });
}

// ---------------------------------------------------------------------------
// Container image

/**
 * Pulls the release image matching this backend, checks that it provides what
 * this backend needs, and makes it the image new environments use. Running
 * environments keep their image until they are rebuilt; the result lists them.
 */
export function startImageUpdate(
  context: CommandContext,
  dependencies = {
    run: runCommand,
    status: getImageStatus,
    read: readImageStatus,
    reset: resetImageManifestCache,
  },
) {
  const service = serviceOf(context);
  const reference = releaseImageReference();
  const target = configuredImageRef(context);
  const { task, outcome } = runInBackground(
    service,
    "image-update",
    `Downloading ${reference}`,
    async (stage) => {
      await dependencies.run("docker", ["pull", reference], { timeoutMs: 45 * 60 * 1000 });
      stage("Checking the image");
      const status = await dependencies.status({ ...context, dockerImage: reference });
      if (status.state !== "compatible") {
        throw new Error(
          `${reference} is not usable by this backend (${status.state})${
            status.missingCapabilities.length
              ? `: missing ${status.missingCapabilities.join(", ")}`
              : ""
          }`,
        );
      }
      stage(`Tagging it as ${target}`);
      await dependencies.run("docker", ["tag", reference, target], { timeoutMs: 60_000 });
      dependencies.reset();
      const image = await dependencies.read(context);
      return {
        imageId: status.imageId,
        reference,
        tag: target,
        outdatedEnvironments: image?.outdatedEnvironments ?? [],
      };
    },
  );
  imageUpdateInFlight = outcome;
  const settle = () => {
    if (imageUpdateInFlight === outcome) imageUpdateInFlight = null;
  };
  void outcome.then(settle, settle);
  return task;
}

/**
 * The image update this process is running. Process-wide on purpose, like the
 * manifest cache: the image belongs to the Docker daemon, not to one backend.
 */
let imageUpdateInFlight: Promise<Record<string, unknown>> | null = null;

/**
 * Downloads the release image when the default environment image is missing,
 * so a new or reset Docker engine needs no manual build before the first
 * container. Joins an image update already running rather than starting a
 * second one. A custom image (`--docker-image`) is the operator's to provide
 * and is never pulled.
 *
 * Call it before taking a container admission slot: the download can take
 * minutes and must not hold up starts that do not need it.
 */
export async function ensureEnvironmentImage(
  context: CommandContext,
  dependencies = { resolve: resolveDockerImage, start: startImageUpdate },
): Promise<void> {
  const imageRef = configuredImageRef(context);
  if (imageRef !== DOCKER_IMAGE || !context.hostMaintenance) return;
  if ((await dependencies.resolve(imageRef)).kind !== "missing") return;
  if (!imageUpdateInFlight) {
    try {
      dependencies.start(context);
    } catch (error) {
      // Busy without an in-flight promise means another process's task; the
      // create then reports the missing image as before.
      if (!(error instanceof HostMaintenanceError)) throw error;
    }
  }
  const download = imageUpdateInFlight;
  if (!download) return;
  try {
    await download;
  } catch (error) {
    // Preserve subprocess metadata so lifecycle reporting can explain disk and timeout failures.
    throw new Error(
      `Environment image download failed: ${releaseImageReference()}: ${message(error)}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// gh, optionally following upstream releases

const GH_LATEST_DIRECTORY = path.join("toolchains", "gh-latest");

function ghTarget(platform: NodeJS.Platform, arch: string): { name: string; zip: boolean } {
  if (platform !== "darwin" && platform !== "linux") throw new Error("Unsupported platform");
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!cpu) throw new Error(`Unsupported architecture: ${arch}`);
  return {
    name: `${platform === "darwin" ? "macOS" : "linux"}_${cpu}`,
    zip: platform === "darwin",
  };
}

/** The newest `gh` already installed under `toolchains/gh-latest`, if any. */
export async function installedLatestGh(dataDir: string): Promise<string | null> {
  const root = path.join(dataDir, GH_LATEST_DIRECTORY);
  const versions = await readdir(root).catch(() => [] as string[]);
  const sorted = versions
    .filter(isHostVersion)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  for (const version of sorted.reverse()) {
    const executable = path.join(root, version, "gh");
    if (existsSync(executable)) return executable;
  }
  return null;
}

/** Selects the `gh` this backend runs, following the channel. */
export async function applyGhChannel(
  context: CommandContext,
  channel: "pinned" | "latest",
  pinned: string | undefined,
): Promise<void> {
  if (channel === "latest") {
    const latest = await installedLatestGh(context.storage.getDataDir());
    if (latest) {
      setManagedGitHubCli(latest);
      return;
    }
  }
  setManagedGitHubCli(pinned);
}

async function installLatestGh(
  dataDir: string,
  stage: (text: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{ version: string; executable: string }> {
  stage("Finding the newest gh release");
  const release = (await (
    await fetchImpl("https://api.github.com/repos/cli/cli/releases/latest", {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `orkestrator/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(30_000),
    })
  ).json()) as { tag_name?: unknown };
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!isHostVersion(version)) throw new Error("GitHub did not report a gh release");
  const executable = path.join(dataDir, GH_LATEST_DIRECTORY, version, "gh");
  if (existsSync(executable)) return { version, executable };

  const { name, zip } = ghTarget(process.platform, process.arch);
  const folder = `gh_${version}_${name}`;
  const archiveName = `${folder}.${zip ? "zip" : "tar.gz"}`;
  const base = `https://github.com/cli/cli/releases/download/v${version}`;
  stage(`Downloading gh ${version}`);
  const checksums = new TextDecoder().decode(
    await download(`${base}/gh_${version}_checksums.txt`, fetchImpl),
  );
  const expected = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === archiveName)?.[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`The gh ${version} checksums do not list ${archiveName}`);
  }
  const archive = await download(`${base}/${archiveName}`, fetchImpl);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`gh ${version} failed its checksum`);

  stage(`Installing gh ${version}`);
  const parent = path.join(dataDir, GH_LATEST_DIRECTORY);
  const staging = path.join(parent, `.staging-${version}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const archivePath = path.join(staging, archiveName);
    await writeFile(archivePath, archive);
    if (zip) {
      await runCommand("unzip", ["-q", "-o", archivePath, `${folder}/bin/gh`, "-d", staging], {
        timeoutMs: 120_000,
      });
    } else {
      await runCommand("tar", ["-xzf", archivePath, "-C", staging, `${folder}/bin/gh`], {
        timeoutMs: 120_000,
      });
    }
    const versionDir = path.join(staging, version);
    await mkdir(versionDir);
    await rename(path.join(staging, folder, "bin", "gh"), path.join(versionDir, "gh"));
    await chmod(path.join(versionDir, "gh"), 0o755);
    const probe = await runCommand(path.join(versionDir, "gh"), ["--version"], {
      timeoutMs: 30_000,
    });
    if (!probe.stdout.includes(version)) throw new Error(`gh ${version} did not run`);
    await rm(path.join(parent, version), { recursive: true, force: true });
    await rename(versionDir, path.join(parent, version));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { version, executable };
}

/**
 * Switches `gh` between its pin and the newest upstream release. Following
 * upstream is unqualified: gh has no SDK tied to its version, but a release
 * this Orkestrator was not tested with may change its output.
 */
export function startGhUpdate(
  context: CommandContext,
  channel: "pinned" | "latest",
  options: { pinned: string | undefined; fetchImpl?: typeof fetch },
) {
  const service = serviceOf(context);
  const dataDir = context.storage.getDataDir();
  return background(service, "gh-update", `Switching gh to ${channel}`, async (stage) => {
    if (channel === "pinned") {
      service.setGhChannel("pinned");
      setManagedGitHubCli(options.pinned);
      return { channel, executable: options.pinned ? "managed" : "path" };
    }
    const { version } = await installLatestGh(dataDir, stage, options.fetchImpl);
    service.setGhChannel("latest");
    await applyGhChannel(context, "latest", options.pinned);
    return { channel, version };
  });
}

// ---------------------------------------------------------------------------
// The next release's pins

/** Reads `toolchain-pins.json` from the release's assets; null when it is not published. */
export async function fetchReleasePins(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostReleasePins | null> {
  if (!isHostVersion(version)) return null;
  try {
    const bytes = await download(`${RELEASES}/v${version}/toolchain-pins.json`, fetchImpl);
    if (bytes.byteLength > 64 * 1024) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { tools?: unknown };
    if (!parsed.tools || typeof parsed.tools !== "object" || Array.isArray(parsed.tools)) {
      return null;
    }
    const tools = Object.fromEntries(
      Object.entries(parsed.tools as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .filter(([name, pin]) => /^[a-z][a-z0-9-]{0,31}$/.test(name) && pin.length <= 64)
        .slice(0, 32),
    );
    return { version, tools };
  } catch {
    return null;
  }
}
