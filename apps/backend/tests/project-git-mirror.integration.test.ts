/**
 * The host side of a project's Git mirror, with real Git against real local
 * repositories: how it is built, refreshed, bounded and removed, and what access
 * each mirror is fetched with. The container side is
 * `tests/unit/workspace-setup-git-mirror.test.ts`, and the mount is
 * `project-git-mirror-docker.test.ts`.
 *
 * A mirror fetch ignores the host's Git configuration, so the local `file://`
 * remotes here are fetched as the agent-test fixture is (`localRemote`), and a
 * test that needs a host-only URL rewrites the fetch's own arguments.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncRuntimeGitHubCredential } from "../src/core/container-github-credential";
import type { Environment } from "../src/core/models";
import { withDockerScript } from "./container-lifecycle-fixtures";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { cleanupProjectForRemoval } from "../src/core/commands-registry-projects";
import type { CommandContext } from "../src/core/commands-context";
import {
  CONTAINER_GIT_MIRROR_MOUNT,
  CONTAINER_GIT_MIRROR_PATH,
  GIT_MIRROR_REFRESH_INTERVAL_MS,
  gitMirrorContainerArguments,
  noteGitMirrorCloneOutcome,
  refreshProjectGitMirror,
  removeProjectGitMirror,
  sweepOrphanedProjectGitMirrors,
  stopProjectGitMirrorRefreshes,
  type GitMirrorRefreshOptions,
} from "../src/core/project-git-mirror";
import type { GitMirrorAccess } from "../src/core/project-git-mirror-access";
import { runCommand } from "../src/core/shell";
import { StorageService } from "../src/core/storage";
import { startGitHttpRemote } from "./git-http-fixture";

const setupScript = path.join(import.meta.dir, "..", "..", "..", "docker", "workspace-setup.sh");
const PROJECT_ID = "project-1";

let root: string;
let dataDir: string;
let remote: string;
let work: string;
let storage: StorageService;
let context: Pick<CommandContext, "storage">;
const savedEnv = { ...process.env };

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(name: string, content: string): void {
  writeFileSync(path.join(work, name), content);
  git(work, ["add", "."]);
  git(work, ["commit", "-qm", `change ${name}`]);
  git(work, ["push", "-q", "origin", "main"]);
}

const project = () => ({ id: PROJECT_ID, gitUrl: `file://${remote}` });
const projectDir = () => path.join(dataDir, "git-mirrors", PROJECT_ID);
/** What a container bound to the agent-test fixture holds: no credential, `file` only. */
const LOCAL: GitMirrorAccess = { kind: "anonymous", localRemote: true };
const mountPath = (kind: string = LOCAL.kind) => path.join(projectDir(), `mount-${kind}`);
const mirrorPath = (kind?: string) => path.join(mountPath(kind), "mirror.git");
const refresh = (
  options: GitMirrorRefreshOptions = {},
  target = project(),
  access: GitMirrorAccess = LOCAL,
) =>
  refreshProjectGitMirror(context, target, access, {
    force: true,
    accountLogin: async () => "alice",
    ...options,
  });
const readState = async () =>
  JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")) as Record<
    string,
    unknown
  >;
const mirrorRefs = () =>
  git(root, [`--git-dir=${mirrorPath()}`, "for-each-ref", "--format=%(refname)"]).split("\n");

/** Every file in the mirror that is not an object: anything Git could have written a URL to. */
async function nonObjectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "objects") files.push(...(await nonObjectFiles(target)));
    } else {
      files.push(target);
    }
  }
  return files;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-project-git-mirror-"));
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await fs.writeFile(
    process.env.GIT_CONFIG_GLOBAL,
    "[user]\n\tname = T\n\temail = t@example.com\n",
  );
  dataDir = path.join(root, "data");
  remote = path.join(root, "remote.git");
  work = path.join(root, "work");
  storage = new StorageService(dataDir);
  await storage.init();
  context = { storage };
  git(root, ["init", "-q", "--bare", "--initial-branch=main", remote]);
  git(root, ["clone", "-q", remote, work]);
  git(work, ["checkout", "-qb", "main"]);
  commit("one.txt", "one\n");
});

afterEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = savedEnv.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = savedEnv.GIT_CONFIG_NOSYSTEM;
  if (savedEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  if (savedEnv.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  await fs.rm(root, { recursive: true, force: true });
});

describe("building and refreshing", () => {
  test("builds a bare mirror of the branches, readable by any user in a container", async () => {
    git(work, ["tag", "v1"]);
    git(work, ["push", "-q", "origin", "v1"]);
    git(work, ["push", "-q", "origin", "HEAD:refs/pull/1/head"]);

    expect(await refresh()).toBe("built");

    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "rev-parse", "--is-bare-repository"])).toBe(
      "true",
    );
    expect(await nonObjectFiles(mirrorPath())).not.toContainEqual(expect.stringContaining("hooks"));
    // Everything a clone reads is world-readable, directories traversable.
    const walk = async (directory: string): Promise<void> => {
      const mode = (await fs.stat(directory)).mode;
      expect(mode & 0o005).toBe(0o005);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else expect((await fs.stat(target)).mode & 0o004).toBe(0o004);
      }
    };
    await walk(mountPath());
    // Only the bind source is open; no other host user can traverse to it.
    expect((await fs.stat(path.join(dataDir, "git-mirrors"))).mode & 0o077).toBe(0);
    expect((await fs.stat(projectDir())).mode & 0o077).toBe(0);
  });

  test("a refresh fetches new work and prunes deleted branches in place", async () => {
    git(work, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    expect(await refresh()).toBe("built");
    expect(mirrorRefs()).toContain("refs/heads/feature");
    const { ino } = await fs.stat(mirrorPath());

    commit("two.txt", "two\n");
    git(work, ["push", "-q", "origin", "--delete", "feature"]);
    expect(await refresh()).toBe("fetched");

    expect((await fs.stat(mirrorPath())).ino).toBe(ino);
    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change two.txt",
    );
  });

  test("launches inside the refresh interval do not contact the remote", async () => {
    let fetches = 0;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) fetches += 1;
      return runCommand(command, args, options);
    };
    let clock = 1_000_000;
    const options = { force: false, run, now: () => clock };

    expect(await refresh(options)).toBe("built");
    expect(fetches).toBe(1);
    clock += GIT_MIRROR_REFRESH_INTERVAL_MS - 1;
    expect(await refresh(options)).toBe("skipped-recent");
    expect(fetches).toBe(1);
    clock += 1;
    expect(await refresh(options)).toBe("fetched");
    expect(fetches).toBe(2);
  });

  test("a changed project URL rebuilds instead of mixing two remotes", async () => {
    expect(await refresh()).toBe("built");
    const other = path.join(root, "other.git");
    git(root, ["clone", "-q", "--bare", remote, other]);

    expect(await refresh({}, { id: PROJECT_ID, gitUrl: `file://${other}` })).toBe("built");
  });

  test("an empty remote publishes nothing", async () => {
    const empty = path.join(root, "empty.git");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", empty]);

    expect(await refresh({}, { id: PROJECT_ID, gitUrl: `file://${empty}` })).toBe("empty");
    expect(existsSync(mirrorPath())).toBe(false);
  });
});

