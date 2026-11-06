import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { statSettled, statStamp } from "./stat-stamp.js";
import { FILE_LINE_COUNT_CHUNK_BYTES, UNTRACKED_SCAN_MAX_FILES } from "./commands-validation.js";
import { MAX_BINARY_FILE_BYTES, validateRelativeFilePath } from "./path-safety.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * What a local diff scan remembers about one worktree so a later scan does not
 * repeat the work: the line count of each settled untracked file, and that the
 * exclude file was ensured (docs/architecture/git-scan-caches.md).
 *
 * Process-wide on purpose, like `git-fsmonitor.ts`'s migrations: both scan paths
 * (diff stats and Git scopes) read the same files, and every entry is checked
 * against the file's own stat before it is used. Bounded by worktree count and,
 * per worktree, by entries and estimated bytes. The diff stats owner drops a
 * worktree when its environment goes away.
 */

export type LocalFileLineCount =
  { kind: "text"; lines: number } | { kind: "binary" } | { kind: "too-large" } | { kind: "other" };

const MAX_WORKTREES = 64;
const MAX_COUNTS_PER_WORKTREE = UNTRACKED_SCAN_MAX_FILES;
const MAX_COUNT_BYTES_PER_WORKTREE = 512 * 1024;
/** Estimated cost of one entry beside its path: the stamp, the count and the map slot. */
const COUNT_ENTRY_OVERHEAD_BYTES = 128;

interface CachedCount {
  stamp: string;
  count: LocalFileLineCount;
}

function countCost(relativePath: string): number {
  return relativePath.length * 2 + COUNT_ENTRY_OVERHEAD_BYTES;
}

class WorktreeScanCache {
  /** Oldest entry first, so a full cache evicts the file it has held longest. */
  readonly counts = new Map<string, CachedCount>();
  private countBytes = 0;
  /** Files read and counted, and files whose settled stamp was reused unread. */
  readonly reads = { contentRead: 0, stampReused: 0 };
  /** The exclude file as last ensured; a changed stamp ensures it again. */
  excludeFile: { file: string; stamp: string } | undefined;
  excludeEnsuring: Promise<void> | undefined;

  setCount(relativePath: string, entry: CachedCount): void {
    this.deleteCount(relativePath);
    this.counts.set(relativePath, entry);
    this.countBytes += countCost(relativePath);
    for (const oldest of this.counts.keys()) {
      if (
        this.counts.size <= MAX_COUNTS_PER_WORKTREE &&
        this.countBytes <= MAX_COUNT_BYTES_PER_WORKTREE
      ) {
        break;
      }
      this.deleteCount(oldest);
    }
  }

  deleteCount(relativePath: string): void {
    if (this.counts.delete(relativePath)) this.countBytes -= countCost(relativePath);
  }
}

const worktrees = new Map<string, WorktreeScanCache>();

function cacheFor(worktreePath: string): WorktreeScanCache {
  let cache = worktrees.get(worktreePath);
  if (cache) worktrees.delete(worktreePath);
  else cache = new WorktreeScanCache();
  worktrees.set(worktreePath, cache);
  for (const oldest of worktrees.keys()) {
    if (worktrees.size <= MAX_WORKTREES) break;
    worktrees.delete(oldest);
  }
  return cache;
}

/** Forget a worktree whose environment went away. Safe for unknown paths. */
export function dropLocalGitScanCaches(worktreePath: string): void {
  worktrees.delete(worktreePath);
}

/**
 * Cache gauges for recurring diagnostics (`local-git-scan`): worktrees with a
 * cache and the line counts held across them. Counts only.
 */
export function localGitScanCacheGauges(): { worktrees: number; counts: number } {
  let counts = 0;
  for (const cache of worktrees.values()) counts += cache.counts.size;
  return { worktrees: worktrees.size, counts };
}

/** Tests and benchmarks: how a worktree's cache has been used, if it has one. */
export function localGitScanCacheStats(
  worktreePath: string,
): { counts: number; contentRead: number; stampReused: number } | null {
  const cache = worktrees.get(worktreePath);
  return cache ? { counts: cache.counts.size, ...cache.reads } : null;
}

/** Tests: forget every worktree. */
export function resetLocalGitScanCachesForTests(): void {
  worktrees.clear();
}

/**
 * Reads one file's line count and how far its stat can be trusted later.
 *
 * Counting lines needs no copy of the file: reading the whole file and splitting
 * it allocated three copies of every untracked file on each poll - the buffer,
 * the decoded string, and an array holding every line - for a number that only
 * needs a running separator count. The chunked walk below is the same algorithm
 * the container scanner uses (CONTAINER_UNTRACKED_STATS_SCANNER), so both
 * environment types report identical counts for identical content.
 */
