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
  type ToolchainArtifact,
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

function artifactExecutablePath(rootDir: string, artifact: ToolchainArtifact): string {
  return path.join(artifactDirectory(rootDir, artifact), artifact.executable.fileName);
}

function upstreamExecutablePath(rootDir: string, artifact: ToolchainArtifact): string {
  return path.join(artifactDirectory(rootDir, artifact), `.upstream-${artifact.executable.fileName}`);
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
  if (artifact.archive.format !== "zip" && artifact.archive.format !== "tar.gz") {
    throw new Error(`${artifact.name} manifest has unsupported archive format`);
  }
  const hasSize = artifact.executable.installedSize !== undefined;
  const hasSha256 = artifact.executable.installedSha256 !== undefined;
  if (hasSize !== hasSha256) {
    throw new Error(
      `${artifact.name} manifest must provide installedSize and installedSha256 together`,
    );
  }
  if (hasSize && (
    !Number.isSafeInteger(artifact.executable.installedSize)
    || artifact.executable.installedSize! <= 0
    || !/^[a-f0-9]{64}$/.test(artifact.executable.installedSha256!)
  )) {
    throw new Error(`${artifact.name} manifest has invalid installed executable metadata`);
  }
  if (artifact.executable.repairInvalidMacSignature && hasSize) {
    throw new Error(
      `${artifact.name} manifest cannot pin locally repaired executable bytes`,
    );
  }
}

function pinnedInstalledState(artifact: ToolchainArtifact): InstalledExecutableState {
  const { size, sha256, installedSize, installedSha256, repairInvalidMacSignature } = artifact.executable;
  if (installedSize !== undefined && installedSha256 !== undefined) {
    return { size: installedSize, sha256: installedSha256 };
  }
  if (repairInvalidMacSignature) {
    throw new Error(`${artifact.name} locally repaired executable has no reproducible pinned state`);
  }
  return { size, sha256 };
}

async function isValidFile(filePath: string, expected: InstalledExecutableState): Promise<boolean> {
  try {
    const file = await lstat(filePath);
    return file.isFile()
      && !file.isSymbolicLink()
      && file.size === expected.size
      && await sha256File(filePath) === expected.sha256;
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
    if (await sha256File(executablePath) !== expected.sha256) return false;
    if ((file.mode & 0o777) !== 0o500) await chmod(executablePath, 0o500);
    return true;
  } catch {
    return false;
  }
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
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
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
        heartbeat = heartbeat.then(async () => {
          const current = await readInstallLockOwner(lockPath);
          if (current?.token !== owner.token) return;
          const now = new Date();
          await utimes(lockPath, now, now);
        }).catch(() => undefined);
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
            throw new Error("Orkestrator toolchain installation lock ownership changed unexpectedly");
          }
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > timings.lockStaleAfterMs) {
      const observedOwner = await readInstallLockOwner(lockPath);
      const ownerIsAlive = observedOwner ? ownerProcessExists(observedOwner.pid) : false;
      if (!ownerIsAlive) {
        const currentOwner = await readInstallLockOwner(lockPath);
        if (currentOwner?.token === observedOwner?.token || (!currentOwner && !observedOwner)) {
          await rm(lockPath, { force: true });
          continue;
        }
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
  artifact: ToolchainArtifact,
  response: Response,
  allowInsecureDownloadsForTests: boolean,
): void {
  const requested = new URL(artifact.archive.url);
  const resolved = new URL(response.url || artifact.archive.url);
  if (!allowInsecureDownloadsForTests && (requested.protocol !== "https:" || resolved.protocol !== "https:")) {
    throw new Error(`${artifact.name} download did not use HTTPS`);
  }
  if (!artifact.archive.allowedHosts.includes(requested.hostname)) {
    throw new Error(`${artifact.name} download host is not allowlisted: ${requested.hostname}`);
  }
  if (!artifact.archive.allowedHosts.includes(resolved.hostname)) {
    throw new Error(`${artifact.name} redirected to an untrusted host: ${resolved.hostname}`);
  }
}

async function downloadArchive(
  artifact: ToolchainArtifact,
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
    const response = await fetchImpl(artifact.archive.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "OrkestratorV2 toolchain installer" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`${artifact.name} download failed with HTTP ${response.status}`);
    }
    assertDownloadLocation(artifact, response, allowInsecureDownloadsForTests);

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== artifact.archive.size) {
      throw new Error(
        `${artifact.name} archive size header did not match the pinned manifest`,
      );
    }

    handle = await open(archivePath, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > artifact.archive.size) {
        throw new Error(`${artifact.name} archive exceeded its pinned size`);
      }
      hash.update(value);
      await handle.writeFile(value);
      onBytes(received);
    }
    await handle.close();
    handle = null;

    if (received !== artifact.archive.size) {
      throw new Error(`${artifact.name} archive was truncated`);
    }
    if (hash.digest("hex") !== artifact.archive.sha256) {
      throw new Error(`${artifact.name} archive checksum did not match the pinned manifest`);
    }
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
  }
}

