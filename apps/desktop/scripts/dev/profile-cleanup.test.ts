import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  parseDockerSize,
  pruneProfiles,
  removeProfile,
  type CommandRunner,
} from "./profile-cleanup.js";
import { atomicWriteJson, initializeProfile } from "./profile-io.js";

let root: string;
let roots: RuntimeProfileRoots;
let checkout: string;
let dockerCalls: string[][];

/** Real git, recorded Docker: no test here may reach a real daemon. */
const run: CommandRunner = (command, args) => {
  if (command === "docker") {
    dockerCalls.push(args);
    return { status: 0, stdout: "", stderr: "" };
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
    expect(existsSync(profile.profileRoot)).toBe(false);
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
    expect(existsSync(profile.profileRoot)).toBe(true);
  });
});

describe("pruneProfiles", () => {
  test("removes a stopped profile whose checkout is gone and keeps one that exists", async () => {
    const orphan = await createProfile("orphan", gone());
    await createProfile("current");

    const outcomes = await pruneProfiles({ roots, run });

    expect(actions(outcomes)).toEqual({ current: "kept", orphan: "removed" });
    expect(outcomes.find((entry) => entry.id === "orphan")?.reason).toBe(
      "its checkout no longer exists",
    );
    expect(existsSync(orphan.profileRoot)).toBe(false);
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
    expect(existsSync(orphan.profileRoot)).toBe(true);
    expect(dockerCalls).toEqual([]);
  });

  test("the age rule applies only when asked for", async () => {
    const idle = await createProfile("idle");
    await writeStatus(idle, { status: "stopped", updatedAt: "2026-01-01T00:00:00.000Z" });
    const now = () => Date.parse("2026-01-31T00:00:00.000Z");

    expect(actions(await pruneProfiles({ roots, run, now }))).toEqual({ idle: "kept" });
    const outcomes = await pruneProfiles({ roots, run, now, olderThanDays: 14 });

    expect(outcomes).toEqual([{ id: "idle", action: "removed", reason: "unused for 30 days" }]);
    expect(existsSync(idle.profileRoot)).toBe(false);
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

    const outcomes = await pruneProfiles({ roots, run });

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
    expect(existsSync(orphan.profileRoot)).toBe(true);
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
