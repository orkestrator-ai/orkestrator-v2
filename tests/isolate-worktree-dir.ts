import { afterAll } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
import { createOwnedTempDir, sweepStaleTempDirs } from "./temp-sweep";

const WORKTREE_DIRECTORY_PREFIX = "orkestrator-test-worktrees-";

sweepStaleTempDirs({ prefix: WORKTREE_DIRECTORY_PREFIX, maxAgeMs: 60 * 60 * 1_000 });

// Tests must never create worktrees in the user's real workspaces root. The
// backend falls back to `ORKESTRATOR_WORKTREE_DIR` when a command context has
// no `worktreeDir`, so point it at a temporary directory. It is assigned
// unconditionally because a value inherited from the shell names a real root.
// The path is canonical so worktree paths compare equal to Git's own output.
const worktreeDirectory = realpathSync(createOwnedTempDir(WORKTREE_DIRECTORY_PREFIX));
process.env.ORKESTRATOR_WORKTREE_DIR = worktreeDirectory;

// See isolate-git-config.ts for why both handlers are needed.
function removeWorktreeDirectory(): void {
  rmSync(worktreeDirectory, { recursive: true, force: true });
}
afterAll(removeWorktreeDirectory);
process.once("exit", removeWorktreeDirectory);
