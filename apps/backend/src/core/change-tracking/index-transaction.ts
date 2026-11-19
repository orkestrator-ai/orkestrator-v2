import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { runCommandBuffer } from "../shell.js";
import type { WorktreeTarget } from "./worktree-owner.js";

/**
 * Work on a private copy while holding Git's real index lock. The marker's
 * inode proves ownership during cleanup, including after a partial begin.
 * The same file operations run on the host and in the container namespace.
 */
async function indexFiles(
  files: typeof fs,
  operation: "begin" | "publish" | "cleanup",
  index: string,
  directory: string,
): Promise<void> {
  const lock = `${index}.lock`;
  const marker = `${directory}/owner`;
  const alternate = `${directory}/index`;
  const prepared = `${directory}/prepared`;
  const ownsLock = async () => {
    const current = await files.lstat(lock).catch(() => null);
    if (!current) return false;
    for (const path of [marker, prepared]) {
      const owner = await files.lstat(path).catch(() => null);
      if (owner?.dev === current.dev && owner.ino === current.ino) return true;
    }
    return false;
  };
  if (operation === "begin") {
    await files.mkdir(directory, { mode: 0o700 });
    await files.writeFile(marker, "", { flag: "wx", mode: 0o600 });
    await files.link(marker, lock);
    if (!(await files.lstat(index)).isFile()) throw new Error("index unavailable");
    await files.copyFile(index, alternate);
  } else if (operation === "publish") {
    const file = await files.open(alternate, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await files.link(alternate, prepared);
    if (!(await ownsLock())) throw new Error("index lock lost");
    await files.rename(alternate, lock);
    // This rename publishes and releases the lock in the same filesystem action.
    await files.rename(lock, index);
  } else {
    if (await ownsLock()) await files.unlink(lock);
    await files.rm(directory, { recursive: true, force: true });
  }
}

export async function withLockedIndex(
  target: WorktreeTarget,
  index: string,
  update: (alternate: string, publish: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = `${index}.orkestrator-${randomUUID()}`;
  const operate = async (operation: Parameters<typeof indexFiles>[1]) => {
    if (target.kind === "local") return indexFiles(fs, operation, index, directory);
    const script = `(${indexFiles.toString()})(require("node:fs/promises"), ...process.argv.slice(1)).catch(() => { process.exitCode = 1; });`;
    await runCommandBuffer(
      "docker",
      ["exec", target.containerId, "node", "-e", script, "--", operation, index, directory],
      { timeoutMs: 30_000 },
    );
  };

  let published = false;
  try {
    await operate("begin");
    await update(`${directory}/index`, async () => {
      await operate("publish");
      published = true;
    });
  } finally {
    // Once published, a scratch cleanup failure cannot change the receipt.
    await operate("cleanup").catch((error: unknown) => {
      if (!published) throw error;
    });
  }
}
