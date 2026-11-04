import { ESSENTIAL_LOG_DIRECTORY_NAME } from "@orkestrator/protocol/node/essential-log";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

const MAX_LOG_STORAGE_ENTRIES = 100_000;

export type LogStorageStats = {
  /** The debug logs, which **Clean up logs** removes. */
  totalBytes: number;
  fileCount: number;
  /** The always-on essential log, which it leaves alone. */
  essentialBytes: number;
  essentialFileCount: number;
};

type DirectoryStats = { bytes: number; files: number };

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
  const budget = { remaining: maxEntries };
  const essential: DirectoryStats = { bytes: 0, files: 0 };
  const debug: DirectoryStats = { bytes: 0, files: 0 };
  await addDirectoryStats(
    path.join(logDirectory, ESSENTIAL_LOG_DIRECTORY_NAME),
    essential,
    budget,
    () => true,
  );
  await addDirectoryStats(
    logDirectory,
    debug,
    budget,
    (entry, directory) => !isEssentialEntry(entry, directory, logDirectory),
  );
  return {
    totalBytes: debug.bytes,
    fileCount: debug.files,
    essentialBytes: essential.bytes,
    essentialFileCount: essential.files,
  };
}

function isEssentialEntry(entry: Dirent, directory: string, logDirectory: string): boolean {
  return (
    directory === logDirectory && entry.name === ESSENTIAL_LOG_DIRECTORY_NAME && entry.isDirectory()
  );
}

async function addDirectoryStats(
  root: string,
  stats: DirectoryStats,
  budget: { remaining: number },
  include: (entry: Dirent, directory: string) => boolean,
): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    for (const entry of entries) {
      if (!include(entry, directory)) continue;
      budget.remaining -= 1;
      if (budget.remaining < 0) {
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
      stats.files += 1;
      stats.bytes += metadata.size;
    }
  }
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
    if (isEssentialEntry(entry, logDirectory, logDirectory)) continue;
    await fs.rm(path.join(logDirectory, entry.name), {
      recursive: entry.isDirectory() && !entry.isSymbolicLink(),
      force: true,
    });
  }
  return getLogStorageStats(logDirectory, maxEntries);
}
