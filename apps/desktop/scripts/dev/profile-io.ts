import { spawnSync } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
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
const MODEL_CACHE_COPY_CHUNK_BYTES = 64 * 1024;

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

/**
 * Delete disposable profile state without ever following directory symlinks.
 * Kept as one tested production helper so both reset modes retain that safety
 * property when provider-owned credential paths are added or changed.
 */
export async function removeProfileState(
  profile: RuntimeProfile,
  keepToolchains: boolean,
): Promise<void> {
  if (!keepToolchains) {
    await rm(profile.profileRoot, { recursive: true, force: true });
    return;
  }
  for (const child of await readdir(profile.profileRoot)) {
    if (child === "profile.json" || child === ".orkestrator-dev-profile") continue;
    if (child === "data") {
      for (const dataChild of await readdir(profile.dataDir).catch(() => [])) {
        if (dataChild !== "toolchains") {
          await rm(path.join(profile.dataDir, dataChild), { recursive: true, force: true });
        }
      }
    } else {
      await rm(path.join(profile.profileRoot, child), { recursive: true, force: true });
    }
  }
}

type ModelCacheSeedOptions = {
  roots?: RuntimeProfileRoots;
  env?: NodeJS.ProcessEnv;
  afterSourceValidation?: (label: string) => void | Promise<void>;
};

type BoundedSeedCandidate = {
  label: string;
  source: string;
  destination: string;
  replace?: boolean;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isSameFile(
  initial: Stats,
  current: Stats,
): boolean {
  return current.isFile()
    && current.dev === initial.dev
    && current.ino === initial.ino
    && current.size === initial.size
    && current.mtimeMs === initial.mtimeMs
    && current.ctimeMs === initial.ctimeMs;
}

async function seedBoundedFiles(
  candidates: readonly BoundedSeedCandidate[],
  options: ModelCacheSeedOptions,
): Promise<string[]> {
  const copied: string[] = [];
  for (const candidate of candidates) {
    let temporary: string | undefined;
    let sourceHandle: FileHandle | undefined;
    let temporaryHandle: FileHandle | undefined;
    try {
      if (!candidate.replace && await pathExists(candidate.destination)) continue;
      sourceHandle = await open(
        candidate.source,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const initialSourceInfo = await sourceHandle.stat();
      if (!initialSourceInfo.isFile() || initialSourceInfo.size > MAX_MODEL_CACHE_BYTES) continue;
      await options.afterSourceValidation?.(candidate.label);

      await mkdir(path.dirname(candidate.destination), { recursive: true, mode: 0o700 });
      temporary = `${candidate.destination}.${process.pid}.${Date.now()}.tmp`;
      temporaryHandle = await open(
        temporary,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );

      let totalBytes = 0;
      while (totalBytes <= MAX_MODEL_CACHE_BYTES) {
        const remaining = (MAX_MODEL_CACHE_BYTES + 1) - totalBytes;
        const chunk = Buffer.allocUnsafe(Math.min(MODEL_CACHE_COPY_CHUNK_BYTES, remaining));
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > MAX_MODEL_CACHE_BYTES) throw new Error("Seed source exceeds the size limit");

        let written = 0;
        while (written < bytesRead) {
          const result = await temporaryHandle.write(chunk, written, bytesRead - written);
          if (result.bytesWritten === 0) throw new Error("Seed write made no progress");
          written += result.bytesWritten;
        }
      }

      const [finalSourceInfo, currentSourceInfo] = await Promise.all([
        sourceHandle.stat(),
        lstat(candidate.source),
      ]);
      if (
        !isSameFile(initialSourceInfo, finalSourceInfo)
        || !currentSourceInfo.isFile()
        || currentSourceInfo.dev !== initialSourceInfo.dev
        || currentSourceInfo.ino !== initialSourceInfo.ino
      ) {
        throw new Error("Seed source changed while it was being copied");
      }

      await temporaryHandle.chmod(0o600);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      if (candidate.replace) {
        await rename(temporary, candidate.destination);
        temporary = undefined;
      } else {
        await link(temporary, candidate.destination);
      }
      copied.push(candidate.label);
    } catch {
      // Provider state is an optional convenience, never a startup dependency.
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return copied;
}

/**
 * Seed model metadata into an isolated agent-test profile without copying
 * credentials, sessions, prompts, projects, or application configuration.
 * Existing profile caches always win so a restart cannot discard live data.
 * Invalid seeds remain harmless because their normal consumers validate them.
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
  return seedBoundedFiles(candidates, options);
}

/**
 * Grok has no documented home-directory override, so an isolated local test
 * cannot point only Grok at the host home. Copy just its credential into the
 * private profile instead. The source is re-read on every start so a refreshed
 * host login wins; sessions, prompts, logs, and the rest of HOME stay isolated.
 */
export async function seedAgentTestProviderCredentials(
  profile: RuntimeProfile,
  options: ModelCacheSeedOptions = {},
): Promise<string[]> {
  if (!profile.credentialSources.includes("grok")) return [];
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  return seedBoundedFiles([{
    label: "grok/auth.json",
    source: path.join(roots.homeDir, ".grok", "auth.json"),
    destination: path.join(
      profile.dataDir,
      "agent-credentials",
      "home",
      ".grok",
      "auth.json",
    ),
    replace: true,
  }], options);
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
