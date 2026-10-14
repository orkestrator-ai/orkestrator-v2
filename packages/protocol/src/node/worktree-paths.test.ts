import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertWorktreePathUnlinked,
  canonicalWorktreePath,
  captureWorktreePathIdentity,
} from "./worktree-paths";

test("canonicalizes missing descendants, rejects aliases and detects replacement ancestors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-paths-"));
  try {
    const parent = path.join(root, "parent");
    const alias = path.join(root, "alias");
    await mkdir(parent);
    await symlink(parent, alias);
    expect(canonicalWorktreePath(path.join(alias, "missing", "child"))).toBe(
      path.join(canonicalWorktreePath(parent), "missing", "child"),
    );
    expect(() => assertWorktreePathUnlinked(path.join(alias, "missing"))).toThrow("symlink");
    const check = captureWorktreePathIdentity(path.join(parent, "new"));
    check();
    await rename(parent, `${parent}-old`);
    await mkdir(parent);
    expect(() => check()).toThrow("ancestor changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
