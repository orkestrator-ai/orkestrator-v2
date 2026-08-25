import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_LOG_STORAGE_ENTRIES = 100_000;

export type LogStorageStats = {
  totalBytes: number;
  fileCount: number;
};

/**
 * Walks the log directory without following symlinks, so a link planted inside
 * it cannot make this report — or later delete — anything outside the tree.
 * `maxEntries` is injectable because the production bound is far past what a
 * test can build.
 */
export async function getLogStorageStats(
  logDirectory: string,
  maxEntries = MAX_LOG_STORAGE_ENTRIES,
): Promise<LogStorageStats> {
  const stats: LogStorageStats = { totalBytes: 0, fileCount: 0 };
  const pending = [logDirectory];
  let visitedEntries = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxEntries) {
        throw new Error("Log directory contains too many entries to inspect safely");
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await fs.stat(entryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) continue;
      stats.fileCount += 1;
      stats.totalBytes += metadata.size;
    }
  }

  return stats;
}

export async function cleanupLogStorage(
  logDirectory: string,
  maxEntries = MAX_LOG_STORAGE_ENTRIES,
): Promise<LogStorageStats> {
  const entries = await fs
    .readdir(logDirectory, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    await fs.rm(path.join(logDirectory, entry.name), {
      recursive: entry.isDirectory() && !entry.isSymbolicLink(),
      force: true,
    });
  }
  return getLogStorageStats(logDirectory, maxEntries);
}
