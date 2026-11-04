import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getContainerGitStatusDetailed, getLocalGitStatusDetailed } from "./commands-files.js";
import { localGitScanCacheStats } from "./local-git-scan-caches.js";
import { observeCommandInvocations, runCommand } from "./shell.js";

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

describe("git processes per scan (ST-14)", () => {
  // What a warm scan spawned before ST-14, on any base: exclude path, base
  // existence, filter config, name-status, numstat, status, base oid. A branch
  // with no `origin/` counterpart spawned one more.
  const BEFORE = 7;
  const fetches = { ensureFetched: async () => undefined };

  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-local-scan-processes-"));
    const repository = path.join(root, "repository");
    await fs.mkdir(repository);
    const git = (...args: string[]) =>
      runCommand(
        "git",
        ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
        {
          cwd: repository,
        },
      );
    await git("init", "-b", "main");
    await fs.writeFile(path.join(repository, "tracked.txt"), "one\ntwo\n");
    await fs.writeFile(path.join(repository, "old name.txt"), "a\nb\nc\nd\n");
    await git("add", ".");
    await git("commit", "-m", "initial");
    await fs.writeFile(path.join(repository, "tracked.txt"), "one\ntwo\nthree\n");
    await git("mv", "old name.txt", "new name.txt");
    await fs.writeFile(path.join(repository, "untracked.txt"), "new\n");
    const oid = (await git("rev-parse", "HEAD")).stdout.trim();
    return { root, repository, git, oid };
  }

  async function scanCounting(repository: string, base: string) {
    const processes: string[][] = [];
    const stop = observeCommandInvocations("git", (args) => processes.push([...args]));
    try {
      const read = await getLocalGitStatusDetailed(repository, base, true, fetches);
      return { read, processes };
    } finally {
      stop();
    }
  }

  const running = (processes: string[][], verb: string) =>
    processes.filter((args) => args.includes(verb));

  test("runs one combined diff, resolves the base once and ensures the exclude file once", async () => {
    const { root, repository, oid } = await fixture();
    try {
      const first = await scanCounting(repository, oid);
      expect(running(first.processes, "diff")).toHaveLength(1);
      expect(
        first.processes.filter((args) => args.includes("--git-path")).map((args) => args.at(-1)),
      ).toEqual(["info/exclude"]);
      expect(first.processes).toHaveLength(BEFORE - 2);
      expect(first.read.baseOid).toBe(oid);
      expect(first.read.changes).toMatchObject([
        { path: "new name.txt", originalPath: "old name.txt", status: "R100" },
        { path: "tracked.txt", status: "M", additions: 1, deletions: 0 },
        { path: "untracked.txt", status: "?", additions: 1 },
      ]);

      const warm = await scanCounting(repository, oid);
      expect(warm.read).toEqual(first.read);
      expect(warm.processes).toHaveLength(4);
      expect(warm.processes.length).toBeLessThan(BEFORE);
      expect(running(warm.processes, "rev-parse")).toHaveLength(1);
      expect(running(warm.processes, "config")).toHaveLength(1);
      expect(running(warm.processes, "status")).toHaveLength(1);
      const [diff] = running(warm.processes, "diff");
      expect(diff).toEqual(expect.arrayContaining(["--raw", "--numstat", "-z", "-M", oid]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("compares against the commit a branch base resolved to, trying origin first", async () => {
    const { root, repository, git, oid } = await fixture();
    try {
      // No remote-tracking ref: `origin/main` misses, and `main` answers.
      const local = await scanCounting(repository, "main");
      expect(local.read.baseOid).toBe(oid);
      expect(running(local.processes, "diff")[0]).toContain(oid);

      await git("commit", "-m", "second", "--allow-empty");
      const second = (await git("rev-parse", "HEAD")).stdout.trim();
      await git("update-ref", "refs/remotes/origin/main", oid);
      const tracking = await scanCounting(repository, "main");
      expect(tracking.read.baseOid).toBe(oid);
      expect(tracking.read.baseOid).not.toBe(second);
      expect(tracking.processes).toHaveLength(4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a missing base still fails the scan with Git's own error", async () => {
    const { root, repository } = await fixture();
    try {
      await expect(
        getLocalGitStatusDetailed(repository, "no-such-branch", true, fetches),
      ).rejects.toThrow("origin/no-such-branch");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a removed exclude file is written again without its patterns going missing", async () => {
    const { root, repository } = await fixture();
    try {
      await getLocalGitStatusDetailed(repository, "main", true, fetches);
      const exclude = path.join(repository, ".git/info/exclude");
      await fs.rm(exclude);
      await fs.mkdir(path.join(repository, ".orkestrator"), { recursive: true });
      await fs.writeFile(path.join(repository, ".orkestrator/state"), "x\n");
      const read = await getLocalGitStatusDetailed(repository, "main", true, fetches);
      expect(read.changes.some((change) => change.path.startsWith(".orkestrator"))).toBe(false);
      expect(await fs.readFile(exclude, "utf8")).toContain(".orkestrator\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("a scan reads an unchanged settled untracked file once, and a fresh one every time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-local-scan-untracked-"));
  try {
    const repository = path.join(root, "repository");
    await fs.mkdir(repository);
    const git = (...args: string[]) =>
      runCommand(
        "git",
        ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
        {
          cwd: repository,
        },
      );
    await git("init", "-b", "main");
    await fs.writeFile(path.join(repository, "tracked.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-m", "initial");
    await fs.writeFile(path.join(repository, "untracked.txt"), "a\nb\n");
    const scan = () =>
      getLocalGitStatusDetailed(repository, "main", true, { ensureFetched: async () => undefined });

    // Inside the settle window: read each time, and a same-size rewrite shows.
    await scan();
    await scan();
    expect(localGitScanCacheStats(repository)).toMatchObject({ contentRead: 2, stampReused: 0 });
    await fs.writeFile(path.join(repository, "untracked.txt"), "\n\n\n\n");
    expect((await scan()).changes).toMatchObject([{ path: "untracked.txt", additions: 4 }]);
    expect(localGitScanCacheStats(repository)?.contentRead).toBe(3);

    const now = Date.now;
    const clock = spyOn(Date, "now").mockImplementation(() => now() + 10_000);
    try {
      await scan();
      expect(localGitScanCacheStats(repository)).toMatchObject({ contentRead: 4, counts: 1 });
      expect((await scan()).changes).toMatchObject([{ path: "untracked.txt", additions: 4 }]);
      expect(localGitScanCacheStats(repository)).toMatchObject({ contentRead: 4, stampReused: 1 });

      // Tracked now: the entry goes with the file's place in the list.
      await git("add", "untracked.txt");
      await scan();
      expect(localGitScanCacheStats(repository)?.counts).toBe(0);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("container status", () => {
  const framed = (body: string) =>
    [
      "\u001eORKESTRATOR_DIFF\u001f",
      Buffer.from(body).toString("base64"),
      "\u001eORKESTRATOR_UNTRACKED\u001f",
      "",
      "\u001eORKESTRATOR_END\u001f",
    ].join("");
  const fetches = {
    observe: () => undefined as never,
    recover: async () => false,
  };

  test("does the exclude housekeeping once per container with a repository", async () => {
    const scripts: string[] = [];
    let response = "";
    const deps = {
      exec: async (_id: string, script: string) => {
        scripts.push(script);
        return response;
      },
      fetches,
      ensuredExcludes: new Set<string>(),
    };
    const status = () => getContainerGitStatusDetailed("box", "main", true, deps);
    const housekeeping = (script?: string) => script?.includes("--git-path info/exclude");

    // No repository yet: the script exits before the housekeeping, so it is still owed.
    await status();
    expect(housekeeping(scripts[0])).toBe(true);
    expect(deps.ensuredExcludes.has("box")).toBe(false);

    response = framed("");
    await status();
    expect(housekeeping(scripts[1])).toBe(true);
    expect(deps.ensuredExcludes.has("box")).toBe(true);

    await status();
    expect(housekeeping(scripts[2])).toBe(false);
    await getContainerGitStatusDetailed("other", "main", true, deps);
    expect(housekeeping(scripts[3])).toBe(true);
  });
});
