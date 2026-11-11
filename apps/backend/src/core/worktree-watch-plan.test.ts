import { describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exceedsDirectories,
  worktreeWatchPlanIo,
  planWatchTargets,
  WATCH_PLAN_MAX_TARGETS,
  WHOLE_WORKTREE,
  type WatchTarget,
} from "./worktree-watch-plan.js";

const tree: Record<string, readonly string[]> = {
  "": [".git", "apps", "node_modules", "src"],
  apps: ["api", "web"],
  "apps/web": ["node_modules", "src"],
};

const children = async (relative: string) => {
  const entries = tree[relative];
  if (!entries) throw Object.assign(new Error("gone"), { code: "ENOENT" });
  return entries;
};

const byPath = (targets: readonly WatchTarget[]) =>
  [...targets].sort((a, b) => a.relative.localeCompare(b.relative));

describe("planWatchTargets", () => {
  test("nothing left out is one recursive watch of the root", async () => {
    expect(await planWatchTargets([], children)).toEqual(WHOLE_WORKTREE);
  });

  test("covers everything but the excluded subtrees, at any depth", async () => {
    const targets = await planWatchTargets(["node_modules", "apps/web/node_modules"], children);
    expect(byPath(targets)).toEqual([
      { relative: "", recursive: false },
      { relative: ".git", recursive: true },
      { relative: "apps", recursive: false },
      { relative: "apps/api", recursive: true },
      { relative: "apps/web", recursive: false },
      { relative: "apps/web/src", recursive: true },
      { relative: "src", recursive: true },
    ]);
  });

  test.each(["ENOENT", "ENOTDIR"])(
    "a split directory that went away (%s) is skipped",
    async (code) => {
      const targets = await planWatchTargets(["gone/deep/node_modules"], async (relative) => {
        if (relative.startsWith("gone")) throw Object.assign(new Error("gone"), { code });
        return children(relative);
      });
      expect(targets.map((target) => target.relative)).not.toContain("gone/deep");
      expect(targets).toContainEqual({ relative: "src", recursive: true });
    },
  );

  test("a root that went away rejects, because nothing can be planned", async () => {
    await expect(
      planWatchTargets(["node_modules"], async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    ).rejects.toThrow("gone");
  });

  test("too many watches keeps the whole worktree under one", async () => {
    const wide = async (relative: string) =>
      relative === ""
        ? Array.from({ length: WATCH_PLAN_MAX_TARGETS + 1 }, (_, index) => `d${index}`)
        : [];
    expect(await planWatchTargets(["node_modules"], wide)).toEqual(WHOLE_WORKTREE);
  });

  // `fs` cannot reopen a name it decoded lossily, so a watch on it would fail.
  test("a directory name that did not decode keeps the whole worktree under one", async () => {
    const lossy = async () => ["src", "caf�"];
    expect(await planWatchTargets(["node_modules"], lossy)).toEqual(WHOLE_WORKTREE);
  });
});

describe("directoryIdentity", () => {
  test.each(["ENOENT", "ENOTDIR"])("%s is absence", async (code) => {
    const read = spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("gone"), { code }));
    try {
      expect(await worktreeWatchPlanIo.directoryIdentity("/wt", "src")).toBeNull();
    } finally {
      read.mockRestore();
    }
  });

  test.each(["EACCES", "EIO"])("%s propagates to the watcher owner", async (code) => {
    const error = Object.assign(new Error("unreadable"), { code });
    const read = spyOn(fs, "lstat").mockRejectedValue(error);
    try {
      await expect(worktreeWatchPlanIo.directoryIdentity("/wt", "src")).rejects.toBe(error);
    } finally {
      read.mockRestore();
    }
  });
});

describe("exceedsDirectories", () => {
  async function treeOf(directories: string[]): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-watch-count-")));
    for (const directory of directories) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
    }
    return root;
  }

  test("counts every directory below the tree, at any depth, against the bound", async () => {
    // Below `big`: a, a/b, a/b/c, d, d/e: five directories.
    const root = await treeOf(["big/a/b/c", "big/d/e"]);
    await fs.writeFile(path.join(root, "big/a/file"), "x");
    try {
      expect(await exceedsDirectories(root, "big", 5)).toBe(false);
      expect(await exceedsDirectories(root, "big", 4)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("stops reading once past the bound", async () => {
    const root = await treeOf(["big/a/x/y/z", "big/b/x/y/z", "big/c/x/y/z"]);
    const reads = spyOn(fs, "readdir");
    try {
      expect(await exceedsDirectories(root, "big", 2)).toBe(true);
      // The tree's own listing names three: no directory below it was read.
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("follows no symlink, and a tree that is gone is not large", async () => {
    const root = await treeOf(["big/a", "elsewhere/a/b/c/d"]);
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "big/link"));
    try {
      expect(await exceedsDirectories(root, "big", 1)).toBe(false);
      expect(await exceedsDirectories(root, "absent", 0)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
