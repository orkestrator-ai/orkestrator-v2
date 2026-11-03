import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLocalGitStatusDetailed } from "./commands-files.js";
import { runCommand } from "./shell.js";

test("scanning a stat-dirty but content-clean linked worktree leaves its index untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-local-scan-index-"));
  try {
    const repository = path.join(root, "repository");
    const linked = path.join(root, "linked");
    await fs.mkdir(repository);
    const git = (cwd: string, ...args: string[]) =>
      runCommand(
        "git",
        ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
        {
          cwd,
        },
      );
    await git(repository, "init", "-b", "main");
    await fs.writeFile(path.join(repository, "tracked.txt"), "unchanged\n");
    await fs.writeFile(path.join(repository, "empty.txt"), "");
    await fs.writeFile(path.join(repository, "binary.bin"), Buffer.from([0, 1]));
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "initial");
    await git(repository, "worktree", "add", "-b", "feature", linked);
    const index = path.resolve(
      linked,
      (await git(linked, "rev-parse", "--git-path", "index")).stdout.trim(),
    );
    // Force stale cached stat data without changing the contents. Unlike a
    // content edit, this makes an ordinary status refresh rewrite the index.
    const oldIndexTime = new Date("2000-01-01T00:00:00Z");
    const oldFileTime = new Date("2001-01-01T00:00:00Z");
    await fs.utimes(index, oldIndexTime, oldIndexTime);
    await fs.utimes(path.join(linked, "tracked.txt"), oldFileTime, oldFileTime);
    const before = await fs.readFile(index);
    const mtimeBefore = (await fs.stat(index)).mtimeMs;

    expect(
      await getLocalGitStatusDetailed(linked, "main", true, {
        ensureFetched: async () => undefined,
      }),
    ).toEqual({
      changes: [],
      truncated: false,
      baseOid: (await git(linked, "rev-parse", "main")).stdout.trim(),
    });
    expect(await fs.readFile(index)).toEqual(before);
    expect((await fs.stat(index)).mtimeMs).toBe(mtimeBefore);

    // Positive control: prove the fixture needs an index refresh, so removing
    // --no-optional-locks cannot make the assertions above pass by accident.
    expect((await git(linked, "status", "--porcelain=v1")).stdout).toBe("");
    expect(await fs.readFile(index)).not.toEqual(before);
    expect((await fs.stat(index)).mtimeMs).not.toBe(mtimeBefore);

    // Content checks must retain real changes, including ones with zero line
    // counts, rather than mistaking them for the stat-only modification above.
    await fs.appendFile(path.join(linked, "tracked.txt"), "added\n");
    await fs.chmod(path.join(linked, "empty.txt"), 0o755);
    await fs.writeFile(path.join(linked, "binary.bin"), Buffer.from([0, 2]));
    await fs.writeFile(path.join(linked, "new-empty.txt"), "");
    await git(linked, "add", "new-empty.txt");
    const dirtyIndex = await fs.readFile(index);
    const dirtyMtime = (await fs.stat(index)).mtimeMs;
    const read = await getLocalGitStatusDetailed(linked, "main", true, {
      ensureFetched: async () => undefined,
    });
    expect(
      read.changes.map(({ path, status, additions, deletions }) => ({
        path,
        status,
        additions,
        deletions,
      })),
    ).toEqual([
      { path: "binary.bin", status: "M", additions: 0, deletions: 0 },
      { path: "empty.txt", status: "M", additions: 0, deletions: 0 },
      { path: "new-empty.txt", status: "A", additions: 0, deletions: 0 },
      { path: "tracked.txt", status: "M", additions: 1, deletions: 0 },
    ]);
    expect(await fs.readFile(index)).toEqual(dirtyIndex);
    expect((await fs.stat(index)).mtimeMs).toBe(dirtyMtime);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scanning a worktree does not run a program its own Git config names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-local-scan-config-"));
  try {
    const repository = path.join(root, "repository");
    const marker = path.join(root, "fsmonitor-ran");
    const hook = path.join(root, "fsmonitor.sh");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const git = (...args: string[]) =>
      runCommand(
        "git",
        ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
        { cwd: repository },
      );
    await fs.mkdir(repository);
    await git("init", "-b", "main");
    await fs.writeFile(path.join(repository, "tracked.txt"), "unchanged\n");
    await git("add", ".");
    await git("commit", "-m", "initial");
    // Whatever runs in the worktree can write this; the repository config
    // overrides the test preload's global `core.fsmonitor=false`.
    await git("config", "core.fsmonitor", hook);
    await fs.writeFile(path.join(repository, "untracked.txt"), "new\n");

    const read = await getLocalGitStatusDetailed(repository, "main", true, {
      ensureFetched: async () => undefined,
    });
    expect(read.changes.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "untracked.txt", status: "?" },
    ]);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();

    // Positive control: an unhardened status in the same worktree runs it.
    await git("--no-optional-locks", "status", "--porcelain=v1");
    expect(await fs.stat(marker).catch(() => null)).not.toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const setting of ["clean", "process"] as const) {
  test(`local scans never execute a configured ${setting} filter`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-local-scan-filter-"));
    try {
      const repository = path.join(root, "repository");
      const marker = path.join(root, "filter-ran");
      const script = path.join(root, "filter.sh");
      await fs.mkdir(repository);
      const git = (...args: string[]) =>
        runCommand(
          "git",
          ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
          { cwd: repository },
        );
      await git("init", "-b", "main");
      await fs.writeFile(
        path.join(repository, ".gitattributes"),
        "tracked.txt filter=evil.dotted\n",
      );
      await fs.writeFile(path.join(repository, "tracked.txt"), "original\n");
      await git("add", ".");
      await git("commit", "-m", "initial");
      // process intentionally exits without a handshake after writing the marker.
      await fs.writeFile(
        script,
        `#!/bin/sh\ntouch '${marker}'\n${setting === "clean" ? "cat" : "exit 1"}\n`,
        { mode: 0o755 },
      );
      await git("config", `filter.evil.dotted.${setting}`, script);
      await git("config", "filter.evil.dotted.required", "true");
      await fs.writeFile(path.join(repository, "tracked.txt"), "modified\n");
      await fs.utimes(
        path.join(repository, "tracked.txt"),
        new Date("2001-01-01"),
        new Date("2001-01-01"),
      );
      const read = await getLocalGitStatusDetailed(repository, "main", true, {
        ensureFetched: async () => undefined,
      });
      expect(read.changes).toMatchObject([
        { path: "tracked.txt", status: "M", additions: 1, deletions: 1 },
      ]);
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
      // Both unhardened read modes must actually reach the external driver.
      for (const args of [
        ["status", "--porcelain=v1"],
        ["diff", "--numstat", "HEAD"],
      ]) {
        await git("--no-optional-locks", ...args).catch(() => undefined);
        expect(await fs.stat(marker).catch(() => null)).not.toBeNull();
        await fs.unlink(marker);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
