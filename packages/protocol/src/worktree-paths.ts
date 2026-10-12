import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/** Resolve existing ancestors too, including when the final directories do not exist. */
export function canonicalWorktreePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(canonicalWorktreePath(parent), path.basename(resolved));
  }
}

/** Refuse user-controlled symlink ancestors before writing or deleting worktrees. */
export function assertWorktreePathUnlinked(value: string): void {
  let current = path.resolve(value);
  while (current !== path.dirname(current)) {
    try {
      const stats = lstatSync(current);
      // macOS provides these system aliases; user-selected descendants are still checked.
      const systemAlias = process.platform === "darwin" && ["/var", "/tmp"].includes(current);
      if (stats.isSymbolicLink() && !systemAlias) {
        throw new Error("Worktree path must not contain symlinked ancestors");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}

/** Recheck the identity of every existing ancestor after asynchronous preparation. */
export function captureWorktreePathIdentity(value: string): () => void {
  assertWorktreePathUnlinked(value);
  const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
  let current = path.resolve(value);
  while (current !== path.dirname(current)) {
    try {
      const stats = lstatSync(current);
      ancestors.push({ path: current, dev: stats.dev, ino: stats.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  return () => {
    assertWorktreePathUnlinked(value);
    for (const ancestor of ancestors) {
      const stats = lstatSync(ancestor.path);
      if (stats.dev !== ancestor.dev || stats.ino !== ancestor.ino) {
        throw new Error("Worktree path ancestor changed during the operation");
      }
    }
  };
}
