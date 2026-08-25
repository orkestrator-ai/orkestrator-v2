import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import yauzl from "yauzl";
import {
  pinnedToolchainArtifacts,
  type ToolchainArchive,
  type ToolchainArtifact,
  type ToolchainCompanion,
  type ToolchainName,
} from "./toolchain-manifest.js";

const TOOLCHAIN_DIRECTORY = "toolchains";
const INSTALL_LOCK = ".install.lock";
const LEASE_DIRECTORY = ".leases";
const LOCK_STALE_AFTER_MS = 10 * 60 * 1_000;
const LOCK_WAIT_TIMEOUT_MS = 12 * 60 * 1_000;
const LOCK_POLL_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const PROCESS_TIMEOUT_MS = 15_000;
const RETAIN_SUPERSEDED_MS = 14 * 24 * 60 * 60 * 1_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ProcessKillLike = (pid: number, signal: 0) => true;

export type ToolchainProgress = {
  phase: "checking" | "waiting" | "downloading" | "verifying" | "installing" | "ready";
  tool?: ToolchainName;
  completedTools: number;
  totalTools: number;
  bytesReceived?: number;
  bytesTotal?: number;
  overallFraction?: number;
  message: string;
};

type ToolchainManagerTimings = {
  lockStaleAfterMs: number;
  lockWaitTimeoutMs: number;
  lockPollMs: number;
  downloadTimeoutMs: number;
  processTimeoutMs: number;
  retainSupersededMs: number;
};

const DEFAULT_TIMINGS: ToolchainManagerTimings = {
  lockStaleAfterMs: LOCK_STALE_AFTER_MS,
  lockWaitTimeoutMs: LOCK_WAIT_TIMEOUT_MS,
  lockPollMs: LOCK_POLL_MS,
  downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
  processTimeoutMs: PROCESS_TIMEOUT_MS,
  retainSupersededMs: RETAIN_SUPERSEDED_MS,
};

export type EnsurePinnedToolchainsOptions = {
  dataDir: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  artifacts?: readonly ToolchainArtifact[];
  fetchImpl?: FetchLike;
  onProgress?: (progress: ToolchainProgress) => void;
  allowInsecureDownloadsForTests?: boolean;
  skipExecutableProbeForTests?: boolean;
  timingsForTests?: Partial<ToolchainManagerTimings>;
  openLockFileForTests?: typeof open;
  openLeaseFileForTests?: typeof open;
  spawnForTests?: typeof spawn;
  processKillForTests?: ProcessKillLike;
  removeSupersededVersionForTests?: typeof rm;
  processExistsForTests?: (pid: number) => boolean;
  skipVersionLeaseForTests?: boolean;
  beforeFinalVerificationForTests?: () => void | Promise<void>;
};

