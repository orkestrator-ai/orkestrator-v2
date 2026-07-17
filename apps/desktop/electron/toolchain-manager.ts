import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
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
const LOCK_STALE_AFTER_MS = 10 * 60 * 1_000;
const LOCK_WAIT_TIMEOUT_MS = 12 * 60 * 1_000;
const LOCK_POLL_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const PROCESS_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
};

const DEFAULT_TIMINGS: ToolchainManagerTimings = {
  lockStaleAfterMs: LOCK_STALE_AFTER_MS,
  lockWaitTimeoutMs: LOCK_WAIT_TIMEOUT_MS,
  lockPollMs: LOCK_POLL_MS,
  downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
  processTimeoutMs: PROCESS_TIMEOUT_MS,
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
  processExistsForTests?: (pid: number) => boolean;
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

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isValidExecutable(rootDir: string, artifact: ToolchainArtifact): Promise<boolean> {
  const executablePath = artifactExecutablePath(rootDir, artifact);
  try {
    const file = await lstat(executablePath);
    const expectedSize = artifact.executable.installedSize ?? artifact.executable.size;
    const expectedSha256 = artifact.executable.installedSha256 ?? artifact.executable.sha256;
    if (!file.isFile() || file.isSymbolicLink() || file.size !== expectedSize) return false;
    if (await sha256File(executablePath) !== expectedSha256) return false;
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], {
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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", executablePath], {
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

async function runCodesign(args: string[], failureMessage: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
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
): Promise<void> {
  await runCodesign(
    ["--remove-signature", executablePath],
    `${artifact.name} invalid signature could not be removed`,
    timeoutMs,
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
): Promise<string> {
  const stagingDirectory = await mkdtemp(path.join(rootDir, `.staging-${artifact.name}-`));
  const archivePath = path.join(stagingDirectory, `archive.${artifact.archive.format === "zip" ? "zip" : "tar.gz"}`);
  const executablePath = path.join(stagingDirectory, artifact.executable.fileName);
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
      await extractZipEntry(archivePath, executablePath, artifact);
    } else {
      await extractTarGzipEntry(archivePath, executablePath, artifact);
    }
    await rm(archivePath, { force: true });
    await chmod(executablePath, 0o700);

    const extracted = await lstat(executablePath);
    if (!extracted.isFile() || extracted.size !== artifact.executable.size) {
      throw new Error(`${artifact.name} extracted executable size did not match the pinned manifest`);
    }
    if (await sha256File(executablePath) !== artifact.executable.sha256) {
      throw new Error(`${artifact.name} executable checksum did not match the pinned manifest`);
    }
    if (!skipExecutableProbeForTests && artifact.platform === "darwin") {
      try {
        await verifyMacCodeSignature(executablePath, artifact, timings.processTimeoutMs);
      } catch (error) {
        if (!artifact.executable.repairInvalidMacSignature) throw error;
        await repairInvalidMacSignature(executablePath, artifact, timings.processTimeoutMs);
        await verifyMacCodeSignature(executablePath, artifact, timings.processTimeoutMs);
      }
    }

    const installed = await lstat(executablePath);
    const expectedInstalledSize = artifact.executable.installedSize ?? artifact.executable.size;
    const expectedInstalledSha256 = artifact.executable.installedSha256 ?? artifact.executable.sha256;
    if (installed.size !== expectedInstalledSize || await sha256File(executablePath) !== expectedInstalledSha256) {
      throw new Error(`${artifact.name} installed executable did not match the pinned manifest`);
    }
    await chmod(executablePath, 0o500);
    if (!skipExecutableProbeForTests) {
      await probeExecutable(executablePath, artifact, timings.processTimeoutMs);
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

async function activateExecutables(
  rootDir: string,
  artifacts: readonly ToolchainArtifact[],
): Promise<PinnedToolchainResult> {
  const binDir = path.join(rootDir, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  const executables = {} as Record<ToolchainName, string>;

  for (const artifact of artifacts) {
    const target = artifactExecutablePath(rootDir, artifact);
    const activePath = path.join(binDir, artifact.name);
    const temporaryLink = path.join(binDir, `.${artifact.name}-${randomUUID()}.tmp`);
    const existingTarget = await readlink(activePath).catch(() => null);
    if (existingTarget !== target) {
      await symlink(target, temporaryLink, "file");
      await rename(temporaryLink, activePath).catch(async (error) => {
        await rm(activePath, { force: true });
        await rename(temporaryLink, activePath).catch(async () => {
          await rm(temporaryLink, { force: true });
          throw error;
        });
      });
    }
    executables[artifact.name] = activePath;
  }

  return { rootDir, binDir, executables };
}

export async function ensurePinnedToolchains(
  options: EnsurePinnedToolchainsOptions,
): Promise<PinnedToolchainResult> {
  const artifacts = options.artifacts ?? pinnedToolchainArtifacts(options.platform, options.architecture);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const onProgress = options.onProgress ?? (() => undefined);
  const timings = { ...DEFAULT_TIMINGS, ...options.timingsForTests };
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

  const validity = await Promise.all(artifacts.map((artifact) => isValidExecutable(rootDir, artifact)));
  artifacts.forEach((artifact, index) => toolFractions.set(artifact.name, validity[index] ? 1 : 0));
  let missing = artifacts.filter((_, index) => !validity[index]);
  if (missing.length > 0) {
    const installLock = await acquireInstallLock(rootDir, (message) => progress({
      phase: "waiting",
      completedTools: totalTools - missing.length,
      message,
    }), timings, options.openLockFileForTests ?? open, options.processExistsForTests ?? processExists);
    try {
      await cleanStagingDirectories(rootDir);
      const lockedValidity = await Promise.all(artifacts.map((artifact) => isValidExecutable(rootDir, artifact)));
      artifacts.forEach((artifact, index) => toolFractions.set(artifact.name, lockedValidity[index] ? 1 : 0));
      missing = artifacts.filter((_, index) => !lockedValidity[index]);
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
    } finally {
      await installLock.release();
    }
  }

  const finalValidity = await Promise.all(artifacts.map((artifact) => isValidExecutable(rootDir, artifact)));
  if (finalValidity.some((valid) => !valid)) {
    throw new Error("One or more pinned Orkestrator tools failed final verification");
  }
  const result = await activateExecutables(rootDir, artifacts);
  artifacts.forEach((artifact) => toolFractions.set(artifact.name, 1));
  progress({
    phase: "ready",
    completedTools: totalTools,
    message: "Pinned Orkestrator tools are ready",
  });
  return result;
}
