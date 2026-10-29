import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEV_PROFILE_SENTINEL,
  resolveRuntimeProfile,
  statusManifestPath,
  type RuntimeProfile,
  type RuntimeProfileRoots,
} from "../../electron/runtime-profile.js";
import { parsePruneArguments } from "./arguments.js";
import {
  dockerBuildCacheWarning,
  formatPruneOutcome,
  KEYCHAIN_ITEM_NOT_FOUND_EXIT,
  parseDockerSize,
  pruneProfiles,
  removeProfile,
  removeProfileKeychainItem,
  type CommandRunner,
} from "./profile-cleanup.js";
import {
  atomicWriteJson,
  initializeProfile,
  isRemovedProfileSkeleton,
  removeProfileSkeleton,
} from "./profile-io.js";

let root: string;
let roots: RuntimeProfileRoots;
let checkout: string;
let dockerCalls: string[][];
let securityCalls: string[][];

/**
 * Real git, recorded Docker and `security`: no test here may reach a real
 * daemon or the host's login Keychain. No Keychain item exists by default.
 */
const run: CommandRunner = (command, args) => {
  if (command === "docker") {
    dockerCalls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command === "security") {
    securityCalls.push(args);
    return { status: KEYCHAIN_ITEM_NOT_FOUND_EXIT, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function createProfile(id: string, repositoryRoot = checkout): Promise<RuntimeProfile> {
  const profile = resolveRuntimeProfile({ repositoryRoot, requestedId: id, roots });
  await initializeProfile(profile);
  return profile;
}

async function writeStatus(
  profile: RuntimeProfile,
  fields: { status: string; updatedAt: string; pids?: Record<string, number> },
): Promise<void> {
  await atomicWriteJson(statusManifestPath(profile), {
    version: 1,
    status: fields.status,
    profile: profile.id,
    flavor: "development",
    dataDir: profile.dataDir,
    electronTitle: profile.electronTitle,
    rendererUrl: "http://127.0.0.1:1",
    logDir: profile.logDir,
    statusPath: statusManifestPath(profile),
    startedAt: fields.updatedAt,
    updatedAt: fields.updatedAt,
    pids: fields.pids ?? {},
    processStartTimes: fields.pids ?? {},
  });
}

const gone = () => path.join(root, "deleted-checkout");
const actions = (outcomes: Awaited<ReturnType<typeof pruneProfiles>>) =>
  Object.fromEntries(outcomes.map((outcome) => [outcome.id, outcome.action]));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-profile-cleanup-"));
  roots = {
    developmentRoot: path.join(root, "dev"),
    productionDataDir: path.join(root, "production"),
    homeDir: root,
  };
  checkout = path.join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  dockerCalls = [];
  securityCalls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("removeProfile", () => {
  test("removes exact-owner containers, volumes, and networks before profile state", async () => {
    const profile = await createProfile("resources");
    const owner = `label=orkestrator-owner=${profile.dockerOwner}`;
    const recorded: string[][] = [];
    const resourceRun: CommandRunner = (command, args) => {
      if (command !== "docker") return run(command, args);
      recorded.push(args);
      const output =
        args[0] === "ps"
          ? "container-one\n"
          : args[0] === "volume" && args[1] === "ls"
            ? "volume-one\nvolume-two\n"
            : args[0] === "network" && args[1] === "ls"
              ? "network-one\n"
              : "";
      return { status: 0, stdout: output, stderr: "" };
    };

    const result = await removeProfile(profile, {
      keepToolchains: false,
      roots,
      run: resourceRun,
    });

    expect(result).toMatchObject({
      containersRemoved: 1,
      volumesRemoved: 2,
      networksRemoved: 1,
    });
    expect(recorded).toEqual([
      ["ps", "-aq", "--filter", owner],
      ["rm", "-f", "container-one"],
      ["volume", "ls", "-q", "--filter", owner],
      ["volume", "rm", "volume-one", "volume-two"],
      ["network", "ls", "-q", "--filter", owner],
      ["network", "rm", "network-one"],
    ]);
    expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(true);
  });

  test("keeps profile state when an owned volume cannot be removed", async () => {
    const profile = await createProfile("volume-failure");
    const resourceRun: CommandRunner = (command, args) => {
      if (command !== "docker") return run(command, args);
      if (args[0] === "volume" && args[1] === "ls") {
        return { status: 0, stdout: "volume-one\n", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "rm") {
        return { status: 1, stdout: "", stderr: "volume is in use" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    await expect(
      removeProfile(profile, { keepToolchains: false, roots, run: resourceRun }),
    ).rejects.toThrow("volume is in use");
    expect(existsSync(path.join(profile.profileRoot, "profile.json"))).toBe(true);
  });
});

describe("profile Keychain item", () => {
  /** A Keychain holding `items` copies of each named service. */
  function keychain(items: Record<string, number>): CommandRunner {
    return (command, args) => {
      if (command !== "security") return run(command, args);
      securityCalls.push(args);
      const service = args[args.indexOf("-s") + 1]!;
      if ((items[service] ?? 0) === 0) {
        return { status: KEYCHAIN_ITEM_NOT_FOUND_EXIT, stdout: "", stderr: "" };
      }
      items[service]! -= 1;
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  test("reset deletes only the profile's own Safe Storage item, after its state", async () => {
    const profile = await createProfile("keychain");
    const service = `${profile.electronTitle} Safe Storage`;
    const items = { [service]: 2, "Orkestrator AI Safe Storage": 1 };
    let stateGoneFirst = true;
    const keychainRun = keychain(items);
    const result = await removeProfile(profile, {
      keepToolchains: false,
      roots,
      platform: "darwin",
      keychainRoots: roots,
      run: (command, args) => {
        if (command === "security")
          stateGoneFirst &&= !existsSync(path.join(profile.profileRoot, "profile.json"));
        return keychainRun(command, args);
      },
    });

    expect(result).toMatchObject({ keychainItemsRemoved: 2, keychainWarning: null });
    expect(stateGoneFirst).toBe(true);
    expect(items).toEqual({ [service]: 0, "Orkestrator AI Safe Storage": 1 });
    expect(securityCalls).toEqual(
      Array.from({ length: 3 }, () => [
        "delete-generic-password",
        "-s",
        "Orkestrator AI — DEV [keychain] Safe Storage",
        "-a",
        "Orkestrator AI — DEV [keychain]",
      ]),
    );
  });

  test("keeps the item when the profile state could not be removed", async () => {
    const profile = await createProfile("keychain-kept");
    const failing: CommandRunner = (command, args) =>
      command === "docker" && args[0] === "ps"
        ? { status: 0, stdout: "container-one\n", stderr: "" }
        : command === "docker" && args[0] === "rm"
          ? { status: 1, stdout: "", stderr: "container is busy" }
          : run(command, args);
    await expect(
      removeProfile(profile, {
        keepToolchains: false,
        roots,
        platform: "darwin",
        keychainRoots: roots,
        run: failing,
      }),
    ).rejects.toThrow("container is busy");
    expect(securityCalls).toEqual([]);
  });

  test("never touches the Keychain off macOS", async () => {
    const profile = await createProfile("keychain-linux");
    const result = await removeProfile(profile, {
      keepToolchains: false,
      roots,
      platform: "linux",
      run,
    });
    expect(result).toMatchObject({ keychainItemsRemoved: 0, keychainWarning: null });
    expect(securityCalls).toEqual([]);
  });

  test("refuses a profile whose title is not the one dev:test gives its id", async () => {
    const profile = await createProfile("keychain-foreign");
    const result = removeProfileKeychainItem(
      { ...profile, electronTitle: "Orkestrator AI" },
      run,
      "darwin",
    );
    expect(result.removed).toBe(0);
    expect(result.warning).toContain('Kept the login Keychain item for "Orkestrator AI"');
    expect(securityCalls).toEqual([]);
  });

  test("keeps the item of a same-id profile under another development root", async () => {
    const profile = await createProfile("keychain-shadow");
    // `roots` is a temporary root, so the platform's own root, where the real
    // profile of this id lives and whose title is the same, owns the item.
    const result = await removeProfile(profile, {
      keepToolchains: false,
      roots,
      platform: "darwin",
      run,
    });
    expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(true);
    expect(result.keychainItemsRemoved).toBe(0);
    expect(result.keychainWarning).toContain("outside the default development root");
    expect(securityCalls).toEqual([]);

    const other = { ...roots, developmentRoot: path.join(root, "other-dev") };
    expect(removeProfileKeychainItem(profile, run, "darwin", other).removed).toBe(0);
    expect(securityCalls).toEqual([]);
  });

  test("reports a Keychain failure without failing the removal", async () => {
    const profile = await createProfile("keychain-locked");
    const locked: CommandRunner = (command, args) =>
      command === "security" ? { status: 51, stdout: "", stderr: "" } : run(command, args);
    const result = await removeProfile(profile, {
      keepToolchains: false,
      roots,
      platform: "darwin",
      keychainRoots: roots,
      run: locked,
    });
    expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(true);
    expect(result.keychainItemsRemoved).toBe(0);
    expect(result.keychainWarning).toBe(
      'Could not remove the login Keychain item "Orkestrator AI — DEV [keychain-locked] Safe Storage" (security exited 51); delete it in Keychain Access.',
    );
  });

  test("pruning removes an orphan's item and reports a failure in its outcome", async () => {
    const orphan = await createProfile("keychain-orphan", gone());
    const locked: CommandRunner = (command, args) =>
      command === "security" ? { status: 51, stdout: "", stderr: "" } : run(command, args);
    const [outcome] = await pruneProfiles({
      roots,
      run: locked,
      platform: "darwin",
      keychainRoots: roots,
    });
    expect(outcome).toMatchObject({ id: orphan.id, action: "removed" });
    expect(formatPruneOutcome(outcome!)).toEndWith(
      'Could not remove the login Keychain item "Orkestrator AI — DEV [keychain-orphan] Safe Storage" (security exited 51); delete it in Keychain Access.',
    );
  });
});

describe("pruneProfiles", () => {
  const old = new Date("2026-01-01T00:00:00.000Z");
  const now = () => Date.parse("2026-01-31T00:00:00.000Z");

  async function oldSkeleton(id: string) {
    const profile = await createProfile(id);
    await mkdir(path.join(profile.dataDir, "portable-inputs"));
    await removeProfile(profile, { keepToolchains: false, roots, run, platform: "linux" });
    await utimes(profile.profileRoot, old, old);
    return profile;
  }

  test("age pruning skips same-name startup paused before metadata publication", async () => {
    const profile = await oldSkeleton("starting");
    const directories = [
      profile.profileRoot,
      profile.dataDir,
      path.join(profile.dataDir, "portable-inputs"),
    ];
    const identities = await Promise.all(
      directories.map(async (directory) => (await stat(directory)).ino),
    );
    let paused = false;

    await initializeProfile(profile, {
      beforeMetadata: async () => {
        paused = true;
        expect(existsSync(path.join(profile.profileRoot, "profile.json"))).toBe(false);
        // All startup siblings exist but are still empty at this boundary.
        expect(await readdir(profile.runtimeDir)).toEqual([]);
        expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(false);
        await utimes(profile.profileRoot, old, old);
        expect(await pruneProfiles({ roots, run, olderThanDays: 14, now })).toEqual([
          { id: profile.id, action: "kept", reason: "initialization or pruning in progress" },
        ]);
        expect(
          await Promise.all(directories.map(async (directory) => (await stat(directory)).ino)),
        ).toEqual(identities);
      },
    });

    expect(paused).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(profile.profileRoot, "profile.json"), "utf8")).id,
    ).toBe(profile.id);
    expect(existsSync(path.join(profile.profileRoot, DEV_PROFILE_SENTINEL))).toBe(true);
    // Successful publication releases the lock.
    await initializeProfile(profile);
  });

  test("startup cannot enter a skeleton selected by pruning and can retry after removal", async () => {
    const profile = await oldSkeleton("selected");
    const outcomes = await pruneProfiles({
      roots,
      run,
      olderThanDays: 14,
      now,
      afterSkeletonSelection: async () => {
        await expect(initializeProfile(profile)).rejects.toThrow("pruning is in progress");
      },
    });
    expect(actions(outcomes)).toEqual({ selected: "removed" });
    await initializeProfile(profile);
    expect(existsSync(path.join(profile.profileRoot, DEV_PROFILE_SENTINEL))).toBe(true);
  });

  test("skeleton detection rejects empty startup siblings and unexpected data children", async () => {
    const profile = await oldSkeleton("shape");
    for (const unexpected of [profile.runtimeDir, path.join(profile.dataDir, "other")]) {
      await mkdir(unexpected);
      expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(false);
      expect(actions(await pruneProfiles({ roots, run, olderThanDays: 14, now }))).toEqual({
        shape: "kept",
      });
      await rm(unexpected, { recursive: true });
    }
    expect(await isRemovedProfileSkeleton(profile.profileRoot)).toBe(true);
  });

  test("content arriving after skeleton selection refuses rmdir and reports failure", async () => {
    const profile = await oldSkeleton("late-content");
    const late = path.join(profile.dataDir, "portable-inputs", "keep");
    const outcomes = await pruneProfiles({
      roots,
      run,
      olderThanDays: 14,
      now,
      afterSkeletonSelection: () => writeFile(late, "new input"),
    });
    expect(actions(outcomes)).toEqual({ "late-content": "failed" });
    expect(outcomes[0]?.reason).toContain("ENOTEMPTY");
    expect(await readFile(late, "utf8")).toBe("new input");
    expect(existsSync(profile.profileRoot)).toBe(true);
    // Failure also releases the startup lock.
    await initializeProfile(profile);
  });

  test("an already removed selected skeleton is a successful prune", async () => {
    const profile = await oldSkeleton("disappeared");
    const outcomes = await pruneProfiles({
      roots,
      run,
      olderThanDays: 14,
      now,
      afterSkeletonSelection: (directory) => rm(directory, { recursive: true }),
    });
    expect(actions(outcomes)).toEqual({ disappeared: "removed" });
    expect(existsSync(profile.profileRoot)).toBe(false);
  });

  test("an unexpected empty sibling appearing after selection blocks skeleton removal", async () => {
    const profile = await oldSkeleton("late-directory");
    const unexpected = path.join(profile.profileRoot, "new-state");
    const outcomes = await pruneProfiles({
      roots,
      run,
      olderThanDays: 14,
      now,
      afterSkeletonSelection: () => mkdir(unexpected),
    });
    expect(actions(outcomes)).toEqual({ "late-directory": "failed" });
    expect(outcomes[0]?.reason).toContain("ENOTEMPTY");
    expect(existsSync(unexpected)).toBe(true);
  });

  test("a skeleton descendant disappearing before enumeration is already removed", async () => {
    const profile = await oldSkeleton("descendant");
    const inputs = path.join(profile.dataDir, "portable-inputs");
    const realReaddir = fs.readdir;
    const enumerate = spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      if (args[0] === inputs) await rm(inputs, { recursive: true, force: true });
      return realReaddir(...args);
    }) as typeof fs.readdir);
    try {
      await expect(removeProfileSkeleton(profile.profileRoot)).resolves.toBeUndefined();
    } finally {
      enumerate.mockRestore();
    }
    expect(existsSync(profile.profileRoot)).toBe(false);
  });

  test("removes a stopped profile whose checkout is gone and keeps one that exists", async () => {
    const orphan = await createProfile("orphan", gone());
    await createProfile("current");

    const outcomes = await pruneProfiles({ roots, run });

    expect(actions(outcomes)).toEqual({ current: "kept", orphan: "removed" });
    expect(outcomes.find((entry) => entry.id === "orphan")?.reason).toBe(
      "its checkout no longer exists",
    );
    expect(await isRemovedProfileSkeleton(orphan.profileRoot)).toBe(true);
    expect(existsSync(path.join(roots.developmentRoot, "profiles", "current"))).toBe(true);
  });

  test("keeps running, excluded, and unverifiable profiles even when orphaned", async () => {
    const running = await createProfile("running", gone());
    await writeStatus(running, {
      status: "ready",
      updatedAt: new Date().toISOString(),
      pids: { launcher: 1 },
    });
    await createProfile("starting", gone());
    const unsigned = await createProfile("unsigned", gone());
    await rm(path.join(unsigned.profileRoot, DEV_PROFILE_SENTINEL));
    await mkdir(path.join(roots.developmentRoot, "profiles", "stray"), { recursive: true });
    await writeFile(path.join(roots.developmentRoot, "profiles", "stray", "notes.txt"), "mine");

    const outcomes = await pruneProfiles({
      roots,
      run,
      exclude: ["starting"],
      isLive: () => ({ launcher: true, vite: false, electron: false, backend: false }),
    });

    expect(actions(outcomes)).toEqual({
      running: "kept",
      starting: "kept",
      stray: "kept",
      unsigned: "kept",
    });
    for (const id of ["running", "starting", "stray", "unsigned"]) {
      expect(existsSync(path.join(roots.developmentRoot, "profiles", id))).toBe(true);
    }
  });

  test("a dry run reports without removing anything", async () => {
    const orphan = await createProfile("orphan", gone());

    const outcomes = await pruneProfiles({ roots, run, dryRun: true });

    expect(actions(outcomes)).toEqual({ orphan: "would-remove" });
    expect(existsSync(path.join(orphan.profileRoot, "profile.json"))).toBe(true);
    expect(dockerCalls).toEqual([]);
  });

  test("the age rule applies only when asked for", async () => {
    const idle = await createProfile("idle");
    await writeStatus(idle, { status: "stopped", updatedAt: "2026-01-01T00:00:00.000Z" });
    const now = () => Date.parse("2026-01-31T00:00:00.000Z");

    expect(actions(await pruneProfiles({ roots, run, now }))).toEqual({ idle: "kept" });
    const outcomes = await pruneProfiles({
      roots,
      run,
      now,
      olderThanDays: 14,
      keychainRoots: roots,
    });

    expect(outcomes).toEqual([{ id: "idle", action: "removed", reason: "unused for 30 days" }]);
    expect(await isRemovedProfileSkeleton(idle.profileRoot)).toBe(true);
  });

  test("leaves what a removal keeps alone until the age rule deletes it", async () => {
    const reset = await createProfile("reset");
    await removeProfile(reset, { keepToolchains: false, roots, run, platform: "linux" });
    const skeleton = reset.profileRoot;
    expect(await isRemovedProfileSkeleton(skeleton)).toBe(true);
    const at = (iso: string) => () => Date.parse(iso);
    await utimes(
      skeleton,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    // Silent and kept: it is no profile, and its name may start again.
    expect(await pruneProfiles({ roots, run })).toEqual([]);
    expect(
      await pruneProfiles({ roots, run, olderThanDays: 14, now: at("2026-01-10T00:00:00.000Z") }),
    ).toEqual([]);
    expect(
      await pruneProfiles({
        roots,
        run,
        olderThanDays: 14,
        dryRun: true,
        now: at("2026-01-31T00:00:00.000Z"),
      }),
    ).toEqual([{ id: "reset", action: "would-remove", reason: "emptied 30 days ago" }]);
    expect(existsSync(skeleton)).toBe(true);

    // A file that appears inside fails the removal instead of being deleted.
    const late = path.join(reset.dataDir, "late");
    await mkdir(late);
    await writeFile(path.join(late, "input"), "staged");
    expect(await isRemovedProfileSkeleton(skeleton)).toBe(false);
    await rm(late, { recursive: true });
    await utimes(
      skeleton,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(
      await pruneProfiles({ roots, run, olderThanDays: 14, now: at("2026-01-31T00:00:00.000Z") }),
    ).toEqual([{ id: "reset", action: "removed", reason: "emptied 30 days ago" }]);
    expect(existsSync(skeleton)).toBe(false);
  });

  test("removes exact-owner containers and the development image of a gone checkout", async () => {
    const orphan = await createProfile("orphan", gone());

    await pruneProfiles({ roots, run });

    expect(dockerCalls).toContainEqual([
      "ps",
      "-aq",
      "--filter",
      `label=orkestrator-owner=${orphan.dockerOwner}`,
    ]);
    expect(dockerCalls).toContainEqual(["image", "rm", orphan.dockerImage]);
  });

  test("keeps a development image another surviving profile still uses", async () => {
    const orphan = await createProfile("orphan", gone());
    const sibling = await createProfile("sibling", gone());
    await rm(path.join(sibling.profileRoot, DEV_PROFILE_SENTINEL));

    await pruneProfiles({ roots, run });

    expect(dockerCalls).not.toContainEqual(["image", "rm", orphan.dockerImage]);
  });

  test("unregisters worktrees the profile made in an outside repository", async () => {
    const repository = path.join(root, "repository");
    await mkdir(repository);
    git(repository, "init", "-q", "-b", "main");
    await writeFile(path.join(repository, "README.md"), "hello\n");
    git(repository, "add", ".");
    git(repository, "commit", "-q", "-m", "initial");

    const orphan = await createProfile("orphan", gone());
    const merged = path.join(orphan.worktreeDir, "merged");
    const unmerged = path.join(orphan.worktreeDir, "unmerged");
    git(repository, "worktree", "add", "-q", "-b", "env-merged", merged, "main");
    git(repository, "worktree", "add", "-q", "-b", "env-unmerged", unmerged, "main");
    await writeFile(path.join(unmerged, "work.txt"), "only copy\n");
    git(unmerged, "add", ".");
    git(unmerged, "commit", "-q", "-m", "work");

    const outcomes = await pruneProfiles({ roots, run, keychainRoots: roots });

    expect(outcomes).toEqual([
      {
        id: "orphan",
        action: "removed",
        reason: "its checkout no longer exists",
        branchesKept: ["env-unmerged"],
      },
    ]);
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(orphan.worktreeDir);
    const branches = git(repository, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).toContain("main");
    expect(branches).toContain("env-unmerged");
    expect(branches).not.toContain("env-merged");
  });

  test("keeps the entire orphan profile when a linked worktree has tracked or untracked changes", async () => {
    const repository = path.join(root, "repository");
    await mkdir(repository);
    git(repository, "init", "-q", "-b", "main");
    await writeFile(path.join(repository, "README.md"), "hello\n");
    git(repository, "add", ".");
    git(repository, "commit", "-q", "-m", "initial");
    const orphan = await createProfile("orphan", gone());
    const tracked = path.join(orphan.worktreeDir, "tracked");
    const untracked = path.join(orphan.worktreeDir, "untracked");
    git(repository, "worktree", "add", "-q", "-b", "env-tracked", tracked, "main");
    git(repository, "worktree", "add", "-q", "-b", "env-untracked", untracked, "main");
    await writeFile(path.join(tracked, "README.md"), "edited\n");
    await writeFile(path.join(untracked, "notes.txt"), "only copy\n");

    expect(actions(await pruneProfiles({ roots, run, dryRun: true }))).toEqual({
      orphan: "failed",
    });

    const outcomes = await pruneProfiles({ roots, run });

    expect(outcomes[0]?.action).toBe("failed");
    expect(outcomes[0]?.reason).toContain("uncommitted changes");
    expect(existsSync(path.join(orphan.profileRoot, "profile.json"))).toBe(true);
    expect(existsSync(path.join(tracked, "README.md"))).toBe(true);
    expect(existsSync(path.join(untracked, "notes.txt"))).toBe(true);
    expect(dockerCalls).toEqual([]);
    expect(git(repository, "worktree", "list", "--porcelain")).toContain(orphan.worktreeDir);

    expect(actions(await pruneProfiles({ roots, run, force: true }))).toEqual({
      orphan: "removed",
    });
  });
});

describe("Docker build cache warning", () => {
  test("parses Docker's decimal sizes", () => {
    expect(parseDockerSize("40.23GB")).toBe(40.23e9);
    expect(parseDockerSize("512kB")).toBe(512e3);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("n/a")).toBeNull();
  });

  test("warns only above the threshold and never when Docker is unavailable", () => {
    const df =
      (size: string, status = 0): CommandRunner =>
      () => ({ status, stdout: `Images\t7.3GB\nBuild Cache\t${size}\n`, stderr: "" });

    expect(dockerBuildCacheWarning(df("40.23GB"))).toContain("40.2 GB");
    expect(dockerBuildCacheWarning(df("12GB"))).toBeNull();
    expect(dockerBuildCacheWarning(df("40GB", 1))).toBeNull();
  });
});

describe("dev:prune arguments", () => {
  test("parses its own options and rejects everything else", () => {
    expect(parsePruneArguments(["--dry-run", "--older-than", "14", "--json"])).toEqual({
      dryRun: true,
      force: false,
      json: true,
      keepToolchains: false,
      olderThanDays: 14,
    });
    expect(parsePruneArguments(["--force"]).force).toBe(true);
    expect(() => parsePruneArguments(["--older-than", "soon"])).toThrow(/whole number/);
    expect(() => parsePruneArguments(["--older-than"])).toThrow(/whole number/);
    expect(() => parsePruneArguments(["--profile", "x"])).toThrow(/Unknown prune option/);
  });
});

test("reset and orphan prune preserve linked worktrees without external ownership", async () => {
  git(checkout, "init", "-b", "main");
  await writeFile(path.join(checkout, "file"), "source");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "initial");
  for (const sentinel of [null, { version: 1, profile: "someone-else" }]) {
    const id = sentinel ? "mismatched" : "missing";
    const profile = resolveRuntimeProfile({
      repositoryRoot: gone(),
      requestedId: id,
      roots,
      worktreeRoot: path.join(root, "trees"),
    });
    await initializeProfile(profile);
    const linked = path.join(profile.worktreeDir, "linked");
    git(checkout, "worktree", "add", "-b", id, linked);
    const marker = path.join(profile.worktreeDir, ".orkestrator-dev-worktrees");
    if (sentinel) await writeFile(marker, JSON.stringify(sentinel));
    else await rm(marker);
    await expect(
      removeProfile(profile, { roots, run, force: true, keepToolchains: false }),
    ).rejects.toThrow("sentinel");
    await pruneProfiles({ roots, run, force: true });
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(path.join(profile.profileRoot, "profile.json"))).toBe(true);
    expect(git(checkout, "worktree", "list", "--porcelain")).toContain(linked);
    expect(git(checkout, "branch", "--list", id)).toContain(id);
  }
  expect(dockerCalls).toEqual([]);
});

test("cleanup releases linked worktrees from a persisted non-default internal directory", async () => {
  git(checkout, "init", "-b", "main");
  await writeFile(path.join(checkout, "file"), "source");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "initial");
  const basic = resolveRuntimeProfile({ repositoryRoot: checkout, requestedId: "custom", roots });
  const profile = resolveRuntimeProfile({
    repositoryRoot: checkout,
    requestedId: "custom",
    roots,
    worktreeDir: path.join(basic.profileRoot, "nested", "trees"),
  });
  await initializeProfile(profile);
  const linked = path.join(profile.worktreeDir, "linked");
  git(checkout, "worktree", "add", "-b", "custom-branch", linked);
  await removeProfile(profile, { roots, run, force: true, keepToolchains: false });
  expect(existsSync(linked)).toBe(false);
  expect(git(checkout, "worktree", "list", "--porcelain")).not.toContain(linked);
  expect(git(checkout, "branch", "--list", "custom-branch")).toBe("");
});
