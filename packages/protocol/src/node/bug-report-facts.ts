/**
 * The non-secret description of a host a bug report diagnoses.
 *
 * Shared by `orkestrator --fix` and the backend's bug-report service. Reads
 * file names, sizes, times and a few fields of the backend descriptor; never
 * file contents, credentials or settings beyond whether debug logging is on.
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BugReportMachineFacts } from "../bug-report.js";
import { isHostVersion } from "../host-maintenance.js";
import { readApplicationLogSettings } from "./application-logging.js";

const MAX_LISTED_LOGS = 8;

async function recentLogFiles(logsDir: string): Promise<BugReportMachineFacts["recentLogs"]> {
  const names = await readdir(logsDir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map(async (name) => {
        const info = await stat(path.join(logsDir, name)).catch(() => null);
        return info?.isFile() ? { name, bytes: info.size, modifiedMs: info.mtimeMs } : null;
      }),
  );
  return files
    .filter((file) => file !== null)
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .slice(0, MAX_LISTED_LOGS)
    .map((file) => ({
      name: file.name,
      bytes: file.bytes,
      modified: new Date(file.modifiedMs).toISOString(),
    }));
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The non-secret fields of the running backend's instance descriptor. */
export function bugReportBackendInstance(dataDir: string): BugReportMachineFacts["backend"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(dataDir, "backend-instance.json"), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === "number" ? record.pid : undefined;
  return {
    ...(typeof record.appVersion === "string" ? { appVersion: record.appVersion } : {}),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(pid !== undefined ? { pid } : {}),
    running: pid !== undefined && processRunning(pid),
  };
}

async function managedGhBinary(toolchainBinDir: string, toolchainRoot: string) {
  const activated = path.join(toolchainBinDir, "gh");
  if (existsSync(activated)) return activated;
  const latestRoot = path.join(toolchainRoot, "gh-latest");
  const latestVersions = await readdir(latestRoot).catch(() => [] as string[]);
  for (const version of latestVersions
    .filter(isHostVersion)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))) {
    const candidate = path.join(latestRoot, version, "gh");
    if (existsSync(candidate)) return candidate;
  }
  const root = path.join(toolchainRoot, "gh");
  const versions = await readdir(root).catch(() => [] as string[]);
  for (const version of versions.sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  )) {
    const platforms = await readdir(path.join(root, version)).catch(() => [] as string[]);
    for (const platform of platforms) {
      const candidate = path.join(root, version, platform, "gh");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function desktopAppPath(home: string): string | null {
  if (process.platform !== "darwin") return null;
  for (const candidate of [
    "/Applications/OrkestratorV2.app",
    path.join(home, "Applications", "OrkestratorV2.app"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The toolchain layout is passed in rather than imported: the toolchain
 * package depends on this one.
 */
export async function collectBugReportMachineFacts(options: {
  dataDir: string;
  toolchainBinDir: string;
  toolchainRoot: string;
  now?: Date;
}): Promise<BugReportMachineFacts> {
  const { dataDir } = options;
  const logsDir = path.join(dataDir, "logs");
  return {
    platform: process.platform,
    osRelease: `${os.type()} ${os.release()}`,
    arch: process.arch,
    bunVersion: process.versions.bun ?? "unknown",
    now: (options.now ?? new Date()).toISOString(),
    dataDir,
    dataDirExists: existsSync(dataDir),
    logsDir,
    debugLogging: readApplicationLogSettings(dataDir).enabled,
    recentLogs: await recentLogFiles(logsDir),
    backend: bugReportBackendInstance(dataDir),
    toolchainBinDir: existsSync(options.toolchainBinDir) ? options.toolchainBinDir : null,
    managedGh: await managedGhBinary(options.toolchainBinDir, options.toolchainRoot),
    desktopApp: desktopAppPath(os.homedir()),
  };
}
