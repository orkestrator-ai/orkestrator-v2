import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type AgentPlatform, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { APP_SLUG, PRODUCT_NAME } from "./app-constants.js";

export const DEV_PROFILE_SENTINEL = ".orkestrator-dev-profile";
export const DEV_PROFILE_FORMAT_VERSION = 1;

export type RuntimeFlavor = "production" | "development" | "agent-test";

export type RuntimeProfile = {
  version: 1;
  flavor: RuntimeFlavor;
  id: string;
  displayName: string;
  repositoryRoot: string;
  profileRoot: string;
  dataDir: string;
  runtimeDir: string;
  worktreeDir: string;
  logDir: string;
  fixtureDir: string;
  dockerOwner: string;
  dockerImage: string;
  rendererHost: "127.0.0.1";
  rendererPort: number;
  gatewayHost: "127.0.0.1";
  gatewayPort: number;
  electronTitle: string;
  credentialSources: AgentPlatform[];
  /**
   * Agent platforms this profile provisions managed toolchains for.
   *
   * Only `agent-test` reads it; the other flavors keep their durable, user-made
   * selection. Cursor and Grok are the reason it exists: they are ACP-only and
   * never fall back to a PATH lookup, so a profile that provisions nothing can
   * launch Claude, Codex and OpenCode from the host but cannot start those two
   * at all.
   */
  agentPlatforms: AgentPlatform[];
};

export type RuntimeProcessName = "launcher" | "vite" | "electron" | "backend";

export type RuntimeStatusManifest = {
  version: 1;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  profile: string;
  flavor: RuntimeFlavor;
  dataDir: string;
  testProject?: string;
  electronTitle: string;
  rendererUrl: string;
  browserUrl?: string;
  authFile?: string;
  logDir: string;
  statusPath: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  pids: Partial<Record<RuntimeProcessName, number>>;
  processStartTimes: Partial<Record<RuntimeProcessName, number>>;
};

const RUNTIME_STATUS_KEYS = new Set([
  "version", "status", "profile", "flavor", "dataDir", "testProject", "electronTitle",
  "rendererUrl", "browserUrl", "authFile", "logDir", "statusPath", "startedAt",
  "updatedAt", "error", "pids", "processStartTimes",
]);

export function parseRuntimeStatusManifest(value: unknown): RuntimeStatusManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime status must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!RUNTIME_STATUS_KEYS.has(key)) throw new Error(`Runtime status contains unsupported field: ${key}`);
  }
  if (candidate.version !== 1
    || !["starting", "ready", "stopping", "stopped", "failed"].includes(String(candidate.status))
    || typeof candidate.profile !== "string"
    || typeof candidate.statusPath !== "string"
    || typeof candidate.pids !== "object"
    || candidate.pids === null
    || typeof candidate.processStartTimes !== "object"
    || candidate.processStartTimes === null) {
    throw new Error("Runtime status format is invalid");
  }
  return candidate as RuntimeStatusManifest;
}

export type RuntimeProfileRoots = {
  developmentRoot: string;
  productionDataDir: string;
  homeDir: string;
};

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, length);
}

export function normalizeRuntimeProfileId(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-")
    .slice(0, 48);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Development profile names must contain a letter or number");
  }
  return normalized;
}

export function defaultRuntimeProfileRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): RuntimeProfileRoots {
  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    return {
      developmentRoot: path.join(appSupport, `${APP_SLUG}-dev`),
      productionDataDir: path.join(appSupport, APP_SLUG),
      homeDir,
    };
  }
  if (platform === "win32") {
    throw new Error("Orkestrator development profiles support macOS and Linux only");
  }
  const configRoot = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  return {
    developmentRoot: path.join(configRoot, `${APP_SLUG}-dev`),
    productionDataDir: path.join(configRoot, APP_SLUG),
    homeDir,
  };
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertProfileIsolatedFromProduction(
  profileRoot: string,
  productionDataDir: string,
): void {
  if (isSameOrInside(profileRoot, productionDataDir)) {
    throw new Error("Development profile path must not be inside the production data directory");
  }
}

export function resolveRuntimeProfile(options: {
  repositoryRoot: string;
  flavor?: Exclude<RuntimeFlavor, "production">;
  requestedId?: string;
  rendererPort?: number;
  gatewayPort?: number;
  roots?: RuntimeProfileRoots;
  credentialSources?: RuntimeProfile["credentialSources"];
  agentPlatforms?: RuntimeProfile["agentPlatforms"];
}): RuntimeProfile {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const requestedId = options.requestedId?.trim() || `workspace-${shortHash(repositoryRoot, 8)}`;
  const id = normalizeRuntimeProfileId(requestedId);
  const profileRoot = path.resolve(roots.developmentRoot, "profiles", id);
  assertProfileIsolatedFromProduction(profileRoot, roots.productionDataDir);

  const dataDir = path.join(profileRoot, "data");
  const flavor = options.flavor ?? "development";
  const displayName = requestedId;
  return {
    version: 1,
    flavor,
    id,
    displayName,
    repositoryRoot,
    profileRoot,
    dataDir,
    runtimeDir: path.join(profileRoot, "runtime"),
    worktreeDir: path.join(profileRoot, "worktrees"),
    logDir: path.join(profileRoot, "logs"),
    fixtureDir: path.join(profileRoot, "fixtures"),
    dockerOwner: shortHash(dataDir, 16),
    dockerImage: `${APP_SLUG}:dev-${shortHash(repositoryRoot, 12)}`,
    rendererHost: "127.0.0.1",
    rendererPort: options.rendererPort ?? 0,
    gatewayHost: "127.0.0.1",
    gatewayPort: options.gatewayPort ?? 0,
    electronTitle: `${PRODUCT_NAME} — DEV [${id}]`,
    credentialSources: [...new Set(options.credentialSources ?? [])],
    agentPlatforms: [...new Set(options.agentPlatforms ?? [])],
  };
}

