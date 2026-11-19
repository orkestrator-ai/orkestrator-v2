/**
 * Writing a project setup into one local worktree
 * (docs/architecture/agent-capabilities-management.md, "Shared locations and
 * isolation"). Shared by this machine's own scoped pass (`scoped-delivery.ts`)
 * and by the executor answering its command node for a worktree that lives
 * here (`scoped-remote.ts`), so both apply the same rules:
 *
 * - a path the repository tracks, or a directory reached through a link or a
 *   file, is a collision and is never written;
 * - every managed path (and the atomic writers' transient names) is listed in
 *   the environment's block of the repository's `info/exclude` before
 *   anything is written, and the block follows what remains afterwards;
 * - writes go through the executor with the worktree's project locations, so
 *   ownership markers, location indexes, atomic writes and local changes work
 *   exactly as they do in the provider homes;
 * - MCP servers go into the provider's project MCP file through this
 *   machine's MCP management (`project-mcp.ts`); the file is excluded only
 *   when Orkestrator created it.
 *
 * Entries name a location id and a component's name and path; a directory is
 * always resolved here, from this machine's own worktree, never taken from a
 * peer.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ComponentKind } from "@orkestrator/protocol/capability-resources";
import type { CapabilityLocation } from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityArtifactStore } from "./artifact-store.js";

import {
  CapabilityExecutor,
  type McpInstaller,
  type NodePlanResult,
  type NodePlanTarget,
} from "./executor.js";
import {
  installName,
  installedDigest,
  readLocationIndex,
  type CapabilityHomes,
} from "./native-ownership.js";
import {
  excludePatterns,
  gitCommonDir,
  linkedAncestor,
  trackedPaths,
  writeExcludeBlock,
  type GitRunner,
} from "./project-git.js";
import { projectMcpExcludeFiles, projectMcpInstaller } from "./project-mcp.js";
import {
  PROJECT_CAPABILITY_LOCATIONS,
  projectCapabilityLocation,
  projectMcpLocation,
  type ScopedLocation,
} from "./scoped-locations.js";
import {
  CAPABILITY_LOCATION_INDEX,
  CAPABILITY_MARKER_FILE,
  removeManagedPath,
} from "./security.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";

/** One managed copy in a worktree, by location and component (no paths). */
export interface WorktreeEntry {
  /** The receipt (and executor) key. */
  key: string;
  locationId: string;
  componentName: string;
  pathOrKey: string;
}

export type WorktreeLocator = (
  locationId: string,
) => { location: CapabilityLocation; directory: string } | undefined;

/** The owner prefix of an environment's `info/exclude` block. */
export const EXCLUDE_OWNER_PREFIX = "env-";

/** A worktree's project directories by location id. */
export function projectLocator(worktree: string): WorktreeLocator {
  return (locationId) => {
    const location = projectCapabilityLocation(locationId);
    return location
      ? { location, directory: path.join(worktree, ...location.relative.split("/")) }
      : undefined;
  };
}

/** The worktree-relative path of one entry (`.claude/skills/review`), or null when it cannot be placed. */
export function worktreeEntryPath(
  entry: Pick<WorktreeEntry, "locationId" | "componentName" | "pathOrKey">,
): { location: ScopedLocation; relative: string; directory: boolean } | null {
  const location = projectCapabilityLocation(entry.locationId);
  if (!location) return null;
  try {
    const name = installName(entry.componentName, entry.pathOrKey, location.layout);
    const file = location.layout === "file" ? `${name}.md` : name;
    return {
      location,
      relative: `${location.relative}/${file}`,
      directory: location.layout === "directory",
    };
  } catch {
    return null;
  }
}

/**
 * The entries that must not be written: a path the index tracks (or the
 * location's index file, for file layouts), or one reached through a link.
 * Without Git's answer nothing can be shown to be safe, so every entry is a
 * collision then.
 */
