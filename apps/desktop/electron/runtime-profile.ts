import {
  canonicalWorktreePath,
  assertWorktreePathUnlinked,
} from "@orkestrator/protocol/node/worktree-paths";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { type AgentPlatform, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { APP_SLUG, PRODUCT_NAME } from "./app-constants.js";
import {
  defaultRuntimeProfileRoots,
  normalizeRuntimeProfileId,
  type RuntimeFlavor,
  type RuntimeProfileRoots,
} from "@orkestrator/protocol/node/runtime-profile-status";

export const DEV_PROFILE_SENTINEL = ".orkestrator-dev-profile";
export const DEV_PROFILE_FORMAT_VERSION = 1;

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
   * selection. Grok never falls back to a PATH lookup, while Cursor's SDK
   * bridge is packaged independently of the managed toolchain.
   */
  agentPlatforms: AgentPlatform[];
};

export {
  defaultRuntimeProfileRoots,
  normalizeRuntimeProfileId,
  parseRuntimeStatusManifest,
  type RuntimeFlavor,
  type RuntimeProcessName,
  type RuntimeProfileRoots,
  type RuntimeStatusManifest,
} from "@orkestrator/protocol/node/runtime-profile-status";

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, length);
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

/** Marks a worktree folder outside its profile, so removal can tell it is the profile's. */
export const DEV_WORKTREES_SENTINEL = ".orkestrator-dev-worktrees";

export function isExternalWorktreeDir(
  profile: Pick<RuntimeProfile, "worktreeDir" | "profileRoot">,
) {
  return !isSameOrInside(profile.worktreeDir, profile.profileRoot);
}

/**
 * A worktree folder outside the profile is deleted with the profile, so it
 * must be a folder of its own named after the profile, and never contain the
 * profile or production data.
 */
function assertExternalWorktreeDirSafe(
  worktreeDir: string,
  id: string,
  profileRoot: string,
  productionDataDir: string,
): void {
  assertWorktreePathUnlinked(worktreeDir);
  if (path.resolve(worktreeDir) === path.resolve(profileRoot)) {
    throw new Error(
      "Runtime profile worktree directory must be a strict child of profileRoot or an external folder",
    );
  }
  if (isSameOrInside(worktreeDir, profileRoot)) return;
  if (
    path.basename(worktreeDir) !== id ||
    isSameOrInside(profileRoot, worktreeDir) ||
    isSameOrInside(canonicalWorktreePath(worktreeDir), canonicalWorktreePath(productionDataDir)) ||
    isSameOrInside(productionDataDir, worktreeDir)
  ) {
    throw new Error("Runtime profile worktree directory is not a safe profile-owned folder");
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
  /**
   * A folder to keep this profile's worktrees in, as `<root>/<id>`, instead
   * of `worktrees/` inside the profile (the dev worktree location setting).
   */
  worktreeRoot?: string;
  /** Exact persisted directory, preserved when restarting a profile. */
  worktreeDir?: string;
}): RuntimeProfile {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const requestedId = options.requestedId?.trim() || `workspace-${shortHash(repositoryRoot, 8)}`;
  const id = normalizeRuntimeProfileId(requestedId);
  const profileRoot = path.resolve(roots.developmentRoot, "profiles", id);
  assertProfileIsolatedFromProduction(profileRoot, roots.productionDataDir);
  const worktreeDir = options.worktreeDir
    ? path.resolve(options.worktreeDir)
    : options.worktreeRoot
      ? path.join(path.resolve(options.worktreeRoot), id)
      : path.join(profileRoot, "worktrees");
  assertExternalWorktreeDirSafe(worktreeDir, id, profileRoot, roots.productionDataDir);

  const dataDir = path.join(profileRoot, "data");
  const flavor = options.flavor ?? "development";
  const displayName = requestedId;
  return parseRuntimeProfile({
    version: 1,
    flavor,
    id,
    displayName,
    repositoryRoot,
    profileRoot,
    dataDir,
    runtimeDir: path.join(profileRoot, "runtime"),
    worktreeDir,
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
  });
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
    "id",
    "displayName",
    "repositoryRoot",
    "profileRoot",
    "dataDir",
    "runtimeDir",
    "worktreeDir",
    "logDir",
    "fixtureDir",
    "dockerOwner",
    "dockerImage",
    "rendererHost",
    "gatewayHost",
    "electronTitle",
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
    if (
      !Number.isInteger(candidate[key]) ||
      (candidate[key] ?? -1) < 0 ||
      (candidate[key] ?? 65536) > 65535
    ) {
      throw new Error(`Runtime profile ${key} is invalid`);
    }
  }
  if (
    !Array.isArray(candidate.credentialSources) ||
    candidate.credentialSources.some((entry) => !isAgentPlatform(entry))
  ) {
    throw new Error("Runtime profile credentialSources is invalid");
  }
  if (candidate.agentPlatforms === undefined) {
    // A profile written before this field existed provisioned nothing, which is
    // exactly what an empty selection means. Rejecting it instead would fail the
    // parse, and `dev:stop`/`dev:reset` would fall back to a profile rebuilt
    // from arguments rather than the one actually on disk.
    candidate.agentPlatforms = [];
  } else if (
    !Array.isArray(candidate.agentPlatforms) ||
    candidate.agentPlatforms.some((entry) => !isAgentPlatform(entry))
  ) {
    throw new Error("Runtime profile agentPlatforms is invalid");
  }
  const parsed = candidate as RuntimeProfile;
  assertProfileIsolatedFromProduction(
    parsed.profileRoot,
    defaultRuntimeProfileRoots().productionDataDir,
  );
  const expectedRoot = path.resolve(parsed.profileRoot);
  assertExternalWorktreeDirSafe(
    path.resolve(parsed.worktreeDir),
    parsed.id,
    expectedRoot,
    defaultRuntimeProfileRoots().productionDataDir,
  );
  for (const child of [
    parsed.dataDir,
    parsed.runtimeDir,
    ...(isExternalWorktreeDir(parsed) ? [] : [parsed.worktreeDir]),
    parsed.logDir,
    parsed.fixtureDir,
  ]) {
    if (!isSameOrInside(child, expectedRoot) || path.resolve(child) === expectedRoot) {
      throw new Error("Runtime profile paths must be children of profileRoot");
    }
  }
  return parsed;
}

