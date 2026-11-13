/**
 * Part of the host side of a project's Git mirror, with real Git against real local
 * repositories: seeding from the host checkout (part 1). The suite is split across
 * `project-git-mirror-*.integration.test.ts` so `bun test --parallel` can run the parts
 * on separate workers; the shared fixture and helpers live in
 * `project-git-mirror-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import {
  registerGitMirrorFixture,
  allObjects,
  commit,
  commitLargeHistory,
  countRemotePackBytes,
  expectExactlyTheRemote,
  git,
  mirrorPath,
  mirrorRefs,
  projectDir,
  refresh,
  remote,
  remoteTip,
  root,
  seeded,
  work,
} from "./project-git-mirror-fixtures";

registerGitMirrorFixture();

describe("seeding from the host checkout", () => {
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

  for (const phase of ["checkout"]) {
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
});
