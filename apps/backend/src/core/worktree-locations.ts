import os from "node:os";
import path from "node:path";

import {
  MAX_WORKTREE_LOCATION_CHARS,
  parseWorktreeLocationSettings,
  type WorktreeLocationSettings,
  type WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";
import { defaultRuntimeProfileRoots } from "@orkestrator/protocol/runtime-profile-status";

import type { CommandContext } from "./commands-context.js";
import { APP_SLUG } from "./constants.js";
import type { AppConfig } from "./models.js";

type LocationContext = Pick<CommandContext, "storage" | "worktreeDir">;

/**
 * The backend's startup worktree root: `--worktree-dir`, else the default.
 * Existing environments without a recorded `worktreeBaseDir` live here.
 */
export function getWorktreeBaseDir(context?: Pick<CommandContext, "worktreeDir">): string {
  return context?.worktreeDir ?? defaultWorktreeBaseDir();
}

// `ORKESTRATOR_WORKTREE_DIR` is what the backend reads into `worktreeDir` at
// startup, so a caller without a context resolves the same root. The test
// preloads also point it at a temporary directory, which keeps a test that
// omits `worktreeDir` out of the user's real workspaces.
function defaultWorktreeBaseDir(): string {
  const configured = process.env.ORKESTRATOR_WORKTREE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), APP_SLUG, "workspaces");
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function productionDataDir(): string | null {
  try {
    return defaultRuntimeProfileRoots().productionDataDir;
  } catch {
    return null;
  }
}

/**
 * Checks a folder the user chose for new worktrees and returns it resolved.
 * A worktree folder is deleted with its environment, so the parent may not be
 * the filesystem root, Orkestrator's own data, or (for an environment) the
 * project checkout the worktree is added to.
 */
export function validateWorktreeLocation(
  value: unknown,
  options: { label: string; dataDir: string; projectPath?: string | null },
): string {
  if (typeof value !== "string") throw new Error(`${options.label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${options.label} is required`);
  if (trimmed.length > MAX_WORKTREE_LOCATION_CHARS) {
    throw new Error(`${options.label} is too long`);
  }
  if (trimmed.includes("\0")) throw new Error(`${options.label} must not contain NUL characters`);
  if (!path.isAbsolute(trimmed)) throw new Error(`${options.label} must be an absolute path`);
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${options.label} must not be the filesystem root`);
  }
  for (const protectedRoot of [options.dataDir, productionDataDir()]) {
    if (protectedRoot && isSameOrInside(resolved, protectedRoot)) {
      throw new Error(`${options.label} must not be inside Orkestrator's data directory`);
    }
  }
  if (options.projectPath && isSameOrInside(resolved, options.projectPath)) {
    throw new Error(`${options.label} must not be inside the project checkout`);
  }
  return resolved;
}

export function configuredWorktreeLocations(config: AppConfig): WorktreeLocationSettings {
  return parseWorktreeLocationSettings(config.global.worktreeLocations);
}

/**
 * Where a new environment's worktree goes when the environment did not pick
 * a folder. A startup `--worktree-dir` (development profiles, tests) wins
 * over the app setting so an isolated backend never writes outside its root.
 */
export async function resolveEnvironmentWorktreeRoot(context: LocationContext): Promise<string> {
  if (context.worktreeDir) return context.worktreeDir;
  const configured = configuredWorktreeLocations(await context.storage.loadConfig()).environments;
  return configured ? path.resolve(configured) : getWorktreeBaseDir(context);
}

export async function getWorktreeLocations(
  context: LocationContext,
): Promise<WorktreeLocationsSnapshot> {
  const configured = configuredWorktreeLocations(await context.storage.loadConfig());
  let profilesDirectory: string;
  try {
    profilesDirectory = path.join(defaultRuntimeProfileRoots().developmentRoot, "profiles");
  } catch {
    profilesDirectory = "";
  }
  return {
    environments: {
      configured: configured.environments ?? null,
      defaultPath: getWorktreeBaseDir({}),
      effective: await resolveEnvironmentWorktreeRoot(context),
      startupOverride: context.worktreeDir ?? null,
    },
    dev: {
      configured: configured.dev ?? null,
      defaultPath: profilesDirectory,
    },
  };
}

/** Validates and saves both settings; null or empty clears one back to its default. */
export async function updateWorktreeLocations(
  args: Record<string, unknown>,
  context: LocationContext,
): Promise<WorktreeLocationsSnapshot> {
  const dataDir = context.storage.getDataDir();
  const next: WorktreeLocationSettings = {};
  for (const [key, label] of [
    ["environments", "Environment worktree location"],
    ["dev", "Dev worktree location"],
  ] as const) {
    const value = args[key];
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      continue;
    }
    next[key] = validateWorktreeLocation(value, { label, dataDir });
  }
  await context.storage.updateWorktreeLocations(next);
  return getWorktreeLocations(context);
}