async function readLocalFileLines(
  rootPath: string,
  relativePath: string,
): Promise<{ count: LocalFileLineCount; settledStamp?: string }> {
  const target = validateRelativeFilePath(relativePath, "git status path");
  const fullPath = path.join(rootPath, target);
  recurringWorkMetrics.work("file-read");

  // O_NOFOLLOW, and a stat of the descriptor rather than the path, so an
  // untracked symlink cannot be followed out of the worktree and the file that
  // gets measured is provably the one that passed the size check.
  const handle = await fs.open(
    fullPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
  );
  try {
    // Taken before the bytes are read: a write during the read moves the stamp,
    // so the next scan misses instead of keeping a count of mixed content.
    const statAt = Date.now();
    const stat = await handle.stat();
    if (!stat.isFile()) return { count: { kind: "other" } };
    const settledStamp = statSettled(stat, statAt) ? statStamp(stat) : undefined;
    const counted = (count: LocalFileLineCount) => ({
      count,
      ...(settledStamp ? { settledStamp } : {}),
    });
    if (stat.size === 0) return counted({ kind: "text", lines: 0 });
    if (stat.size > MAX_BINARY_FILE_BYTES) return counted({ kind: "too-large" });

    const buffer = Buffer.allocUnsafe(FILE_LINE_COUNT_CHUNK_BYTES);
    let total = 0;
    let separators = 0;
    let previousWasCarriageReturn = false;
    let lastByte = -1;

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // The file can grow between the stat and the read; stop rather than let an
      // actively-written log turn one poll into an unbounded scan.
      if (total > MAX_BINARY_FILE_BYTES) return counted({ kind: "too-large" });
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index]!;
        if (byte === 0) return counted({ kind: "binary" });
        if (byte === 0x0d) {
          separators += 1;
          previousWasCarriageReturn = true;
        } else if (byte === 0x0a) {
          if (!previousWasCarriageReturn) separators += 1;
          previousWasCarriageReturn = false;
        } else {
          previousWasCarriageReturn = false;
        }
        lastByte = byte;
      }
    }

    return counted({
      kind: "text",
      lines: separators + (lastByte !== 0x0d && lastByte !== 0x0a ? 1 : 0),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function countLocalFileLines(rootPath: string, relativePath: string): Promise<number> {
  const counted = await countLocalFileLinesDetailed(rootPath, relativePath);
  return counted.kind === "text" ? counted.lines : 0;
}

/**
 * {@link countLocalFileLines}, keeping why a file has no count: binary (a NUL
 * byte) and oversized files are not "zero lines", and the environment
 * projection must not present them as such.
 */
export async function countLocalFileLinesDetailed(
  rootPath: string,
  relativePath: string,
): Promise<LocalFileLineCount> {
  return (await readLocalFileLines(rootPath, relativePath)).count;
}

/**
 * {@link countLocalFileLinesDetailed} for an untracked file of a scanned
 * worktree: a file whose stat still matches a settled read is not read again.
 *
 * Only a stamp older than the settle window when it was read is kept, so a
 * same-size rewrite within one timestamp tick cannot publish a stale count. A
 * file being written is read on every scan until it ages. Failures are not
 * cached: they propagate as they always did.
 */
export async function countUntrackedFileLines(
  worktreePath: string,
  relativePath: string,
): Promise<LocalFileLineCount> {
  const cache = cacheFor(worktreePath);
  const cached = cache.counts.get(relativePath);
  if (cached) {
    const target = validateRelativeFilePath(relativePath, "git status path");
    const info = await fs.lstat(path.join(worktreePath, target)).catch(() => null);
    if (info?.isFile() && statStamp(info) === cached.stamp) {
      cache.reads.stampReused += 1;
      return cached.count;
    }
    cache.deleteCount(relativePath);
  }
  cache.reads.contentRead += 1;
  const { count, settledStamp } = await readLocalFileLines(worktreePath, relativePath);
  if (settledStamp) cache.setCount(relativePath, { stamp: settledStamp, count });
  return count;
}

/** Forget counts of files a complete scan no longer lists as untracked. */
export function retainUntrackedCounts(worktreePath: string, listed: readonly string[]): void {
  const cache = cacheFor(worktreePath);
  if (cache.counts.size === 0) return;
  const keep = new Set(listed);
  for (const relativePath of Array.from(cache.counts.keys())) {
    if (!keep.has(relativePath)) cache.deleteCount(relativePath);
  }
}

/**
 * Runs `ensure` for a worktree once: it resolves the exclude file with a git
 * process, reads it and rarely has anything to write. Later calls compare one
 * `stat` of that file instead, so a file something else rewrote or removed is
 * still repaired. `ensure` reports the stamp from before the read that found
 * every pattern, so a rewrite after that read still shows as a change.
 *
 * Concurrent scans share an attempt, and each then checks the file for itself,
 * because it may have changed after that attempt read it. A failed attempt is
 * not remembered.
 */
export async function ensureLocalGitExcludeOnce(
  worktreePath: string,
  ensure: () => Promise<{ file: string; stamp?: string }>,
): Promise<void> {
  const cache = cacheFor(worktreePath);
  while (cache.excludeEnsuring) await cache.excludeEnsuring;
  if (cache.excludeFile) {
    const info = await fs.stat(cache.excludeFile.file).catch(() => null);
    if (info && statStamp(info) === cache.excludeFile.stamp) return;
    if (cache.excludeEnsuring) return ensureLocalGitExcludeOnce(worktreePath, ensure);
  }
  const attempt = (async () => {
    const { file, stamp } = await ensure();
    cache.excludeFile = stamp ? { file, stamp } : undefined;
  })().finally(() => {
    cache.excludeEnsuring = undefined;
  });
  cache.excludeEnsuring = attempt;
  return attempt;
}