export type PinnedToolchainResult = {
  rootDir: string;
  binDir: string;
  executables: Record<ToolchainName, string>;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function artifactDirectory(rootDir: string, artifact: ToolchainArtifact): string {
  return path.join(
    rootDir,
    artifact.name,
    artifact.version,
    `${artifact.platform}-${artifact.architecture}`,
  );
}

/** The toolchain root this module owns inside a given data directory. */
export function toolchainRootDir(dataDir: string): string {
  return path.join(dataDir, TOOLCHAIN_DIRECTORY);
}

/**
 * Where a pinned artifact is installed under `dataDir`.
 *
 * Exported so anything that pre-populates a cache — the isolated dev-profile
 * seeder — derives the layout from this module rather than re-deriving it. A
 * duplicated path join would keep validating until the layout changed, and then
 * silently seed into a directory the installer never looks at.
 */
export function pinnedArtifactDirectory(dataDir: string, artifact: ToolchainArtifact): string {
  return artifactDirectory(toolchainRootDir(dataDir), artifact);
}

function artifactExecutablePath(rootDir: string, artifact: ToolchainArtifact): string {
  return path.join(artifactDirectory(rootDir, artifact), artifact.executable.fileName);
}

function upstreamExecutablePath(rootDir: string, artifact: ToolchainArtifact): string {
  return path.join(
    artifactDirectory(rootDir, artifact),
    `.upstream-${artifact.executable.fileName}`,
  );
}

function artifactCompanions(artifact: ToolchainArtifact): readonly ToolchainCompanion[] {
  return artifact.companions ?? [];
}

function companionPath(
  rootDir: string,
  artifact: ToolchainArtifact,
  companion: ToolchainCompanion,
): string {
  return path.join(artifactDirectory(rootDir, artifact), companion.fileName);
}

/** Every archive byte an artifact downloads, so progress covers companions. */
function artifactArchiveBytes(artifact: ToolchainArtifact): number {
  return artifactCompanions(artifact).reduce(
    (total, companion) => total + companion.archive.size,
    artifact.archive.size,
  );
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

type InstalledExecutableState = {
  size: number;
  sha256: string;
};

function assertValidArtifactMetadata(artifact: ToolchainArtifact): void {
  if (!["zip", "tar.gz", "raw"].includes(artifact.archive.format)) {
    throw new Error(`${artifact.name} manifest has unsupported archive format`);
  }
  if (
    artifact.archive.bundleRoot !== undefined &&
    (artifact.archive.format !== "tar.gz" ||
      !artifact.archive.bundleRoot.endsWith("/") ||
      artifact.archive.bundleRoot.startsWith("/") ||
      artifact.archive.bundleRoot.includes(".."))
  ) {
    throw new Error(`${artifact.name} manifest has an unsafe bundle root`);
  }
  if (artifact.archive.bundleFiles !== undefined) {
    if (!artifact.archive.bundleRoot || artifact.archive.bundleFiles.length === 0) {
      throw new Error(`${artifact.name} manifest has bundle files without a bundle root`);
    }
    const paths = new Set<string>();
    for (const file of artifact.archive.bundleFiles) {
      const normalized = path.posix.normalize(file.path);
      if (
        normalized !== file.path ||
        normalized.startsWith("../") ||
        normalized.startsWith("/") ||
        normalized.includes("\\") ||
        paths.has(normalized) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        throw new Error(`${artifact.name} manifest has an unsafe bundle file`);
      }
      paths.add(normalized);
    }
  }
  if (artifact.archive.bundleIntegrity !== undefined) {
    const integrity = artifact.archive.bundleIntegrity;
    if (
      !artifact.archive.bundleRoot ||
      artifact.archive.bundleFiles !== undefined ||
      !Number.isSafeInteger(integrity.fileCount) ||
      integrity.fileCount < 1 ||
      !Number.isSafeInteger(integrity.totalSize) ||
      integrity.totalSize < 1 ||
      !/^[a-f0-9]{64}$/.test(integrity.sha256)
    ) {
      throw new Error(`${artifact.name} manifest has invalid bundle integrity`);
    }
  }
  const hasSize = artifact.executable.installedSize !== undefined;
  const hasSha256 = artifact.executable.installedSha256 !== undefined;
  if (hasSize !== hasSha256) {
    throw new Error(
      `${artifact.name} manifest must provide installedSize and installedSha256 together`,
    );
  }
  if (
    hasSize &&
    (!Number.isSafeInteger(artifact.executable.installedSize) ||
      artifact.executable.installedSize! <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.executable.installedSha256!))
  ) {
    throw new Error(`${artifact.name} manifest has invalid installed executable metadata`);
  }
  if (artifact.executable.repairInvalidMacSignature && hasSize) {
    throw new Error(`${artifact.name} manifest cannot pin locally repaired executable bytes`);
  }

  const activationNames = new Set<string>([artifact.name, artifact.executable.fileName]);
  for (const alias of artifact.activationAliases ?? []) {
    if (
      !alias ||
      alias.startsWith(".") ||
      alias.includes("/") ||
      alias.includes("\\") ||
      alias !== path.basename(alias) ||
      activationNames.has(alias)
    ) {
      throw new Error(`${artifact.name} manifest has an unsafe or duplicate activation alias`);
    }
    activationNames.add(alias);
  }

  const companionNames = new Set<string>(activationNames);
  for (const companion of artifactCompanions(artifact)) {
    if (companion.archive.format !== "zip" && companion.archive.format !== "tar.gz") {
      throw new Error(`${artifact.name} companion has an unsupported archive format`);
    }
    // A companion is written into, and symlinked out of, directories this
    // module owns. Anything that is not a plain file name could escape them.
    if (
      !companion.fileName ||
      companion.fileName.startsWith(".") ||
      companion.fileName.includes("/") ||
      companion.fileName.includes("\\") ||
      companion.fileName !== path.basename(companion.fileName)
    ) {
      throw new Error(`${artifact.name} companion has an unsafe file name`);
    }
    if (companionNames.has(companion.fileName)) {
      throw new Error(`${artifact.name} companion ${companion.fileName} is declared twice`);
    }
    companionNames.add(companion.fileName);
    if (
      !Number.isSafeInteger(companion.executable.size) ||
      companion.executable.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(companion.executable.sha256)
    ) {
      throw new Error(
        `${artifact.name} companion ${companion.fileName} has invalid executable metadata`,
      );
    }
  }
}

function archiveExtension(archive: ToolchainArchive): string {
  return archive.format === "zip" ? "zip" : archive.format === "raw" ? "bin" : "tar.gz";
}

/**
 * Every artifact, activation alias, and companion is linked into one shared
 * activation directory, so a name collision could silently replace another
 * tool's symlink — and the winner would depend on iteration order.
 * `assertValidArtifactMetadata` can only see one artifact, so the set-wide
 * check lives here.
 */
function assertUniqueActivationNames(artifacts: readonly ToolchainArtifact[]): void {
  // Owned by tool name rather than by artifact, so the per-platform entries of
  // one tool legitimately claim the same names as each other.
  const owners = new Map<string, ToolchainName>();
  const claim = (
    linkName: string,
    owner: ToolchainName,
    kind: "activation alias" | "companion" = "companion",
  ): void => {
    const existing = owners.get(linkName);
    if (existing !== undefined && existing !== owner) {
      throw new Error(
        `${owner} ${kind} ${linkName} collides with ${existing} in the shared activation directory`,
      );
    }
    owners.set(linkName, owner);
  };

  // Tool names first, so a collision is reported no matter which artifact
  // declares the companion or which order the set arrives in.
  for (const artifact of artifacts) {
    owners.set(artifact.name, artifact.name);
    owners.set(artifact.executable.fileName, artifact.name);
  }
  for (const artifact of artifacts) {
    for (const alias of artifact.activationAliases ?? []) {
      claim(alias, artifact.name, "activation alias");
    }
    for (const companion of artifactCompanions(artifact)) {
      claim(companion.fileName, artifact.name);
    }
  }
}

function pinnedInstalledState(artifact: ToolchainArtifact): InstalledExecutableState {
  const { size, sha256, installedSize, installedSha256, repairInvalidMacSignature } =
    artifact.executable;
  if (installedSize !== undefined && installedSha256 !== undefined) {
    return { size: installedSize, sha256: installedSha256 };
  }
  if (repairInvalidMacSignature) {
    throw new Error(
      `${artifact.name} locally repaired executable has no reproducible pinned state`,
    );
  }
  return { size, sha256 };
}

async function isValidFile(filePath: string, expected: InstalledExecutableState): Promise<boolean> {
  try {
    const file = await lstat(filePath);
    return (
      file.isFile() &&
      !file.isSymbolicLink() &&
      file.size === expected.size &&
      (await sha256File(filePath)) === expected.sha256
    );
  } catch {
    return false;
  }
}

async function isValidUpstreamExecutable(
  rootDir: string,
  artifact: ToolchainArtifact,
): Promise<boolean> {
  return isValidFile(upstreamExecutablePath(rootDir, artifact), {
    size: artifact.executable.size,
    sha256: artifact.executable.sha256,
  });
}

async function isValidExecutable(rootDir: string, artifact: ToolchainArtifact): Promise<boolean> {
  if (artifact.executable.repairInvalidMacSignature) {
    // Locally ad-hoc-signed bytes are not reproducible and therefore cannot be
    // pinned in the manifest. The cache is reusable only through the separately
    // retained, manifest-pinned upstream executable. The runnable copy is
    // regenerated from it under the install lock on every startup.
    return isValidUpstreamExecutable(rootDir, artifact);
  }
  const executablePath = artifactExecutablePath(rootDir, artifact);
  try {
    const expected = pinnedInstalledState(artifact);
    const file = await lstat(executablePath);
    if (!file.isFile() || file.isSymbolicLink() || file.size !== expected.size) return false;
    if ((await sha256File(executablePath)) !== expected.sha256) return false;
    if ((file.mode & 0o777) !== 0o500) await chmod(executablePath, 0o500);
    for (const bundled of artifact.archive.bundleFiles ?? []) {
      if (
        !(await isValidFile(
          path.join(artifactDirectory(rootDir, artifact), ...bundled.path.split("/")),
          bundled,
        ))
      ) {
        return false;
      }
    }
    if (
      artifact.archive.bundleIntegrity &&
      !(await hasValidBundleIntegrity(artifactDirectory(rootDir, artifact), artifact))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

type BundleTreeEntry = {
  path: string;
  size: number;
  executable: boolean;
  sha256: string;
};

async function bundleTreeEntries(
  directory: string,
  artifact: ToolchainArtifact,
): Promise<BundleTreeEntry[]> {
  const entries: BundleTreeEntry[] = [];
  const excludedExecutablePaths = new Set<string>([artifact.executable.fileName]);
  if (artifact.executable.repairInvalidMacSignature) {
    // Repairable artifacts retain the manifest-pinned upstream launcher beside
    // the locally signed runnable copy. Both represent the primary executable,
    // which the bundle digest deliberately excludes and validates separately.
    excludedExecutablePaths.add(`.upstream-${artifact.executable.fileName}`);
  }
  const visit = async (currentDirectory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        if (excludedExecutablePaths.has(relativePath)) continue;
        const info = await lstat(filePath);
        entries.push({
          path: relativePath,
          size: info.size,
          executable: (info.mode & 0o111) !== 0,
          sha256: await sha256File(filePath),
        });
      } else {
        throw new Error(`Bundle contains unsupported entry: ${relativePath}`);
      }
    }
  };
  await visit(directory);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function bundleTreeDigest(entries: readonly BundleTreeEntry[]): {
  fileCount: number;
  totalSize: number;
  sha256: string;
} {
  const hash = createHash("sha256");
  let totalSize = 0;
  for (const entry of entries) {
    totalSize += entry.size;
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(entry.executable ? "x" : "-");
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return { fileCount: entries.length, totalSize, sha256: hash.digest("hex") };
}

async function hasValidBundleIntegrity(
  directory: string,
  artifact: ToolchainArtifact,
): Promise<boolean> {
  const expected = artifact.archive.bundleIntegrity;
  if (!expected) return true;
  const actual = bundleTreeDigest(await bundleTreeEntries(directory, artifact));
  return (
    actual.fileCount === expected.fileCount &&
    actual.totalSize === expected.totalSize &&
    actual.sha256 === expected.sha256
  );
}

async function isValidCompanion(
  rootDir: string,
  artifact: ToolchainArtifact,
  companion: ToolchainCompanion,
): Promise<boolean> {
  const filePath = companionPath(rootDir, artifact, companion);
  try {
    const file = await lstat(filePath);
    if (!file.isFile() || file.isSymbolicLink() || file.size !== companion.executable.size)
      return false;
    if ((await sha256File(filePath)) !== companion.executable.sha256) return false;
    if ((file.mode & 0o777) !== 0o500) await chmod(filePath, 0o500);
    return true;
  } catch {
    return false;
  }
}

async function missingCompanions(
  rootDir: string,
  artifact: ToolchainArtifact,
): Promise<ToolchainCompanion[]> {
  const companions = artifactCompanions(artifact);
  const validity = await Promise.all(
    companions.map((companion) => isValidCompanion(rootDir, artifact, companion)),
  );
  return companions.filter((_, index) => !validity[index]);
}

/**
 * An artifact is only usable when its companions are present too. A cache that
 * predates a companion being added holds a valid primary executable, so the
 * install has to be judged as a set or the missing companion is never repaired.
 *
 * `companions-missing` is kept distinct from `missing` because the two are
 * repaired differently: re-downloading a primary archive that is already
 * verified on disk costs the user the whole release for a helper a fraction of
 * its size, and rebuilding the version directory disturbs a still-running build
 * whose activation symlinks point into it. It carries the companions it found
 * missing so the repair does not have to digest them a second time.
 */
type InstallationStatus =
  | { state: "valid" }
  | { state: "missing" }
  | { state: "companions-missing"; companions: readonly ToolchainCompanion[] };

async function installationStatus(
  rootDir: string,
  artifact: ToolchainArtifact,
): Promise<InstallationStatus> {
  if (!(await isValidExecutable(rootDir, artifact))) return { state: "missing" };
  const companions = await missingCompanions(rootDir, artifact);
  return companions.length === 0 ? { state: "valid" } : { state: "companions-missing", companions };
}

async function isValidInstallation(rootDir: string, artifact: ToolchainArtifact): Promise<boolean> {
  return (await installationStatus(rootDir, artifact)).state === "valid";
}

type InstallLockOwner = {
  token: string;
  pid: number;
  createdAt: string;
};

type InstallLock = {
  release(): Promise<void>;
};

async function readInstallLockOwner(lockPath: string): Promise<InstallLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<InstallLockOwner>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return { token: parsed.token, pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function processExists(pid: number, killProcess: ProcessKillLike = process.kill): boolean {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function initializeInstallLock(
  lockPath: string,
  owner: InstallLockOwner,
  openLockFile: typeof open,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  let initialized = false;
  try {
    handle = await openLockFile(lockPath, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(owner));
    await handle.close();
    handle = null;
    initialized = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (created && !initialized) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function acquireInstallLock(
  rootDir: string,
  onProgress: (message: string) => void,
  timings: ToolchainManagerTimings,
  openLockFile: typeof open,
  ownerProcessExists: (pid: number) => boolean,
): Promise<InstallLock> {
  const lockPath = path.join(rootDir, INSTALL_LOCK);
  const startedAt = Date.now();
  let announcedWait = false;

  while (Date.now() - startedAt < timings.lockWaitTimeoutMs) {
    const owner: InstallLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    try {
      await initializeInstallLock(lockPath, owner, openLockFile);
      let heartbeat: Promise<void> = Promise.resolve();
      const heartbeatInterval = Math.max(10, Math.floor(timings.lockStaleAfterMs / 3));
      const heartbeatTimer = setInterval(() => {
        heartbeat = heartbeat
          .then(async () => {
            const current = await readInstallLockOwner(lockPath);
            if (current?.token !== owner.token) return;
            const now = new Date();
            await utimes(lockPath, now, now);
          })
          .catch(() => undefined);
      }, heartbeatInterval);
      heartbeatTimer.unref();
      return {
        release: async () => {
          clearInterval(heartbeatTimer);
          await heartbeat;
          const current = await readInstallLockOwner(lockPath);
          if (!current) {
            throw new Error("Orkestrator toolchain installation lock disappeared unexpectedly");
          }
          if (current.token !== owner.token) {
            throw new Error(
              "Orkestrator toolchain installation lock ownership changed unexpectedly",
            );
          }
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const observedOwner = await readInstallLockOwner(lockPath);
    if (observedOwner && !ownerProcessExists(observedOwner.pid)) {
      // A process can exit immediately after creating the lock (for example,
      // when a dev server is restarted during first-run downloads). Waiting
      // for the age threshold in that case strands the next launch even though
      // the recorded owner is conclusively gone.
      const currentOwner = await readInstallLockOwner(lockPath);
      if (currentOwner?.token === observedOwner.token) {
        await rm(lockPath, { force: true });
        continue;
      }
    }

    const lockStat = await stat(lockPath).catch(() => null);
    if (!observedOwner && lockStat && Date.now() - lockStat.mtimeMs > timings.lockStaleAfterMs) {
      // A newly-created lock can briefly be empty while its owner metadata is
      // written. Only malformed locks need the age safeguard.
      const currentOwner = await readInstallLockOwner(lockPath);
      if (!currentOwner) {
        await rm(lockPath, { force: true });
        continue;
      }
    }
    if (!announcedWait) {
      announcedWait = true;
      onProgress("Waiting for another Orkestrator window to finish preparing tools…");
    }
    await delay(timings.lockPollMs);
  }
  throw new Error("Timed out waiting for the Orkestrator toolchain installation lock");
}

function assertDownloadLocation(
  label: string,
  archive: ToolchainArchive,
  response: Response,
  allowInsecureDownloadsForTests: boolean,
): void {
  const requested = new URL(archive.url);
  const resolved = new URL(response.url || archive.url);
  if (
    !allowInsecureDownloadsForTests &&
    (requested.protocol !== "https:" || resolved.protocol !== "https:")
  ) {
    throw new Error(`${label} download did not use HTTPS`);
  }
  if (!archive.allowedHosts.includes(requested.hostname)) {
    throw new Error(`${label} download host is not allowlisted: ${requested.hostname}`);
  }
  if (!archive.allowedHosts.includes(resolved.hostname)) {
    throw new Error(`${label} redirected to an untrusted host: ${resolved.hostname}`);
  }
}

async function downloadArchive(
  label: string,
  archive: ToolchainArchive,
  archivePath: string,
  fetchImpl: FetchLike,
  onBytes: (received: number) => void,
  allowInsecureDownloadsForTests: boolean,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const response = await fetchImpl(archive.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "OrkestratorV2 toolchain installer" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`${label} download failed with HTTP ${response.status}`);
    }
    assertDownloadLocation(label, archive, response, allowInsecureDownloadsForTests);

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== archive.size) {
      throw new Error(`${label} archive size header did not match the pinned manifest`);
    }

    handle = await open(archivePath, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > archive.size) {
        throw new Error(`${label} archive exceeded its pinned size`);
      }
      hash.update(value);
      await handle.writeFile(value);
      onBytes(received);
    }
    await handle.close();
    handle = null;

    if (received !== archive.size) {
      throw new Error(`${label} archive was truncated`);
    }
    if (hash.digest("hex") !== archive.sha256) {
      throw new Error(`${label} archive checksum did not match the pinned manifest`);
    }
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
  }
}

async function extractTarGzipEntry(
  archivePath: string,
  destinationPath: string,
  label: string,
  archive: ToolchainArchive,
  executableSize: number,
): Promise<void> {
  let found = false;
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    if (header.name !== archive.entryPath) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    if (found) {
      extract.destroy(new Error(`${label} archive contains a duplicate executable entry`));
      stream.resume();
      return;
    }
    found = true;
    if (header.type !== "file" || header.size !== executableSize) {
      extract.destroy(new Error(`${label} executable entry did not match the pinned manifest`));
      stream.resume();
      return;
    }
    // `next` is tar-stream's per-entry callback; signalling it once the write
    // settles is how the callback stream and the promise pipeline are bridged.
    void pipeline(stream, createWriteStream(destinationPath, { flags: "wx", mode: 0o500 })).then(
      // oxlint-disable-next-line promise/no-callback-in-promise
      next,
      (error: unknown) =>
        extract.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });

  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  if (!found) throw new Error(`${label} executable was not found in its archive`);
}

async function extractTarGzipBundle(
  archivePath: string,
  destinationDirectory: string,
  label: string,
  archive: ToolchainArchive,
): Promise<void> {
  const root = archive.bundleRoot!;
  const executableRelativePath = archive.entryPath.slice(root.length);
  const installedFiles = new Set([
    executableRelativePath,
    ...(archive.bundleFiles ?? []).map((file) => file.path),
  ]);
  let foundExecutable = false;
  let entryCount = 0;
  let extractedBytes = 0;
  const maxExtractedBytes = Math.max(archive.size * 6, archive.size);
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    if (!header.name.startsWith(root)) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    const relative = header.name.slice(root.length);
    if (!relative) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    const normalized = path.posix.normalize(relative);
    if (
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      path.isAbsolute(normalized)
    ) {
      extract.destroy(new Error(`Unsafe path in ${label} bundle`));
      stream.resume();
      return;
    }
    entryCount += 1;
    extractedBytes += header.size ?? 0;
    if (entryCount > 20_000 || extractedBytes > maxExtractedBytes) {
      extract.destroy(new Error(`${label} bundle exceeded its extraction bounds`));
      stream.resume();
      return;
    }
    const destination = path.join(destinationDirectory, ...normalized.split("/"));
    if (header.type === "directory") {
      stream.once("end", next);
      stream.resume();
      return;
    }
    if (header.type !== "file") {
      extract.destroy(new Error(`${label} bundle contains an unsupported link or entry type`));
      stream.resume();
      return;
    }
    // Small bundles use a per-file allowlist. Runtimes that load code and native
    // modules dynamically retain the complete, archive-pinned tree and verify
    // its aggregate digest on every startup.
    if (!archive.bundleIntegrity && !installedFiles.has(normalized)) {
      stream.once("end", next);
      stream.resume();
      return;
    }
    if (header.name === archive.entryPath) foundExecutable = true;
    void mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      .then(() =>
        pipeline(
          stream,
          createWriteStream(destination, {
            flags: "wx",
            mode: (header.mode ?? 0) & 0o111 ? 0o500 : 0o400,
          }),
        ),
      )
      // As above: `next` is tar-stream's per-entry callback.
      // oxlint-disable-next-line promise/no-callback-in-promise
      .then(next, (error: unknown) =>
        extract.destroy(error instanceof Error ? error : new Error(String(error))),
      );
  });
  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  if (!foundExecutable) throw new Error(`${label} executable was not found in its bundle`);
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { autoClose: true, lazyEntries: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error) reject(error);
        else if (!zipFile) reject(new Error("ZIP archive did not open"));
        else resolve(zipFile);
      },
    );
  });
}