describe("seeding from the host checkout", () => {
  const seeded = (localPath: string | null = work) => ({ ...project(), localPath });
  const remoteTip = (branch = "main") => git(remote, ["rev-parse", `refs/heads/${branch}`]);
  const allObjects = () =>
    git(root, [
      `--git-dir=${mirrorPath()}`,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ])
      .split("\n")
      .sort();
  const reachableObjects = () =>
    git(root, [`--git-dir=${mirrorPath()}`, "rev-list", "--objects", "--all", "--no-object-names"])
      .split("\n")
      .sort();

  /** Asserts the mirror holds what a plain build would: the remote's branches and nothing else. */
  function expectExactlyTheRemote() {
    expect(
      git(root, [`--git-dir=${mirrorPath()}`, "for-each-ref", "--format=%(refname) %(objectname)"]),
    ).toBe(git(remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]));
    expect(allObjects()).toEqual(reachableObjects());
    expect(existsSync(path.join(mirrorPath(), "objects", "info", "alternates"))).toBe(false);
    expect(existsSync(path.join(mirrorPath(), "shallow"))).toBe(false);
    expect(existsSync(path.join(mirrorPath(), "FETCH_HEAD"))).toBe(false);
    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full", "--strict"]);
  }

  /**
   * Records the size of every pack the remote serves, not a local repository's.
   * `upload-pack` reads its hook only from global configuration, which a mirror
   * fetch withholds from the remote it spawns, so `run` hands that one hook to
   * the mirror's remote fetches.
   */
  async function countRemotePackBytes(): Promise<{
    bytes: () => Promise<number>;
    run: typeof runCommand;
  }> {
    const log = path.join(root, "remote-packs");
    const hook = path.join(root, "pack-hook.sh");
    const hookConfig = path.join(root, "pack-hook-config");
    await fs.writeFile(
      hook,
      `#!/bin/sh\ncase "$PWD" in ${remote}*) "$@" | tee -a "${log}" ;; *) exec "$@" ;; esac\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(hookConfig, `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
    await fs.appendFile(process.env.GIT_CONFIG_GLOBAL!, `[include]\n\tpath = ${hookConfig}\n`);
    const run: typeof runCommand = (command, args, options = {}) =>
      runCommand(
        command,
        args,
        options.env?.GIT_CONFIG_GLOBAL === os.devNull
          ? { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: hookConfig } }
          : options,
      );
    return {
      run,
      bytes: async () =>
        fs.stat(log).then(
          (stats) => stats.size,
          () => 0,
        ),
    };
  }

  /** History too random to compress, so a download of it cannot be mistaken for a small one. */
  function commitLargeHistory() {
    writeFileSync(path.join(work, "big.bin"), randomBytes(512 * 1024));
    git(work, ["add", "."]);
    git(work, ["commit", "-qm", "big"]);
    git(work, ["push", "-q", "origin", "main"]);
  }

  test("a current checkout saves the download, and the result is a plain mirror", async () => {
    commitLargeHistory();
    const remotePacks = await countRemotePackBytes();

    expect(await refresh({ run: remotePacks.run }, seeded())).toBe("built");

    expect(await remotePacks.bytes()).toBeLessThan(10 * 1024);
    expectExactlyTheRemote();
    const walk = async (directory: string): Promise<void> => {
      expect((await fs.stat(directory)).mode & 0o005).toBe(0o005);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else expect((await fs.stat(target)).mode & 0o004).toBe(0o004);
      }
    };
    await walk(mirrorPath());
    expect(existsSync(path.join(mirrorPath(), "hooks"))).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a plain build of the same repository does download it", async () => {
    commitLargeHistory();
    const remotePacks = await countRemotePackBytes();

    expect(await refresh({ run: remotePacks.run })).toBe("built");

    expect(await remotePacks.bytes()).toBeGreaterThan(512 * 1024);
  });

  test("a checkout behind the remote gets the rest from the remote", async () => {
    commitLargeHistory();
    const behind = path.join(root, "behind");
    git(root, ["clone", "-q", `file://${remote}`, behind]);
    commit("two.txt", "two\n");
    git(work, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    const remotePacks = await countRemotePackBytes();

    expect(await refresh({ run: remotePacks.run }, seeded(behind))).toBe("built");

    expect(await remotePacks.bytes()).toBeLessThan(10 * 1024);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "rev-parse", "main"])).toBe(remoteTip());
    expect(mirrorRefs()).toEqual(["refs/heads/feature", "refs/heads/main"]);
    expectExactlyTheRemote();
  });

  test("unpushed work, stale branches and forged refs stay out of the mirror", async () => {
    const pushed = remoteTip();
    git(work, ["checkout", "-qb", "local-only"]);
    writeFileSync(path.join(work, "secret.txt"), "not for the mirror\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-qm", "unpushed"]);
    const unpushed = git(work, ["rev-parse", "HEAD"]);
    const secretBlob = git(work, ["rev-parse", "HEAD:secret.txt"]);
    git(work, ["tag", "local-tag"]);
    // What a process in the checkout could write: the remote's main moved onto
    // unpushed work, and branches that the remote never had.
    git(work, ["update-ref", "refs/remotes/origin/main", unpushed]);
    git(work, ["update-ref", "refs/remotes/origin/invented", unpushed]);
    git(work, ["update-ref", "refs/remotes/fork/invented", unpushed]);
    git(work, ["update-ref", "refs/heads/invented", unpushed]);

    let checkoutRead = false;
    const run: typeof runCommand = async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (
        args?.includes("fetch") &&
        args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git"))
      )
        checkoutRead = true;
      return result;
    };
    expect(await refresh({ run }, seeded())).toBe("built");
    expect(checkoutRead).toBe(true);

    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "rev-parse", "main"])).toBe(pushed);
    expect(allObjects()).not.toContain(unpushed);
    expect(allObjects()).not.toContain(secretBlob);
    expectExactlyTheRemote();
  });

  test("a branch deleted on the remote is not revived from the checkout", async () => {
    git(work, ["push", "-q", "origin", "HEAD:refs/heads/gone"]);
    git(work, ["fetch", "-q", "origin"]);
    git(work, ["push", "-q", "origin", "--delete", "gone"]);
    git(work, ["update-ref", "refs/remotes/origin/gone", git(work, ["rev-parse", "HEAD"])]);

    expect(await refresh({}, seeded())).toBe("built");

    expect(mirrorRefs()).toEqual(["refs/heads/main"]);
  });

  test("a checkout's config and hooks run nothing", async () => {
    const marker = path.join(root, "ran");
    const script = path.join(root, "mark.sh");
    await fs.writeFile(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    git(work, ["config", "uploadpack.packObjectsHook", script]);
    git(work, ["config", "core.fsmonitor", script]);
    git(work, ["config", "core.sshCommand", script]);
    git(work, ["config", "core.hooksPath", root]);
    for (const hook of [
      "post-upload-pack",
      "pre-upload-pack",
      "post-checkout",
      "reference-transaction",
    ]) {
      await fs.copyFile(script, path.join(work, ".git", "hooks", hook));
    }

    let checkoutRead = false;
    const run: typeof runCommand = async (command, args, options) => {
      const result = await runCommand(command, args, options);
      if (
        args?.includes("fetch") &&
        args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git"))
      )
        checkoutRead = true;
      return result;
    };
    expect(await refresh({ run }, seeded())).toBe("built");
    expect(checkoutRead).toBe(true);

    expect(existsSync(marker)).toBe(false);
    expectExactlyTheRemote();
  });

  test("a partial clone falls back to a download without fetching from its promisor", async () => {
    commit("two.txt", "two\n");
    git(remote, ["config", "uploadpack.allowFilter", "true"]);
    const partial = path.join(root, "partial");
    git(root, ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${remote}`, partial]);
    const promisorFetched = path.join(root, "promisor-fetched");
    const helper = path.join(root, "promisor.sh");
    await fs.writeFile(helper, `#!/bin/sh\ntouch "${promisorFetched}"\nexit 1\n`, { mode: 0o755 });
    git(partial, ["config", "remote.origin.url", `ext::${helper}`]);

    expect(await refresh({}, seeded(partial))).toBe("built");

    expect(existsSync(promisorFetched)).toBe(false);
    expectExactlyTheRemote();
  });

  test("a shallow checkout falls back to the whole history", async () => {
    commit("two.txt", "two\n");
    const shallow = path.join(root, "shallow");
    git(root, ["clone", "-q", "--depth=1", `file://${remote}`, shallow]);

    expect(await refresh({}, seeded(shallow))).toBe("built");

    expectExactlyTheRemote();
    expect(git(root, [`--git-dir=${mirrorPath()}`, "rev-list", "--count", "main"])).toBe("2");
  });

  test("a damaged checkout falls back to a download", async () => {
    const damaged = path.join(root, "damaged");
    git(root, ["clone", "-q", "--no-local", remote, damaged]);
    git(damaged, ["repack", "-qad"]);
    for (const name of await fs.readdir(path.join(damaged, ".git", "objects", "pack"))) {
      await fs.rm(path.join(damaged, ".git", "objects", "pack", name), { force: true });
    }

    expect(await refresh({}, seeded(damaged))).toBe("built");

    expectExactlyTheRemote();
  });

  test("a checkout that is not usable leaves an ordinary download", async () => {
    const plainDirectory = path.join(root, "plain");
    await fs.mkdir(plainDirectory);
    const file = path.join(root, "file");
    await fs.writeFile(file, "");

    for (const localPath of [
      null,
      path.join(root, "absent"),
      plainDirectory,
      file,
      "relative/path",
    ]) {
      await fs.rm(projectDir(), { recursive: true, force: true });
      expect(await refresh({}, seeded(localPath))).toBe("built");
      expectExactlyTheRemote();
    }
  });

  test("a checkout never makes a mirror on its own", async () => {
    const gone = { ...seeded(), gitUrl: `file://${root}/absent.git` };

    expect(await refresh({}, gone)).toBe("failed");

    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a remote with no branches is empty whatever the checkout holds", async () => {
    const empty = path.join(root, "empty.git");
    git(root, ["init", "-q", "--bare", "--initial-branch=main", empty]);

    expect(await refresh({}, { ...seeded(), gitUrl: `file://${empty}` })).toBe("empty");

    expect(existsSync(mirrorPath())).toBe(false);
  });

  test("a checkout larger than the limit ends the seed, not the mirror", async () => {
    writeFileSync(path.join(work, "big.bin"), randomBytes(512 * 1024));
    git(work, ["add", "."]);
    git(work, ["commit", "-qm", "not on the remote"]);
    git(work, ["update-ref", "refs/remotes/fork/big", git(work, ["rev-parse", "HEAD"])]);

    expect(await refresh({ maxBytes: 256 * 1024 }, seeded())).toBe("built");

    expectExactlyTheRemote();
    const state = JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8"));
    expect(state.oversizedUntil).toBeUndefined();
  });

  test("a repository past the limit is still oversized with a seed", async () => {
    commitLargeHistory();

    expect(await refresh({ maxBytes: 256 * 1024 }, seeded())).toBe("oversized");

    expect(existsSync(mirrorPath())).toBe(false);
    const state = JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8"));
    expect(state.oversizedUntil).toBeGreaterThan(0);
  });

  test("combined seed and remote data above the limit falls back before staging", async () => {
    commitLargeHistory();
    const behind = path.join(root, "behind");
    git(root, ["clone", "-q", `file://${remote}`, behind]);
    commitLargeHistory();
    const maxBytes = 800 * 1024;
    let seededCopy = false;
    const run: typeof runCommand = (command, args, options) => {
      if (
        args?.includes("fetch") &&
        args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git"))
      )
        seededCopy = true;
      return runCommand(command, args, options);
    };
    expect(
      await refresh(
        { run, maxBytes, freeBytes: async () => 1024 ** 3 + 3 * maxBytes },
        seeded(behind),
      ),
    ).toBe("oversized");
    expect(seededCopy).toBe(false);
    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("failure after staging initialization falls back to a clean download", async () => {
    let stagedFetch = false;
    const run: typeof runCommand = (command, args, options) => {
      if (
        args?.includes("fetch") &&
        args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git"))
      ) {
        stagedFetch = true;
        return Promise.reject(new Error("local copy failed"));
      }
      return runCommand(command, args, options);
    };
    expect(await refresh({ run }, seeded())).toBe("built");
    expect(stagedFetch).toBe(true);
    expectExactlyTheRemote();
  });

  for (const phase of ["checkout", "staged"]) {
    test(`the running ${phase} copy guard aborts and falls back`, async () => {
      let aborted = false;
      const run: typeof runCommand = async (command, args = [], options) => {
        const local =
          args.includes("fetch") &&
          (phase === "checkout"
            ? args.includes(work)
            : args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git")));
        if (!local) return runCommand(command, args, options);
        const dest = args.find((arg) => arg.startsWith("--git-dir="))!.slice(10);
        await fs.writeFile(
          path.join(dest, "objects", "pack", "tmp_pack_test"),
          Buffer.alloc(300 * 1024),
        );
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("copy aborted"));
            },
            { once: true },
          );
        });
      };
      expect(await refresh({ run, maxBytes: 256 * 1024 }, seeded())).toBe("built");
      expect(aborted).toBe(true);
      expectExactlyTheRemote();
      expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
    }, 15000);
  }

  test("seeds and fetches missing history over a network Git remote", async () => {
    commitLargeHistory();
    const behind = path.join(root, "behind");
    git(root, ["clone", "-q", `file://${remote}`, behind]);
    commit("network.txt", "from network\n");
    // Over HTTP, as a container's clone reaches it: no local remote allowed.
    const server = startGitHttpRemote(root);
    try {
      let copied = false;
      const run: typeof runCommand = (command, args, options) => {
        if (
          args?.includes("fetch") &&
          args.some((arg) => !arg.startsWith("--git-dir=") && arg.endsWith("/seed.git"))
        )
          copied = true;
        return runCommand(command, args, options);
      };
      expect(
        await refresh(
          { run },
          { ...seeded(behind), gitUrl: `${server.origin}/remote.git` },
          { kind: "anonymous" },
        ),
      ).toBe("built");
      expect(copied).toBe(true);
      expectExactlyTheRemote();
    } finally {
      await server.stop();
    }
  });

  test("a disk with room only for a download does not seed", async () => {
    const paths: string[] = [];
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) paths.push(...args);
      return runCommand(command, args, options);
    };

    expect(await refresh({ run, freeBytes: async () => 4 * 1024 ** 3 }, seeded())).toBe("built");

    expect(paths).not.toContain(work);
    expectExactlyTheRemote();
  });

  test("only a build reads the checkout, not an update of a mirror it has", async () => {
    expect(await refresh()).toBe("built");
    commit("two.txt", "two\n");
    const paths: string[] = [];
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) paths.push(...args);
      return runCommand(command, args, options);
    };

    expect(await refresh({ run }, seeded())).toBe("fetched");

    expect(paths).not.toContain(work);
  });

  test("cancelling during a seed stops it and leaves nothing behind", async () => {
    let started: () => void;
    const seeding = new Promise<void>((resolve) => (started = resolve));
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes(work)) {
        started();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return runCommand(command, args, options);
    };
    const refreshing = refresh({ run }, seeded());
    await seeding;

    await removeProjectGitMirror(context, PROJECT_ID);

    expect(await refreshing).toBe("cancelled");
    expect(existsSync(projectDir())).toBe(false);
  });

  test("a clone from a seeded mirror needs nothing from the checkout", async () => {
    commitLargeHistory();
    expect(await refresh({}, seeded())).toBe("built");
    await fs.rm(work, { recursive: true, force: true });

    const dest = path.join(root, "clone");
    git(root, [
      "clone",
      "-q",
      "--no-tags",
      "--reference-if-able",
      mirrorPath(),
      "--dissociate",
      `file://${remote}`,
      dest,
    ]);

    git(dest, ["fsck", "--full"]);
    expect(existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
  });
});

