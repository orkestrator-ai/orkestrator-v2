import { captureWorktreePathIdentity } from "@orkestrator/protocol/node/worktree-paths";
import { mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";

/**
 * Startup and skeleton pruning share a lock outside the removable profile.
 * A crash leaves the lock in place: fail closed until it is removed after
 * confirming no lifecycle operation is running.
 */
export function tryLockProfile(profileRoot: string): (() => void) | null {
  const locks = path.join(path.dirname(path.dirname(profileRoot)), ".profile-locks");
  const recheckParent = captureWorktreePathIdentity(locks);
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  recheckParent();
  const lock = path.join(locks, path.basename(profileRoot));
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const recheckLock = captureWorktreePathIdentity(lock);
  return () => {
    recheckLock();
    rmdirSync(lock);
  };
}
