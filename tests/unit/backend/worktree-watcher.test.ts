import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyWorktreeChange,
  isIgnorableWorktreeChange,
  startWorktreeWatcher,
  WATCH_BURST_OVERFLOW_EVENTS,
  WATCH_SETTLE_MS,
} from "../../../apps/backend/src/core/worktree-watcher";
import {
  relevantRefPaths,
  resolveWorktreeGitPaths,
} from "../../../apps/backend/src/core/worktree-git-paths";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

interface FakeWatch {
  emit: (eventType: string, filename: string | null) => void;
  closed: boolean;
  fail: (error: unknown) => void;
}

function fakeWatcher(): {
  start: NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;
  handle: FakeWatch;
} {
  const handle: FakeWatch = { emit: () => {}, closed: false, fail: () => {} };
  const errorHandlers = new Set<(error: unknown) => void>();

  const start = ((
    _target: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => {
    handle.emit = listener;
    handle.fail = (error) => {
      for (const onError of errorHandlers) onError(error);
    };
    return {
      on(event: string, onError: (error: unknown) => void) {
        if (event === "error") errorHandlers.add(onError);
        return this;
      },
      close() {
        handle.closed = true;
      },
    };
  }) as NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;

  return { start, handle };
}

async function waitForSettle(settleMs: number) {
  await new Promise((resolve) => setTimeout(resolve, settleMs + 30));
}

describe("isIgnorableWorktreeChange", () => {
  // Git rewrites .git constantly with locks, object writes and packing; only the
  // index and HEAD change what a diff reports.
  test.each([
    ".git/objects/ab/cdef",
    ".git/index.lock",
    ".git/refs/heads/main",
    ".git/COMMIT_EDITMSG",
    ".git/logs/HEAD",
  ])("ignores git churn: %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(true);
  });

  test.each([".git/index", ".git/HEAD"])("does not ignore %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(false);
  });

  test.each([
    "src/index.ts",
    "README.md",
    ".gitignore",
    ".github/workflows/ci.yml",
    "docs/.git-notes.md",
  ])("does not ignore source path: %s", (filename) => {
    expect(isIgnorableWorktreeChange(filename)).toBe(false);
  });

  // A rename can arrive without a filename; assuming "irrelevant" would drop a
  // real change, so it must fall through to a scan.
  test("does not ignore a missing filename", () => {
    expect(isIgnorableWorktreeChange(null)).toBe(false);
  });

  test("does not ignore a path merely starting with .git", () => {
    expect(isIgnorableWorktreeChange(".gitmodules")).toBe(false);
  });
});

describe("startWorktreeWatcher", () => {
  test("debounces a burst of events into one callback", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => {
        changes += 1;
      },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", "a.ts");
    handle.emit("change", "b.ts");
    handle.emit("change", "c.ts");
    expect(changes).toBe(0);

    await waitForSettle(20);
    expect(changes).toBe(1);
  });

  test("fires again for a later burst", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => {
        changes += 1;
      },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", "a.ts");
    await waitForSettle(20);
    handle.emit("change", "b.ts");
    await waitForSettle(20);

    expect(changes).toBe(2);
  });

  test("does not fire for git churn alone", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => {
        changes += 1;
      },
    });
    cleanups.push(() => watcher.close());

    handle.emit("change", ".git/index.lock");
    handle.emit("change", ".git/objects/aa/bb");
    await waitForSettle(20);

    expect(changes).toBe(0);
  });

  test("does not fire after close", async () => {
    const { start, handle } = fakeWatcher();
    let changes = 0;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 20,
      startWatch: start,
      onChange: () => {
        changes += 1;
      },
    });

    handle.emit("change", "a.ts");
    watcher.close();
    await waitForSettle(20);

    expect(changes).toBe(0);
    expect(handle.closed).toBe(true);
  });

  test("close is idempotent", () => {
    const { start } = fakeWatcher();
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
    });

    watcher.close();
    expect(() => watcher.close()).not.toThrow();
    expect(watcher.watching).toBe(false);
  });

  test("close remains safe when the platform watcher throws while closing", () => {
    const start = ((
      _target: string,
      _listener: (eventType: string, filename: string | null) => void,
    ) => ({
      on() {
        return this;
      },
      close() {
        throw new Error("watcher already torn down");
      },
    })) as NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
    });

    expect(watcher.watching).toBe(true);
    expect(() => watcher.close()).not.toThrow();
    expect(watcher.watching).toBe(false);
  });

  // The owner has to fall back to polling rather than going quiet forever.
  test("reports not watching when the watch cannot be established", () => {
    let reported: unknown;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: () => {
        throw new Error("ENOSYS: recursive watch unsupported");
      },
      onChange: () => {},
      onError: (error) => {
        reported = error;
      },
    });
    cleanups.push(() => watcher.close());

    expect(watcher.watching).toBe(false);
    expect(reported).toBeInstanceOf(Error);
  });

  test("reports and closes when the watch fails asynchronously", () => {
    const { start, handle } = fakeWatcher();
    let reported: unknown;
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      startWatch: start,
      onChange: () => {},
      onError: (error) => {
        reported = error;
      },
    });
    cleanups.push(() => watcher.close());
    expect(watcher.watching).toBe(true);

    handle.fail(new Error("EMFILE"));

    expect(reported).toBeInstanceOf(Error);
    expect(watcher.watching).toBe(false);
  });

  test("defaults to a settle window rather than firing per event", () => {
    expect(WATCH_SETTLE_MS).toBeGreaterThan(0);
  });

  // Exercises the real fs.watch rather than the injected fake. Recursive watching
  // is not available on every platform, so an unwatchable environment is a skip
  // and not a failure - that is the documented degradation.
  test("observes a real file write", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-watch-"));
    let changes = 0;
    let resolveChange!: () => void;
    const changeObserved = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = startWorktreeWatcher({
      worktreePath: directory,
      settleMs: 50,
      onChange: () => {
        changes += 1;
        resolveChange();
      },
    });
    cleanups.push(() => watcher.close());

    if (!watcher.watching) return;

    const deadline = Date.now() + 2_000;
    let attempt = 0;
    while (changes === 0 && Date.now() < deadline) {
      await fs.writeFile(
        path.join(directory, `created-${attempt}.ts`),
        `export const value = ${attempt};\n`,
      );
      attempt += 1;
      await Promise.race([changeObserved, new Promise<void>((resolve) => setTimeout(resolve, 75))]);
    }

    expect(changes).toBeGreaterThan(0);
  });
});