describe("credentials", () => {
  const secret = "s3cret-token-value";
  const backendSecret = "backend-token-value";

  type Call = { args: string[]; env: NodeJS.ProcessEnv };

  /**
   * Sends the transfer to the local remote; everything else is what Git would
   * have been given, recorded in `calls`.
   */
  function redirecting(url: string, calls: Call[]) {
    const run: typeof runCommand = (command, args = [], options = {}) => {
      if (!args.includes("fetch")) return runCommand(command, args, options);
      calls.push({ args: [...args], env: { ...options.env } });
      const real = args.map((arg) => (arg === url ? `file://${remote}` : arg));
      return runCommand(command, real, {
        ...options,
        env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" },
      });
    };
    return run;
  }

  /** The backend's own GitHub credential, which a mirror fetch must never use. */
  function selectBackendPat() {
    const load = storage.loadConfig.bind(storage);
    storage.loadConfig = async () => {
      const config = await load();
      return {
        ...config,
        global: { ...config.global, useHostGitHubCredentials: false, githubToken: backendSecret },
      };
    };
    process.env.GH_TOKEN = backendSecret;
    process.env.GITHUB_TOKEN = backendSecret;
  }

  afterEach(() => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "HOME"] as const) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  async function expectNoSecretInMirror(kind?: string) {
    const config = await fs.readFile(path.join(mirrorPath(kind), "config"), "utf8");
    for (const forbidden of ["url", "remote", "credential", "extraheader", "insteadOf"]) {
      expect(config.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(existsSync(path.join(mirrorPath(kind), "FETCH_HEAD"))).toBe(false);
    for (const file of await nonObjectFiles(path.join(projectDir()))) {
      const content = await fs.readFile(file, "utf8");
      expect(content).not.toContain(secret);
      expect(content).not.toContain(backendSecret);
    }
  }

  test("a token in the project URL reaches neither the mirror nor its state", async () => {
    const url = `https://user:${secret}@github.invalid/acme/repo.git`;
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(url, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "anonymous",
        },
      ),
    ).toBe("built");

    expect(calls).toHaveLength(1);
    await expectNoSecretInMirror("anonymous");
  });

  test("the containers' token goes per transfer, by helper and environment, never by argument", async () => {
    selectBackendPat();
    const url = "https://github.com/acme/repo.git";
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(url, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "github-pat",
          token: secret,
        },
      ),
    ).toBe("built");

    expect(calls).toHaveLength(1);
    const [{ args, env }] = calls as [Call];
    expect(env.ORKESTRATOR_GITHUB_TOKEN).toBe(secret);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(args.join(" ")).not.toContain(secret);
    expect(args.join(" ")).toContain("credential.https://github.com.helper=");
    await expectNoSecretInMirror("github-pat");
  });

  test("with no token for containers, a GitHub remote is fetched with no credential at all", async () => {
    // The backend has a PAT selected and in its environment, as it often does.
    selectBackendPat();
    const url = "git@github.com:acme/repo.git";
    const https = "https://github.com/acme/repo.git";
    const calls: Call[] = [];

    expect(
      await refresh(
        { run: redirecting(https, calls) },
        { id: PROJECT_ID, gitUrl: url },
        {
          kind: "anonymous",
        },
      ),
    ).toBe("built");

    const [{ args, env }] = calls as [Call];
    // Converted as the container's setup script converts it, and HTTPS only.
    expect(args).toContain(https);
    expect(args).not.toContain(url);
    expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
    // Neither the backend's token nor its Git configuration or helpers.
    expect(Object.values(env).join("\n")).not.toContain(backendSecret);
    expect(env.ORKESTRATOR_GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(args.join(" ")).not.toContain("credential.https://github.com.helper=");
    expect(args).toContain("credential.helper=");
    await expectNoSecretInMirror("anonymous");
  });

  test("a private remote is never fetched with the host's own credentials", async () => {
    const credentials = { username: "host-user", password: "host-password" };
    const server = startGitHttpRemote(root, { credentials });
    try {
      const url = `${server.origin}/remote.git`;
      // Everything the host offers: a helper in global config, a `.netrc` in
      // its home and an askpass program. Each one alone lets plain Git in.
      const helper = path.join(root, "helper.sh");
      await fs.writeFile(
        helper,
        `#!/bin/sh\ntest "$1" = get && printf 'username=%s\\npassword=%s\\n' ${credentials.username} ${credentials.password}\n`,
        { mode: 0o755 },
      );
      await fs.appendFile(process.env.GIT_CONFIG_GLOBAL!, `[credential]\n\thelper = ${helper}\n`);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, ".netrc"),
        `machine 127.0.0.1 login ${credentials.username} password ${credentials.password}\n`,
        { mode: 0o600 },
      );
      process.env.HOME = home;
      const askpass = path.join(root, "askpass.sh");
      await fs.writeFile(askpass, `#!/bin/sh\necho ${credentials.password}\n`, { mode: 0o755 });
      process.env.GIT_ASKPASS = askpass;
      // Async: the server answers on this process's event loop.
      await runCommand("git", ["ls-remote", url], { timeoutMs: 30_000 });
      const before = server.refused();

      expect(await refresh({}, { id: PROJECT_ID, gitUrl: url }, { kind: "anonymous" })).toBe(
        "failed",
      );

      expect(server.refused()).toBeGreaterThan(before);
      expect(existsSync(mirrorPath("anonymous"))).toBe(false);
      expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("a refused remote with a checkout is probed before seeding and backed off", async () => {
    const server = startGitHttpRemote(root, {
      credentials: { username: "user", password: "password" },
    });
    try {
      let copies = 0;
      let probes = 0;
      const run: typeof runCommand = (command, args, options) => {
        if (args?.includes("ls-remote")) probes++;
        if (args?.includes("+refs/remotes/*:refs/seed/*")) copies++;
        return runCommand(command, args, options);
      };
      const target = { ...project(), gitUrl: server.origin + "/remote.git", localPath: work };
      const options = { run, force: false, now: () => 1_000_000 };
      expect(await refresh(options, target, { kind: "anonymous" })).toBe("failed");
      expect(await refresh(options, target, { kind: "anonymous" })).toBe("skipped-recent");
      expect(probes).toBe(1);
      expect(copies).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("a public remote over HTTP builds with no credential", async () => {
    const server = startGitHttpRemote(root);
    try {
      expect(
        await refresh(
          {},
          { id: PROJECT_ID, gitUrl: `${server.origin}/remote.git` },
          {
            kind: "anonymous",
          },
        ),
      ).toBe("built");
      expect(git(root, [`--git-dir=${mirrorPath("anonymous")}`, "rev-parse", "main"])).toBe(
        git(remote, ["rev-parse", "main"]),
      );
    } finally {
      await server.stop();
    }
  });

  test("a URL a container's clone cannot use gets no mirror", async () => {
    // A local path, without the agent-test fixture's own bind, and `file://`.
    for (const gitUrl of [remote, `file://${remote}`]) {
      expect(await refresh({}, { id: PROJECT_ID, gitUrl }, { kind: "anonymous" })).toBe("failed");
      expect(existsSync(mirrorPath("anonymous"))).toBe(false);
    }
  });
});

describe("access kinds", () => {
  const PAT: GitMirrorAccess = { kind: "github-pat", token: "t", localRemote: true };

  test("a refresh retires every other kind's mirror and the legacy one, keeping their directories", async () => {
    expect(await refresh()).toBe("built");
    // What a backend before access kinds left: one mirror every container read.
    const legacy = path.join(projectDir(), "mount");
    await fs.mkdir(legacy, { mode: 0o755 });
    await fs.cp(mirrorPath(), path.join(legacy, "mirror.git"), { recursive: true });

    expect(await refresh({}, project(), PAT)).toBe("built");

    expect(existsSync(mirrorPath("github-pat"))).toBe(true);
    expect(existsSync(mirrorPath("anonymous"))).toBe(false);
    expect(existsSync(path.join(legacy, "mirror.git"))).toBe(false);
    // Stopped containers still name these with `-v`.
    expect(existsSync(mountPath("anonymous"))).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(await readState()).toMatchObject({ access: "github-pat", account: "alice" });
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a change of kind rebuilds at once, inside the refresh interval", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh(options)).toBe("built");
    clock += 1;

    expect(await refresh(options, project(), PAT)).toBe("built");
    expect(await refresh(options, project(), PAT)).toBe("skipped-recent");
    expect(await refresh(options)).toBe("built");
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);
  });

  test("a token for another account under the same setting withdraws the mirror before fetching", async () => {
    let clock = 1_000_000;
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    clock += 1;
    let mirrorDuringFetch: boolean | undefined;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) mirrorDuringFetch ??= existsSync(mirrorPath("github-pat"));
      return runCommand(command, args, options);
    };

    expect(
      await refresh(
        { force: false, now: () => clock, run, accountLogin: async () => "bob" },
        project(),
        PAT,
      ),
    ).toBe("built");

    expect(mirrorDuringFetch).toBe(false);
    expect(await readState()).toMatchObject({ access: "github-pat", account: "bob" });
  });

  test("the same account keeps its mirror and the refresh interval", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh(options, project(), PAT)).toBe("built");
    clock += 1;

    expect(await refresh(options, project(), PAT)).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat"))).toBe(true);
  });

  test("an account that cannot be read withdraws the mirror until a refresh can rebuild it", async () => {
    let clock = 1_000_000;
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    clock += 1;
    const unreadable = { force: false, now: () => clock, accountLogin: async () => undefined };

    expect(await refresh(unreadable, project(), PAT)).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);

    clock += GIT_MIRROR_REFRESH_INTERVAL_MS;
    expect(await refresh(unreadable, project(), PAT)).toBe("failed");
    expect(await readState()).toMatchObject({ account: null });
    // Known again: whatever the unreadable one was, this is fetched anew.
    expect(await refresh({ force: false, now: () => clock }, project(), PAT)).toBe("built");
    expect(await readState()).toMatchObject({ account: "alice" });
  });

  test("anonymous access reads no account", async () => {
    let read = false;
    expect(
      await refresh({
        accountLogin: async () => {
          read = true;
          return "alice";
        },
      }),
    ).toBe("built");
    expect(read).toBe(false);
    expect(await readState()).not.toHaveProperty("account");
  });
});

