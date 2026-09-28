import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getWorktreeBaseDir } from "./commands-environment.js";
import { APP_SLUG } from "./constants.js";

const preloadWorktreeDir = process.env.ORKESTRATOR_WORKTREE_DIR;

afterEach(() => {
  if (preloadWorktreeDir === undefined) delete process.env.ORKESTRATOR_WORKTREE_DIR;
  else process.env.ORKESTRATOR_WORKTREE_DIR = preloadWorktreeDir;
});

describe("getWorktreeBaseDir", () => {
  test("stays out of the user's real workspaces root under the test preload", () => {
    expect(preloadWorktreeDir).toBeDefined();
    expect(getWorktreeBaseDir()).toBe(preloadWorktreeDir!);
    const relative = path.relative(path.join(os.homedir(), APP_SLUG), getWorktreeBaseDir());
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
  });

  test("prefers the context's directory over the configured fallback", () => {
    process.env.ORKESTRATOR_WORKTREE_DIR = "/configured/worktrees";
    expect(getWorktreeBaseDir({ worktreeDir: "/profile/worktrees" })).toBe("/profile/worktrees");
    expect(getWorktreeBaseDir({})).toBe("/configured/worktrees");
  });

  test("resolves ORKESTRATOR_WORKTREE_DIR and otherwise uses the home workspaces root", () => {
    process.env.ORKESTRATOR_WORKTREE_DIR = "relative-worktrees";
    expect(getWorktreeBaseDir()).toBe(path.resolve("relative-worktrees"));

    const homeRoot = path.join(os.homedir(), APP_SLUG, "workspaces");
    process.env.ORKESTRATOR_WORKTREE_DIR = "  ";
    expect(getWorktreeBaseDir()).toBe(homeRoot);
    delete process.env.ORKESTRATOR_WORKTREE_DIR;
    expect(getWorktreeBaseDir()).toBe(homeRoot);
  });
});
