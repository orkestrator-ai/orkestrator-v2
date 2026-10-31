import { canonicalWorktreePath } from "@orkestrator/protocol/node/worktree-paths";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  DevProfileDiskUsage,
  DiskUsageEnvironmentSummary,
  DiskUsageItem,
  EnvironmentDiskUsage,
} from "@orkestrator/protocol/disk-usage";
import { defaultRuntimeProfileRoots } from "@orkestrator/protocol/node/runtime-profile-status";

import type { CommandContext } from "./commands-context.js";
import { retainedContainerIds, storageVolumeNames } from "./environment-cleanup.js";
import type { Environment } from "./models.js";
import { containerSize, volumeSizes } from "./recovery-copies.js";
import { pathExists } from "./shell.js";

const DU_TIMEOUT_MS = 180_000;
const DU_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Concurrent `du` walks; more only contend for the same disk. */
const MAX_CONCURRENT_MEASUREMENTS = 2;
/** Largest entries listed for a worktree; the rest are summed into one row. */
const MAX_LISTED_ENTRIES = 15;
const MAX_DEV_PROFILES = 64;
const MAX_DEV_WORKTREES_PER_PROFILE = 64;
const CACHE_TTL_MS = 5 * 60_000;

/** Runs `du` and returns its stdout, also when some entries were unreadable. */
export type DuRunner = (args: string[]) => Promise<string>;

export type DiskUsageProbes = {
  du: DuRunner;
  containerSize: (containerId: string) => Promise<number | null>;
  volumeSizes: () => Promise<Map<string, number> | null>;
  profilesDirectory: () => string | null;
};

const runDu: DuRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "du",
      args,
      { encoding: "utf8", maxBuffer: DU_MAX_OUTPUT_BYTES, timeout: DU_TIMEOUT_MS },
      (error, stdout) => {
        // `du` exits 1 when it cannot read part of a tree and still reports
        // what it could; a timeout or kill leaves totals that are too small.
        if (error && (error.killed || error.signal || !stdout)) reject(error);
        else resolve(stdout);
      },
    );
  });

const defaultProbes: DiskUsageProbes = {
  du: runDu,
  containerSize,
  volumeSizes,
  profilesDirectory: () => {
    try {
      return path.join(defaultRuntimeProfileRoots().developmentRoot, "profiles");
    } catch {
      return null;
    }
  },
};

/**
 * Process-wide on purpose: this bounds disk scans on this host, so a bound per
 * backend would multiply it (docs/architecture/backend-runtime.md).
 */
let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_MEASUREMENTS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** `du -k` lines (`<kilobytes>\t<path>`) as allocated bytes by path. */
export function parseDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match) sizes.set(path.resolve(match[2]!), Number(match[1]) * 1024);
  }
  return sizes;
}

/**
 * Allocated size of `directory` and of each directory directly inside it,
 * plus what the files at its top level add up to. Stays on one filesystem, so
 * a mount inside a worktree is not counted. (BSD `du` cannot combine `-a`
 * with `-d`, so top-level files are the difference from the total.)
 */
async function measureDirectory(
  directory: string,
  probes: DiskUsageProbes,
): Promise<{ bytes: number | null; entries: DiskUsageItem[]; looseFileBytes: number }> {
  if (!(await pathExists(directory))) return { bytes: 0, entries: [], looseFileBytes: 0 };
  let sizes: Map<string, number>;
  try {
    sizes = parseDuOutput(await limited(() => probes.du(["-k", "-x", "-d", "1", directory])));
  } catch {
    return { bytes: null, entries: [], looseFileBytes: 0 };
  }
  const root = path.resolve(directory);
  const entries: DiskUsageItem[] = [];
  for (const [entryPath, bytes] of sizes) {
    if (entryPath !== root && path.dirname(entryPath) === root) {
      entries.push({ label: path.basename(entryPath), path: entryPath, bytes });
    }
  }
  entries.sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0));
  const bytes = sizes.get(root) ?? null;
  const listed = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  return { bytes, entries, looseFileBytes: bytes === null ? 0 : Math.max(0, bytes - listed) };
}