describe("what never stops a launch", () => {
  test("a remote that cannot be reached leaves no partial mirror and does not throw", async () => {
    const outcome = await refresh({}, { id: PROJECT_ID, gitUrl: `file://${root}/absent.git` });

    expect(outcome).toBe("failed");
    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a failed fetch keeps the mirror it had", async () => {
    expect(await refresh()).toBe("built");
    const before = mirrorRefs();
    const away = `${remote}.away`;
    await fs.rename(remote, away);

    expect(await refresh()).toBe("failed");

    expect(mirrorRefs()).toEqual(before);
    await fs.rename(away, remote);
    expect(await refresh()).toBe("fetched");
  });

  test("a mirror left locked by a crash is rebuilt after repeated failures", async () => {
    expect(await refresh()).toBe("built");
    commit("two.txt", "two\n");
    // What a killed `git fetch` can leave behind: the ref it was updating.
    await fs.writeFile(path.join(mirrorPath(), "refs", "heads", "main.lock"), "");

    for (let attempt = 0; attempt < 3; attempt += 1) expect(await refresh()).toBe("failed");
    expect(await refresh()).toBe("built");

    expect(existsSync(path.join(mirrorPath(), "refs", "heads", "main.lock"))).toBe(false);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change two.txt",
    );
  });

  test("a clone's report of a corrupt mirror has the next refresh check and replace it", async () => {
    expect(await refresh()).toBe("built");
    const packDir = path.join(mirrorPath(), "objects");
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.mkdir(packDir);

    await noteGitMirrorCloneOutcome(
      "\x1eORKESTRATOR_GIT_MIRROR:corrupt\x1f\n",
      dataDir,
      PROJECT_ID,
    );
    expect(await refresh()).toBe("built");

    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
  });

  test("a clone's report that the mirror was only missing marks nothing", async () => {
    expect(await refresh()).toBe("built");
    await noteGitMirrorCloneOutcome(
      "\x1eORKESTRATOR_GIT_MIRROR:missing\x1f\n",
      dataDir,
      PROJECT_ID,
    );
    const state = JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8"));
    expect(state.suspect).toBeFalsy();
    expect(await refresh()).toBe("fetched");
  });
});