describe("classifyWorktreeChange", () => {
  const refs = relevantRefPaths("main");

  test("a working-tree edit may change both views; node_modules only the file list", () => {
    expect(classifyWorktreeChange("src/a.ts", refs)).toEqual({ fileList: true, tree: true });
    // The tree skips node_modules at every depth, but tracked or visible
    // untracked files there still change Git status.
    expect(classifyWorktreeChange("pkg/node_modules/x/index.js", refs)).toEqual({
      fileList: true,
      tree: false,
    });
    expect(classifyWorktreeChange("dist/bundle.js", refs)).toEqual({ fileList: true, tree: true });
  });

  test("only metadata that can move the diff passes: index, HEAD, packed-refs, the baseline's refs", () => {
    for (const relevant of [
      ".git/index",
      ".git/HEAD",
      ".git/packed-refs",
      ".git/refs/remotes/origin/main",
      ".git/refs/heads/main",
    ]) {
      expect(classifyWorktreeChange(relevant, refs)).toEqual({ fileList: true, tree: false });
    }
    for (const noise of [
      ".git/FETCH_HEAD",
      ".git/refs/heads/other-branch",
      ".git/refs/remotes/origin/main.lock",
      ".git/logs/refs/heads/main",
      ".git/objects/pack/pack-1.pack",
    ]) {
      expect(classifyWorktreeChange(noise, refs)).toBeNull();
    }
  });

  test("an unknown filename dirties everything", () => {
    expect(classifyWorktreeChange(null, refs)).toEqual({ fileList: true, tree: true });
  });

  test("an immutable commit baseline resolves through no ref", () => {
    expect(relevantRefPaths("0123456789abcdef0123456789abcdef01234567")).toEqual([]);
    expect(relevantRefPaths("main")).toEqual(
      expect.arrayContaining(["refs/remotes/origin/main", "refs/heads/main"]),
    );
  });
});

