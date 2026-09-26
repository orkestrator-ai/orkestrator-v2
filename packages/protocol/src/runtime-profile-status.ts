/**
 * The development-profile status manifest contract (`dev:status`), shared by
 * the desktop launcher that writes it and the `orkestrator` client that reads
 * it to find an isolated backend. Pure: no Electron, no repository paths.
 */
import os from "node:os";
import path from "node:path";

/** Directory slug of the application's data roots. */
export const RUNTIME_APP_SLUG = "orkestrator-v2";

export type RuntimeFlavor = "production" | "development" | "agent-test";

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
  "version",
  "status",
  "profile",
  "flavor",
  "dataDir",
  "testProject",
  "electronTitle",
  "rendererUrl",
  "browserUrl",
  "authFile",
  "logDir",
  "statusPath",
  "startedAt",
  "updatedAt",
  "error",
  "pids",
  "processStartTimes",
]);

export function parseRuntimeStatusManifest(value: unknown): RuntimeStatusManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime status must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!RUNTIME_STATUS_KEYS.has(key))
      throw new Error(`Runtime status contains unsupported field: ${key}`);
  }
  if (
    candidate.version !== 1 ||
    !["starting", "ready", "stopping", "stopped", "failed"].includes(String(candidate.status)) ||
    typeof candidate.profile !== "string" ||
    typeof candidate.statusPath !== "string" ||
    typeof candidate.pids !== "object" ||
    candidate.pids === null ||
    typeof candidate.processStartTimes !== "object" ||
    candidate.processStartTimes === null
  ) {
    throw new Error("Runtime status format is invalid");
  }
  return candidate as RuntimeStatusManifest;
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

export type RuntimeProfileRoots = {
  developmentRoot: string;
  productionDataDir: string;
  homeDir: string;
};

export function defaultRuntimeProfileRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): RuntimeProfileRoots {
  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    return {
      developmentRoot: path.join(appSupport, `${RUNTIME_APP_SLUG}-dev`),
      productionDataDir: path.join(appSupport, RUNTIME_APP_SLUG),
      homeDir,
    };
  }
  if (platform === "win32") {
    throw new Error("Orkestrator development profiles support macOS and Linux only");
  }
  const configRoot = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  return {
    developmentRoot: path.join(configRoot, `${RUNTIME_APP_SLUG}-dev`),
    productionDataDir: path.join(configRoot, RUNTIME_APP_SLUG),
    homeDir,
  };
}

/** Where `dev:test --profile <name>` publishes its status manifest. */
export function runtimeProfileStatusPath(
  developmentRoot: string,
  profileName: string,
): { id: string; profileRoot: string; statusPath: string } {
  const id = normalizeRuntimeProfileId(profileName);
  const profileRoot = path.resolve(developmentRoot, "profiles", id);
  return { id, profileRoot, statusPath: path.join(profileRoot, "runtime", "status.json") };
}