describe("disk bounds", () => {
  test("a repository past the limit gets no mirror and is not tried again for a week", async () => {
    let clock = 1_000_000;
    const options = { force: false, now: () => clock };
    expect(await refresh({ ...options, maxBytes: 1 })).toBe("oversized");
    expect(existsSync(mirrorPath())).toBe(false);
    expect((await fs.readdir(projectDir())).filter((name) => name.startsWith("."))).toEqual([]);

    clock += GIT_MIRROR_REFRESH_INTERVAL_MS * 2;
    expect(await refresh({ ...options, maxBytes: 1 })).toBe("skipped-oversized");
    clock += 7 * 24 * 60 * 60_000;
    expect(await refresh(options)).toBe("built");
  });

  test("a mirror that grows past the limit is removed by its own refresh", async () => {
    expect(await refresh()).toBe("built");

    expect(await refresh({ maxBytes: 1 })).toBe("oversized");

    expect(existsSync(mirrorPath())).toBe(false);
    expect(existsSync(mountPath())).toBe(true);
  });

  test("a nearly full disk does not start a build, and keeps an existing mirror", async () => {
    expect(await refresh({ freeBytes: async () => 2 * 1024 ** 3 })).toBe("skipped-low-disk");
    expect(existsSync(mirrorPath())).toBe(false);

    expect(await refresh()).toBe("built");
    expect(await refresh({ freeBytes: async () => 1024 })).toBe("skipped-low-disk");
    expect(existsSync(mirrorPath())).toBe(true);
  });

  test("repeated fetches are compacted", async () => {
    expect(await refresh()).toBe("built");
    // Above the pack limit, each fetch of even one commit keeps its own pack.
    await fs.appendFile(path.join(mirrorPath(), "config"), "[fetch]\n\tunpackLimit = 1\n");
    for (let index = 0; index < 32; index += 1) {
      commit(`file-${index}.txt`, `${index}\n`);
      await refresh();
    }
    const packs = (await fs.readdir(path.join(mirrorPath(), "objects", "pack"))).filter((name) =>
      name.endsWith(".pack"),
    );
    expect(packs.length).toBeLessThanOrEqual(31);
    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
  }, 60_000);
});

