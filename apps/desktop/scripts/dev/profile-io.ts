import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import {
  DEV_PROFILE_FORMAT_VERSION,
  DEV_PROFILE_SENTINEL,
  assertSafeProfileResetTarget,
  defaultRuntimeProfileRoots,
  parseRuntimeProfile,
  parseRuntimeStatusManifest,
  type RuntimeProcessName,
  type RuntimeProfile,
  type RuntimeProfileRoots,
  type RuntimeStatusManifest,
} from "../../electron/runtime-profile.js";

const MAX_MODEL_CACHE_BYTES = 16 * 1024 * 1024;

export async function atomicWriteJson(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, filePath);
    await chmod(filePath, mode);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function initializeProfile(profile: RuntimeProfile): Promise<string> {
  for (const directory of [
    profile.profileRoot,
    profile.dataDir,
    profile.runtimeDir,
    profile.worktreeDir,
    profile.logDir,
    profile.fixtureDir,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const profilePath = path.join(profile.profileRoot, "profile.json");
  await atomicWriteJson(profilePath, profile);
  await atomicWriteJson(path.join(profile.profileRoot, DEV_PROFILE_SENTINEL), {
    version: DEV_PROFILE_FORMAT_VERSION,
    profile: profile.id,
  });
  return profilePath;
}

type ModelCacheSeedOptions = {
  roots?: RuntimeProfileRoots;
  env?: NodeJS.ProcessEnv;
};

/**
 * Seed model metadata into an isolated agent-test profile without copying
 * credentials, sessions, prompts, projects, or application configuration.
 * Invalid caches remain harmless because their normal consumers validate them.
 */
export async function seedInstalledModelCatalogCaches(
  profile: RuntimeProfile,
  options: ModelCacheSeedOptions = {},
): Promise<string[]> {
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim() || path.join(roots.homeDir, ".codex");
  const isolatedCodexHome = path.join(profile.dataDir, "agent-credentials", "codex");
  const isolatedHome = path.join(profile.dataDir, "agent-credentials", "home");
  const candidates = [
    {
      label: "agent-model-catalog.json",
      source: path.join(roots.productionDataDir, "agent-model-catalog.json"),
      destination: path.join(profile.dataDir, "agent-model-catalog.json"),
    },
    {
      label: "opencode-model-catalog.json",
      source: path.join(roots.productionDataDir, "opencode-model-catalog.json"),
      destination: path.join(profile.dataDir, "opencode-model-catalog.json"),
    },
    {
      label: "codex/models_cache.json",
      source: path.join(codexHome, "models_cache.json"),
      destination: path.join(isolatedCodexHome, "models_cache.json"),
    },
    {
      label: "codex/orkestrator-bridge/models-cache.json",
      source: path.join(codexHome, "orkestrator-bridge", "models-cache.json"),
      destination: path.join(isolatedCodexHome, "orkestrator-bridge", "models-cache.json"),
    },
    {
      label: "grok/models_cache.json",
      source: path.join(roots.homeDir, ".grok", "models_cache.json"),
      destination: path.join(isolatedHome, ".grok", "models_cache.json"),
    },
  ];
  const copied: string[] = [];
  for (const candidate of candidates) {
    let temporary: string | undefined;
    try {
      const sourceInfo = await lstat(candidate.source).catch(() => null);
      if (!sourceInfo?.isFile() || sourceInfo.size > MAX_MODEL_CACHE_BYTES) continue;
      await mkdir(path.dirname(candidate.destination), { recursive: true, mode: 0o700 });
      temporary = `${candidate.destination}.${process.pid}.${Date.now()}.tmp`;
      await copyFile(candidate.source, temporary);
      await chmod(temporary, 0o600);
      await rename(temporary, candidate.destination);
      copied.push(candidate.label);
    } catch {
      // Installed caches are an optional warm start, never a startup dependency.
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return copied;
}

export async function readProfile(profilePath: string): Promise<RuntimeProfile> {
  return parseRuntimeProfile(JSON.parse(await readFile(profilePath, "utf8")) as unknown);
}

export async function readStatus(statusPath: string): Promise<RuntimeStatusManifest | null> {
  try {
    return parseRuntimeStatusManifest(JSON.parse(await readFile(statusPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export async function reserveLoopbackPort(): Promise<number> {
  return (await reserveLoopbackPorts(1))[0]!;
}

export async function reserveLoopbackPorts(count: number): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
    throw new Error("Loopback port reservation count is invalid");
  }
  const servers: net.Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
      ports.push(address.port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
  return ports;
}

export function processStartTime(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) return null;
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function processMatches(pid: number | undefined, expectedStart: number | undefined): boolean {
  if (!pid || !expectedStart) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const actual = processStartTime(pid);
  return actual !== null && Math.abs(actual - expectedStart) < 1_000;
}

export function liveness(status: RuntimeStatusManifest | null): Record<RuntimeProcessName, boolean> {
  return Object.fromEntries(
    (["launcher", "vite", "electron", "backend"] as const).map((name) => [
      name,
      processMatches(status?.pids[name], status?.processStartTimes[name]),
    ]),
  ) as Record<RuntimeProcessName, boolean>;
}

export async function readAndValidateSentinel(
  profile: RuntimeProfile,
  roots?: RuntimeProfileRoots,
): Promise<unknown> {
  const sentinelPath = path.join(profile.profileRoot, DEV_PROFILE_SENTINEL);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as unknown;
  assertSafeProfileResetTarget({ profile, sentinel, roots });
  return sentinel;
}
