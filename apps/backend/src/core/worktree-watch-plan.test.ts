import { describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import {
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