describe("concurrency", () => {
  /** Runs the setup script's own clone path against the mirror, as a launch does. */
  function launchClone(dest: string): Promise<{ code: number | null; stdout: string }> {
    const harness = `
set -e
YELLOW=""; NC=""
eval "$(sed -n '/^git_mirror_problem() {/,/^}$/p; /^report_git_mirror_outcome() {/,/^}$/p; /^clone_from_git_mirror() {/,/^}$/p; /^clone_repository() {/,/^}$/p' "$1")"
clone_repository "$2" "$3"
`;
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", harness, "--", setupScript, `file://${remote}`, dest], {
        env: { ...process.env, ORKESTRATOR_GIT_MIRROR: mirrorPath() },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
  }

  test.each(["anonymous", "github-pat"] as const)(
    "changed access to %s cancels a blocked writer and reconciles the latest reader",
    async (kind) => {
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run: typeof runCommand = async (command, args, options) => {
        if (args?.includes("fetch")) {
          started();
          await blocked;
        }
        return runCommand(command, args, options);
      };
      const first = refresh({ run }, project(), {
        kind: "github-pat",
        token: "old-token",
        generation: "11111111-1111-1111-1111-111111111111",
        localRemote: true,
      });
      await entered;
      const second = refresh({}, project(), {
        kind,
        token: kind === "anonymous" ? undefined : "new-token",
        generation: kind === "anonymous" ? undefined : "22222222-2222-2222-2222-222222222222",
        localRemote: true,
      });
      release();
      expect(await first).toBe("built");
      expect(await second).toBe("built");
      expect(
        existsSync(
          mirrorPath(
            kind === "anonymous" ? kind : "github-pat-22222222-2222-2222-2222-222222222222",
          ),
        ),
      ).toBe(true);
      expect(existsSync(mirrorPath("github-pat-11111111-1111-1111-1111-111111111111"))).toBe(false);
      expect(await readState()).toMatchObject({ access: kind });
    },
  );

  test("fresh authenticated binds never expose either reader's predecessor", async () => {
    const alice = {
      kind: "github-pat",
      token: "alice",
      localRemote: true,
      generation: "11111111-1111-1111-1111-111111111111",
    } as const;
    const bob = { ...alice, token: "bob", generation: "22222222-2222-2222-2222-222222222222" };
    const oldMirror = mirrorPath("github-pat-" + alice.generation);
    const newMirror = mirrorPath("github-pat-" + bob.generation);
    await gitMirrorContainerArguments(dataDir, project(), alice.kind, alice.generation);
    expect(await refresh({}, project(), alice)).toBe("built");
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    await gitMirrorContainerArguments(dataDir, project(), bob.kind, bob.generation);
    const next = refresh(
      {
        accountLogin: async () => {
          started();
          await blocked;
          return "bob";
        },
      },
      project(),
      bob,
    );
    await entered;
    expect(existsSync(newMirror)).toBe(false);
    release();
    expect(await next).toBe("built");
    expect(existsSync(oldMirror)).toBe(false);
    expect(existsSync(newMirror)).toBe(true);
  });

  test("shutdown during account lookup withdraws the old mirror without publication", async () => {
    const access = { kind: "github-pat", token: "token", localRemote: true } as const;
    expect(await refresh({}, project(), access)).toBe("built");
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = refresh(
      {
        accountLogin: async () => {
          started();
          await blocked;
          return undefined;
        },
      },
      project(),
      access,
    );
    await entered;
    const stopped = stopProjectGitMirrorRefreshes(dataDir);
    release();
    expect(await next).toBe("cancelled");
    await stopped;
    expect(existsSync(mirrorPath("github-pat"))).toBe(false);
  });

  test("launches arriving during a refresh join it", async () => {
    let fetches = 0;
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) fetches += 1;
      return runCommand(command, args, options);
    };

    const outcomes = await Promise.all([refresh({ run }), refresh({ run }), refresh({ run })]);

    expect(outcomes).toEqual(["built", "built", "built"]);
    expect(fetches).toBe(1);
  });

  test("two launches and refreshes at once leave a valid mirror and whole clones", async () => {
    expect(await refresh()).toBe("built");
    // A real history, so the clones overlap the fetch and the compaction.
    for (let index = 0; index < 8; index += 1) commit(`seed-${index}.txt`, `${index}\n`);
    await refresh();

    const clones: Promise<{ code: number | null; stdout: string }>[] = [];
    const refreshes: Promise<unknown>[] = [];
    for (let round = 0; round < 6; round += 1) {
      commit(`round-${round}.txt`, `${round}\n`);
      clones.push(launchClone(path.join(root, `env-${round}-a`)));
      clones.push(launchClone(path.join(root, `env-${round}-b`)));
      refreshes.push(refresh());
      refreshes.push(refresh());
      if (round === 3) {
        refreshes.push(
          runCommand("git", [`--git-dir=${mirrorPath()}`, "gc", "--quiet"]).catch(() => undefined),
        );
      }
      await refreshes.at(-1);
    }
    const results = await Promise.all(clones);
    await Promise.all(refreshes);

    git(root, [`--git-dir=${mirrorPath()}`, "fsck", "--full"]);
    expect(git(root, [`--git-dir=${mirrorPath()}`, "log", "-1", "--format=%s", "main"])).toBe(
      "change round-5.txt",
    );
    for (const [index, result] of results.entries()) {
      expect(result.code).toBe(0);
      const dest = path.join(root, `env-${Math.floor(index / 2)}-${index % 2 === 0 ? "a" : "b"}`);
      expect(existsSync(path.join(dest, ".git", "objects", "info", "alternates"))).toBe(false);
      git(dest, ["fsck"]);
    }
    expect(results.some((result) => result.stdout.includes("ORKESTRATOR_GIT_MIRROR:used"))).toBe(
      true,
    );
  }, 120_000);
});

