import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  defaultRuntimeProfileRoots,
  statusManifestPath,
  type RuntimeProfile,
  type RuntimeProfileRoots,
  type RuntimeProcessName,
  type RuntimeStatusManifest,
} from "../../electron/runtime-profile.js";
import {
  liveness,
  readAndValidateSentinel,
  readProfile,
  readStatus,
  removeProfileState,
} from "./profile-io.js";

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

const runCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const DAY_MS = 24 * 60 * 60 * 1_000;

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type ProfileWorktree = { worktree: string; commonDir: string; branch: string | null };

/**
 * Worktrees that an environment inside the profile registered with a
 * repository outside it. Removing the profile directory alone leaves them in
 * that repository's `git worktree list`, and leaves their branches behind.
 * Fixture repositories live inside the profile and go with it.
 */
async function externalProfileWorktrees(profile: RuntimeProfile): Promise<ProfileWorktree[]> {
  const entries = await readdir(profile.worktreeDir, { withFileTypes: true }).catch(() => []);
  const found: ProfileWorktree[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktree = path.join(profile.worktreeDir, entry.name);
    const gitFile = await readFile(path.join(worktree, ".git"), "utf8").catch(() => null);
    const gitDirLine = gitFile ? /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1]?.trim() : undefined;
    if (!gitDirLine) continue;
    const gitDir = path.resolve(worktree, gitDirLine);
    const commonRelative = (
      await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")
    ).trim();
    if (!commonRelative) continue;
    const commonDir = path.resolve(gitDir, commonRelative);
    if (isSameOrInside(commonDir, profile.profileRoot) || !existsSync(commonDir)) continue;
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
    found.push({
      worktree,
      commonDir,
      branch: head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null,
    });
  }
  return found;
}

function refExists(run: CommandRunner, gitDir: string, ref: string): boolean {
  return run("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", ref]).status === 0;
}