export async function worktreeCollisions(
  git: GitRunner,
  worktree: string,
  entries: readonly WorktreeEntry[],
): Promise<Map<string, string>> {
  const collisions = new Map<string, string>();
  const candidates = entries.flatMap((entry) => {
    const placed = worktreeEntryPath(entry);
    return placed ? [{ entry, ...placed }] : [];
  });
  // A project MCP file: tracked, behind a link, or not a regular file.
  const mcp = entries.flatMap((entry) => {
    const location = projectMcpLocation(entry.locationId);
    return location ? [{ entry, relative: location.relative }] : [];
  });
  const commonDir = await gitCommonDir(git, worktree);
  if (commonDir && mcp.length > 0) {
    let tracked: Set<string>;
    try {
      tracked = await trackedPaths(git, worktree, [...new Set(mcp.map((item) => item.relative))]);
    } catch {
      tracked = new Set(mcp.map((item) => item.relative));
    }
    for (const item of mcp) {
      if (tracked.has(item.relative)) {
        collisions.set(
          item.entry.key,
          `${item.relative} is tracked in this repository; Orkestrator never edits a tracked file. Add the server to the repository's own ${item.relative}, or use My setup.`,
        );
      }
    }
  }
  for (const item of mcp) {
    if (collisions.has(item.entry.key)) continue;
    const linked = await linkedAncestor(worktree, path.posix.dirname(item.relative));
    const stat = await fs.lstat(path.join(worktree, ...item.relative.split("/"))).catch(() => null);
    if (linked || (stat && !stat.isFile())) {
      collisions.set(
        item.entry.key,
        `${linked ?? item.relative} in this worktree is a link or not a regular file; Orkestrator does not write through it.`,
      );
    }
  }
  if (commonDir) {
    const paths = new Set<string>();
    for (const candidate of candidates) {
      paths.add(candidate.relative);
      if (!candidate.directory)
        paths.add(`${candidate.location.relative}/${CAPABILITY_LOCATION_INDEX}`);
    }
    let tracked: Set<string>;
    try {
      tracked = await trackedPaths(git, worktree, [...paths]);
    } catch {
      tracked = new Set(paths);
    }
    for (const candidate of candidates) {
      const index = `${candidate.location.relative}/${CAPABILITY_LOCATION_INDEX}`;
      if (tracked.has(candidate.relative) || (!candidate.directory && tracked.has(index))) {
        collisions.set(
          candidate.entry.key,
          `${candidate.relative} is tracked in this repository; Orkestrator never replaces a tracked file. Rename the component or remove the file from the repository.`,
        );
      }
    }
  }
  for (const candidate of candidates) {
    if (collisions.has(candidate.entry.key)) continue;
    const linked = await linkedAncestor(worktree, candidate.location.relative);
    if (linked) {
      collisions.set(
        candidate.entry.key,
        `${linked} in this worktree is a link or a file; Orkestrator does not write through it.`,
      );
    }
  }
  return collisions;
}

/** The digest on disk of each entry's copy (null: missing or unreadable). */
export async function observeWorktreeEntries(
  worktree: string,
  entries: readonly WorktreeEntry[],
): Promise<Map<string, string | null>> {
  const locate = projectLocator(worktree);
  const observed = new Map<string, string | null>();
  for (const entry of entries) {
    const located = locate(entry.locationId);
    const placed = worktreeEntryPath(entry);
    if (!located || !placed) continue;
    observed.set(
      entry.key,
      await installedDigest(
        located.location,
        located.directory,
        path.posix.basename(placed.relative),
      ),
    );
  }
  return observed;
}