async function extractTarGzipEntry(
  archivePath: string,
  destinationPath: string,
  artifact: ToolchainArtifact,
): Promise<void> {
  let found = false;
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    if (header.name !== artifact.archive.entryPath) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    if (found) {
      extract.destroy(new Error(`${artifact.name} archive contains a duplicate executable entry`));
      stream.resume();
      return;
    }
    found = true;
    if (header.type !== "file" || header.size !== artifact.executable.size) {
      extract.destroy(new Error(`${artifact.name} executable entry did not match the pinned manifest`));
      stream.resume();
      return;
    }
    void pipeline(
      stream,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o500 }),
    ).then(next, (error: unknown) => extract.destroy(error instanceof Error ? error : new Error(String(error))));
  });

  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  if (!found) throw new Error(`${artifact.name} executable was not found in its archive`);
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
  artifact: ToolchainArtifact,
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
        fail(new Error(`Unsafe ZIP entry in ${artifact.name} archive: ${invalidName}`));
        return;
      }
      if (entry.fileName !== artifact.archive.entryPath) {
        zipFile.readEntry();
        return;
      }
      if (found) {
        fail(new Error(`${artifact.name} archive contains a duplicate executable entry`));
        return;
      }
      found = true;
      if (entry.fileName.endsWith("/") || entry.uncompressedSize !== artifact.executable.size) {
        fail(new Error(`${artifact.name} executable entry did not match the pinned manifest`));
        return;
      }
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error(`${artifact.name} executable stream was unavailable`));
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
      else reject(new Error(`${artifact.name} executable was not found in its archive`));
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
      reject(new Error(
        `${artifact.name} could not execute from the Orkestrator toolchain cache: ${error.message}`,
      ));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${artifact.name} version check failed (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
      } else if (!output.includes(artifact.version)) {
        reject(new Error(`${artifact.name} reported an unexpected version: ${output.trim() || "no output"}`));
      } else {
        resolve();
      }
    });
  });
}