describe("removal", () => {
  test("removing the project removes its mirror through the project's cleanup", async () => {
    expect(await refresh()).toBe("built");

    await cleanupProjectForRemoval(
      PROJECT_ID,
      context as unknown as CommandContext,
      new Map() as never,
    );

    expect(existsSync(projectDir())).toBe(false);
  });

  test("a project with no mirror removes cleanly", async () => {
    await removeProjectGitMirror(context, PROJECT_ID);
    expect(existsSync(projectDir())).toBe(false);
  });

  test("a refresh in progress is stopped and leaves nothing behind", async () => {
    let started: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    const run: typeof runCommand = (command, args, options) => {
      if (args?.includes("fetch")) {
        started();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return runCommand(command, args, options);
    };
    const refreshing = refresh({ run });
    await fetching;

    await removeProjectGitMirror(context, PROJECT_ID);

    expect(await refreshing).toBe("cancelled");
    expect(existsSync(projectDir())).toBe(false);
  });

  test("the sweep removes only mirrors whose project is gone, once settled", async () => {
    expect(await refresh()).toBe("built");
    const orphan = path.join(dataDir, "git-mirrors", "project-gone");
    await fs.mkdir(path.join(orphan, "mount", "mirror.git"), { recursive: true });
    const stray = path.join(dataDir, "git-mirrors", "not a project id");
    await fs.mkdir(stray);
    const live = new Set([PROJECT_ID]);

    expect(await sweepOrphanedProjectGitMirrors(dataDir, live, 60_000)).toBe(0);
    expect(existsSync(orphan)).toBe(true);

    const later = () => Date.now() + 120_000;
    expect(await sweepOrphanedProjectGitMirrors(dataDir, live, 60_000, later)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(mirrorPath())).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });

  test("a sweep with no settling age takes a mirror changed in the current millisecond", async () => {
    const orphan = path.join(dataDir, "git-mirrors", "project-gone");
    await fs.mkdir(path.join(orphan, "mount"), { recursive: true });
    // Half a millisecond into the clock's current millisecond, as a change
    // just made reads on a filesystem with sub-millisecond timestamps.
    const changedAtMs = 1_700_000_000_000;
    await fs.utimes(orphan, (changedAtMs + 0.5) / 1000, (changedAtMs + 0.5) / 1000);
    expect((await fs.lstat(orphan)).mtimeMs).toBeGreaterThan(changedAtMs);

    expect(await sweepOrphanedProjectGitMirrors(dataDir, new Set(), 0, () => changedAtMs)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  test("the sweep's owner set comes from a store that exists, or not at all", async () => {
    await expect(storage.loadProjectIdsForCleanup()).rejects.toThrow("cleanup refused");
    await storage.addProject({
      id: PROJECT_ID,
      gitUrl: `file://${remote}`,
      name: "p",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    } as never);
    expect(await storage.loadProjectIdsForCleanup()).toEqual(new Set([PROJECT_ID]));
  });
});

describe("container arguments", () => {
  test("a read-only bind of its own access kind's mount, and the path the setup script reads", async () => {
    for (const kind of ["anonymous", "github-pat", "github-host-cli"] as const) {
      const args = await gitMirrorContainerArguments(dataDir, { id: PROJECT_ID }, kind);

      expect(args).toEqual([
        "-v",
        `${mountPath(kind)}:${CONTAINER_GIT_MIRROR_MOUNT}:ro`,
        "-e",
        `ORKESTRATOR_GIT_MIRROR=${CONTAINER_GIT_MIRROR_PATH}`,
      ]);
      expect((await fs.stat(mountPath(kind))).mode & 0o777).toBe(0o755);
    }
    // Binding one kind never creates the legacy mount every container shared.
    expect(existsSync(path.join(projectDir(), "mount"))).toBe(false);
  });

  test("a path `-v` cannot express gives no mount rather than a failed create", async () => {
    const colon = path.join(root, "da:ta");
    expect(await gitMirrorContainerArguments(colon, { id: PROJECT_ID }, "anonymous")).toEqual([]);
  });

  test("an unusable data directory gives no mount and does not throw", async () => {
    const file = path.join(root, "file");
    await fs.writeFile(file, "");
    expect(await gitMirrorContainerArguments(file, { id: PROJECT_ID }, "anonymous")).toEqual([]);
  });
});

test("a clone report during fetch survives publication and is verified next time", async () => {
  expect(await refresh()).toBe("built");
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run: typeof runCommand = async (command, args, options) => {
    if (args?.includes("fetch")) {
      started();
      await gate;
    }
    return runCommand(command, args, options);
  };
  const pending = refresh({ run });
  await fetching;
  try {
    await noteGitMirrorCloneOutcome("\x1eORKESTRATOR_GIT_MIRROR:corrupt\x1f", dataDir, PROJECT_ID);
  } finally {
    release();
  }
  expect(await pending).toBe("fetched");
  expect(JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")).suspect).toBe(
    true,
  );
  let verified = false;
  expect(
    await refresh({
      run: (command, args, options) => {
        if (args?.includes("fsck")) verified = true;
        return runCommand(command, args, options);
      },
    }),
  ).toBe("fetched");
  expect(verified).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(projectDir(), "state.json"), "utf8")).suspect).toBe(
    false,
  );
});

describe("review regressions", () => {
  const access = (generation: string): GitMirrorAccess => ({
    kind: "github-pat",
    token: "token",
    localRemote: true,
    generation,
  });
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";

  test("oversized backoff survives a fresh authenticated generation", async () => {
    const options = { force: false, now: () => 100000000, maxBytes: 1 };
    expect(await refresh(options, project(), access(first))).toBe("oversized");
    let commands = 0;
    expect(
      await refresh(
        {
          ...options,
          run: async () => {
            commands++;
            throw new Error("unexpected transfer");
          },
        },
        project(),
        access(second),
      ),
    ).toBe("skipped-oversized");
    expect(commands).toBe(0);
    expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
  });

  test("failed-attempt backoff survives a fresh authenticated generation", async () => {
    const options = {
      force: false,
      now: () => 100000000,
      run: async () => {
        throw new Error("refused");
      },
    };
    expect(await refresh(options, project(), access(first))).toBe("failed");
    expect(await refresh(options, project(), access(second))).toBe("skipped-recent");
  });

  test("successful-attempt interval survives a fresh authenticated generation", async () => {
    const options = { force: false, now: () => 100000000 };
    expect(await refresh(options, project(), access(first))).toBe("built");
    expect(await refresh(options, project(), access(second))).toBe("skipped-recent");
    expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
    expect(existsSync(mirrorPath("github-pat-" + second))).toBe(false);
  });

  test.each([undefined, "less-privileged-token"])(
    "credential sync withdraws old publication and drains a blocked fetch (%s)",
    async (token) => {
      const old = access(first);
      expect(await refresh({}, project(), old)).toBe("built");
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run: typeof runCommand = async (command, args, options) => {
        if (args?.includes("fetch")) {
          started();
          await blocked;
        }
        return runCommand(command, args, options);
      };
      const running = refresh({ run }, project(), old);
      await entered;
      try {
        await withDockerScript(
          `#!/bin/sh
[ ! -e '${mirrorPath("github-pat-" + first)}' ] || exit 1
cat >/dev/null
exit 0
`,
          async () => {
            const sync = syncRuntimeGitHubCredential(
              { projectId: PROJECT_ID } as Environment,
              "fixture-container",
              token,
              context,
            );
            release();
            await sync;
          },
        );
        expect(await running).toBe("cancelled");
        expect(existsSync(mirrorPath("github-pat-" + first))).toBe(false);
      } finally {
        release();
        await running;
      }
    },
  );

  test("outer permission failure includes the ownership remediation", async () => {
    const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    configureLogger({
      sink: (entry) => {
        if (entry.record) entries.push(entry.record);
      },
    });
    try {
      const error = Object.assign(new Error("denied"), { code: "EACCES" });
      expect(
        await refresh({
          freeBytes: async () => {
            throw error;
          },
        }),
      ).toBe("failed");
      expect(
        entries.find((entry) => entry.event === "git-mirror.refresh-failed")?.fields?.remediation,
      ).toContain("Restore backend-user ownership");
    } finally {
      resetLogger();
    }
  });
});