async function extractZipEntry(
  archivePath: string,
  destinationPath: string,
  label: string,
  archive: ToolchainArchive,
  executableSize: number,
): Promise<void> {
  const zipFile = await openZip(archivePath);
  await new Promise<void>((resolve, reject) => {
    let found = false;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    zipFile.on("error", fail);
    zipFile.on("entry", (entry) => {
      const invalidName = yauzl.validateFileName(entry.fileName);
      if (invalidName) {
        fail(new Error(`Unsafe ZIP entry in ${label} archive: ${invalidName}`));
        return;
      }
      if (entry.fileName !== archive.entryPath) {
        zipFile.readEntry();
        return;
      }
      if (found) {
        fail(new Error(`${label} archive contains a duplicate executable entry`));
        return;
      }
      found = true;
      if (entry.fileName.endsWith("/") || entry.uncompressedSize !== executableSize) {
        fail(new Error(`${label} executable entry did not match the pinned manifest`));
        return;
      }
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error(`${label} executable stream was unavailable`));
          return;
        }
        void pipeline(
          stream,
          createWriteStream(destinationPath, { flags: "wx", mode: 0o500 }),
        ).then(() => zipFile.readEntry(), fail);
      });
    });
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      if (found) resolve();
      else reject(new Error(`${label} executable was not found in its archive`));
    });
    zipFile.readEntry();
  });
}