export function loadRuntimeProfileSync(filePath: string): RuntimeProfile {
  return parseRuntimeProfile(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function runtimeProfileFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProfile | null {
  const filePath = env.ORKESTRATOR_RUNTIME_PROFILE_FILE?.trim();
  if (!filePath) return null;
  if (!existsSync(filePath)) throw new Error(`Runtime profile does not exist: ${filePath}`);
  return loadRuntimeProfileSync(filePath);
}

/**
 * Chromium switches to append before `app.whenReady()` for this flavor.
 *
 * `safeStorage` keeps its key in the macOS login keychain under the profile's
 * fixed title. When an earlier Electron build created that item, the current
 * binary is not on its access list, so macOS raises an access prompt that no
 * one answers in an unattended run, and startup waits on it with no window and
 * no log. A mock keychain keeps encryption working without reading or writing
 * the user's keychain. Other flavors keep the real one.
 */
export function chromiumSwitchesForRuntime(
  flavor: RuntimeFlavor,
  platform: NodeJS.Platform,
): string[] {
  return flavor === "agent-test" && platform === "darwin" ? ["use-mock-keychain"] : [];
}

/** When a window's preview partition retention passes run (`PreviewPartitionRetention.schedule`). */
export const PREVIEW_RETENTION_TIMING = { delayMs: 60_000, intervalMs: 30 * 60_000 } as const;

/**
 * Agent-test runtimes only: run the retention passes every this many
 * milliseconds (first pass included), so a real-window test can watch one
 * clear a removed service's partition instead of waiting a minute.
 */
export const AGENT_TEST_PREVIEW_RETENTION_ENV = "ORKESTRATOR_AGENT_TEST_PREVIEW_RETENTION_MS";
const AGENT_TEST_PREVIEW_RETENTION_MIN_MS = 100;

/**
 * Retention timing for this flavor. Every flavor but `agent-test` ignores the
 * override, so a variable left in a user's environment cannot change how
 * often an installed app clears site data. Malformed or out-of-range values
 * keep the default.
 */
export function previewRetentionTimingForRuntime(
  flavor: RuntimeFlavor,
  env: NodeJS.ProcessEnv = process.env,
): { delayMs: number; intervalMs: number } {
  const fallback = { ...PREVIEW_RETENTION_TIMING };
  if (flavor !== "agent-test") return fallback;
  const value = env[AGENT_TEST_PREVIEW_RETENTION_ENV]?.trim() ?? "";
  if (!/^\d{1,7}$/.test(value)) return fallback;
  const ms = Number(value);
  if (ms < AGENT_TEST_PREVIEW_RETENTION_MIN_MS || ms > PREVIEW_RETENTION_TIMING.intervalMs)
    return fallback;
  return { delayMs: ms, intervalMs: ms };
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
  if (forbidden.includes(target))
    throw new Error(`Refusing unsafe profile reset target: ${target}`);
  if (!isSameOrInside(target, path.join(path.resolve(roots.developmentRoot), "profiles"))) {
    throw new Error("Refusing profile reset outside the development profiles root");
  }
  const sentinel = options.sentinel as { version?: unknown; profile?: unknown } | null;
  if (
    !sentinel ||
    sentinel.version !== DEV_PROFILE_FORMAT_VERSION ||
    sentinel.profile !== options.profile.id
  ) {
    throw new Error(
      "Development profile sentinel is missing or does not match the selected profile",
    );
  }
}