/** Replaces the environment's `info/exclude` block with `entries`' patterns. */
export async function syncWorktreeExclude(
  git: GitRunner,
  worktree: string,
  environmentId: string,
  entries: ReadonlyArray<Pick<WorktreeEntry, "locationId" | "componentName" | "pathOrKey">>,
  knownEnvironment: (environmentId: string) => boolean,
  /** Project MCP files Orkestrator created (`projectMcpExcludeFiles`). */
  mcpFiles: readonly string[] = [],
): Promise<void> {
  const commonDir = await gitCommonDir(git, worktree);
  if (!commonDir) return;
  const placed = entries.flatMap((entry) => {
    const found = worktreeEntryPath(entry);
    return found ? [found] : [];
  });
  const patterns = new Set(excludePatterns(placed));
  for (const relative of mcpFiles) {
    const directory = path.posix.dirname(relative);
    const base = path.posix.basename(relative);
    patterns.add(`/${relative}`);
    // MCP management's atomic writer stages `.<name>.orkestrator-<id>.tmp` beside the file.
    patterns.add(`${directory === "." ? "" : `/${directory}`}/.${base}.orkestrator-*`);
  }
  await writeExcludeBlock(
    commonDir,
    `${EXCLUDE_OWNER_PREFIX}${environmentId}`,
    [...patterns].sort(),
    (owner) =>
      !owner.startsWith(EXCLUDE_OWNER_PREFIX) ||
      knownEnvironment(owner.slice(EXCLUDE_OWNER_PREFIX.length)),
  );
}

/** A file location whose last managed file was removed keeps no empty index behind. */
export async function dropEmptyIndexes(
  targets: readonly NodePlanTarget[],
  results: readonly NodePlanResult[],
  locate: WorktreeLocator,
): Promise<void> {
  const removed = new Set(
    results.filter((result) => result.status === "ready").map((result) => result.key),
  );
  const directories = new Set<string>();
  for (const target of targets) {
    if (target.action !== "remove" || !removed.has(target.key) || !target.locationId) continue;
    const located = locate(target.locationId);
    if (located?.location.layout === "file") directories.add(located.directory);
  }
  for (const directory of directories) {
    const index = await readLocationIndex(directory);
    if (Object.keys(index.files).length > 0) continue;
    await removeManagedPath(directory, CAPABILITY_LOCATION_INDEX).catch(() => false);
  }
}

const FILE_KINDS: ReadonlySet<ComponentKind> = new Set(["skill", "command", "prompt", "subagent"]);

/**
 * Applies a scoped plan to one worktree on this machine: collisions are
 * checked again right before writing, the exclude block lists `keep` and
 * everything about to be written, the executor writes with the worktree's
 * locations, and the block then follows what is there.
 */
