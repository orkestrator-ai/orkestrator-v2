/**
 * Memory budget for file-change diff state.
 *
 * `ToolDiffMetadata` can carry `before`/`after` — **entire file contents** (an
 * added or deleted file's text) — plus the diff, and the render state keeps one
 * per `fileChange` item in a turn-scoped cache:
 *
 *   cache: item → { before?, after?, diff } for one file_change item
 *
 * With a long-lived app-server thread a turn that touches many large files
 * would hold all of them, so oversized contents are dropped before they are
 * stored and the cache is capped.
 */
import type { FileChangeDiffContext, ToolDiffMetadata } from "./types.js";

/**
 * `before`/`after` are only a fallback for providers that could not produce a
 * unified diff. Once `diff` exists the renderer always prefers it, so shipping
 * the two whole-file snapshots as well only duplicates payload and retained
 * memory.
 *
 * The diff is what the UI renders by default; before/after exist for
 * side-by-side. For a 5MB minified bundle the side-by-side view is useless
 * anyway, so paying 10MB of RSS for it is a bad trade.
 */
export const MAX_INLINE_FILE_BYTES = 256 * 1024;

/** Above this a diff is summarised rather than stored in full. */
export const MAX_DIFF_BYTES = 1024 * 1024;

/** The per-turn cache; cleared between turns, so this is a within-turn cap. */
export const MAX_DIFF_CACHE_ENTRIES = 256;

export const TRUNCATED_NOTICE = "\n… content omitted (file too large to keep in memory)";

function byteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

/**
 * Drops oversized `before`/`after` before they are stored.
 *
 * Returns metadata that is always safe to keep: counts and the diff survive, so
 * the transcript still shows what changed and by how much.
 */
export function applyDiffBudget(metadata: ToolDiffMetadata): ToolDiffMetadata {
  const beforeBytes = byteLength(metadata.before);
  const afterBytes = byteLength(metadata.after);
  const tooLarge = beforeBytes > MAX_INLINE_FILE_BYTES || afterBytes > MAX_INLINE_FILE_BYTES;

  let diff = metadata.diff;
  if (diff !== undefined && byteLength(diff) > MAX_DIFF_BYTES) {
    // Keep the head: the first hunks are the ones a reviewer reads.
    diff = `${diff.slice(0, MAX_DIFF_BYTES)}${TRUNCATED_NOTICE}`;
  }

  if (!tooLarge && !diff) return { ...metadata, diff };

  return {
    filePath: metadata.filePath,
    additions: metadata.additions,
    deletions: metadata.deletions,
    diff,
    // `before`/`after` are deliberately omitted when either side is oversized
    // or a unified diff already carries the same visible information.
  };
}

export function pruneDiffCache(cache: Map<string, ToolDiffMetadata>): number {
  let evicted = 0;
  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    evicted += 1;
  }
  return evicted;
}

export interface DiffBudgetStats {
  cacheEntries: number;
}

export function describeDiffBudget(context: FileChangeDiffContext): DiffBudgetStats {
  return { cacheEntries: context.cache.size };
}