async function verifyMacCodeSignature(
  executablePath: string,
  artifact: ToolchainArtifact,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", executablePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${artifact.name} code-signature check timed out`));
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
      reject(new Error(
        `${artifact.name} has an invalid macOS code signature (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
      ));
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
      reject(new Error(
        `${failureMessage} (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
      ));
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
        await verifyMacCodeSignature(temporaryPath, artifact, processTimeoutMs, spawnProcess);
      } catch {
        await repairInvalidMacSignature(temporaryPath, artifact, processTimeoutMs, spawnProcess);
        await verifyMacCodeSignature(temporaryPath, artifact, processTimeoutMs, spawnProcess);
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
  if (!await isValidUpstreamExecutable(rootDir, artifact)) {
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
  const archivePath = path.join(stagingDirectory, `archive.${artifact.archive.format === "zip" ? "zip" : "tar.gz"}`);
  const executablePath = path.join(stagingDirectory, artifact.executable.fileName);
  const extractedPath = artifact.executable.repairInvalidMacSignature
    ? path.join(stagingDirectory, `.upstream-${artifact.executable.fileName}`)
    : executablePath;
  try {
    await downloadArchive(
      artifact,
      archivePath,
      fetchImpl,
      onBytes,
      allowInsecureDownloadsForTests,
      timings.downloadTimeoutMs,
    );
    onVerify();
    if (artifact.archive.format === "zip") {
      await extractZipEntry(archivePath, extractedPath, artifact);
    } else {
      await extractTarGzipEntry(archivePath, extractedPath, artifact);
    }
    await rm(archivePath, { force: true });
    await chmod(extractedPath, 0o700);

    const extracted = await lstat(extractedPath);
    if (!extracted.isFile() || extracted.size !== artifact.executable.size) {
      throw new Error(`${artifact.name} extracted executable size did not match the pinned manifest`);
    }
    if (await sha256File(extractedPath) !== artifact.executable.sha256) {
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
    } else if (!skipExecutableProbeForTests && artifact.platform === "darwin") {
      try {
        await verifyMacCodeSignature(executablePath, artifact, timings.processTimeoutMs, spawnProcess);
      } catch (error) {
        throw error;
      }
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
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
    .map((entry) => rm(path.join(rootDir, entry.name), { recursive: true, force: true })));
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
  if (existingLeasePath && await lstat(existingLeasePath).then(
    (entry) => entry.isFile() && !entry.isSymbolicLink(),
    () => false,
  )) return;
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
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const leasePath = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(await readFile(leasePath, "utf8")) as Partial<VersionLeaseOwner>;
      if (
        typeof parsed.token === "string"
        && typeof parsed.pid === "number"
        && typeof parsed.createdAt === "string"
        && ownerProcessExists(parsed.pid)
      ) {
        live = true;
        return;
      }
    } catch {
      // Malformed leases cannot prove that a process owns this version.
    }
    await rm(leasePath, { force: true }).catch(() => undefined);
  }));
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
  await Promise.all(Array.from(keepByName, async ([name, keep]) => {
    const toolDir = path.join(rootDir, name);
    try {
      const entries = await readdir(toolDir, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
        .map(async (entry) => {
          const versionDir = path.join(toolDir, entry.name);
          try {
            if ((await stat(versionDir)).mtimeMs > staleBefore) return;
            if (await versionHasLiveLease(rootDir, name, entry.name, ownerProcessExists)) return;
            // Re-check after async lease cleanup so a version is never deleted
            // after a cooperative process has established ownership.
            if (await versionHasLiveLease(rootDir, name, entry.name, ownerProcessExists)) return;
            await removeVersion(versionDir, { recursive: true, force: true });
          } catch {
            // Raced with another instance, or not readable. Try again next launch.
          }
        }));
    } catch {
      // Nothing installed for this tool yet, or the directory is unreadable.
    }
  }));
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

  for (const artifact of artifacts) {
    const target = artifactExecutablePath(rootDir, artifact);
    const activePath = path.join(binDir, artifact.name);
    const temporaryLink = path.join(binDir, `.${artifact.name}-${randomUUID()}.tmp`);
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
    executables[artifact.name] = activePath;
  }

  return { rootDir, binDir, executables };
}