/** The largest entries, with everything after them summed into one row. */
export function summarizeEntries(entries: DiskUsageItem[], limit = MAX_LISTED_ENTRIES) {
  if (entries.length <= limit) return entries;
  const rest = entries.slice(limit);
  return [
    ...entries.slice(0, limit),
    {
      label: `${rest.length} more`,
      path: null,
      bytes: rest.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    },
  ];
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(canonicalWorktreePath(root), canonicalWorktreePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type DevProfileManifest = { id: string; profileRoot: string; worktreeDir: string };

/**
 * Development profiles launched from `repositoryRoot` (`mise run dev` or
 * `dev:test` inside that checkout), found by the `repositoryRoot` each
 * profile records in its `profile.json`.
 */
export async function findDevProfiles(
  repositoryRoot: string,
  profilesDirectory: string,
): Promise<DevProfileManifest[]> {
  const target = path.resolve(repositoryRoot);
  const names = await readdir(profilesDirectory).catch(() => [] as string[]);
  const found: DevProfileManifest[] = [];
  for (const name of names.sort()) {
    const profileRoot = path.join(profilesDirectory, name);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(path.join(profileRoot, "profile.json"), "utf8"));
    } catch {
      continue;
    }
    if (
      !manifest ||
      typeof manifest !== "object" ||
      manifest.id !== name ||
      typeof manifest.repositoryRoot !== "string" ||
      path.resolve(manifest.repositoryRoot) !== target ||
      typeof manifest.profileRoot !== "string" ||
      path.resolve(manifest.profileRoot) !== profileRoot ||
      typeof manifest.worktreeDir !== "string" ||
      !path.isAbsolute(manifest.worktreeDir)
    ) {
      continue;
    }
    found.push({ id: name, profileRoot, worktreeDir: path.resolve(manifest.worktreeDir) });
    if (found.length >= MAX_DEV_PROFILES) break;
  }
  return found;
}

async function measureDevProfile(
  profile: DevProfileManifest,
  probes: DiskUsageProbes,
): Promise<{ usage: DevProfileDiskUsage; worktreeBytes: number | null; roots: DiskUsageItem[] }> {
  const [whole, worktrees] = await Promise.all([
    measureDirectory(profile.profileRoot, probes),
    measureDirectory(profile.worktreeDir, probes),
  ]);
  const worktreesInside = isSameOrInside(profile.worktreeDir, profile.profileRoot);
  const stateBytes =
    whole.bytes === null
      ? null
      : Math.max(0, whole.bytes - (worktreesInside ? (worktrees.bytes ?? 0) : 0));
  const entries = [...worktrees.entries];
  if (worktrees.looseFileBytes > 0)
    entries.push({ label: "Other files", path: null, bytes: worktrees.looseFileBytes });
  return {
    worktreeBytes: worktrees.bytes,
    roots: [
      { label: profile.id, path: profile.profileRoot, bytes: whole.bytes },
      ...(worktreesInside
        ? []
        : [{ label: profile.id, path: profile.worktreeDir, bytes: worktrees.bytes }]),
    ],
    usage: {
      id: profile.id,
      profileRoot: profile.profileRoot,
      worktreeDir: profile.worktreeDir,
      stateBytes,
      worktreeCount: worktrees.entries.length,
      worktrees: summarizeEntries(entries, MAX_DEV_WORKTREES_PER_PROFILE - 1),
      bytes: stateBytes === null || worktrees.bytes === null ? null : stateBytes + worktrees.bytes,
    },
  };
}

async function measureContainer(
  environment: Environment,
  probes: DiskUsageProbes,
): Promise<EnvironmentDiskUsage["primary"]> {
  const items: DiskUsageItem[] = [];
  if (environment.containerId) {
    items.push({
      label: "Container writable layer",
      path: null,
      bytes: await probes.containerSize(environment.containerId),
    });
  }
  for (const retained of retainedContainerIds(environment)) {
    items.push({
      label: `Recovery copy ${retained.slice(0, 12)}`,
      path: null,
      bytes: await probes.containerSize(retained),
    });
  }
  const volumes = storageVolumeNames(environment);
  if (volumes.length > 0) {
    const sizes = await limited(() => probes.volumeSizes());
    for (const name of volumes) {
      items.push({ label: `Volume ${name}`, path: null, bytes: sizes?.get(name) ?? null });
    }
  }
  if (items.length === 0) {
    return {
      kind: "container",
      path: null,
      bytes: 0,
      items,
      unavailable: "The container has not been created yet",
    };
  }
  const known = items.filter((item) => item.bytes !== null);
  return {
    kind: "container",
    path: null,
    bytes: known.length === 0 ? null : known.reduce((sum, item) => sum + item.bytes!, 0),
    items,
    ...(known.length < items.length ? { unavailable: "Docker did not report every size" } : {}),
  };
}

/** Count each measured directory once, even when dev roots overlap the checkout. */
function outerRoots(roots: DiskUsageItem[]): DiskUsageItem[] {
  const canonical = roots.map((root) => ({
    root,
    path: root.path ? canonicalWorktreePath(root.path) : null,
  }));
  return canonical
    .filter(
      (entry, index) =>
        !entry.path ||
        !canonical.some((other, otherIndex) => {
          if (otherIndex === index || !other.path) return false;
          const relative = path.relative(other.path, entry.path!);
          return relative === ""
            ? otherIndex < index
            : !relative.startsWith("..") && !path.isAbsolute(relative);
        }),
    )
    .map((entry) => entry.root);
}

