import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";

const OWNER = /^(\d+)-[0-9a-f-]{36}$/;

function alive(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    process.kill(pid, 0); // Existence probe only; never terminates a process.
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeEmpty(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
}

/**
 * Atomically publishes a nonempty lock directory. A contender can reclaim only
 * a dead owner's uniquely named empty child, then rmdir the root. A racing
 * contender can never remove a replacement owner's child or nonempty root.
 * No clock expiry can steal a lock from a slow but live process. PID reuse
 * conservatively leaves it busy. Staging directories contain no file bytes.
 */
export function createEssentialLogLock(directory: string): () => (() => void) | null {
  const token = `${process.pid}-${randomUUID()}`;
  const lock = path.join(directory, ".writer-lock");
  const stage = path.join(directory, `.writer-stage-${token}`);

  return () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Clean interrupted publications; only our empty, dead-process directories.
    const names = readdirSync(directory);
    if (names.length > 1024) throw new Error("Essential log directory entry bound exceeded");
    for (const name of names) {
      if (!name.startsWith(".writer-stage-")) continue;
      const owner = name.slice(".writer-stage-".length);
      const match = OWNER.exec(owner);
      if (match && !alive(Number(match[1]))) {
        removeEmpty(path.join(directory, name, owner));
        removeEmpty(path.join(directory, name));
      }
    }
    mkdirSync(stage, { mode: 0o700 });
    mkdirSync(path.join(stage, token), { mode: 0o700 });
    try {
      renameSync(stage, lock);
    } catch (error) {
      removeEmpty(path.join(stage, token));
      removeEmpty(stage);
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      let owners: string[];
      try {
        owners = readdirSync(lock);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw readError;
      }
      if (owners.length === 1) {
        const match = OWNER.exec(owners[0]!);
        if (match && !alive(Number(match[1]))) removeEmpty(path.join(lock, owners[0]!));
      }
      // Also handles a process dying between removing its child and its root.
      removeEmpty(lock);
      return null;
    }
    return () => {
      removeEmpty(path.join(lock, token));
      removeEmpty(lock);
    };
  };
}
