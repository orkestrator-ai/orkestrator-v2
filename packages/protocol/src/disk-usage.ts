/**
 * Disk usage reporting and the settings that choose where new worktrees go.
 * Shared by the backend, the renderer and the development launcher, so it
 * stays free of Node imports.
 */

export const MAX_WORKTREE_LOCATION_CHARS = 4_096;

/** App settings (`global.worktreeLocations`) for where new worktrees are created. */
export interface WorktreeLocationSettings {
  /** Parent folder for new local environment worktrees. Absent: the default root. */
  environments?: string;
  /**
   * Parent folder for the worktrees of newly created development profiles,
   * each in `<root>/<profile id>`. Absent: inside each profile directory.
   */
  dev?: string;
}

/** A plausible absolute host path; the backend still resolves and checks it. */
export function isWorktreeLocationPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKTREE_LOCATION_CHARS &&
    value.trim() === value &&
    value.startsWith("/") &&
    !value.includes("\0")
  );
}

/** Lenient read of a stored setting: malformed entries fall back to the default. */
export function parseWorktreeLocationSettings(value: unknown): WorktreeLocationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const settings: WorktreeLocationSettings = {};
  if (isWorktreeLocationPath(record.environments)) settings.environments = record.environments;
  if (isWorktreeLocationPath(record.dev)) settings.dev = record.dev;
  return settings;
}

export interface WorktreeLocationsSnapshot {
  environments: {
    /** The app setting, when one is saved. */
    configured: string | null;
    /** Where new environments go without the setting. */
    defaultPath: string;
    /** Where the next new environment goes. */
    effective: string;
    /** A `--worktree-dir` or `ORKESTRATOR_WORKTREE_DIR` that takes precedence. */
    startupOverride: string | null;
  };
  dev: {
    configured: string | null;
    /** The profiles directory; each profile keeps `worktrees/` inside it by default. */
    defaultPath: string;
    /** Development backends cannot change the production-owned preference. */
    readOnly?: boolean;
  };
}

/** One measured location. `bytes` is null when it could not be measured. */
export interface DiskUsageItem {
  label: string;
  path: string | null;
  bytes: number | null;
}

export interface DevProfileDiskUsage {
  id: string;
  profileRoot: string;
  worktreeDir: string;
  /** Data, logs, runtime and fixtures: the profile without its worktrees. */
  stateBytes: number | null;
  /** Number of worktree directories, before the detail-row limit. */
  worktreeCount?: number;
  worktrees: DiskUsageItem[];
  bytes: number | null;
}

export interface EnvironmentDiskUsage {
  environmentId: string;
  environmentType: "containerized" | "local";
  measuredAt: string;
  primary: {
    kind: "worktree" | "container";
    /** The worktree, or null for a container. */
    path: string | null;
    bytes: number | null;
    /** Largest entries of the worktree, or the container layer and volumes. */
    items: DiskUsageItem[];
    /** Why nothing was measured, e.g. no worktree yet or Docker unavailable. */
    unavailable?: string;
  };
  dev: {
    profiles: DevProfileDiskUsage[];
    worktreeBytes: number;
    bytes: number;
  };
  /** Union of primary and development roots; null when a root is unknown. */
  totalBytes: number | null;
}

export interface DiskUsageEnvironmentSummary {
  environmentId: string;
  name: string;
  projectId: string;
  projectName: string;
  environmentType: "containerized" | "local";
  location: string | null;
  projectHome: boolean;
}
