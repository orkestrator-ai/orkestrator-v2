import { captureWorktreePathIdentity } from "@orkestrator/protocol/node/worktree-paths";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { tryLockProfile } from "./profile-lock.js";

import {
  defaultRuntimeProfileRoots,
  runtimeProfileElectronTitle,
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
  isRemovedProfileSkeleton,
  removeProfileSkeleton,
  removeProfileState,
  assertExternalWorktreeOwnership,
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

/** `security` exits with errSecItemNotFound once no matching item is left. */
export const KEYCHAIN_ITEM_NOT_FOUND_EXIT = 44;
/** A Keychain can hold more than one matching item; this bounds the loop. */
const MAX_KEYCHAIN_ITEM_DELETIONS = 8;
/**
 * A locked login Keychain can make `security` wait on an unlock dialog, and
 * start-up pruning runs unattended. A timed-out call reports no status.
 */
const KEYCHAIN_COMMAND_TIMEOUT_MS = 15_000;

const runKeychainCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export type KeychainItemRemoval = { removed: number; warning: string | null };

/**
 * Removes a profile's `safeStorage` key from the macOS login Keychain.
 * Electron stores it as the generic password "<app name> Safe Storage" with
 * account "<app name>", and a profile's app name is its `electronTitle`, so
 * every reset profile used to leave one behind. The item is named by title
 * alone, so two guards keep this to the profile's own item:
 *
 * - The title must be the one `dev:test` gives this profile id. A
 *   `profile.json` naming another title (the production app's, say) must
 *   never delete that app's key.
 * - The profile must live under `ownerRoots`, the platform's own development
 *   root. A profile of the same id under another root (a test harness, a
 *   temporary root) has the same title, so the item is the real profile's.
 *
 * A failure is reported, not thrown, because the profile state is already
 * gone by then.
 */
export function removeProfileKeychainItem(
  profile: RuntimeProfile,
  run: CommandRunner = runKeychainCommand,
  platform: NodeJS.Platform = process.platform,
  ownerRoots?: RuntimeProfileRoots,
): KeychainItemRemoval {
  if (platform !== "darwin") return { removed: 0, warning: null };
  if (profile.electronTitle !== runtimeProfileElectronTitle(profile.id)) {
    return {
      removed: 0,
      warning: `Kept the login Keychain item for "${profile.electronTitle}": it is not this profile's title.`,
    };
  }
  const owners = ownerRoots ?? defaultRuntimeProfileRoots(platform);
  const ownProfileRoot = path.resolve(owners.developmentRoot, "profiles", profile.id);
  if (path.resolve(profile.profileRoot) !== ownProfileRoot) {
    return {
      removed: 0,
      warning: `Kept the login Keychain item for "${profile.electronTitle}": the profile is outside the default development root, whose profile of the same id owns it.`,
    };
  }
  const service = `${profile.electronTitle} Safe Storage`;
  let removed = 0;
  for (let attempt = 0; attempt < MAX_KEYCHAIN_ITEM_DELETIONS; attempt += 1) {
    const result = run("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      profile.electronTitle,
    ]);
    if (result.status === 0) {
      removed += 1;
      continue;
    }
    if (result.status === KEYCHAIN_ITEM_NOT_FOUND_EXIT) return { removed, warning: null };
    return {
      removed,
      warning: `Could not remove the login Keychain item "${service}" (security exited ${result.status ?? "without a status"}); delete it in Keychain Access.`,
    };
  }
  return { removed, warning: null };
}

export type ProfileRemoval = {
  containersRemoved: number;
  volumesRemoved: number;
  networksRemoved: number;
  worktreesReleased: number;
  branchesDeleted: string[];
  branchesKept: string[];
  /** macOS `safeStorage` Keychain items removed (always 0 elsewhere). */
  keychainItemsRemoved: number;
  keychainWarning: string | null;
};

export type RemoveProfileOptions = {
  keepToolchains: boolean;
  /** Explicit reset may discard uncommitted work in linked worktrees. */
  force?: boolean;
  roots?: RuntimeProfileRoots;
  run?: CommandRunner;
  /** Selects the Keychain step; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /**
   * The roots whose profiles own their title's Keychain item; defaults to the
   * platform's own development root. Tests point it at their temporary roots.
   */
  keychainRoots?: RuntimeProfileRoots;
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
  await assertExternalWorktreeOwnership(profile);
  const recheckWorktrees = captureWorktreePathIdentity(profile.worktreeDir);
  const recheckProfile = captureWorktreePathIdentity(profile.profileRoot);
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
    recheckWorktrees();
    recheckProfile();
    await assertExternalWorktreeOwnership(profile);
    const removed = run("git", ["--git-dir", commonDir, "worktree", "remove", "--force", worktree]);
    if (removed.status !== 0) throw new Error(`Could not release linked worktree ${worktree}`);
  }

  recheckWorktrees();
  recheckProfile();
  await removeProfileState(profile, options.keepToolchains);
  // Only once the state it encrypts is gone: a failed reset keeps both.
  const keychain = removeProfileKeychainItem(
    profile,
    options.run ?? runKeychainCommand,
    options.platform,
    options.keychainRoots,
  );

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
    keychainItemsRemoved: keychain.removed,
    keychainWarning: keychain.warning,
  };
}

export type PruneOutcome = {
  id: string;
  action: "removed" | "would-remove" | "kept" | "failed";
  reason: string;
  branchesKept?: string[];
  keychainWarning?: string;
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
  /** Selects the Keychain step of each removal; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /** See `RemoveProfileOptions.keychainRoots`. */
  keychainRoots?: RuntimeProfileRoots;
  /** Barrier after skeleton selection, while holding the startup lock. */
  afterSkeletonSelection?: (profileRoot: string) => void | Promise<void>;
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
 * within that window. Running profiles and directories whose `profile.json`
 * does not describe them are kept. A valid sentinel is required except for
 * empty reset skeletons, which only the age rule can remove under a startup lock.
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
    const unlock = tryLockProfile(profileRoot);
    if (!unlock) {
      keep("initialization or pruning in progress");
      continue;
    }
    try {
      if (await isRemovedProfileSkeleton(profileRoot)) {
        // What a removal keeps so the name can boot containers again (see
        // `removeProfileState`). Only the age rule deletes it, quietly otherwise.
        if (options.olderThanDays === undefined) continue;
        const idleDays =
          (now() - ((await stat(profileRoot).catch(() => null))?.mtimeMs ?? 0)) / DAY_MS;
        if (idleDays <= options.olderThanDays) continue;
        const reason = `emptied ${Math.floor(idleDays)} days ago`;
        if (options.dryRun) {
          outcomes.push({ id, action: "would-remove", reason });
          continue;
        }
        try {
          await options.afterSkeletonSelection?.(profileRoot);
          await removeProfileSkeleton(profileRoot);
          outcomes.push({ id, action: "removed", reason });
        } catch (error) {
          outcomes.push({
            id,
            action: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
    } finally {
      unlock();
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
        platform: options.platform,
        keychainRoots: options.keychainRoots,
      });
      if (orphaned) orphanImages.add(profile.dockerImage);
      outcomes.push({
        id,
        action: "removed",
        reason,
        ...(removal.branchesKept.length ? { branchesKept: removal.branchesKept } : {}),
        ...(removal.keychainWarning ? { keychainWarning: removal.keychainWarning } : {}),
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
  const keychain = outcome.keychainWarning ? ` ${outcome.keychainWarning}` : "";
  return `${verb} profile ${outcome.id}: ${outcome.reason}.${kept}${keychain}`;
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