export async function measureEnvironmentDiskUsage(
  environment: Environment,
  probes: DiskUsageProbes = defaultProbes,
  now: () => Date = () => new Date(),
): Promise<EnvironmentDiskUsage> {
  let primary: EnvironmentDiskUsage["primary"];
  let measuredProfiles: Awaited<ReturnType<typeof measureDevProfile>>[] = [];
  if (environment.environmentType === "containerized") {
    primary = await measureContainer(environment, probes);
  } else if (!environment.worktreePath || !(await pathExists(environment.worktreePath))) {
    primary = {
      kind: "worktree",
      path: environment.worktreePath ?? null,
      bytes: 0,
      items: [],
      unavailable: "The worktree has not been created yet",
    };
  } else {
    const measured = await measureDirectory(environment.worktreePath, probes);
    const items = summarizeEntries(measured.entries);
    if (measured.looseFileBytes > 0) {
      items.push({ label: "Other files", path: null, bytes: measured.looseFileBytes });
    }
    primary = {
      kind: "worktree",
      path: environment.worktreePath,
      bytes: measured.bytes,
      items,
      ...(measured.bytes === null ? { unavailable: "The worktree could not be measured" } : {}),
    };
  }
  if (environment.environmentType === "local" && environment.worktreePath) {
    const profilesDirectory = probes.profilesDirectory();
    const found = profilesDirectory
      ? await findDevProfiles(environment.worktreePath, profilesDirectory)
      : [];
    measuredProfiles = await Promise.all(
      found.map((profile) => measureDevProfile(profile, probes)),
    );
  }
  const profiles = measuredProfiles.map((profile) => profile.usage);
  const worktreeBytes = measuredProfiles.reduce(
    (sum, profile) => sum + (profile.worktreeBytes ?? 0),
    0,
  );
  const devRoots = measuredProfiles.flatMap((profile) => profile.roots);
  const devBytes = outerRoots(devRoots).reduce((sum, root) => sum + (root.bytes ?? 0), 0);
  const totalRoots = outerRoots([
    { label: "Primary", path: primary.path, bytes: primary.bytes },
    ...devRoots,
  ]);
  return {
    environmentId: environment.id,
    environmentType: environment.environmentType,
    measuredAt: now().toISOString(),
    primary,
    dev: { profiles, worktreeBytes, bytes: devBytes },
    totalBytes: totalRoots.some((root) => root.bytes === null)
      ? null
      : totalRoots.reduce((sum, root) => sum + root.bytes!, 0),
  };
}

const caches = new WeakMap<
  DiskUsageProbes,
  Map<string, { at: number; result: Promise<EnvironmentDiskUsage> }>
>();

/**
 * Measures one environment, reusing a recent result: walking a worktree with
 * its dependencies takes seconds, and the settings views ask on every open.
 */
export async function getEnvironmentDiskUsage(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
  options: { refresh?: boolean; probes?: DiskUsageProbes } = {},
): Promise<EnvironmentDiskUsage> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const probes = options.probes ?? defaultProbes;
  let cache = caches.get(probes);
  if (!cache) {
    cache = new Map();
    caches.set(probes, cache);
  }
  const currentCache = cache;
  const cached = cache.get(environmentId);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  const result = measureEnvironmentDiskUsage(environment, probes);
  cache.set(environmentId, { at: Date.now(), result });
  // A failed walk is not remembered.
  const evict = () => {
    if (currentCache.get(environmentId)?.result === result) currentCache.delete(environmentId);
  };
  void result.then((usage) => {
    if (
      usage.totalBytes === null ||
      usage.primary.unavailable ||
      usage.dev.profiles.some((profile) => profile.bytes === null)
    )
      evict();
  }, evict);
  for (const [id, entry] of cache) {
    if (Date.now() - entry.at >= CACHE_TTL_MS) cache.delete(id);
  }
  return result;
}

/** Every environment, for the disk usage overview; sizes are asked per environment. */
export async function listDiskUsageEnvironments(
  context: Pick<CommandContext, "storage">,
): Promise<DiskUsageEnvironmentSummary[]> {
  const [projects, environments] = await Promise.all([
    context.storage.loadProjects(),
    context.storage.loadEnvironments(),
  ]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return environments
    .filter((environment) => projectNames.has(environment.projectId))
    .map((environment) => ({
      environmentId: environment.id,
      name: environment.name,
      projectId: environment.projectId,
      projectName: projectNames.get(environment.projectId)!,
      environmentType: environment.environmentType,
      location: environment.environmentType === "local" ? (environment.worktreePath ?? null) : null,
      projectHome: environment.projectHome === true,
    }));
}