async function probeExecutable(
  executablePath: string,
  artifact: ToolchainArtifact,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(executablePath, ["--version"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${artifact.name} version check timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `${artifact.name} could not execute from the Orkestrator toolchain cache: ${error.message}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `${artifact.name} version check failed (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
          ),
        );
      } else if (!output.includes(artifact.version)) {
        reject(
          new Error(
            `${artifact.name} reported an unexpected version: ${output.trim() || "no output"}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

async function verifyMacCodeSignature(
  executablePath: string,
  label: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", executablePath],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} code-signature check timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(errors).toString("utf8").trim();
      reject(
        new Error(
          `${label} has an invalid macOS code signature (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

async function runCodesign(
  args: string[],
  failureMessage: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${failureMessage} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(errors).toString("utf8").trim();
      reject(
        new Error(
          `${failureMessage} (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

async function repairInvalidMacSignature(
  executablePath: string,
  artifact: ToolchainArtifact,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await runCodesign(
    ["--remove-signature", executablePath],
    `${artifact.name} invalid signature could not be removed`,
    timeoutMs,
    spawnProcess,
  ).catch((error: unknown) => {
    // codesign exits non-zero when no removable signature exists. The following
    // forced signature is still authoritative, so only retain unexpected I/O errors.
    if (error instanceof Error && /code [1-9]/.test(error.message)) return;
    throw error;
  });
  await runCodesign(
    ["--sign", "-", "--force", executablePath],
    `${artifact.name} could not be ad-hoc signed after source verification`,
    timeoutMs,
    spawnProcess,
  );
}

async function prepareRepairableExecutable(
  sourcePath: string,
  executablePath: string,
  artifact: ToolchainArtifact,
  skipExecutableProbeForTests: boolean,
  processTimeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(executablePath),
    `.repair-${artifact.executable.fileName}-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(sourcePath, temporaryPath);
    await chmod(temporaryPath, 0o700);
    if (!skipExecutableProbeForTests) {
      try {
        await verifyMacCodeSignature(temporaryPath, artifact.name, processTimeoutMs, spawnProcess);
      } catch {
        await repairInvalidMacSignature(temporaryPath, artifact, processTimeoutMs, spawnProcess);
        await verifyMacCodeSignature(temporaryPath, artifact.name, processTimeoutMs, spawnProcess);
      }
      await probeExecutable(temporaryPath, artifact, processTimeoutMs, spawnProcess);
    }
    await chmod(temporaryPath, 0o500);
    await rename(temporaryPath, executablePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function refreshRepairableArtifact(
  rootDir: string,
  artifact: ToolchainArtifact,
  skipExecutableProbeForTests: boolean,
  processTimeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  const sourcePath = upstreamExecutablePath(rootDir, artifact);
  if (!(await isValidUpstreamExecutable(rootDir, artifact))) {
    throw new Error(`${artifact.name} trusted upstream executable failed verification`);
  }
  await prepareRepairableExecutable(
    sourcePath,
    artifactExecutablePath(rootDir, artifact),
    artifact,
    skipExecutableProbeForTests,
    processTimeoutMs,
    spawnProcess,
  );
}

/**
 * Downloads, verifies and stages every requested companion into
 * `stagingDirectory`. Nothing is published: the caller decides whether the
 * staged files become visible through a directory rename (a fresh install) or
 * per-file renames into an existing version directory (a companion repair).
 *
 * `startBytes` offsets the progress stream by whatever the caller already
 * downloaded, so a fresh install keeps counting from the primary archive.
 */
async function stageCompanions(
  stagingDirectory: string,
  artifact: ToolchainArtifact,
  companions: readonly ToolchainCompanion[],
  fetchImpl: FetchLike,
  onBytes: (received: number) => void,
  startBytes: number,
  allowInsecureDownloadsForTests: boolean,
  skipExecutableProbeForTests: boolean,
  timings: ToolchainManagerTimings,
  spawnProcess: typeof spawn,
): Promise<void> {
  let downloadedBytes = startBytes;
  for (const companion of companions) {
    const companionArchivePath = path.join(
      stagingDirectory,
      `.archive-${companion.fileName}.${archiveExtension(companion.archive)}`,
    );
    const companionFilePath = path.join(stagingDirectory, companion.fileName);
    const precedingBytes = downloadedBytes;
    await downloadArchive(
      companion.fileName,
      companion.archive,
      companionArchivePath,
      fetchImpl,
      (received) => onBytes(precedingBytes + received),
      allowInsecureDownloadsForTests,
      timings.downloadTimeoutMs,
    );
    downloadedBytes += companion.archive.size;
    if (companion.archive.format === "zip") {
      await extractZipEntry(
        companionArchivePath,
        companionFilePath,
        companion.fileName,
        companion.archive,
        companion.executable.size,
      );
    } else if (companion.archive.format === "tar.gz") {
      await extractTarGzipEntry(
        companionArchivePath,
        companionFilePath,
        companion.fileName,
        companion.archive,
        companion.executable.size,
      );
    } else await rename(companionArchivePath, companionFilePath);
    await rm(companionArchivePath, { force: true });

    const installedCompanion = await lstat(companionFilePath);
    if (!installedCompanion.isFile() || installedCompanion.size !== companion.executable.size) {
      throw new Error(
        `${companion.fileName} extracted executable size did not match the pinned manifest`,
      );
    }
    if ((await sha256File(companionFilePath)) !== companion.executable.sha256) {
      throw new Error(
        `${companion.fileName} executable checksum did not match the pinned manifest`,
      );
    }
    if (!skipExecutableProbeForTests && artifact.platform === "darwin") {
      await verifyMacCodeSignature(
        companionFilePath,
        companion.fileName,
        timings.processTimeoutMs,
        spawnProcess,
      );
    }
    await chmod(companionFilePath, 0o500);
  }
}

/**
 * Adds companions to a version directory whose primary executable is already
 * verified. The archive that executable came from is not downloaded again, and
 * the directory is never removed, so a concurrently running build keeps the
 * exact executable its activation symlink resolves to.
 *
 * Every companion is staged and verified before any of them is published, and
 * each rename is atomic, so a failure part-way leaves whole files behind rather
 * than truncated ones. An interrupted repair simply reports as
 * `companions-missing` again on the next launch.
 */
async function repairArtifactCompanions(
  rootDir: string,
  artifact: ToolchainArtifact,
  companions: readonly ToolchainCompanion[],
  fetchImpl: FetchLike,
  onBytes: (received: number) => void,
  onVerify: () => void,
  allowInsecureDownloadsForTests: boolean,
  skipExecutableProbeForTests: boolean,
  timings: ToolchainManagerTimings,
  spawnProcess: typeof spawn,
): Promise<void> {
  const stagingDirectory = await mkdtemp(path.join(rootDir, `.staging-${artifact.name}-`));
  try {
    await stageCompanions(
      stagingDirectory,
      artifact,
      companions,
      fetchImpl,
      onBytes,
      0,
      allowInsecureDownloadsForTests,
      skipExecutableProbeForTests,
      timings,
      spawnProcess,
    );
    onVerify();
    const destinationDirectory = artifactDirectory(rootDir, artifact);
    for (const companion of companions) {
      await rename(
        path.join(stagingDirectory, companion.fileName),
        path.join(destinationDirectory, companion.fileName),
      );
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function installArtifact(
  rootDir: string,
  artifact: ToolchainArtifact,
  fetchImpl: FetchLike,
  onBytes: (received: number) => void,
  onVerify: () => void,
  allowInsecureDownloadsForTests: boolean,
  skipExecutableProbeForTests: boolean,
  timings: ToolchainManagerTimings,
  spawnProcess: typeof spawn,
): Promise<string> {
  const stagingDirectory = await mkdtemp(path.join(rootDir, `.staging-${artifact.name}-`));
  const archivePath = path.join(stagingDirectory, `archive.${archiveExtension(artifact.archive)}`);
  const executablePath = path.join(stagingDirectory, artifact.executable.fileName);
  const extractedPath = artifact.executable.repairInvalidMacSignature
    ? path.join(stagingDirectory, `.upstream-${artifact.executable.fileName}`)
    : executablePath;
  try {
    await downloadArchive(
      artifact.name,
      artifact.archive,
      archivePath,
      fetchImpl,
      onBytes,
      allowInsecureDownloadsForTests,
      timings.downloadTimeoutMs,
    );
    if (artifact.archive.bundleRoot) {
      await extractTarGzipBundle(archivePath, stagingDirectory, artifact.name, artifact.archive);
      const bundledExecutable = path.join(
        stagingDirectory,
        ...artifact.archive.entryPath.slice(artifact.archive.bundleRoot.length).split("/"),
      );
      if (bundledExecutable !== extractedPath) {
        await rename(bundledExecutable, extractedPath);
      }
    } else if (artifact.archive.format === "zip") {
      await extractZipEntry(
        archivePath,
        extractedPath,
        artifact.name,
        artifact.archive,
        artifact.executable.size,
      );
    } else if (artifact.archive.format === "tar.gz") {
      await extractTarGzipEntry(
        archivePath,
        extractedPath,
        artifact.name,
        artifact.archive,
        artifact.executable.size,
      );
    } else {
      await rename(archivePath, extractedPath);
    }
    if (artifact.archive.format !== "raw") await rm(archivePath, { force: true });
    if (
      artifact.archive.bundleIntegrity &&
      !(await hasValidBundleIntegrity(stagingDirectory, artifact))
    ) {
      throw new Error(`${artifact.name} extracted bundle did not match the pinned manifest`);
    }
    await chmod(extractedPath, 0o700);

    const extracted = await lstat(extractedPath);
    if (!extracted.isFile() || extracted.size !== artifact.executable.size) {
      throw new Error(
        `${artifact.name} extracted executable size did not match the pinned manifest`,
      );
    }
    if ((await sha256File(extractedPath)) !== artifact.executable.sha256) {
      throw new Error(`${artifact.name} executable checksum did not match the pinned manifest`);
    }
    if (artifact.executable.repairInvalidMacSignature) {
      await prepareRepairableExecutable(
        extractedPath,
        executablePath,
        artifact,
        skipExecutableProbeForTests,
        timings.processTimeoutMs,
        spawnProcess,
      );
      await chmod(extractedPath, 0o400);
    } else if (
      !skipExecutableProbeForTests &&
      artifact.platform === "darwin" &&
      !artifact.executable.skipMacSignatureVerification
    ) {
      await verifyMacCodeSignature(
        executablePath,
        artifact.name,
        timings.processTimeoutMs,
        spawnProcess,
      );
    }

    if (!artifact.executable.repairInvalidMacSignature) {
      const installed = await lstat(executablePath);
      const installedState: InstalledExecutableState = {
        size: installed.size,
        sha256: await sha256File(executablePath),
      };
      const pinned = pinnedInstalledState(artifact);
      if (installedState.size !== pinned.size || installedState.sha256 !== pinned.sha256) {
        throw new Error(`${artifact.name} installed executable did not match the pinned manifest`);
      }
    }
    await chmod(executablePath, 0o500);
    if (!skipExecutableProbeForTests && !artifact.executable.repairInvalidMacSignature) {
      await probeExecutable(executablePath, artifact, timings.processTimeoutMs, spawnProcess);
    }

    // Companions land in the same staging directory, so the complete set
    // becomes visible in a single rename. A version directory holding only the
    // primary executable would pass its own validation and never be repaired.
    await stageCompanions(
      stagingDirectory,
      artifact,
      artifactCompanions(artifact),
      fetchImpl,
      onBytes,
      artifact.archive.size,
      allowInsecureDownloadsForTests,
      skipExecutableProbeForTests,
      timings,
      spawnProcess,
    );

    // Every archive — the primary and each companion — has finished
    // downloading by now, so announcing "verifying" here can never be followed
    // by a "downloading" event: the phase only moves forward.
    onVerify();

    const destinationDirectory = artifactDirectory(rootDir, artifact);
    await mkdir(path.dirname(destinationDirectory), { recursive: true, mode: 0o700 });
    await rm(destinationDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, destinationDirectory);
    await chmod(destinationDirectory, 0o700);
    return artifactExecutablePath(rootDir, artifact);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function cleanStagingDirectories(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
      .map((entry) => rm(path.join(rootDir, entry.name), { recursive: true, force: true })),
  );
}

/**
 * Mark a version directory as still in use, so `pruneSupersededVersions` leaves
 * it alone. Best-effort: a failure here only costs disk space.
 */
async function touchArtifactDirectory(rootDir: string, artifact: ToolchainArtifact): Promise<void> {
  const now = new Date();
  await utimes(path.dirname(artifactDirectory(rootDir, artifact)), now, now).catch(() => undefined);
}

type VersionLeaseOwner = {
  token: string;
  pid: number;
  createdAt: string;
};

const processVersionLeases = new Map<string, string>();

function versionLeaseDirectory(rootDir: string, name: ToolchainName, version: string): string {
  return path.join(rootDir, LEASE_DIRECTORY, name, version);
}

async function acquireVersionLease(
  rootDir: string,
  artifact: ToolchainArtifact,
  openLeaseFile: typeof open,
): Promise<void> {
  const leaseKey = `${rootDir}\0${artifact.name}\0${artifact.version}`;
  const existingLeasePath = processVersionLeases.get(leaseKey);
  if (
    existingLeasePath &&
    (await lstat(existingLeasePath).then(
      (entry) => entry.isFile() && !entry.isSymbolicLink(),
      () => false,
    ))
  )
    return;
  processVersionLeases.delete(leaseKey);
  const owner: VersionLeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const directory = versionLeaseDirectory(rootDir, artifact.name, artifact.version);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const leasePath = path.join(directory, `${owner.pid}-${owner.token}.json`);
  const handle = await openLeaseFile(leasePath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(leasePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  processVersionLeases.set(leaseKey, leasePath);
}

async function versionHasLiveLease(
  rootDir: string,
  name: ToolchainName,
  version: string,
  ownerProcessExists: (pid: number) => boolean,
): Promise<boolean> {
  const directory = versionLeaseDirectory(rootDir, name, version);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let live = false;
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const leasePath = path.join(directory, entry.name);
        try {
          const parsed = JSON.parse(
            await readFile(leasePath, "utf8"),
          ) as Partial<VersionLeaseOwner>;
          if (
            typeof parsed.token === "string" &&
            typeof parsed.pid === "number" &&
            typeof parsed.createdAt === "string" &&
            ownerProcessExists(parsed.pid)
          ) {
            live = true;
            return;
          }
        } catch {
          // Malformed leases cannot prove that a process owns this version.
        }
        await rm(leasePath, { force: true }).catch(() => undefined);
      }),
  );
  return live;
}

/**
 * Remove installed versions of the managed tools that are no longer pinned.
 *
 * Only tools named in `artifacts` are considered, and only after their pinned
 * version has been verified and activated, so a failed or partial run never
 * deletes the copy that is still in use.
 *
 * Superseded versions are kept for `retainSupersededMs` after they were last
 * used. Another build of the app can legitimately share this cache while
 * pinning an older version; it refreshes the version directory and publishes a
 * process lease on launch, so neither a recently used nor currently live
 * version is reclaimed.
 *
 * Failures are non-fatal: reclaiming disk space must not be able to break
 * startup.
 */
async function pruneSupersededVersions(
  rootDir: string,
  artifacts: readonly ToolchainArtifact[],
  retainSupersededMs: number,
  ownerProcessExists: (pid: number) => boolean,
  removeVersion: typeof rm,
): Promise<void> {
  const keepByName = new Map<ToolchainName, Set<string>>();
  for (const artifact of artifacts) {
    const versions = keepByName.get(artifact.name) ?? new Set<string>();
    versions.add(artifact.version);
    keepByName.set(artifact.name, versions);
  }

  const staleBefore = Date.now() - retainSupersededMs;
  await Promise.all(
    Array.from(keepByName, async ([name, keep]) => {
      const toolDir = path.join(rootDir, name);
      try {
        const entries = await readdir(toolDir, { withFileTypes: true });
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
            .map(async (entry) => {
              const versionDir = path.join(toolDir, entry.name);
              try {
                if ((await stat(versionDir)).mtimeMs > staleBefore) return;
                if (await versionHasLiveLease(rootDir, name, entry.name, ownerProcessExists))
                  return;
                // Re-check after async lease cleanup so a version is never deleted
                // after a cooperative process has established ownership.
                if (await versionHasLiveLease(rootDir, name, entry.name, ownerProcessExists))
                  return;
                await removeVersion(versionDir, { recursive: true, force: true });
              } catch {
                // Raced with another instance, or not readable. Try again next launch.
              }
            }),
        );
      } catch {
        // Nothing installed for this tool yet, or the directory is unreadable.
      }
    }),
  );
}

function activationSetId(artifacts: readonly ToolchainArtifact[]): string {
  const identity = artifacts
    .map((artifact) => ({
      name: artifact.name,
      version: artifact.version,
      platform: artifact.platform,
      architecture: artifact.architecture,
      executableSize: artifact.executable.size,
      executableSha256: artifact.executable.sha256,
      installedSize: artifact.executable.installedSize,
      installedSha256: artifact.executable.installedSha256,
      repairInvalidMacSignature: artifact.executable.repairInvalidMacSignature ?? false,
      activationAliases: artifact.activationAliases ?? [],
      bundleFiles: artifact.archive.bundleFiles ?? [],
      bundleIntegrity: artifact.archive.bundleIntegrity ?? null,
      // Aliases and companions are part of the activated set: adding or
      // changing one has to produce a new bin directory, so a running older
      // build keeps the exact sibling layout it was launched against.
      companions: artifactCompanions(artifact).map((companion) => ({
        fileName: companion.fileName,
        size: companion.executable.size,
        sha256: companion.executable.sha256,
      })),
    }))
    .sort((left, right) => {
      const leftKey = `${left.name}\0${left.platform}\0${left.architecture}`;
      const rightKey = `${right.name}\0${right.platform}\0${right.architecture}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function activateExecutables(
  rootDir: string,
  artifacts: readonly ToolchainArtifact[],
): Promise<PinnedToolchainResult> {
  // Each pinned artifact set receives its own stable activation directory.
  // Running app builds retain this exact path, so a newer build can activate a
  // different set without redirecting commands launched by the older backend.
  const binRoot = path.join(rootDir, "bin");
  const binDir = path.join(binRoot, activationSetId(artifacts));
  await mkdir(binRoot, { recursive: true, mode: 0o700 });
  const binRootEntry = await lstat(binRoot);
  if (!binRootEntry.isDirectory() || binRootEntry.isSymbolicLink()) {
    throw new Error(`Refusing unsafe toolchain activation root: ${binRoot}`);
  }
  await chmod(binRoot, 0o700);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const binEntry = await lstat(binDir);
  if (!binEntry.isDirectory() || binEntry.isSymbolicLink()) {
    throw new Error(`Refusing unsafe toolchain activation directory: ${binDir}`);
  }
  await chmod(binDir, 0o700);
  const executables = {} as Record<ToolchainName, string>;

  const activate = async (linkName: string, target: string): Promise<string> => {
    const activePath = path.join(binDir, linkName);
    const temporaryLink = path.join(binDir, `.${linkName}-${randomUUID()}.tmp`);
    const existingTarget = await readlink(activePath).catch(() => null);
    if (existingTarget !== target) {
      await symlink(target, temporaryLink, "file");
      try {
        await rename(temporaryLink, activePath);
      } catch {
        try {
          const active = await lstat(activePath).catch(() => null);
          if (active?.isDirectory()) {
            throw new Error(`Refusing to replace toolchain activation directory: ${activePath}`);
          }
          await rm(activePath, { force: true });
          await rename(temporaryLink, activePath);
        } catch (error) {
          await rm(temporaryLink, { force: true }).catch(() => undefined);
          throw error;
        }
      }
    }
    return activePath;
  };

  for (const artifact of artifacts) {
    const executablePath = artifactExecutablePath(rootDir, artifact);
    executables[artifact.name] = await activate(artifact.name, executablePath);
    for (const alias of artifact.activationAliases ?? []) {
      await activate(alias, executablePath);
    }
    // Codex resolves `codex-code-mode-host` from the directory it was launched
    // from, which is this activation directory rather than the version
    // directory the symlink points into.
    for (const companion of artifactCompanions(artifact)) {
      await activate(companion.fileName, companionPath(rootDir, artifact, companion));
    }
  }

  return { rootDir, binDir, executables };
}

export async function ensurePinnedToolchains(
  options: EnsurePinnedToolchainsOptions,
): Promise<PinnedToolchainResult> {
  const artifacts =
    options.artifacts ?? pinnedToolchainArtifacts(options.platform, options.architecture);
  for (const artifact of artifacts) assertValidArtifactMetadata(artifact);
  assertUniqueActivationNames(artifacts);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const onProgress = options.onProgress ?? (() => undefined);
  const timings = { ...DEFAULT_TIMINGS, ...options.timingsForTests };
  const spawnProcess = options.spawnForTests ?? spawn;
  const ownerProcessExists =
    options.processExistsForTests ??
    ((pid: number) => processExists(pid, options.processKillForTests));
  const rootDir = path.join(options.dataDir, TOOLCHAIN_DIRECTORY);
  const totalTools = artifacts.length;
  const toolFractions = new Map<ToolchainName, number>(
    artifacts.map((artifact) => [artifact.name, 0]),
  );
  const progress = (value: Omit<ToolchainProgress, "totalTools" | "overallFraction">) => {
    const overallFraction =
      totalTools === 0
        ? 1
        : Array.from(toolFractions.values()).reduce((sum, fraction) => sum + fraction, 0) /
          totalTools;
    onProgress({ ...value, totalTools, overallFraction });
  };

  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  progress({
    phase: "checking",
    completedTools: 0,
    message: "Checking pinned Orkestrator tools…",
  });

  const installLock = await acquireInstallLock(
    rootDir,
    (message) =>
      progress({
        phase: "waiting",
        completedTools: 0,
        message,
      }),
    timings,
    options.openLockFileForTests ?? open,
    ownerProcessExists,
  );
  try {
    // Validation, installation, activation, lease publication, and pruning are
    // one cache-wide transaction. Cached callers also take the lock so pruning
    // in another app window cannot remove a version between its validation and
    // activation.
    await cleanStagingDirectories(rootDir);
    const statuses = await Promise.all(
      artifacts.map((artifact) => installationStatus(rootDir, artifact)),
    );
    artifacts.forEach((artifact, index) =>
      toolFractions.set(artifact.name, statuses[index]!.state === "valid" ? 1 : 0),
    );
    const pending = artifacts
      .map((artifact, index) => ({ artifact, status: statuses[index]! }))
      .filter((entry) => entry.status.state !== "valid");
    let completedTools = totalTools - pending.length;

    const installations = await Promise.allSettled(
      pending.map(async ({ artifact, status }) => {
        // A cache that predates a companion has a verified primary executable on
        // disk already. Repairing only what is missing keeps the download to the
        // companion itself and leaves the version directory — which a running
        // older build may have activated — in place.
        const companions = status.state === "companions-missing" ? status.companions : [];
        const repairable = status.state === "companions-missing";
        const bytesTotal = repairable
          ? companions.reduce((total, companion) => total + companion.archive.size, 0)
          : artifactArchiveBytes(artifact);
        progress({
          phase: "downloading",
          tool: artifact.name,
          completedTools,
          bytesReceived: 0,
          bytesTotal,
          message: `Downloading ${artifact.name} ${artifact.version}…`,
        });
        let lastReportedAt = 0;
        const onBytes = (bytesReceived: number) => {
          toolFractions.set(artifact.name, bytesReceived / bytesTotal);
          const now = Date.now();
          if (now - lastReportedAt < 200 && bytesReceived !== bytesTotal) return;
          lastReportedAt = now;
          progress({
            phase: "downloading",
            tool: artifact.name,
            completedTools,
            bytesReceived,
            bytesTotal,
            message: `Downloading ${artifact.name} ${artifact.version}…`,
          });
        };
        const onVerify = () => {
          // Every byte — the primary archive and then each companion — has
          // already been reported through onBytes, so the fraction is where it
          // should be and only the phase moves on. `installArtifact` fires this
          // after its companion staging, and the repair path fires it after
          // staging too, so "downloading" never follows "verifying".
          progress({
            phase: "verifying",
            tool: artifact.name,
            completedTools,
            message: `Verifying ${artifact.name} ${artifact.version}…`,
          });
        };
        if (repairable) {
          await repairArtifactCompanions(
            rootDir,
            artifact,
            companions,
            fetchImpl,
            onBytes,
            onVerify,
            options.allowInsecureDownloadsForTests ?? false,
            options.skipExecutableProbeForTests ?? false,
            timings,
            spawnProcess,
          );
        } else {
          await installArtifact(
            rootDir,
            artifact,
            fetchImpl,
            onBytes,
            onVerify,
            options.allowInsecureDownloadsForTests ?? false,
            options.skipExecutableProbeForTests ?? false,
            timings,
            spawnProcess,
          );
        }
        toolFractions.set(artifact.name, 1);
        completedTools += 1;
        progress({
          phase: "installing",
          tool: artifact.name,
          completedTools,
          message: `Installed ${artifact.name} ${artifact.version}`,
        });
      }),
    );
    const failedInstallation = installations.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedInstallation) throw failedInstallation.reason;

    // Never trust a mutable digest next to a locally re-signed executable.
    // Recreate those runnable bytes from the manifest-pinned pristine copy.
    await Promise.all(
      artifacts
        .filter((artifact) => artifact.executable.repairInvalidMacSignature)
        .map((artifact) =>
          refreshRepairableArtifact(
            rootDir,
            artifact,
            options.skipExecutableProbeForTests ?? false,
            timings.processTimeoutMs,
            spawnProcess,
          ),
        ),
    );

    await options.beforeFinalVerificationForTests?.();
    const finalValidity = await Promise.all(
      artifacts.map(async (artifact) => {
        if (!(await isValidInstallation(rootDir, artifact))) return false;
        const executable = await lstat(artifactExecutablePath(rootDir, artifact)).catch(() => null);
        return executable?.isFile() === true && !executable.isSymbolicLink();
      }),
    );
    if (finalValidity.some((valid) => !valid)) {
      throw new Error("One or more pinned Orkestrator tools failed final verification");
    }
    const result = await activateExecutables(rootDir, artifacts);
    await Promise.all(artifacts.map((artifact) => touchArtifactDirectory(rootDir, artifact)));
    if (!options.skipVersionLeaseForTests) {
      await Promise.all(
        artifacts.map((artifact) =>
          acquireVersionLease(rootDir, artifact, options.openLeaseFileForTests ?? open),
        ),
      );
    }
    await pruneSupersededVersions(
      rootDir,
      artifacts,
      timings.retainSupersededMs,
      ownerProcessExists,
      options.removeSupersededVersionForTests ?? rm,
    );
    artifacts.forEach((artifact) => toolFractions.set(artifact.name, 1));
    progress({
      phase: "ready",
      completedTools: totalTools,
      message: "Pinned Orkestrator tools are ready",
    });
    return result;
  } finally {
    await installLock.release();
  }
}