describe("linked worktree metadata coverage", () => {
  function recordingWatches() {
    const watches = new Map<
      string,
      {
        emit: (eventType: string, filename: string | null) => void;
        fail: (error: unknown) => void;
        recursive: boolean;
        closed: boolean;
      }
    >();
    const start = ((
      target: string,
      listener: (eventType: string, filename: string | null) => void,
      options: { recursive: boolean },
    ) => {
      const errorHandlers = new Set<(error: unknown) => void>();
      const record = {
        emit: listener,
        fail: (error: unknown) => {
          for (const onError of errorHandlers) onError(error);
        },
        recursive: options?.recursive ?? true,
        closed: false,
      };
      watches.set(target, record);
      return {
        on(event: string, onError: (error: unknown) => void) {
          if (event === "error") errorHandlers.add(onError);
          return this;
        },
        close() {
          record.closed = true;
        },
      };
    }) as NonNullable<Parameters<typeof startWorktreeWatcher>[0]["startWatch"]>;
    return { watches, start };
  }

  const linkedPaths = {
    gitDir: "/repo/.git/worktrees/wt",
    commonDir: "/repo/.git",
    linked: true,
  };

  test("is qualified only once the Git dir and shared refs are watched", async () => {
    const { watches, start } = recordingWatches();
    let resolvePaths!: (paths: typeof linkedPaths) => void;
    let coverageChanges = 0;
    const hints: unknown[] = [];
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      comparisonRef: "main",
      settleMs: 10,
      startWatch: start,
      resolveGitPaths: () => new Promise((resolve) => (resolvePaths = resolve)),
      onChange: (hint) => hints.push(hint),
      onCoverageChange: () => {
        coverageChanges += 1;
      },
    });
    cleanups.push(() => watcher.close());
    expect(watcher.watching).toBe(true);
    expect(watcher.qualified).toBe(false);

    resolvePaths(linkedPaths);
    await Promise.resolve();
    await Promise.resolve();
    expect(watcher.qualified).toBe(true);
    expect(coverageChanges).toBe(1);
    expect([...watches.keys()].sort()).toEqual(
      ["/wt", "/repo/.git/worktrees/wt", "/repo/.git", "/repo/.git/refs"].sort(),
    );
    expect(watches.get("/repo/.git/worktrees/wt")?.recursive).toBe(false);

    // Staging in the linked worktree rewrites only its own index.
    watches.get("/repo/.git/worktrees/wt")!.emit("rename", "index.lock");
    watches.get("/repo/.git/worktrees/wt")!.emit("rename", "index");
    await waitForSettle(10);
    expect(hints).toEqual([{ fileList: true, tree: false, overflow: false }]);

    // A fetch that moves the baseline lands in the shared refs.
    watches.get("/repo/.git/refs")!.emit("rename", "heads/other");
    watches.get("/repo/.git")!.emit("change", "FETCH_HEAD");
    await waitForSettle(10);
    expect(hints).toHaveLength(1);
    watches.get("/repo/.git/refs")!.emit("rename", "remotes/origin/main");
    await waitForSettle(10);
    watches.get("/repo/.git")!.emit("rename", "packed-refs");
    await waitForSettle(10);
    expect(hints).toHaveLength(3);
  });

  test("a failing metadata watch closes everything so the owner falls back", async () => {
    const { watches, start } = recordingWatches();
    const errors: unknown[] = [];
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      comparisonRef: "main",
      startWatch: start,
      resolveGitPaths: async () => linkedPaths,
      onChange: () => undefined,
      onError: (error) => errors.push(error),
    });
    cleanups.push(() => watcher.close());
    await Promise.resolve();
    await Promise.resolve();
    watches.get("/repo/.git/refs")!.fail(new Error("ENOSPC"));
    expect(errors).toHaveLength(1);
    expect(watcher.watching).toBe(false);
    expect(watcher.qualified).toBe(false);
    expect([...watches.values()].every((watch) => watch.closed)).toBe(true);
  });

  test("a main checkout is covered by the root watch alone", async () => {
    const { watches, start } = recordingWatches();
    const watcher = startWorktreeWatcher({
      worktreePath: "/repo",
      startWatch: start,
      resolveGitPaths: async () => ({
        gitDir: "/repo/.git",
        commonDir: "/repo/.git",
        linked: false,
      }),
      onChange: () => undefined,
    });
    cleanups.push(() => watcher.close());
    await Promise.resolve();
    await Promise.resolve();
    expect(watcher.qualified).toBe(true);
    expect([...watches.keys()]).toEqual(["/repo"]);
  });

  test("a burst beyond the overflow bound is reported once, as an overflow", async () => {
    const { watches, start } = recordingWatches();
    const hints: unknown[] = [];
    const watcher = startWorktreeWatcher({
      worktreePath: "/wt",
      settleMs: 10,
      startWatch: start,
      resolveGitPaths: null,
      onChange: (hint) => hints.push(hint),
    });
    cleanups.push(() => watcher.close());
    for (let index = 0; index <= WATCH_BURST_OVERFLOW_EVENTS; index += 1) {
      watches.get("/wt")!.emit("change", "node_modules/a.js");
    }
    await waitForSettle(10);
    expect(hints).toEqual([{ fileList: true, tree: true, overflow: true }]);
    expect(watcher.qualified).toBe(false);
  });
});

describe("resolveWorktreeGitPaths", () => {
  test("resolves a main checkout and a linked worktree from real Git", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-gitpaths-")));
    cleanups.push(() => void fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    const linked = path.join(root, "linked");
    const run = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    await fs.mkdir(repo);
    run(repo, "init", "-q", "-b", "main");
    run(
      repo,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    run(repo, "worktree", "add", "-q", linked, "-b", "feature");

    expect(await resolveWorktreeGitPaths(repo)).toEqual({
      gitDir: path.join(repo, ".git"),
      commonDir: path.join(repo, ".git"),
      linked: false,
    });
    expect(await resolveWorktreeGitPaths(linked)).toEqual({
      gitDir: path.join(repo, ".git", "worktrees", "linked"),
      commonDir: path.join(repo, ".git"),
      linked: true,
    });
    expect(await resolveWorktreeGitPaths(root)).toBeUndefined();
  });
});