function isRuntimeFlavor(value: unknown): value is RuntimeFlavor {
  return value === "production" || value === "development" || value === "agent-test";
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime profile must be an object");
  }
  const candidate = value as Partial<RuntimeProfile>;
  if (candidate.version !== 1 || !isRuntimeFlavor(candidate.flavor)) {
    throw new Error("Unsupported runtime profile format");
  }
  const requiredStrings: Array<keyof RuntimeProfile> = [
    "id", "displayName", "repositoryRoot", "profileRoot", "dataDir", "runtimeDir",
    "worktreeDir", "logDir", "fixtureDir", "dockerOwner", "dockerImage",
    "rendererHost", "gatewayHost", "electronTitle",
  ];
  for (const key of requiredStrings) {
    if (typeof candidate[key] !== "string" || !(candidate[key] as string).trim()) {
      throw new Error(`Runtime profile ${key} is invalid`);
    }
  }
  const candidateId = candidate.id as string;
  if (candidateId !== normalizeRuntimeProfileId(candidateId)) {
    throw new Error("Runtime profile ID is not normalized");
  }
  if (candidate.rendererHost !== "127.0.0.1" || candidate.gatewayHost !== "127.0.0.1") {
    throw new Error("Development profiles must bind only to 127.0.0.1");
  }
  for (const key of ["rendererPort", "gatewayPort"] as const) {
    if (!Number.isInteger(candidate[key]) || (candidate[key] ?? -1) < 0 || (candidate[key] ?? 65536) > 65535) {
      throw new Error(`Runtime profile ${key} is invalid`);
    }
  }
  if (!Array.isArray(candidate.credentialSources)
    || candidate.credentialSources.some((entry) => !isAgentPlatform(entry))) {
    throw new Error("Runtime profile credentialSources is invalid");
  }
  if (candidate.agentPlatforms === undefined) {
    // A profile written before this field existed provisioned nothing, which is
    // exactly what an empty selection means. Rejecting it instead would fail the
    // parse, and `dev:stop`/`dev:reset` would fall back to a profile rebuilt
    // from arguments rather than the one actually on disk.
    candidate.agentPlatforms = [];
  } else if (!Array.isArray(candidate.agentPlatforms)
    || candidate.agentPlatforms.some((entry) => !isAgentPlatform(entry))) {
    throw new Error("Runtime profile agentPlatforms is invalid");
  }
  const parsed = candidate as RuntimeProfile;
  assertProfileIsolatedFromProduction(parsed.profileRoot, defaultRuntimeProfileRoots().productionDataDir);
  const expectedRoot = path.resolve(parsed.profileRoot);
  for (const child of [parsed.dataDir, parsed.runtimeDir, parsed.worktreeDir, parsed.logDir, parsed.fixtureDir]) {
    if (!isSameOrInside(child, expectedRoot) || path.resolve(child) === expectedRoot) {
      throw new Error("Runtime profile paths must be children of profileRoot");
    }
  }
  return parsed;
}

export function loadRuntimeProfileSync(filePath: string): RuntimeProfile {
  return parseRuntimeProfile(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function runtimeProfileFromEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeProfile | null {
  const filePath = env.ORKESTRATOR_RUNTIME_PROFILE_FILE?.trim();
  if (!filePath) return null;
  if (!existsSync(filePath)) throw new Error(`Runtime profile does not exist: ${filePath}`);
  return loadRuntimeProfileSync(filePath);
}

export function statusManifestPath(profile: RuntimeProfile): string {
  return path.join(profile.runtimeDir, "status.json");
}

export function assertSafeProfileResetTarget(options: {
  profile: RuntimeProfile;
  roots?: RuntimeProfileRoots;
  repositoryRoot?: string;
  sentinel: unknown;
}): void {
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const target = path.resolve(options.profile.profileRoot);
  const forbidden = [
    path.parse(target).root,
    path.resolve(roots.homeDir),
    path.resolve(roots.productionDataDir),
    path.resolve(options.repositoryRoot ?? options.profile.repositoryRoot),
    path.resolve(roots.developmentRoot),
  ];
  if (forbidden.includes(target)) throw new Error(`Refusing unsafe profile reset target: ${target}`);
  if (!isSameOrInside(target, path.join(path.resolve(roots.developmentRoot), "profiles"))) {
    throw new Error("Refusing profile reset outside the development profiles root");
  }
  const sentinel = options.sentinel as { version?: unknown; profile?: unknown } | null;
  if (!sentinel || sentinel.version !== DEV_PROFILE_FORMAT_VERSION || sentinel.profile !== options.profile.id) {
    throw new Error("Development profile sentinel is missing or does not match the selected profile");
  }
}