export async function ensurePinnedToolchains(
  options: EnsurePinnedToolchainsOptions,
): Promise<PinnedToolchainResult> {
  const artifacts = options.artifacts ?? pinnedToolchainArtifacts(options.platform, options.architecture);
  for (const artifact of artifacts) assertValidArtifactMetadata(artifact);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const onProgress = options.onProgress ?? (() => undefined);
  const timings = { ...DEFAULT_TIMINGS, ...options.timingsForTests };
  const spawnProcess = options.spawnForTests ?? spawn;
  const ownerProcessExists = options.processExistsForTests
    ?? ((pid: number) => processExists(pid, options.processKillForTests));
  const rootDir = path.join(options.dataDir, TOOLCHAIN_DIRECTORY);
  const totalTools = artifacts.length;
  const toolFractions = new Map<ToolchainName, number>(
    artifacts.map((artifact) => [artifact.name, 0]),
  );
  const progress = (value: Omit<ToolchainProgress, "totalTools" | "overallFraction">) => {
    const overallFraction = totalTools === 0
      ? 1
      : Array.from(toolFractions.values()).reduce((sum, fraction) => sum + fraction, 0) / totalTools;
    onProgress({ ...value, totalTools, overallFraction });
  };

  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  await chmod(rootDir, 0o700);
  progress({
    phase: "checking",
    completedTools: 0,
    message: "Checking pinned Orkestrator tools…",
  });

  const installLock = await acquireInstallLock(rootDir, (message) => progress({
    phase: "waiting",
    completedTools: 0,
    message,
  }), timings, options.openLockFileForTests ?? open, ownerProcessExists);
  try {
    // Validation, installation, activation, lease publication, and pruning are
    // one cache-wide transaction. Cached callers also take the lock so pruning
    // in another app window cannot remove a version between its validation and
    // activation.
    await cleanStagingDirectories(rootDir);
    const validity = await Promise.all(artifacts.map((artifact) => isValidExecutable(rootDir, artifact)));
    artifacts.forEach((artifact, index) => toolFractions.set(artifact.name, validity[index] ? 1 : 0));
    const missing = artifacts.filter((_, index) => !validity[index]);
    let completedTools = totalTools - missing.length;

    const installations = await Promise.allSettled(missing.map(async (artifact) => {
      progress({
        phase: "downloading",
        tool: artifact.name,
        completedTools,
        bytesReceived: 0,
        bytesTotal: artifact.archive.size,
        message: `Downloading ${artifact.name} ${artifact.version}…`,
      });
      let lastReportedAt = 0;
      await installArtifact(
        rootDir,
        artifact,
        fetchImpl,
        (bytesReceived) => {
          toolFractions.set(artifact.name, bytesReceived / artifact.archive.size);
          const now = Date.now();
          if (now - lastReportedAt < 200 && bytesReceived !== artifact.archive.size) return;
          lastReportedAt = now;
          progress({
            phase: "downloading",
            tool: artifact.name,
            completedTools,
            bytesReceived,
            bytesTotal: artifact.archive.size,
            message: `Downloading ${artifact.name} ${artifact.version}…`,
          });
        },
        () => {
          toolFractions.set(artifact.name, 1);
          progress({
            phase: "verifying",
            tool: artifact.name,
            completedTools,
            message: `Verifying ${artifact.name} ${artifact.version}…`,
          });
        },
        options.allowInsecureDownloadsForTests ?? false,
        options.skipExecutableProbeForTests ?? false,
        timings,
        spawnProcess,
      );
      toolFractions.set(artifact.name, 1);
      completedTools += 1;
      progress({
        phase: "installing",
        tool: artifact.name,
        completedTools,
        message: `Installed ${artifact.name} ${artifact.version}`,
      });
    }));
    const failedInstallation = installations.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedInstallation) throw failedInstallation.reason;

    // Never trust a mutable digest next to a locally re-signed executable.
    // Recreate those runnable bytes from the manifest-pinned pristine copy.
    await Promise.all(artifacts
      .filter((artifact) => artifact.executable.repairInvalidMacSignature)
      .map((artifact) => refreshRepairableArtifact(
        rootDir,
        artifact,
        options.skipExecutableProbeForTests ?? false,
        timings.processTimeoutMs,
        spawnProcess,
      )));

    await options.beforeFinalVerificationForTests?.();
    const finalValidity = await Promise.all(artifacts.map(async (artifact) => {
      if (!await isValidExecutable(rootDir, artifact)) return false;
      const executable = await lstat(artifactExecutablePath(rootDir, artifact)).catch(() => null);
      return executable?.isFile() === true && !executable.isSymbolicLink();
    }));
    if (finalValidity.some((valid) => !valid)) {
      throw new Error("One or more pinned Orkestrator tools failed final verification");
    }
    const result = await activateExecutables(rootDir, artifacts);
    await Promise.all(artifacts.map((artifact) => touchArtifactDirectory(rootDir, artifact)));
    if (!options.skipVersionLeaseForTests) {
      await Promise.all(artifacts.map((artifact) => acquireVersionLease(
        rootDir,
        artifact,
        options.openLeaseFileForTests ?? open,
      )));
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
