/**
 * Part of the host side of a project's Git mirror, with real Git against real local
 * repositories: seeding from the host checkout (part 2). The suite is split across
 * `project-git-mirror-*.integration.test.ts` so `bun test --parallel` can run the parts
 * on separate workers; the shared fixture and helpers live in
 * `project-git-mirror-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { removeProjectGitMirror } from "../src/core/project-git-mirror";
import { runCommand } from "../src/core/shell";
import { startGitHttpRemote } from "./git-http-fixture";
import {
  registerGitMirrorFixture,
  PROJECT_ID,
  commit,
  commitLargeHistory,
  context,
  expectExactlyTheRemote,
  git,
  mirrorPath,
  projectDir,
  refresh,
  remote,
  root,
  seeded,
  work,
} from "./project-git-mirror-fixtures";

registerGitMirrorFixture();

describe("seeding from the host checkout", () => {
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

  for (const phase of ["staged"]) {
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