function assertCleanWorktrees(worktrees: ProfileWorktree[], run: CommandRunner): void {
  for (const { worktree } of worktrees) {
    const status = run("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
    if (status.status !== 0) {
      throw new Error(`Could not inspect linked worktree ${worktree}; profile was kept`);
    }
    if (status.stdout.trim()) {
      throw new Error(`Linked worktree ${worktree} has uncommitted changes; profile was kept`);
    }
  }
}

/**
 * The same no-data-loss rule environment deletion applies: a branch is only
 * disposable when its tip is already contained in the default branch. Anything
 * else may hold the only copy of someone's commits, so it is kept and named.
 */
export function branchIsDisposable(run: CommandRunner, gitDir: string, branch: string): boolean {
  const ref = `refs/heads/${branch}`;
  if (!refExists(run, gitDir, ref)) return false;
  const checkedOut = run("git", ["--git-dir", gitDir, "worktree", "list", "--porcelain"]);
  if (checkedOut.status !== 0 || checkedOut.stdout.split("\n").includes(`branch ${ref}`)) {
    return false;
  }
  const originHead = run("git", [
    "--git-dir",
    gitDir,
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  const originDefault = originHead.status === 0 ? originHead.stdout.trim() : "";
  const localDefaults = ["refs/heads/main", "refs/heads/master"];
  if (originDefault)
    localDefaults.push(originDefault.replace("refs/remotes/origin/", "refs/heads/"));
  // Never the default branch itself, even though it is an ancestor of origin's.
  if (localDefaults.includes(ref)) return false;
  const bases = [originDefault, "refs/remotes/origin/main", ...localDefaults].filter(
    (base) => base && refExists(run, gitDir, base),
  );
  return bases.some(
    (base) =>
      run("git", ["--git-dir", gitDir, "merge-base", "--is-ancestor", ref, base]).status === 0,
  );
}

export type ProfileRemoval = {
  containersRemoved: number;
  volumesRemoved: number;
  networksRemoved: number;
  worktreesReleased: number;
  branchesDeleted: string[];
  branchesKept: string[];
};

export type RemoveProfileOptions = {
  keepToolchains: boolean;
  /** Explicit reset may discard uncommitted work in linked worktrees. */
  force?: boolean;
  roots?: RuntimeProfileRoots;
  run?: CommandRunner;
};

/**
 * Remove one stopped profile: its exact-owner containers, any worktrees it
 * registered with an outside repository, and its disposable state. Callers
 * check liveness first; the sentinel check here refuses anything that is not
 * a development profile directory.
 */
export async function removeProfile(
  profile: RuntimeProfile,
  options: RemoveProfileOptions,
): Promise<ProfileRemoval> {
  const run = options.run ?? runCommand;
  await readAndValidateSentinel(profile, options.roots);
  const worktrees = await externalProfileWorktrees(profile);
  if (!options.force) assertCleanWorktrees(worktrees, run);

  let containersRemoved = 0;
  const listed = run("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=orkestrator-owner=${profile.dockerOwner}`,
  ]);
  if (listed.status === 0) {
    const ids = listed.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.length) {
      const removed = run("docker", ["rm", "-f", ...ids]);
      if (removed.status !== 0)
        throw new Error(removed.stderr.trim() || "Could not remove profile Docker containers");
      containersRemoved = ids.length;
    }
  }

  // Persistent volumes and per-environment networks carry the same exact
  // owner label. Remove them after their containers release them.
  const ownedResources = (kind: "volume" | "network") => {
    const found = run("docker", [
      kind,
      "ls",
      "-q",
      "--filter",
      `label=orkestrator-owner=${profile.dockerOwner}`,
    ]);
    return found.status === 0
      ? found.stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  };
  let volumesRemoved = 0;
  let networksRemoved = 0;
  for (const kind of ["volume", "network"] as const) {
    const names = ownedResources(kind);
    if (!names.length) continue;
    const removed = run("docker", [kind, "rm", ...names]);
    if (removed.status !== 0) {
      throw new Error(removed.stderr.trim() || `Could not remove profile Docker ${kind}s`);
    }
    if (kind === "volume") volumesRemoved = names.length;
    else networksRemoved = names.length;
  }

  for (const { worktree, commonDir } of worktrees) {
    const removed = run("git", ["--git-dir", commonDir, "worktree", "remove", "--force", worktree]);
    if (removed.status !== 0) throw new Error(`Could not release linked worktree ${worktree}`);
  }

  await removeProfileState(profile, options.keepToolchains);

  const branchesDeleted: string[] = [];
  const branchesKept: string[] = [];
  for (const commonDir of new Set(worktrees.map((entry) => entry.commonDir))) {
    run("git", ["--git-dir", commonDir, "worktree", "prune"]);
  }
  for (const { commonDir, branch } of worktrees) {
    if (!branch) continue;
    if (
      branchIsDisposable(run, commonDir, branch) &&
      run("git", ["--git-dir", commonDir, "branch", "-D", branch]).status === 0
    ) {
      branchesDeleted.push(branch);
    } else {
      branchesKept.push(branch);
    }
  }
  return {
    containersRemoved,
    volumesRemoved,
    networksRemoved,
    worktreesReleased: worktrees.length,
    branchesDeleted,
    branchesKept,
  };
}

export type PruneOutcome = {
  id: string;
  action: "removed" | "would-remove" | "kept" | "failed";
  reason: string;
  branchesKept?: string[];
};

export type PruneProfilesOptions = {
  roots?: RuntimeProfileRoots;
  /** Also remove stopped profiles last used longer ago than this. */
  olderThanDays?: number;
  dryRun?: boolean;
  keepToolchains?: boolean;
  /** Required to discard uncommitted changes in linked worktrees. */
  force?: boolean;
  /** Profile IDs never to touch, such as the one about to start. */
  exclude?: readonly string[];
  now?: () => number;
  run?: CommandRunner;
  isLive?: (status: RuntimeStatusManifest) => Record<RuntimeProcessName, boolean>;
};

async function lastUsedAt(
  profile: RuntimeProfile,
  status: RuntimeStatusManifest | null,
): Promise<number> {
  const updated = status ? Date.parse(status.updatedAt) : Number.NaN;
  if (Number.isFinite(updated)) return updated;
  const profileFile = await stat(path.join(profile.profileRoot, "profile.json")).catch(() => null);
  return profileFile?.mtimeMs ?? 0;
}

/**
 * Remove development profiles nobody can use any more.
 *
 * A profile is removed when the checkout it was created from no longer
 * exists, or, with `olderThanDays`, when it has not been started or stopped
 * within that window. Running profiles, profiles without a valid sentinel,
 * and directories whose `profile.json` does not describe them are kept.
 */
export async function pruneProfiles(options: PruneProfilesOptions = {}): Promise<PruneOutcome[]> {
  const roots = options.roots ?? defaultRuntimeProfileRoots();
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const isLive = options.isLive ?? liveness;
  const exclude = new Set(options.exclude ?? []);
  const profilesRoot = path.join(roots.developmentRoot, "profiles");
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);

  const outcomes: PruneOutcome[] = [];
  const keptImages = new Set<string>();
  const orphanImages = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const profileRoot = path.join(profilesRoot, id);
    const keep = (reason: string, profile?: RuntimeProfile) => {
      if (profile) keptImages.add(profile.dockerImage);
      outcomes.push({ id, action: "kept", reason });
    };
    if (exclude.has(id)) {
      keep("requested by this run");
      continue;
    }

    let profile: RuntimeProfile;
    try {
      profile = await readProfile(path.join(profileRoot, "profile.json"));
    } catch {
      keep("profile.json is missing or invalid");
      continue;
    }
    if (profile.id !== id || path.resolve(profile.profileRoot) !== profileRoot) {
      keep("profile.json describes a different directory", profile);
      continue;
    }
    try {
      await readAndValidateSentinel(profile, roots);
    } catch {
      keep("sentinel is missing or does not match", profile);
      continue;
    }
    const status = await readStatus(statusManifestPath(profile));
    if (status && Object.values(isLive(status)).some(Boolean)) {
      keep("running", profile);
      continue;
    }

    const orphaned = !existsSync(profile.repositoryRoot);
    let reason: string | null = orphaned ? "its checkout no longer exists" : null;
    if (!reason && options.olderThanDays !== undefined) {
      const idleDays = (now() - (await lastUsedAt(profile, status))) / DAY_MS;
      if (idleDays > options.olderThanDays) reason = `unused for ${Math.floor(idleDays)} days`;
    }
    if (!reason) {
      keep("in use", profile);
      continue;
    }
    if (options.dryRun) {
      try {
        if (!options.force) assertCleanWorktrees(await externalProfileWorktrees(profile), run);
        outcomes.push({ id, action: "would-remove", reason });
      } catch (error) {
        keptImages.add(profile.dockerImage);
        outcomes.push({
          id,
          action: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    try {
      const removal = await removeProfile(profile, {
        keepToolchains: options.keepToolchains ?? false,
        force: options.force,
        roots,
        run,
      });
      if (orphaned) orphanImages.add(profile.dockerImage);
      outcomes.push({
        id,
        action: "removed",
        reason,
        ...(removal.branchesKept.length ? { branchesKept: removal.branchesKept } : {}),
      });
    } catch (error) {
      keptImages.add(profile.dockerImage);
      outcomes.push({
        id,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The development image is named after the checkout, so once that checkout
  // is gone nothing can rebuild or reuse it. `image rm` without `--force`
  // refuses an image a container still uses; a missing image is not an error.
  for (const image of orphanImages) {
    if (!keptImages.has(image)) run("docker", ["image", "rm", image]);
  }
  return outcomes;
}

export function formatPruneOutcome(outcome: PruneOutcome): string {
  const verb = {
    removed: "Removed",
    "would-remove": "Would remove",
    kept: "Kept",
    failed: "Could not remove",
  }[outcome.action];
  const kept = outcome.branchesKept?.length
    ? ` Kept unmerged branch(es): ${outcome.branchesKept.join(", ")}.`
    : "";
  return `${verb} profile ${outcome.id}: ${outcome.reason}.${kept}`;
}

const BUILD_CACHE_WARNING_BYTES = 25e9;
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
};

/** Parse Docker's decimal size strings, such as `40.23GB` or `512kB`. */
export function parseDockerSize(value: string): number | null {
  const match = /^([\d.]+)\s*([kKMGT]?B)$/.exec(value.trim());
  if (!match) return null;
  const multiplier = SIZE_UNITS[match[2]!.toUpperCase()];
  const amount = Number(match[1]);
  return multiplier && Number.isFinite(amount) ? amount * multiplier : null;
}

/**
 * A warning when the Docker build cache is large, or null.
 *
 * The build cache is shared with every other project on the machine, so it is
 * never pruned from here; the daemon's own GC limit is the durable fix.
 */
export function dockerBuildCacheWarning(run: CommandRunner = runCommand): string | null {
  const result = run("docker", ["system", "df", "--format", "{{.Type}}\t{{.Size}}"]);
  if (result.status !== 0) return null;
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("Build Cache\t"));
  const bytes = line ? parseDockerSize(line.split("\t")[1] ?? "") : null;
  if (bytes === null || bytes < BUILD_CACHE_WARNING_BYTES) return null;
  return (
    `Docker's build cache is ${(bytes / 1e9).toFixed(1)} GB. Set builder.gc.defaultKeepStorage ` +
    `in the Docker daemon configuration to cap it, or run ` +
    `\`docker builder prune --max-used-space 15GB\` once. See docs/development/disk-usage.md.`
  );
}