export async function applyWorktreePlan(
  deps: {
    storage: { capabilities: CapabilitiesStorage };
    artifacts: CapabilityArtifactStore;
    homes(): CapabilityHomes;
    git: GitRunner;
    /** The environment's MCP installer (MCP management, environment scope). */
    projectMcp?: McpInstaller;
    now?: () => string;
  },
  input: {
    /** This machine: the executor's keys start with it. */
    nodeId: string;
    worktree: string;
    environmentId: string;
    targets: readonly NodePlanTarget[];
    /** Copies already there that stay (the environment's other receipts). */
    keep: readonly WorktreeEntry[];
    knownEnvironment(environmentId: string): boolean;
  },
): Promise<NodePlanResult[]> {
  const entryOf = (target: NodePlanTarget): WorktreeEntry => ({
    key: target.key,
    locationId: target.locationId ?? "",
    componentName: target.componentName,
    pathOrKey: target.pathOrKey,
  });
  const writes = input.targets.filter((target) => target.action !== "remove");
  const collisions = await worktreeCollisions(deps.git, input.worktree, writes.map(entryOf));
  const results: NodePlanResult[] = [];
  const runnable: NodePlanTarget[] = [];
  for (const target of input.targets) {
    const reason = collisions.get(target.key);
    const mcpTarget =
      target.kind === "mcp-server" &&
      target.locationId !== undefined &&
      projectMcpLocation(target.locationId)?.provider === target.provider;
    if (!FILE_KINDS.has(target.kind) && !mcpTarget) {
      results.push({
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason:
          "Only skills, commands, prompts, subagents and MCP servers are delivered into a worktree.",
      });
    } else if (reason) {
      results.push({ key: target.key, status: "failed", verification: "requested", reason });
    } else {
      runnable.push(target);
    }
  }
  const removing = new Set(
    runnable.filter((target) => target.action === "remove").map((target) => target.key),
  );
  const writing = runnable.filter((target) => target.action !== "remove");
  const mcpContext = {
    storage: deps.storage,
    nodeId: input.nodeId,
    environmentId: input.environmentId,
    worktree: input.worktree,
  };
  // Exclude before writing, so no status ever shows the copies.
  await syncWorktreeExclude(
    deps.git,
    input.worktree,
    input.environmentId,
    [...input.keep, ...writing.map(entryOf)],
    input.knownEnvironment,
    await projectMcpExcludeFiles(mcpContext, writing.map(entryOf)),
  );
  const locate = projectLocator(input.worktree);
  if (runnable.length > 0) {
    const executor = new CapabilityExecutor({
      storage: deps.storage,
      artifacts: deps.artifacts,
      homes: deps.homes,
      locate,
      ...(deps.projectMcp ? { mcp: projectMcpInstaller(deps.projectMcp, mcpContext) } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const applied = await executor.apply(runnable);
    await dropEmptyIndexes(runnable, applied, locate);
    results.push(...applied);
  }
  const byKey = new Map(results.map((result) => [result.key, result]));
  const written = writing.filter((target) => {
    const status = byKey.get(target.key)?.status;
    return status === "installed-next-session" || status === "ready";
  });
  const remaining = [
    ...input.keep.filter(
      (entry) => !(removing.has(entry.key) && byKey.get(entry.key)?.status === "ready"),
    ),
    ...written.map(entryOf),
  ];
  await syncWorktreeExclude(
    deps.git,
    input.worktree,
    input.environmentId,
    remaining,
    input.knownEnvironment,
    await projectMcpExcludeFiles(mcpContext, []),
  );
  return results;
}

/** At most this many managed copies are reported per location. */
const MAX_REPORTED_PER_LOCATION = 500;

async function markerComponent(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const marker = JSON.parse(await fs.readFile(file, "utf8")) as { componentId?: unknown };
    return typeof marker.componentId === "string" ? marker.componentId : null;
  } catch {
    return null;
  }
}

/**
 * The managed copies in a worktree's project directories, by location and
 * component, with the digest on disk: what a leaf reports to its command
 * node at launch (ids and digests only). A directory reached through a link
 * is not read.
 */
export async function managedWorktreeEntries(
  worktree: string,
): Promise<Array<{ locationId: string; componentId: string; digest: string }>> {
  const entries: Array<{ locationId: string; componentId: string; digest: string }> = [];
  for (const location of PROJECT_CAPABILITY_LOCATIONS) {
    const id = location.id;
    if (await linkedAncestor(worktree, location.relative)) continue;
    const directory = path.join(worktree, ...location.relative.split("/"));
    if (location.layout === "file") {
      const index = await readLocationIndex(directory);
      for (const [name, marker] of Object.entries(index.files).slice(
        0,
        MAX_REPORTED_PER_LOCATION,
      )) {
        const digest = await installedDigest(location, directory, name);
        if (digest) entries.push({ locationId: id, componentId: marker.componentId, digest });
      }
      continue;
    }
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children.slice(0, MAX_REPORTED_PER_LOCATION)) {
      if (!child.isDirectory()) continue;
      const componentId = await markerComponent(
        path.join(directory, child.name, CAPABILITY_MARKER_FILE),
      );
      if (!componentId) continue;
      const digest = await installedDigest(location, directory, child.name);
      if (digest) entries.push({ locationId: id, componentId, digest });
    }
  }
  return entries;
}
